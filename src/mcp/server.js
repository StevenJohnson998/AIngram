/**
 * MCP (Model Context Protocol) server — read-only tools for AI agents.
 * Mounted in the Express app at /mcp (Streamable HTTP transport).
 *
 * Tools: search, get_topic, get_chunk
 * Auth: API key via Bearer header (reuses existing auth middleware).
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const chunkService = require('../services/chunk');
const topicService = require('../services/topic');
const vectorSearch = require('../services/vector-search');
const { generateEmbedding } = require('../services/ollama');
const { getPool } = require('../config/database');

/**
 * Create and configure the MCP server with read-only tools.
 */
function createMcpServer() {
  const server = new McpServer({
    name: 'aingram',
    version: '1.0.0',
  });

  // Tool: search
  server.tool(
    'search',
    'Search the AIngram knowledge base. Returns top 10 chunks matching the query with topic context, trust scores, and sources.',
    {
      query: z.string().describe('Search query (natural language or keywords)'),
      lang: z.string().optional().describe('Language filter (e.g. "en", "fr"). Defaults to all languages.'),
      limit: z.number().optional().describe('Max results (1-20, default 10)'),
    },
    async ({ query, lang, limit }) => {
      try {
        const maxResults = Math.min(Math.max(limit || 10, 1), 20);

        // Try vector search first, fall back to text search
        const embedding = await generateEmbedding(query).catch(() => null);
        let results;

        if (embedding) {
          results = await vectorSearch.hybridSearch(query, { limit: maxResults, langs: lang ? [lang] : ['en'] });
        } else {
          // Text-only fallback
          const pool = getPool();
          const { rows } = await pool.query(
            `SELECT * FROM (
               SELECT DISTINCT ON (c.id) c.id, c.content, c.trust_score, c.status,
                      t.title AS topic_title, t.slug AS topic_slug,
                      ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', $1)) AS rank
               FROM chunks c
               JOIN chunk_topics ct ON ct.chunk_id = c.id
               JOIN topics t ON t.id = ct.topic_id
               WHERE c.status = 'active'
                 AND to_tsvector('english', c.content) @@ plainto_tsquery('english', $1)
               ORDER BY c.id, c.trust_score DESC
             ) sub ORDER BY sub.rank DESC, sub.trust_score DESC
             LIMIT $2`,
            [query, maxResults]
          );
          results = rows;
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              results: (results || []).map(r => ({
                chunkId: r.id,
                content: r.content,
                trustScore: r.trust_score,
                topicTitle: r.topic_title,
                topicSlug: r.topic_slug,
                similarity: r.similarity,
                status: r.status,
              })),
              total: (results || []).length,
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // Tool: get_topic
  server.tool(
    'get_topic',
    'Get a topic by ID or slug, including its active chunks with trust scores.',
    {
      topicId: z.string().optional().describe('Topic UUID'),
      slug: z.string().optional().describe('Topic slug (alternative to topicId)'),
    },
    async ({ topicId, slug }) => {
      try {
        let topic;
        if (topicId) {
          topic = await topicService.getTopicById(topicId);
        } else if (slug) {
          topic = await topicService.getTopicBySlug(slug);
        } else {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Either topicId or slug is required' }) }],
            isError: true,
          };
        }

        if (!topic) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Topic not found' }) }],
            isError: true,
          };
        }

        // Get active chunks for this topic
        const chunks = await chunkService.getChunksByTopic(topic.id, { status: 'active', limit: 50 });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              topic: {
                id: topic.id,
                title: topic.title,
                slug: topic.slug,
                lang: topic.lang,
                sensitivity: topic.sensitivity,
                createdAt: topic.created_at,
              },
              chunks: chunks.data.map(c => ({
                id: c.id,
                content: c.content,
                trustScore: c.trust_score,
                version: c.version,
                title: c.title,
                subtitle: c.subtitle,
              })),
              totalChunks: chunks.pagination.total,
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // Tool: get_chunk
  server.tool(
    'get_chunk',
    'Get a specific chunk by ID, including its sources, trust score, status, and version history.',
    {
      chunkId: z.string().describe('Chunk UUID'),
    },
    async ({ chunkId }) => {
      try {
        const chunk = await chunkService.getChunkById(chunkId);
        if (!chunk) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Chunk not found' }) }],
            isError: true,
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id: chunk.id,
              content: chunk.content,
              technicalDetail: chunk.technical_detail,
              trustScore: chunk.trust_score,
              status: chunk.status,
              version: chunk.version,
              title: chunk.title,
              subtitle: chunk.subtitle,
              parentChunkId: chunk.parent_chunk_id,
              createdBy: chunk.created_by,
              createdAt: chunk.created_at,
              sources: chunk.sources || [],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  return server;
}

/**
 * Mount MCP endpoints on an Express app.
 * POST /mcp — main MCP endpoint (Streamable HTTP)
 * GET /mcp — SSE endpoint for server-initiated messages
 * DELETE /mcp — session termination
 */
const MAX_MCP_SESSIONS = 200;
const MCP_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function mountMcp(app) {
  const server = createMcpServer();

  // Track active transports by session ID with last-activity timestamp
  const transports = new Map(); // sessionId → { transport, lastActivity }

  // Sweep stale sessions every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of transports) {
      if (now - entry.lastActivity > MCP_SESSION_TTL_MS) {
        transports.delete(id);
      }
    }
  }, 5 * 60 * 1000).unref();

  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];
      let transport;

      if (sessionId && transports.has(sessionId)) {
        const entry = transports.get(sessionId);
        entry.lastActivity = Date.now();
        transport = entry.transport;
      } else {
        if (transports.size >= MAX_MCP_SESSIONS) {
          return res.status(503).json({ error: 'Too many active MCP sessions. Try again later.' });
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // auto-generate
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
          }
        };
        await server.connect(transport);
        transports.set(transport.sessionId, { transport, lastActivity: Date.now() });
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP POST error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP server error' });
      }
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const entry = sessionId && transports.get(sessionId);
    if (!entry) {
      return res.status(400).json({ error: 'No active session. Send an initialize request first.' });
    }
    entry.lastActivity = Date.now();
    await entry.transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const entry = sessionId && transports.get(sessionId);
    if (entry) {
      await entry.transport.handleRequest(req, res);
      transports.delete(sessionId);
    } else {
      res.status(200).end();
    }
  });
}

module.exports = { createMcpServer, mountMcp };
