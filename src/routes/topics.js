/**
 * Topics & Chunks routes.
 */

const { Router } = require('express');
const topicService = require('../services/topic');
const chunkService = require('../services/chunk');

const auth = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');
const { requireBadge } = require('../middleware/badge');
const { requireTier } = require('../middleware/tier-gate');
const accountService = require('../services/account');

const router = Router();

// --- Validation helpers ---

const VALID_LANGS = [
  'en', 'fr', 'zh', 'hi', 'es', 'ar', 'ja', 'de', 'pt', 'ru', 'ko', 'it', 'nl', 'pl', 'sv', 'tr',
];

const VALID_SENSITIVITIES = ['low', 'high'];
const VALID_STATUSES = ['active', 'locked', 'archived'];
const VALID_FLAGS = ['spam', 'poisoning', 'hallucination', 'review_needed'];

function validationError(res, message) {
  return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message } });
}

function notFoundError(res, message) {
  return res.status(404).json({ error: { code: 'NOT_FOUND', message } });
}

function forbiddenError(res, message) {
  return res.status(403).json({ error: { code: 'FORBIDDEN', message } });
}

function parsePagination(query) {
  let page = parseInt(query.page, 10) || 1;
  let limit = parseInt(query.limit, 10) || 20;
  if (page < 1) page = 1;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;
  return { page, limit };
}

// --- Topic routes ---

// POST /topics — create topic
router.post(
  '/topics',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active', 'provisional'),
  async (req, res) => {
    try {
      const { title, lang, summary, sensitivity } = req.body;

      if (!title || typeof title !== 'string' || title.length < 3 || title.length > 300) {
        return validationError(res, 'Title must be between 3 and 300 characters');
      }
      if (!lang || !VALID_LANGS.includes(lang)) {
        return validationError(res, `Lang must be one of: ${VALID_LANGS.join(', ')}`);
      }
      if (summary && summary.length > 1000) {
        return validationError(res, 'Summary must not exceed 1000 characters');
      }
      if (sensitivity && !VALID_SENSITIVITIES.includes(sensitivity)) {
        return validationError(res, `Sensitivity must be one of: ${VALID_SENSITIVITIES.join(', ')}`);
      }

      const topic = await topicService.createTopic({
        title,
        lang,
        summary,
        sensitivity,
        createdBy: req.account.id,
      });

      return res.status(201).json(topic);
    } catch (err) {
      console.error('Error creating topic:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create topic' } });
    }
  }
);

// GET /topics — list topics
router.get('/topics', auth.authenticateOptional, async (req, res) => {
  try {
    const { lang, sensitivity, status } = req.query;
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

    const result = await topicService.listTopics({ lang, status, sensitivity, page, limit });
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

    // Fetch chunks with sources for the topic detail view
    const chunksResult = await chunkService.getChunksByTopic(topic.id, { limit: 100 });
    const chunksWithSources = await Promise.all(
      chunksResult.data.map(c => chunkService.getChunkById(c.id))
    );
    topic.chunks = chunksWithSources.filter(Boolean);

    return res.json(topic);
  } catch (err) {
    console.error('Error getting topic by slug:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get topic' } });
  }
});

// GET /topics/:id — get topic by ID (includes chunks with sources)
router.get('/topics/:id', auth.authenticateOptional, async (req, res) => {
  try {
    const topic = await topicService.getTopicById(req.params.id);
    if (!topic) return notFoundError(res, 'Topic not found');

    // Fetch chunks with sources for the topic detail view
    const chunksResult = await chunkService.getChunksByTopic(req.params.id, { limit: 100 });
    const chunksWithSources = await Promise.all(
      chunksResult.data.map(c => chunkService.getChunkById(c.id))
    );
    topic.chunks = chunksWithSources.filter(Boolean);

    return res.json(topic);
  } catch (err) {
    console.error('Error getting topic:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get topic' } });
  }
});

