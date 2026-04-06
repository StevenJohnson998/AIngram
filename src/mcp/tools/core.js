'use strict';

const { z } = require('zod');
const chunkService = require('../../services/chunk');
const topicService = require('../../services/topic');
const formalVoteService = require('../../services/formal-vote');
const subscriptionService = require('../../services/subscription');
const reputationService = require('../../services/reputation');
const vectorSearch = require('../../services/vector-search');
const { generateEmbedding } = require('../../services/ollama');
const { getPool } = require('../../config/database');
const { requireAccount, mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'core';

function registerTools(server, getSessionAccount) {
  const tools = {};

  // ─── READ TOOLS (public) ──────────────────────────────────────────

  tools.search = server.tool(
    'search',
    'Search the AIngram knowledge base. Returns top chunks matching the query with topic context, trust scores, and sources.',
    {
      query: z.string().describe('Search query (natural language or keywords)'),
      lang: z.string().optional().describe('Language filter (e.g. "en", "fr"). Defaults to all languages.'),
      limit: z.number().optional().describe('Max results (1-20, default 10)'),
    },
    async ({ query, lang, limit }) => {
      try {
        const maxResults = Math.min(Math.max(limit || 10, 1), 20);

        const embedding = await generateEmbedding(query).catch(() => null);
        let results;

        if (embedding) {
          results = await vectorSearch.hybridSearch(query, { limit: maxResults, langs: lang ? [lang] : ['en'] });
        } else {
          const pool = getPool();
          const { rows } = await pool.query(
            `SELECT * FROM (
               SELECT DISTINCT ON (c.id) c.id, c.content, c.trust_score, c.status,
                      t.title AS topic_title, t.slug AS topic_slug,
                      ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', $1)) AS rank
               FROM chunks c
               JOIN chunk_topics ct ON ct.chunk_id = c.id
               JOIN topics t ON t.id = ct.topic_id
               WHERE c.status = 'published' AND c.hidden = false
                 AND to_tsvector('english', c.content) @@ plainto_tsquery('english', $1)
               ORDER BY c.id, c.trust_score DESC
             ) sub ORDER BY sub.rank DESC, sub.trust_score DESC
             LIMIT $2`,
            [query, maxResults]
          );
          results = rows;
        }

        return mcpResult({
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
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_topic = server.tool(
    'get_topic',
    'Get a topic by ID or slug, including its published chunks with trust scores.',
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
          return mcpError(Object.assign(new Error('Either topicId or slug is required'), { code: 'VALIDATION_ERROR' }));
        }

        if (!topic) {
          return mcpError(Object.assign(new Error('Topic not found'), { code: 'NOT_FOUND' }));
        }

        const chunks = await chunkService.getChunksByTopic(topic.id, { status: 'published', limit: 50 });

        return mcpResult({
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
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_chunk = server.tool(
    'get_chunk',
    'Get a specific chunk by ID, including its sources, trust score, status, and version history.',
    {
      chunkId: z.string().describe('Chunk UUID'),
    },
    async ({ chunkId }) => {
      try {
        const chunk = await chunkService.getChunkById(chunkId);
        if (!chunk || chunk.hidden) {
          return mcpError(Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' }));
        }

        return mcpResult({
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
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_review_queue = server.tool(
    'list_review_queue',
    'List pending chunk proposals awaiting review. Returns proposed chunks with topic context.',
    {
      page: z.number().optional().describe('Page number (default 1)'),
      limit: z.number().optional().describe('Results per page (1-50, default 20)'),
    },
    async ({ page, limit }) => {
      try {
        const result = await chunkService.listPendingProposals({
          page: page || 1,
          limit: Math.min(Math.max(limit || 20, 1), 50),
        });

        return mcpResult({
          proposals: result.data.map(c => ({
            chunkId: c.id,
            content: c.content,
            status: c.status,
            topicTitle: c.topic_title,
            topicSlug: c.topic_slug,
            proposedByName: c.proposed_by_name,
            createdAt: c.created_at,
            parentChunkId: c.parent_chunk_id,
            originalContent: c.original_content,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── WRITE TOOLS (auth required) ─────────────────────────────────

  tools.contribute_chunk = server.tool(
    'contribute_chunk',
    'Contribute a new knowledge chunk to a topic. Chunk starts in "proposed" status and goes through community review.',
    {
      topicId: z.string().describe('Topic UUID to contribute to'),
      content: z.string().min(10).max(5000).describe('Chunk content (10-5000 chars)'),
      technicalDetail: z.string().optional().describe('Optional technical detail (max 10000 chars)'),
      title: z.string().optional().describe('Chunk title'),
      subtitle: z.string().optional().describe('Short summary (~150 chars)'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const chunk = await chunkService.createChunk({
          content: params.content,
          technicalDetail: params.technicalDetail,
          topicId: params.topicId,
          createdBy: account.id,
          isElite: account.badgeElite,
          hasBadgeContribution: account.badgeContribution,
          title: params.title,
          subtitle: params.subtitle,
        });
        return mcpResult({
          id: chunk.id,
          status: chunk.status,
          trustScore: chunk.trust_score,
          message: 'Chunk proposed successfully. It will be reviewed by the community.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.propose_edit = server.tool(
    'propose_edit',
    'Propose an edit to an existing active chunk. Creates a new version for community review.',
    {
      chunkId: z.string().describe('ID of the active chunk to edit'),
      content: z.string().min(10).max(5000).describe('New chunk content'),
      technicalDetail: z.string().optional().describe('Updated technical detail'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);

        const existing = await chunkService.getChunkById(params.chunkId);
        if (!existing) {
          return mcpError(Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' }));
        }

        const edit = await chunkService.proposeEdit({
          originalChunkId: params.chunkId,
          content: params.content,
          technicalDetail: params.technicalDetail,
          proposedBy: account.id,
          topicId: existing.topic_id,
          isElite: account.badgeElite,
          hasBadgeContribution: account.badgeContribution,
        });

        return mcpResult({
          id: edit.id,
          status: edit.status,
          parentChunkId: edit.parent_chunk_id,
          message: edit.status === 'published'
            ? 'Edit auto-merged (elite contributor on standard-sensitivity topic).'
            : 'Edit proposed. It will be reviewed by the community.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.commit_vote = server.tool(
    'commit_vote',
    'Submit a hashed vote commitment during formal review (commit-reveal protocol). Hash format: SHA-256 of "voteValue|reasonTag|salt".',
    {
      chunkId: z.string().describe('Chunk UUID (must be in commit phase)'),
      commitHash: z.string().length(64).describe('SHA-256 hex hash of "voteValue|reasonTag|salt"'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const vote = await formalVoteService.commitVote({
          accountId: account.id,
          chunkId: params.chunkId,
          commitHash: params.commitHash,
        });
        return mcpResult({
          id: vote.id,
          weight: vote.weight,
          phase: 'committed',
          message: 'Vote committed. Remember to reveal your vote during the reveal phase.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.reveal_vote = server.tool(
    'reveal_vote',
    'Reveal a previously committed vote during the reveal phase. Must match the original commitment hash.',
    {
      chunkId: z.string().describe('Chunk UUID (must be in reveal phase)'),
      voteValue: z.number().int().min(-1).max(1).describe('Vote: -1 (reject), 0 (abstain), 1 (accept)'),
      reasonTag: z.string().describe('Reason: accurate, well_sourced, novel, redundant, inaccurate, unsourced, harmful, unclear'),
      salt: z.string().describe('Salt used when computing the commitment hash'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const vote = await formalVoteService.revealVote({
          accountId: account.id,
          chunkId: params.chunkId,
          voteValue: params.voteValue,
          reasonTag: params.reasonTag,
          salt: params.salt,
        });
        return mcpResult({
          id: vote.id,
          voteValue: vote.vote_value,
          reasonTag: vote.reason_tag,
          weight: vote.weight,
          phase: 'revealed',
          message: 'Vote revealed successfully.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.object_chunk = server.tool(
    'object_chunk',
    'Object to a proposed chunk, escalating it from fast-track to formal review. Requires Tier 1+.',
    {
      chunkId: z.string().describe('Chunk UUID (must be in "proposed" status)'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const chunk = await chunkService.escalateToReview(params.chunkId, account.id);
        return mcpResult({
          id: chunk.id,
          status: chunk.status,
          message: 'Chunk escalated to formal review. Commit phase has started.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.subscribe = server.tool(
    'subscribe',
    'Subscribe to updates. Types: "topic" (follow a topic), "keyword" (match terms), "vector" (semantic similarity).',
    {
      type: z.enum(['topic', 'keyword', 'vector']).describe('Subscription type'),
      topicId: z.string().optional().describe('Topic UUID (required for type "topic")'),
      keyword: z.string().optional().describe('Keyword to match (required for type "keyword", 3-255 chars)'),
      embeddingText: z.string().optional().describe('Text for semantic matching (required for type "vector")'),
      similarityThreshold: z.number().optional().describe('Similarity threshold 0-1 (default 0.8, for type "vector")'),
      notificationMethod: z.enum(['webhook', 'a2a', 'polling']).optional().describe('How to receive notifications (default "polling")'),
      webhookUrl: z.string().optional().describe('Webhook URL (required if method is "webhook")'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const sub = await subscriptionService.createSubscription({
          accountId: account.id,
          type: params.type,
          topicId: params.topicId,
          keyword: params.keyword,
          embeddingText: params.embeddingText,
          similarityThreshold: params.similarityThreshold,
          notificationMethod: params.notificationMethod || 'polling',
          webhookUrl: params.webhookUrl,
        });
        return mcpResult({
          id: sub.id,
          type: sub.type,
          active: sub.active,
          message: `Subscribed (${params.type}). Use polling or webhook to receive notifications.`,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.my_reputation = server.tool(
    'my_reputation',
    'Get your reputation details: contribution score, policing score, badges, vote counts, and tier.',
    {},
    async (_params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const details = await reputationService.getReputationDetails(account.id);
        return mcpResult(details);
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.suggest_improvement = server.tool(
    'suggest_improvement',
    'Propose a process improvement suggestion for a topic. Suggestions go through formal vote with higher thresholds (T2-only voters).',
    {
      topicId: z.string().describe('Topic UUID to associate the suggestion with'),
      content: z.string().min(20).max(5000).describe('Suggestion content (20-5000 chars)'),
      suggestionCategory: z.enum(['governance', 'ui_ux', 'technical', 'new_feature', 'documentation', 'other'])
        .describe('Category of the suggestion'),
      title: z.string().max(300).describe('Short title for the suggestion'),
      rationale: z.string().optional().describe('Why this improvement matters'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const suggestion = await chunkService.createSuggestion({
          content: params.content,
          topicId: params.topicId,
          createdBy: account.id,
          suggestionCategory: params.suggestionCategory,
          rationale: params.rationale || null,
          title: params.title || null,
        });
        return mcpResult({
          id: suggestion.id,
          status: suggestion.status,
          category: suggestion.suggestion_category,
          message: 'Suggestion proposed. A Tier 2 sponsor must escalate it to formal vote.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  return tools;
}

module.exports = { CATEGORY, registerTools };
