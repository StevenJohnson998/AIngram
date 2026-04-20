/**
 * Topics & Chunks routes.
 */

const { Router } = require('express');
const topicService = require('../services/topic');
const chunkService = require('../services/chunk');

const auth = require('../middleware/auth');
const { authenticatedLimiter, publicLimiter } = require('../middleware/rate-limit');
const { requireBadge } = require('../middleware/badge');
const { requireInstanceAdmin } = require('../middleware/instance-admin');
const { requireTier } = require('../middleware/tier-gate');
const { validationError, notFoundError, forbiddenError } = require('../utils/http-errors');
const { getErrorContext } = require('../utils/error-examples');
const { parsePagination, enrichPagination } = require('../utils/pagination');
const { VALID_LANGS } = require('../config/constants');
const { REJECTION_CATEGORIES, REJECTION_SUGGESTIONS_MAX_LENGTH, BULK_MAX_CHUNKS, MAX_CHUNKS_PER_TOPIC } = require('../config/protocol');
const { getPool } = require('../config/database');
const { OBJECTION_REASON_TAGS } = require('../config/protocol');
const { checkBackpressure, getQuarantineQueueStats, resetCircuitBreaker } = require('../services/quarantine-validator');
const { parseFields, applyFieldset } = require('../utils/sparse-fieldset');
const { DEFAULTS } = require('../utils/fieldset-defaults');

const router = Router();

const VALID_SENSITIVITIES = ['standard', 'sensitive'];
const VALID_STATUSES = ['active', 'locked', 'archived'];
const VALID_TOPIC_TYPES = ['knowledge', 'course'];
const VALID_CATEGORIES = [
  'uncategorized', 'agent-governance', 'collective-intelligence',
  'multi-agent-deliberation', 'agentic-protocols', 'llm-evaluation',
  'agent-memory', 'open-problems', 'field-notes', 'collective-cognition',
];
const VALID_FLAGS = ['spam', 'poisoning', 'hallucination', 'review_needed', 'wrong_category'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Agent hallucination guards (observed in 27-run audit) ---

// Agents use "article" as synonym for "topic". Redirect preserves method + body.
// Regex matches /articles and any /articles/<anything> (Express 5 requires named wildcards).
router.all(/^\/articles(?:\/.*)?$/, (req, res) => {
  const newPath = req.originalUrl
    .replace(/^\/v1\/articles/, '/v1/topics')
    .replace(/^\/articles/, '/topics');
  return res.redirect(307, newPath);
});

// Agents guess `GET /chunks` as the list endpoint. No such concept — chunks live
// under topics. 404 pédagogique plutôt que redirect (pas de mapping 1:1).
router.get('/chunks', (req, res) => {
  return notFoundError(res, 'No root list endpoint for chunks.', {
    did_you_mean: '/v1/topics/:topicId/chunks',
    hint: 'Chunks are nested under topics. To browse: first find a topic via GET /v1/topics or GET /v1/search, then GET /v1/topics/{topicId}/chunks. If lost, start from /llms.txt.',
    example_valid_call: { method: 'GET', url: '/v1/topics/{topicId}/chunks?limit=10' },
  });
});

// Agents guess `POST /chunks` to create. Real shape: POST /v1/topics/:id/chunks.
router.post('/chunks', (req, res) => {
  return notFoundError(res, 'No root create endpoint for chunks.', {
    did_you_mean: '/v1/topics/:topicId/chunks',
    hint: 'Chunks are created inside a topic. Use POST /v1/topics/{topicId}/chunks with body {content, sources?}. If lost, start from /llms.txt.',
    example_valid_call: { method: 'POST', url: '/v1/topics/{topicId}/chunks', body: { content: 'Chunk content here', sources: [{ url: '...', description: '...' }] } },
  });
});

// --- Topic routes ---

// POST /topics — create topic
router.post(
  '/topics',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active', 'provisional'),
  async (req, res) => {
    try {
      const { title, lang, summary, sensitivity, topicType, category } = req.body;

      if (!title || typeof title !== 'string' || title.length < 3 || title.length > 300) {
        return validationError(res, 'Title must be between 3 and 300 characters',
          getErrorContext('POST /topics', 'title'));
      }
      if (!lang || !VALID_LANGS.includes(lang)) {
        return validationError(res, `Lang must be one of: ${VALID_LANGS.join(', ')}`,
          getErrorContext('POST /topics', 'lang'));
      }
      if (summary && summary.length > 800) {
        return validationError(res, 'Summary must not exceed 1000 characters');
      }
      if (sensitivity && !VALID_SENSITIVITIES.includes(sensitivity)) {
        return validationError(res, `Sensitivity must be one of: ${VALID_SENSITIVITIES.join(', ')}`);
      }
      if (topicType && !VALID_TOPIC_TYPES.includes(topicType)) {
        return validationError(res, `topicType must be one of: ${VALID_TOPIC_TYPES.join(', ')}`);
      }
      if (category && !VALID_CATEGORIES.includes(category)) {
        return validationError(res, `category must be one of: ${VALID_CATEGORIES.join(', ')}`);
      }

      const topic = await topicService.createTopic({
        title,
        lang,
        summary,
        sensitivity,
        topicType,
        category,
        createdBy: req.account.id,
      });

      return res.status(201).json({
        ...topic,
        _hint: 'This creates a topic without content. Use POST /topics/full to create a topic with chunks in one request.',
      });
    } catch (err) {
      if (err.code === 'DUPLICATE_TOPIC') {
        return res.status(409).json({
          error: { code: 'DUPLICATE_TOPIC', message: err.message, existingTopicId: err.existingTopicId },
        });
      }
      console.error('Error creating topic:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create topic' } });
    }
  }
);

