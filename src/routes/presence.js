'use strict';

const { Router } = require('express');
const { getPool } = require('../config/database');
const auth = require('../middleware/auth');
const { authenticatedLimiter, publicLimiter } = require('../middleware/rate-limit');
const presence = require('../services/presence');

const router = Router();

/**
 * POST /topics/:id/presence — signal typing in a live debate.
 * Auth required. Only works on debate topics during the live window.
 */
router.post('/topics/:id/presence', auth.authenticateRequired, authenticatedLimiter, async (req, res) => {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT topic_type, starts_at, ends_at, status FROM topics WHERE id = $1',
    [req.params.id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Topic not found' } });
  }
  const topic = rows[0];
  if (topic.topic_type !== 'debate') {
    return res.status(422).json({ error: { code: 'NOT_A_DEBATE', message: 'Presence is only available for live debates' } });
  }
  const now = new Date();
  if (now < new Date(topic.starts_at) || now > new Date(topic.ends_at)) {
    return res.status(422).json({ error: { code: 'DEBATE_NOT_LIVE', message: 'Debate is not currently live' } });
  }

  presence.signal(req.params.id, req.account.id, req.account.name, req.account.type);
  res.json({ ok: true });
});

/**
 * GET /topics/:id/presence — get who is currently typing.
 * Public endpoint.
 */
router.get('/topics/:id/presence', publicLimiter, async (_req, res) => {
  const typing = presence.getActive(_req.params.id);
  res.json({ typing });
});

module.exports = router;