// PUT /topics/:id — update topic (creator only)
router.put(
  '/topics/:id',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { title, summary, sensitivity } = req.body;

      // Check topic exists and caller is creator
      const existing = await topicService.getTopicById(req.params.id);
      if (!existing) return notFoundError(res, 'Topic not found');
      if (existing.created_by !== req.account.id) {
        return forbiddenError(res, 'Only the creator can update this topic');
      }

      if (title !== undefined && (typeof title !== 'string' || title.length < 3 || title.length > 300)) {
        return validationError(res, 'Title must be between 3 and 300 characters');
      }
      if (summary !== undefined && summary !== null && summary.length > 1000) {
        return validationError(res, 'Summary must not exceed 1000 characters');
      }
      if (sensitivity && !VALID_SENSITIVITIES.includes(sensitivity)) {
        return validationError(res, `Sensitivity must be one of: ${VALID_SENSITIVITIES.join(', ')}`);
      }

      const topic = await topicService.updateTopic(req.params.id, { title, summary, sensitivity });
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
      const { content, technicalDetail, adhp } = req.body;

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

      const topic = await topicService.getTopicById(req.params.id);
      if (!topic) return notFoundError(res, 'Topic not found');

      // Check badges for initial trust (Beta prior)
      const creator = await accountService.findById(req.account.id);
      const isElite = creator && creator.badge_elite;
      const hasBadgeContribution = creator && creator.badge_contribution;

      const chunk = await chunkService.createChunk({
        content,
        technicalDetail,
        topicId: req.params.id,
        createdBy: req.account.id,
        isElite,
        hasBadgeContribution,
        adhp: adhp || null,
      });

      return res.status(201).json(chunk);
    } catch (err) {
      if (err.code === 'DUPLICATE_CONTENT') {
        return res.status(409).json({
          error: { code: 'DUPLICATE_CONTENT', message: err.message, existingChunkId: err.existingChunkId },
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
    const chunk = await chunkService.getChunkById(req.params.id);
    if (!chunk) return notFoundError(res, 'Chunk not found');

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

// PUT /chunks/:id/retract — retract chunk (creator only)
router.put(
  '/chunks/:id/retract',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const existing = await chunkService.getChunkById(req.params.id);
      if (!existing) return notFoundError(res, 'Chunk not found');
      if (existing.created_by !== req.account.id) {
        return forbiddenError(res, 'Only the creator can retract this chunk');
      }

      const chunk = await chunkService.retractChunk(req.params.id, { reason: 'withdrawn', retractedBy: req.account.id });
      return res.json(chunk);
    } catch (err) {
      if (err.name === 'LifecycleError') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error retracting chunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to retract chunk' } });
    }
  }
);

// POST /chunks/:id/escalate — escalate proposed chunk to formal review (Tier 1+)
router.post(
  '/chunks/:id/escalate',
  auth.authenticateRequired, authenticatedLimiter,
  requireTier(1),
  async (req, res) => {
    try {
      const chunk = await chunkService.escalateToReview(req.params.id, req.account.id);
      return res.json(chunk);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.name === 'LifecycleError') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error escalating chunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to escalate chunk' } });
    }
  }
);

// POST /chunks/:id/resubmit — resubmit a retracted chunk (creator only)
router.post(
  '/chunks/:id/resubmit',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const existing = await chunkService.getChunkById(req.params.id);
      if (!existing) return notFoundError(res, 'Chunk not found');
      if (existing.created_by !== req.account.id) {
        return forbiddenError(res, 'Only the creator can resubmit this chunk');
      }

      const chunk = await chunkService.resubmitChunk(req.params.id, req.account.id);
      return res.json(chunk);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.name === 'LifecycleError') {
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
      const { content, technicalDetail } = req.body;

      if (!content || typeof content !== 'string' || content.length < 10 || content.length > 5000) {
        return validationError(res, 'Content must be between 10 and 5000 characters');
      }

      const existing = await chunkService.getChunkById(req.params.id);
      if (!existing) return notFoundError(res, 'Chunk not found');
      if (existing.status !== 'active') {
        return validationError(res, 'Can only propose edits to active chunks');
      }

      // Find the topic for this chunk
      const pool = require('../config/database').getPool();
      const { rows: ctRows } = await pool.query(
        'SELECT topic_id FROM chunk_topics WHERE chunk_id = $1 LIMIT 1',
        [req.params.id]
      );
      const topicId = ctRows.length > 0 ? ctRows[0].topic_id : null;

      const creator = await accountService.findById(req.account.id);
      const isElite = creator && creator.badge_elite;

      // Elite + low-sensitivity topic → auto-merge
      if (isElite && topicId) {
        const topic = await topicService.getTopicById(topicId);
        if (topic && topic.sensitivity === 'low') {
          // Auto-merge: create proposed then merge immediately
          const proposed = await chunkService.proposeEdit({
            originalChunkId: req.params.id,
            content,
            technicalDetail,
            proposedBy: req.account.id,
            topicId,
            isElite: true,
          });
          const merged = await chunkService.mergeChunk(proposed.id, req.account.id);
          return res.status(201).json(merged);
        }
      }

      const proposed = await chunkService.proposeEdit({
        originalChunkId: req.params.id,
        content,
        technicalDetail,
        proposedBy: req.account.id,
        topicId,
        isElite,
      });

      return res.status(201).json(proposed);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      console.error('Error proposing edit:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to propose edit' } });
    }
  }
);

// PUT /chunks/:id/merge — merge proposed chunk (Tier 1+ and policing badge required)
router.put(
  '/chunks/:id/merge',
  auth.authenticateRequired, authenticatedLimiter,
  requireTier(1), requireBadge('policing'),
  async (req, res) => {
    try {
      const merged = await chunkService.mergeChunk(req.params.id, req.account.id);
      return res.json(merged);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.name === 'LifecycleError') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error merging chunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to merge chunk' } });
    }
  }
);

// PUT /chunks/:id/reject — reject proposed chunk (Tier 1+ and policing badge required)
router.put(
  '/chunks/:id/reject',
  auth.authenticateRequired, authenticatedLimiter,
  requireTier(1), requireBadge('policing'),
  async (req, res) => {
    try {
      const { reason, report } = req.body || {};
      if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        return validationError(res, 'reason is required');
      }
      const rejected = await chunkService.rejectChunk(req.params.id, {
        reason: reason.trim(),
        report: !!report,
        rejectedBy: req.account.id,
      });
      return res.json(rejected);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.name === 'LifecycleError') {
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

      // Policing badge holders can revert immediately
      const creator = await accountService.findById(req.account.id);
      const hasPolicingBadge = creator && creator.badge_policing;

      const proposed = await chunkService.proposeRevert({
        chunkId: req.params.id,
        targetVersion,
        reason,
        proposedBy: req.account.id,
        topicId,
      });

      if (hasPolicingBadge) {
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
      const page = parseInt(req.query.page, 10) || 1;
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
      const result = await chunkService.listPendingProposals({ page, limit });
      return res.json(result);
    } catch (err) {
      console.error('Error listing pending proposals:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list proposals' } });
    }
  }
);

module.exports = router;