// POST /topics/full — create topic with multiple chunks in one atomic transaction
router.post(
  '/topics/full',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active', 'provisional'),
  async (req, res) => {
    try {
      const { title, lang, summary, sensitivity, topicType, category, chunks, forAgentId } = req.body;

      // Resolve target account: parent can create on behalf of their agent
      let creatorId = req.account.id;
      if (forAgentId) {
        const accountService = require('../services/account');
        const agent = await accountService.findById(forAgentId);
        if (!agent || agent.parent_id !== req.account.id) {
          return validationError(res, 'forAgentId must reference one of your sub-accounts');
        }
        creatorId = forAgentId;
      }

      if (!title || typeof title !== 'string' || title.length < 3 || title.length > 300) {
        return validationError(res, 'Title must be between 3 and 300 characters',
          getErrorContext('POST /topics/full', 'title'));
      }
      if (!lang || !VALID_LANGS.includes(lang)) {
        return validationError(res, `Lang must be one of: ${VALID_LANGS.join(', ')}`,
          getErrorContext('POST /topics/full', 'lang'));
      }
      if (summary && summary.length > 800) {
        return validationError(res, 'Summary must not exceed 1000 characters');
      }
      if (sensitivity && !VALID_SENSITIVITIES.includes(sensitivity)) {
        return validationError(res, `Sensitivity must be one of: ${VALID_SENSITIVITIES.join(', ')}`);
      }
      if (topicType && !VALID_TOPIC_TYPES.includes(topicType)) {
        return validationError(res, `topicType must be one of: ${VALID_TOPIC_TYPES.join(', ')}`);
      }
      if (category && !VALID_CATEGORIES.includes(category)) {
        return validationError(res, `category must be one of: ${VALID_CATEGORIES.join(', ')}`);
      }
      if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
        return validationError(res, 'chunks array is required and must not be empty',
          getErrorContext('POST /topics/full', 'chunks'));
      }
      if (chunks.length > BULK_MAX_CHUNKS) {
        return validationError(res, `Maximum ${BULK_MAX_CHUNKS} chunks per request`);
      }
      if (chunks.length > MAX_CHUNKS_PER_TOPIC) {
        return validationError(res, `Maximum ${MAX_CHUNKS_PER_TOPIC} chunks per topic`);
      }

      // Validate each chunk
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        if (!c.content || typeof c.content !== 'string') {
          return validationError(res, `chunks[${i}].content is required and must be a string`,
            getErrorContext('POST /topics/full', 'chunks[i].content'));
        }
        const trimmed = c.content.trim();
        if (trimmed.length < 10 || trimmed.length > 5000) {
          return validationError(res, `chunks[${i}].content must be between 10 and 5000 characters`,
            getErrorContext('POST /topics/full', 'chunks[i].content'));
        }
        if (c.technicalDetail && typeof c.technicalDetail !== 'string') {
          return validationError(res, `chunks[${i}].technicalDetail must be a string`);
        }
        if (c.technicalDetail && c.technicalDetail.length > 10000) {
          return validationError(res, `chunks[${i}].technicalDetail must not exceed 10000 characters`);
        }
        if (c.sources && !Array.isArray(c.sources)) {
          return validationError(res, `chunks[${i}].sources must be an array`);
        }
      }

      // QuarantineValidator backpressure check
      const bp = await checkBackpressure();
      if (bp.blocked) {
        return res.status(503).json({
          error: { code: 'SERVICE_UNAVAILABLE', message: bp.error },
          retry_after: bp.retryAfter,
        });
      }

      const result = await topicService.createTopicFull({
        title,
        lang,
        summary,
        sensitivity,
        topicType,
        category,
        createdBy: creatorId,
        chunks: chunks.map(c => ({
          content: c.content.trim(),
          technicalDetail: c.technicalDetail || null,
          title: c.title || null,
          subtitle: c.subtitle || null,
          adhp: c.adhp || null,
          sources: c.sources || [],
        })),
        isElite: !!req.account.badgeElite,
        hasBadgeContribution: !!req.account.badgeContribution,
      });

      return res.status(201).json({ data: result });
    } catch (err) {
      console.error('Error creating topic with chunks:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create topic with chunks' } });
    }
  }
);

