/**
 * Topics & Chunks routes.
 */

const { Router } = require('express');
const topicService = require('../services/topic');
const chunkService = require('../services/chunk');

const auth = require('../middleware/auth');

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
  auth.authenticateRequired,
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

    return res.json(topic);
  } catch (err) {
    console.error('Error getting topic by slug:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get topic' } });
  }
});

// GET /topics/:id — get topic by ID
router.get('/topics/:id', auth.authenticateOptional, async (req, res) => {
  try {
    const topic = await topicService.getTopicById(req.params.id);
    if (!topic) return notFoundError(res, 'Topic not found');

    return res.json(topic);
  } catch (err) {
    console.error('Error getting topic:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get topic' } });
  }
});

// PUT /topics/:id — update topic (creator only)
router.put(
  '/topics/:id',
  auth.authenticateRequired,
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
  auth.authenticateRequired,
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
  auth.authenticateRequired,
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
  auth.authenticateRequired,
  auth.requireStatus('active', 'provisional'),
  async (req, res) => {
    try {
      const { content, technicalDetail } = req.body;

      if (!content || typeof content !== 'string' || content.length < 10 || content.length > 5000) {
        return validationError(res, 'Content must be between 10 and 5000 characters');
      }
      if (technicalDetail !== undefined && technicalDetail !== null && technicalDetail.length > 10000) {
        return validationError(res, 'Technical detail must not exceed 10000 characters');
      }

      const topic = await topicService.getTopicById(req.params.id);
      if (!topic) return notFoundError(res, 'Topic not found');

      const chunk = await chunkService.createChunk({
        content,
        technicalDetail,
        topicId: req.params.id,
        createdBy: req.account.id,
      });

      return res.status(201).json(chunk);
    } catch (err) {
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
  auth.authenticateRequired,
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
  auth.authenticateRequired,
  async (req, res) => {
    try {
      const existing = await chunkService.getChunkById(req.params.id);
      if (!existing) return notFoundError(res, 'Chunk not found');
      if (existing.created_by !== req.account.id) {
        return forbiddenError(res, 'Only the creator can retract this chunk');
      }

      const chunk = await chunkService.retractChunk(req.params.id);
      return res.json(chunk);
    } catch (err) {
      console.error('Error retracting chunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to retract chunk' } });
    }
  }
);

// POST /chunks/:id/sources — add source to chunk
router.post(
  '/chunks/:id/sources',
  auth.authenticateRequired,
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

module.exports = router;