// GET /topics — list topics
// Supports sparse fieldsets via ?fields=id,title,slug (see fieldset-defaults.js TOPIC_LIST for defaults).
// Embedding and injection metadata are always stripped.
router.get('/topics', auth.authenticateOptional, async (req, res) => {
  try {
    const { lang, sensitivity, status, topicType, category, include_empty } = req.query;
    const includeEmpty = include_empty === 'true';
    const { page, limit } = parsePagination(req.query);

    if (lang && !VALID_LANGS.includes(lang)) {
      return validationError(res, `Lang must be one of: ${VALID_LANGS.join(', ')}`);
    }
    if (sensitivity && !VALID_SENSITIVITIES.includes(sensitivity)) {
      return validationError(res, `Sensitivity must be one of: ${VALID_SENSITIVITIES.join(', ')}`);
    }
    if (status && !VALID_STATUSES.includes(status)) {
      return validationError(res, `Status must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    if (topicType && !VALID_TOPIC_TYPES.includes(topicType)) {
      return validationError(res, `topicType must be one of: ${VALID_TOPIC_TYPES.join(', ')}`);
    }
    if (category && !VALID_CATEGORIES.includes(category)) {
      return validationError(res, `category must be one of: ${VALID_CATEGORIES.join(', ')}`);
    }

    const fields = parseFields(req.query.fields);
    const result = await topicService.listTopics({ lang, status, sensitivity, topicType, category, includeEmpty, page, limit });
    if (result.pagination) result.pagination = enrichPagination(result.pagination, req);

    // Apply sparse fieldset — defaults strip heavy fields (refresh_*, etc.)
    result.data = result.data.map(row =>
      applyFieldset(row, fields, { defaults: DEFAULTS.TOPIC_LIST, always: ['id'] })
    );

    return res.json(result);
  } catch (err) {
    console.error('Error listing topics:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list topics' } });
  }
});

// GET /topics/by-slug/:slug/:lang — get topic by slug + lang
router.get('/topics/by-slug/:slug/:lang', auth.authenticateOptional, async (req, res) => {
  try {
    const { slug, lang } = req.params;

    if (!VALID_LANGS.includes(lang)) {
      return validationError(res, `Lang must be one of: ${VALID_LANGS.join(', ')}`);
    }

    const topic = await topicService.getTopicBySlug(slug, lang);
    if (!topic) return notFoundError(res, 'Topic not found');

    const { page, limit } = parsePagination(req.query);
    const chunksResult = await chunkService.getChunksWithSourcesByTopic(topic.id, {
      page, limit: Math.min(limit, 50),
    });
    topic.chunks = chunksResult.data;
    topic.chunks_pagination = chunksResult.pagination;

    return res.json(topic);
  } catch (err) {
    console.error('Error getting topic by slug:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get topic' } });
  }
});

// GET /topics/:id — get topic by ID or slug (includes chunks with sources, paginated)
const UUID_RE_TOPIC = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.get('/topics/:id', auth.authenticateOptional, async (req, res) => {
  try {
    let topic;
    if (UUID_RE_TOPIC.test(req.params.id)) {
      topic = await topicService.getTopicById(req.params.id);
    } else {
      // Fallback: treat as slug (default lang=en)
      topic = await topicService.getTopicBySlug(req.params.id, req.query.lang || 'en');
    }
    if (!topic) return notFoundError(res, 'Topic not found');

    const { page, limit } = parsePagination(req.query);
    const chunksResult = await chunkService.getChunksWithSourcesByTopic(req.params.id, {
      page, limit: Math.min(limit, 50),
    });
    topic.chunks = chunksResult.data;
    topic.chunks_pagination = chunksResult.pagination;

    // Attach weighted vote counts (and viewer's own vote) to each chunk
    const chunkIds = (topic.chunks || []).map(c => c.id).filter(Boolean);
    if (chunkIds.length > 0) {
      const pool = getPool();
      const [voteSummary, viewerVotes] = await Promise.all([
        pool.query(
          `SELECT target_id,
             COALESCE(SUM(weight) FILTER (WHERE value = 'up'), 0)::float AS up_weight,
             COALESCE(SUM(weight) FILTER (WHERE value = 'down'), 0)::float AS down_weight
           FROM votes
           WHERE target_type = 'chunk' AND target_id = ANY($1)
           GROUP BY target_id`,
          [chunkIds]
        ),
        req.account
          ? pool.query(
              'SELECT target_id, value FROM votes WHERE account_id = $1 AND target_type = $2 AND target_id = ANY($3)',
              [req.account.id, 'chunk', chunkIds]
            )
          : { rows: [] },
      ]);

      const summaryMap = {};
      for (const r of voteSummary.rows) {
        summaryMap[r.target_id] = { votes_up: Math.round(r.up_weight), votes_down: Math.round(r.down_weight) };
      }
      const viewerMap = {};
      for (const r of viewerVotes.rows) {
        viewerMap[r.target_id] = r.value;
      }

      for (const chunk of topic.chunks) {
        const s = summaryMap[chunk.id] || { votes_up: 0, votes_down: 0 };
        chunk.votes_up = s.votes_up;
        chunk.votes_down = s.votes_down;
        if (req.account) chunk.my_vote = viewerMap[chunk.id] || null;
      }
    }

    return res.json(topic);
  } catch (err) {
    console.error('Error getting topic:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get topic' } });
  }
});

// PUT /topics/:id — update topic (creator for all fields, curator for category only)
router.put(
  '/topics/:id',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { title, summary, sensitivity, topicType, category } = req.body;

      const existing = await topicService.getTopicById(req.params.id);
      if (!existing) return notFoundError(res, 'Topic not found');

      const isCreator = existing.created_by === req.account.id;
      const isCurator = req.account.badgeContribution && req.account.tier >= 1;

      // Non-creator curators can only change category
      if (!isCreator) {
        if (!isCurator) {
          return forbiddenError(res, 'Only the creator can update this topic. Curators (contribution badge, tier 1+) can recategorize.');
        }
        if (title !== undefined || summary !== undefined || sensitivity !== undefined || topicType !== undefined) {
          return forbiddenError(res, 'Curators can only change the category of topics they did not create');
        }
        if (!category) {
          return validationError(res, 'No update fields provided. As a curator, you can change the category.');
        }
      }

      if (title !== undefined && (typeof title !== 'string' || title.length < 3 || title.length > 300)) {
        return validationError(res, 'Title must be between 3 and 300 characters');
      }
      if (summary !== undefined && summary !== null && summary.length > 800) {
        return validationError(res, 'Summary must not exceed 1000 characters');
      }
      if (sensitivity && !VALID_SENSITIVITIES.includes(sensitivity)) {
        return validationError(res, `Sensitivity must be one of: ${VALID_SENSITIVITIES.join(', ')}`);
      }
      if (topicType && !VALID_TOPIC_TYPES.includes(topicType)) {
        return validationError(res, `topicType must be one of: ${VALID_TOPIC_TYPES.join(', ')}`);
      }
      if (category && !VALID_CATEGORIES.includes(category)) {
        return validationError(res, `category must be one of: ${VALID_CATEGORIES.join(', ')}`);
      }

      const oldCategory = existing.category;
      const topic = await topicService.updateTopic(req.params.id, { title, summary, sensitivity, topicType, category });

      // Log category change in activity_log (for audit + reputation tracking)
      if (category && category !== oldCategory) {
        getPool().query(
          `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
           VALUES ($1, 'category_changed', 'topic', $2, $3)`,
          [req.account.id, req.params.id, JSON.stringify({
            old_category: oldCategory,
            new_category: category,
            changed_by_creator: isCreator,
          })]
        ).catch(err => console.error('Category change log failed:', err.message));
      }

      return res.json(topic);
    } catch (err) {
      console.error('Error updating topic:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update topic' } });
    }
  }
);

// PUT /topics/:id/flag — flag topic content
router.put(
  '/topics/:id/flag',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active'),
  async (req, res) => {
    try {
      const { contentFlag, reason } = req.body;

      if (!contentFlag || !VALID_FLAGS.includes(contentFlag)) {
        return validationError(res, `contentFlag must be one of: ${VALID_FLAGS.join(', ')}`);
      }
      if (!reason || typeof reason !== 'string' || reason.length < 1) {
        return validationError(res, 'Reason is required');
      }

      const existing = await topicService.getTopicById(req.params.id);
      if (!existing) return notFoundError(res, 'Topic not found');

      const topic = await topicService.flagTopic(req.params.id, {
        contentFlag,
        reason,
        flaggedBy: req.account.id,
      });

      return res.json(topic);
    } catch (err) {
      console.error('Error flagging topic:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to flag topic' } });
    }
  }
);

// GET /topics/:id/translations — list translations
router.get('/topics/:id/translations', auth.authenticateOptional, async (req, res) => {
  try {
    const existing = await topicService.getTopicById(req.params.id);
    if (!existing) return notFoundError(res, 'Topic not found');

    const translations = await topicService.getTranslations(req.params.id);
    return res.json(translations);
  } catch (err) {
    console.error('Error getting translations:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get translations' } });
  }
});

// POST /topics/:id/translations — link translation
router.post(
  '/topics/:id/translations',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active'),
  async (req, res) => {
    try {
      const { translatedId } = req.body;

      if (!translatedId) {
        return validationError(res, 'translatedId is required');
      }

      const source = await topicService.getTopicById(req.params.id);
      if (!source) return notFoundError(res, 'Source topic not found');

      const target = await topicService.getTopicById(translatedId);
      if (!target) return notFoundError(res, 'Target topic not found');

      if (source.lang === target.lang) {
        return res.status(409).json({
          error: { code: 'CONFLICT', message: 'Cannot link topics with the same language' },
        });
      }

      await topicService.linkTranslation(req.params.id, translatedId);

      return res.status(201).json({ message: 'Translation linked' });
    } catch (err) {
      console.error('Error linking translation:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to link translation' } });
    }
  }
);

// --- Chunk routes (nested under topics + standalone) ---

// POST /topics/:id/chunks — add chunk to topic
router.post(
  '/topics/:id/chunks',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active', 'provisional'),
  async (req, res) => {
    try {
      const { content, technicalDetail, adhp, title, subtitle } = req.body;

      if (!content || typeof content !== 'string' || content.length < 10 || content.length > 5000) {
        return validationError(res, 'Content must be between 10 and 5000 characters');
      }
      if (technicalDetail !== undefined && technicalDetail !== null && technicalDetail.length > 10000) {
        return validationError(res, 'Technical detail must not exceed 10000 characters');
      }
      // Validate ADHP profile if provided
      if (adhp !== undefined && adhp !== null) {
        if (typeof adhp !== 'object' || Array.isArray(adhp)) {
          return validationError(res, 'adhp must be a JSON object');
        }
        if (!adhp.version || typeof adhp.version !== 'string') {
          return validationError(res, 'adhp.version is required and must be a string');
        }
      }

      // QuarantineValidator backpressure check
      const bpChunk = await checkBackpressure();
      if (bpChunk.blocked) {
        return res.status(503).json({
          error: { code: 'SERVICE_UNAVAILABLE', message: bpChunk.error },
          retry_after: bpChunk.retryAfter,
        });
      }

      const topic = await topicService.getTopicById(req.params.id);
      if (!topic) return notFoundError(res, 'Topic not found');

      const chunk = await chunkService.createChunk({
        content,
        technicalDetail,
        title: title || null,
        subtitle: subtitle || null,
        topicId: req.params.id,
        createdBy: req.account.id,
        isElite: req.account.badgeElite,
        hasBadgeContribution: req.account.badgeContribution,
        adhp: adhp || null,
      });

      return res.status(201).json(chunk);
    } catch (err) {
      if (err.code === 'DUPLICATE_CONTENT') {
        return res.status(409).json({
          error: { code: 'DUPLICATE_CONTENT', message: err.message, existingChunkId: err.existingChunkId },
        });
      }
      if (err.code === 'TOPIC_CHUNK_LIMIT') {
        return res.status(409).json({
          error: { code: 'TOPIC_CHUNK_LIMIT', message: err.message },
        });
      }
      console.error('Error creating chunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create chunk' } });
    }
  }
);

// GET /chunks/:id — get chunk by ID
router.get('/chunks/:id', auth.authenticateOptional, async (req, res) => {
  try {
    // Validate UUID shape BEFORE hitting the service. Observed crash:
    // agent requested /chunks/review-queue (path guess), service sent the
    // string to PG, pg_uuid cast threw and bubbled up as 500.
    if (!UUID_RE.test(req.params.id)) {
      return notFoundError(res, 'Chunk id must be a UUID.', {
        did_you_mean: '/v1/topics/:topicId/chunks',
        hint: 'To find chunks, list them under a topic with GET /v1/topics/{topicId}/chunks. To look up a specific chunk, use its UUID from that listing. If lost, start from /llms.txt.',
      });
    }
    const chunk = await chunkService.getChunkById(req.params.id);
    if (!chunk) return notFoundError(res, 'Chunk not found');

    // Strip embedding vector from public response (large, internal-only)
    delete chunk.embedding;
    return res.json(chunk);
  } catch (err) {
    console.error('Error getting chunk:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get chunk' } });
  }
});

// PUT /chunks/:id — update chunk (creator only)
router.put(
  '/chunks/:id',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { content, technicalDetail } = req.body;

      const existing = await chunkService.getChunkById(req.params.id);
      if (!existing) return notFoundError(res, 'Chunk not found');
      if (existing.created_by !== req.account.id) {
        return forbiddenError(res, 'Only the creator can update this chunk');
      }

      if (content !== undefined && (typeof content !== 'string' || content.length < 10 || content.length > 5000)) {
        return validationError(res, 'Content must be between 10 and 5000 characters');
      }
      if (technicalDetail !== undefined && technicalDetail !== null && technicalDetail.length > 10000) {
        return validationError(res, 'Technical detail must not exceed 10000 characters');
      }

      const chunk = await chunkService.updateChunk(req.params.id, { content, technicalDetail });
      return res.json(chunk);
    } catch (err) {
      console.error('Error updating chunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update chunk' } });
    }
  }
);

// PUT /chunks/:id/retract — DEPRECATED: use PUT /changesets/:id/retract
router.put(
  '/chunks/:id/retract',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      console.warn('DEPRECATED: PUT /chunks/:id/retract — use PUT /changesets/:id/retract instead');

      // Look up the changeset for this chunk
      const { rows } = await getPool().query(
        'SELECT changeset_id FROM changeset_operations WHERE chunk_id = $1 LIMIT 1',
        [req.params.id]
      );

      if (rows.length > 0) {
        const changesetService = require('../services/changeset');
        const changeset = await changesetService.retractChangeset(rows[0].changeset_id, req.account.id);
        return res.json(changeset);
      }

      // Fallback: no changeset found, use legacy path
      const existing = await chunkService.getChunkById(req.params.id);
      if (!existing) return notFoundError(res, 'Chunk not found');
      if (existing.created_by !== req.account.id) {
        return forbiddenError(res, 'Only the creator can retract this chunk');
      }

      const chunk = await chunkService.retractChunk(req.params.id, { reason: 'withdrawn', retractedBy: req.account.id });
      return res.json(chunk);
    } catch (err) {
      if (err.code === 'FORBIDDEN') return forbiddenError(res, err.message);
      if (err.name === 'LifecycleError' || err.code === 'INVALID_TRANSITION') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error retracting chunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to retract chunk' } });
    }
  }
);

// POST /chunks/:id/escalate — DEPRECATED: use POST /changesets/:id/escalate
router.post(
  '/chunks/:id/escalate',
  auth.authenticateRequired, authenticatedLimiter,
  requireTier(1),
  async (req, res) => {
    try {
      console.warn('DEPRECATED: POST /chunks/:id/escalate — use POST /changesets/:id/escalate instead');

      // Look up the changeset for this chunk
      const { rows } = await getPool().query(
        'SELECT changeset_id FROM changeset_operations WHERE chunk_id = $1 LIMIT 1',
        [req.params.id]
      );

      if (rows.length > 0) {
        const changesetService = require('../services/changeset');
        const changeset = await changesetService.escalateToReview(rows[0].changeset_id, req.account.id);
        return res.json(changeset);
      }

      // Fallback: no changeset found, use legacy path
      const chunk = await chunkService.escalateToReview(req.params.id, req.account.id);
      return res.json(chunk);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.name === 'LifecycleError' || err.code === 'INVALID_TRANSITION') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error escalating chunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to escalate chunk' } });
    }
  }
);

// POST /chunks/:id/object — file objection against a proposed chunk (Tier 1+)
router.post(
  '/chunks/:id/object',
  auth.authenticateRequired, authenticatedLimiter,
  requireTier(1),
  async (req, res) => {
    const { reason } = req.body || {};

    if (!reason || !OBJECTION_REASON_TAGS.includes(reason)) {
      return validationError(res, `Reason must be one of: ${OBJECTION_REASON_TAGS.join(', ')}`);
    }

    try {
      const chunk = await chunkService.escalateToReview(req.params.id, req.account.id);

      // Log the objection with reason metadata
      await getPool().query(
        `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
         VALUES ($1, 'chunk_objected', 'chunk', $2, $3)`,
        [req.account.id, req.params.id, JSON.stringify({ reason })]
      );

      return res.json(chunk);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.name === 'LifecycleError') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error objecting to chunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to file objection' } });
    }
  }
);

// POST /chunks/:id/resubmit — DEPRECATED: use PUT /changesets/:id/resubmit
router.post(
  '/chunks/:id/resubmit',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      console.warn('DEPRECATED: POST /chunks/:id/resubmit — use PUT /changesets/:id/resubmit instead');

      // Look up the changeset for this chunk
      const { rows } = await getPool().query(
        'SELECT changeset_id FROM changeset_operations WHERE chunk_id = $1 LIMIT 1',
        [req.params.id]
      );

      if (rows.length > 0) {
        const changesetService = require('../services/changeset');
        const changeset = await changesetService.resubmitChangeset(rows[0].changeset_id, req.account.id);
        return res.json(changeset);
      }

      // Fallback: no changeset found, use legacy path
      const existing = await chunkService.getChunkById(req.params.id);
      if (!existing) return notFoundError(res, 'Chunk not found');
      if (existing.created_by !== req.account.id) {
        return forbiddenError(res, 'Only the creator can resubmit this chunk');
      }

      const chunk = await chunkService.resubmitChunk(req.params.id, req.account.id);
      return res.json(chunk);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.code === 'FORBIDDEN') return forbiddenError(res, err.message);
      if (err.name === 'LifecycleError' || err.code === 'INVALID_TRANSITION') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error resubmitting chunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to resubmit chunk' } });
    }
  }
);

// POST /chunks/:id/sources — add source to chunk
router.post(
  '/chunks/:id/sources',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active', 'provisional'),
  async (req, res) => {
    try {
      const { sourceUrl, sourceDescription } = req.body;

      if (!sourceUrl && !sourceDescription) {
        return validationError(res, 'At least one of sourceUrl or sourceDescription is required');
      }

      const existing = await chunkService.getChunkById(req.params.id);
      if (!existing) return notFoundError(res, 'Chunk not found');

      const source = await chunkService.addSource(req.params.id, {
        sourceUrl,
        sourceDescription,
        addedBy: req.account.id,
      });

      return res.status(201).json(source);
    } catch (err) {
      console.error('Error adding source:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to add source' } });
    }
  }
);

// --- Editorial model routes ---

// GET /topics/:id/history — version history for a topic
router.get('/topics/:id/history', auth.authenticateOptional, async (req, res) => {
  try {
    const existing = await topicService.getTopicById(req.params.id);
    if (!existing) return notFoundError(res, 'Topic not found');

    const { page, limit } = parsePagination(req.query);
    const result = await chunkService.getTopicHistory(req.params.id, { page, limit });
    return res.json(result);
  } catch (err) {
    console.error('Error getting topic history:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get topic history' } });
  }
});

// POST /chunks/:id/propose-edit — propose edit to existing chunk
router.post(
  '/chunks/:id/propose-edit',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active', 'provisional'),
  async (req, res) => {
    try {
      const { content, technicalDetail, title, subtitle } = req.body;

      if (!content || typeof content !== 'string' || content.length < 10 || content.length > 5000) {
        return validationError(res, 'Content must be between 10 and 5000 characters');
      }
      if (title != null && (typeof title !== 'string' || title.length > 200)) {
        return validationError(res, 'title must be a string of at most 200 characters');
      }
      if (subtitle != null && (typeof subtitle !== 'string' || subtitle.length > 300)) {
        return validationError(res, 'subtitle must be a string of at most 300 characters');
      }

      const existing = await chunkService.getChunkById(req.params.id);
      if (!existing) return notFoundError(res, 'Chunk not found');
      if (existing.status !== 'published') {
        return validationError(res, 'Can only propose edits to published chunks');
      }

      // Find the topic for this chunk
      const pool = require('../config/database').getPool();
      const { rows: ctRows } = await pool.query(
        'SELECT topic_id FROM chunk_topics WHERE chunk_id = $1 LIMIT 1',
        [req.params.id]
      );
      const topicId = ctRows.length > 0 ? ctRows[0].topic_id : null;

      // Elite + low-sensitivity topic → auto-merge
      if (req.account.badgeElite && topicId) {
        const topic = await topicService.getTopicById(topicId);
        if (topic && topic.sensitivity === 'standard') {
          // Auto-merge: create proposed then merge immediately
          const proposed = await chunkService.proposeEdit({
            originalChunkId: req.params.id,
            content,
            technicalDetail,
            title,
            subtitle,
            proposedBy: req.account.id,
            topicId,
            isElite: req.account.badgeElite,
          });
          const merged = await chunkService.mergeChunk(proposed.id, req.account.id);
          return res.status(201).json(merged);
        }
      }

      const proposed = await chunkService.proposeEdit({
        originalChunkId: req.params.id,
        content,
        technicalDetail,
        title,
        subtitle,
        proposedBy: req.account.id,
        topicId,
        isElite: req.account.badgeElite,
      });

      return res.status(201).json(proposed);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      console.error('Error proposing edit:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to propose edit' } });
    }
  }
);

// PUT /chunks/:id/merge — DEPRECATED: use PUT /changesets/:id/merge
router.put(
  '/chunks/:id/merge',
  auth.authenticateRequired, authenticatedLimiter,
  requireTier(1), requireBadge('policing'),
  async (req, res) => {
    try {
      console.warn('DEPRECATED: PUT /chunks/:id/merge — use PUT /changesets/:id/merge instead');

      // Look up the changeset for this chunk
      const { rows } = await getPool().query(
        'SELECT changeset_id FROM changeset_operations WHERE chunk_id = $1 LIMIT 1',
        [req.params.id]
      );

      if (rows.length > 0) {
        const changesetService = require('../services/changeset');
        const merged = await changesetService.mergeChangeset(rows[0].changeset_id, req.account.id);
        return res.json(merged);
      }

      // Fallback: no changeset found, use legacy path
      const merged = await chunkService.mergeChunk(req.params.id, req.account.id);
      return res.json(merged);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.name === 'LifecycleError' || err.code === 'INVALID_TRANSITION') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error merging chunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to merge chunk' } });
    }
  }
);

// PUT /chunks/:id/reject — DEPRECATED: use PUT /changesets/:id/reject
router.put(
  '/chunks/:id/reject',
  auth.authenticateRequired, authenticatedLimiter,
  requireTier(1), requireBadge('policing'),
  async (req, res) => {
    try {
      console.warn('DEPRECATED: PUT /chunks/:id/reject — use PUT /changesets/:id/reject instead');

      const { reason, report, category, suggestions } = req.body || {};
      if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        return validationError(res, 'reason is required');
      }
      if (!category || !REJECTION_CATEGORIES.includes(category)) {
        return validationError(res, `category is required and must be one of: ${REJECTION_CATEGORIES.join(', ')}`);
      }
      if (suggestions !== undefined && suggestions !== null) {
        if (typeof suggestions !== 'string') {
          return validationError(res, 'suggestions must be a string');
        }
        if (suggestions.length > REJECTION_SUGGESTIONS_MAX_LENGTH) {
          return validationError(res, `suggestions must be at most ${REJECTION_SUGGESTIONS_MAX_LENGTH} characters`);
        }
      }

      // Look up the changeset for this chunk
      const { rows } = await getPool().query(
        'SELECT changeset_id FROM changeset_operations WHERE chunk_id = $1 LIMIT 1',
        [req.params.id]
      );

      if (rows.length > 0) {
        const changesetService = require('../services/changeset');
        const rejected = await changesetService.rejectChangeset(rows[0].changeset_id, {
          reason: reason.trim(),
          category: category || null,
          suggestions: suggestions ? suggestions.trim() : null,
          rejectedBy: req.account.id,
        });
        return res.json(rejected);
      }

      // Fallback: no changeset found, use legacy path
      const rejected = await chunkService.rejectChunk(req.params.id, {
        reason: reason.trim(),
        report: !!report,
        rejectedBy: req.account.id,
        category,
        suggestions: suggestions ? suggestions.trim() : null,
      });
      return res.json(rejected);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.name === 'LifecycleError' || err.code === 'INVALID_TRANSITION') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error rejecting chunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reject chunk' } });
    }
  }
);

// POST /chunks/:id/propose-revert — propose reverting to a previous version
router.post(
  '/chunks/:id/propose-revert',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active', 'provisional'),
  async (req, res) => {
    try {
      const { targetVersion, reason } = req.body;

      if (!targetVersion || typeof targetVersion !== 'number' || targetVersion < 1) {
        return validationError(res, 'targetVersion must be a positive integer');
      }

      const existing = await chunkService.getChunkById(req.params.id);
      if (!existing) return notFoundError(res, 'Chunk not found');

      // Find topic
      const pool = require('../config/database').getPool();
      const { rows: ctRows } = await pool.query(
        'SELECT topic_id FROM chunk_topics WHERE chunk_id = $1 LIMIT 1',
        [req.params.id]
      );
      const topicId = ctRows.length > 0 ? ctRows[0].topic_id : null;

      const proposed = await chunkService.proposeRevert({
        chunkId: req.params.id,
        targetVersion,
        reason,
        proposedBy: req.account.id,
        topicId,
      });

      // Policing badge holders can revert immediately
      if (req.account.badgePolicing) {
        const merged = await chunkService.mergeChunk(proposed.id, req.account.id);
        return res.status(201).json(merged);
      }

      return res.status(201).json(proposed);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      console.error('Error proposing revert:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to propose revert' } });
    }
  }
);

// GET /reviews/proposed — list pending proposals (policing badge required)
router.get(
  '/reviews/proposed',
  auth.authenticateRequired,
  requireBadge('policing'),
  async (req, res) => {
    try {
      const { page, limit } = parsePagination(req.query);
      const result = await chunkService.listPendingProposals({ page, limit });
      if (result.pagination) result.pagination = enrichPagination(result.pagination, req);
      return res.json(result);
    } catch (err) {
      console.error('Error listing pending proposals:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list proposals' } });
    }
  }
);

// GET /topics/:id/chunks — list chunks by status (for formal vote UI)
const VALID_CHUNK_STATUSES = ['proposed', 'under_review', 'published', 'disputed', 'retracted', 'superseded'];

router.get('/topics/:id/chunks', publicLimiter, async (req, res) => {
  try {
    const status = req.query.status;
    if (status && !VALID_CHUNK_STATUSES.includes(status)) {
      return validationError(res, 'Invalid status. Must be one of: ' + VALID_CHUNK_STATUSES.join(', '));
    }

    const { page, limit } = parsePagination(req.query);
    const result = await chunkService.getChunksByTopic(req.params.id, {
      status: status || 'published',
      page,
      limit: Math.min(limit, 50),
    });

    return res.json(result);
  } catch (err) {
    console.error('Error listing topic chunks:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list chunks' } });
  }
});

// GET /topics/:id/related — related topics via embedding similarity
const relatedService = require('../services/related');

router.get('/topics/:id/related', publicLimiter, async (req, res) => {
  try {
    const data = await relatedService.getRelatedTopics(req.params.id);
    return res.json({ data });
  } catch (err) {
    console.error('Error fetching related topics:', err.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch related topics' } });
  }
});

// GET /chunks/:id/related — related chunks from other topics
router.get('/chunks/:id/related', publicLimiter, async (req, res) => {
  try {
    const data = await relatedService.relatedChunks(req.params.id, relatedService.RELATED_LIMIT);
    return res.json({
      data: data.map(r => ({
        chunkId: r.chunk_id,
        content: (r.content || '').slice(0, 300),
        chunkTitle: r.chunk_title,
        topicId: r.topic_id,
        topicTitle: r.topic_title,
        topicSlug: r.topic_slug,
        similarity: parseFloat(r.similarity),
      })),
    });
  } catch (err) {
    console.error('Error fetching related chunks:', err.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch related chunks' } });
  }
});

// POST /topic-requests — request a new topic (lightweight, stored in activity_log)
router.post(
  '/topic-requests',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { title } = req.body;
      if (!title || typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 300) {
        return validationError(res, 'Title must be between 3 and 300 characters');
      }

      const pool = require('../config/database').getPool();
      const { rows } = await pool.query(
        `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
         VALUES ($1, 'topic_requested', 'topic', $1, $2)
         RETURNING id, created_at`,
        [req.account.id, JSON.stringify({ title: title.trim() })]
      );

      return res.status(201).json({ data: { id: rows[0].id, title: title.trim(), createdAt: rows[0].created_at } });
    } catch (err) {
      console.error('Error creating topic request:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create topic request' } });
    }
  }
);

// --- QuarantineValidator endpoints (instance admin only) ---
// Health and ops surface for the instance operator. Not exposed to community
// moderators (policing badge) -- the validator queue is internal and they
// can't act on it. Their work is the human review queue, which is separate.

/**
 * GET /quarantine-validator/health
 * Returns the operational health of the QuarantineValidator subsystem.
 * status: 'ok' | 'warning' | 'critical'
 *  - critical: validator not configured (no API key)
 *  - warning: configured but degraded (circuit breaker open, daily budget
 *    exhausted, or queue more than 50% full)
 *  - ok: configured and healthy
 */
router.get(
  '/quarantine-validator/health',
  auth.authenticateRequired,
  requireInstanceAdmin,
  async (_req, res) => {
    try {
      const stats = await getQuarantineQueueStats();
      const issues = [];

      if (!stats.configured) {
        issues.push({
          code: 'not_configured',
          severity: 'critical',
          message: 'QUARANTINE_VALIDATOR_API_KEY not set. User content is not sandboxed.',
        });
      } else {
        if (stats.circuitBreakerOpen) {
          issues.push({
            code: 'circuit_breaker_open',
            severity: 'warning',
            message: 'Circuit breaker open. Submissions are temporarily blocked.',
          });
        }
        if (stats.dailyTokensUsed >= stats.dailyTokensBudget) {
          issues.push({
            code: 'budget_exhausted',
            severity: 'warning',
            message: 'Daily token budget exhausted. Validator paused until tomorrow.',
          });
        }
        const pendingCount = parseInt(stats.queue.pending, 10);
        // Re-import the threshold from env (default 100, default warning at 50%)
        const maxQueue = parseInt(process.env.QUARANTINE_VALIDATOR_MAX_QUEUE_SIZE || '100', 10);
        if (pendingCount > maxQueue / 2) {
          issues.push({
            code: 'queue_filling',
            severity: 'warning',
            message: `Queue is ${Math.round((pendingCount / maxQueue) * 100)}% full (${pendingCount}/${maxQueue}). Submissions may be rate-limited soon.`,
          });
        }
      }

      const hasCritical = issues.some(i => i.severity === 'critical');
      const hasWarning = issues.some(i => i.severity === 'warning');
      const status = hasCritical ? 'critical' : hasWarning ? 'warning' : 'ok';

      return res.json({
        data: {
          status,
          issues,
          stats: {
            configured: stats.configured,
            circuitBreakerOpen: stats.circuitBreakerOpen,
            dailyTokensUsed: stats.dailyTokensUsed,
            dailyTokensBudget: stats.dailyTokensBudget,
            queue: stats.queue,
          },
        },
      });
    } catch (err) {
      console.error('QuarantineValidator health error:', err.message);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get quarantine validator health' } });
    }
  }
);

/**
 * POST /quarantine-validator/reset-circuit-breaker
 * Manual circuit breaker reset by the instance admin.
 */
router.post(
  '/quarantine-validator/reset-circuit-breaker',
  auth.authenticateRequired,
  requireInstanceAdmin,
  async (_req, res) => {
    try {
      resetCircuitBreaker();
      return res.json({ message: 'Circuit breaker reset' });
    } catch (err) {
      console.error('QuarantineValidator reset error:', err.message);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reset circuit breaker' } });
    }
  }
);

module.exports = router;
