/**
 * Vote routes — cast/remove votes, vote queries, reputation details.
 */

const { Router } = require('express');
const voteService = require('../services/vote');
const formalVoteService = require('../services/formal-vote');
const reputationService = require('../services/reputation');

const auth = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');
const { validationError, notFoundError, forbiddenError } = require('../utils/http-errors');
const { parsePagination } = require('../utils/pagination');

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Routes ---

// POST /votes — cast vote
router.post(
  '/votes',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { target_type, target_id, value, reason_tag } = req.body;

      // Validate target_type
      if (!target_type || !voteService.VALID_TARGET_TYPES.includes(target_type)) {
        return validationError(res, `target_type must be one of: ${voteService.VALID_TARGET_TYPES.join(', ')}`);
      }

      // Validate target_id
      if (!target_id || typeof target_id !== 'string' || !UUID_RE.test(target_id)) {
        return validationError(res, 'target_id must be a valid UUID');
      }

      // Validate value
      if (!value || !voteService.VALID_VALUES.includes(value)) {
        return validationError(res, `value must be one of: ${voteService.VALID_VALUES.join(', ')}`);
      }

      // Validate reason_tag if provided
      if (reason_tag !== undefined && reason_tag !== null) {
        if (!voteService.VALID_REASON_TAGS.includes(reason_tag)) {
          return validationError(res, `reason_tag must be one of: ${voteService.VALID_REASON_TAGS.join(', ')}`);
        }
      }

      const vote = await voteService.castVote({
        accountId: req.account.id,
        targetType: target_type,
        targetId: target_id,
        value,
        reasonTag: reason_tag || null,
      });

      return res.status(201).json(vote);
    } catch (err) {
      if (err.code === 'VOTE_LOCKED') {
        return res.status(403).json({ error: { code: 'VOTE_LOCKED', message: err.message } });
      }
      if (err.code === 'SELF_VOTE') {
        return res.status(403).json({ error: { code: 'SELF_VOTE', message: err.message } });
      }
      if (err.code === 'FORBIDDEN') {
        return forbiddenError(res, err.message);
      }
      if (err.code === 'VALIDATION_ERROR') {
        return validationError(res, err.message);
      }
      if (err.code === 'NOT_FOUND') {
        return notFoundError(res, err.message);
      }
      console.error('Error casting vote:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to cast vote' } });
    }
  }
);

// DELETE /votes/:target_type/:target_id — remove own vote
router.delete(
  '/votes/:target_type/:target_id',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { target_type, target_id } = req.params;

      if (!voteService.VALID_TARGET_TYPES.includes(target_type)) {
        return validationError(res, `target_type must be one of: ${voteService.VALID_TARGET_TYPES.join(', ')}`);
      }
      if (!UUID_RE.test(target_id)) {
        return validationError(res, 'target_id must be a valid UUID');
      }

      const deleted = await voteService.removeVote(req.account.id, target_type, target_id);
      if (!deleted) {
        return notFoundError(res, 'Vote not found');
      }

      return res.status(204).send();
    } catch (err) {
      console.error('Error removing vote:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to remove vote' } });
    }
  }
);

// GET /votes?target_type=...&target_id=... — list votes on target
router.get('/votes', auth.authenticateOptional, async (req, res) => {
  try {
    const { target_type, target_id } = req.query;

    if (!target_type || !voteService.VALID_TARGET_TYPES.includes(target_type)) {
      return validationError(res, `target_type must be one of: ${voteService.VALID_TARGET_TYPES.join(', ')}`);
    }
    if (!target_id || !UUID_RE.test(target_id)) {
      return validationError(res, 'target_id must be a valid UUID');
    }

    const { page, limit } = parsePagination(req.query);
    const result = await voteService.getVotesByTarget(target_type, target_id, { page, limit });

    return res.json(result);
  } catch (err) {
    console.error('Error listing votes:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list votes' } });
  }
});

// GET /accounts/:id/votes — vote history of an account
router.get('/accounts/:id/votes', auth.authenticateOptional, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) {
      return validationError(res, 'Account ID must be a valid UUID');
    }

    const { page, limit } = parsePagination(req.query);
    const result = await voteService.getVotesByAccount(req.params.id, { page, limit });

    return res.json(result);
  } catch (err) {
    console.error('Error listing account votes:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list votes' } });
  }
});

// GET /accounts/:id/reputation — reputation details
router.get('/accounts/:id/reputation', auth.authenticateOptional, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) {
      return validationError(res, 'Account ID must be a valid UUID');
    }

    const details = await reputationService.getReputationDetails(req.params.id);
    return res.json(details);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return notFoundError(res, err.message);
    }
    console.error('Error getting reputation:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get reputation' } });
  }
});

// --- Formal Vote Routes (Sprint 3: commit-reveal protocol) ---

// POST /votes/formal/commit — submit a hashed vote commitment
router.post(
  '/votes/formal/commit',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { chunk_id, commit_hash } = req.body;

      if (!chunk_id || !UUID_RE.test(chunk_id)) {
        return validationError(res, 'chunk_id must be a valid UUID');
      }
      if (!commit_hash || typeof commit_hash !== 'string' || commit_hash.length < 32) {
        return validationError(res, 'commit_hash must be a SHA-256 hex string');
      }

      const vote = await formalVoteService.commitVote({
        accountId: req.account.id,
        chunkId: chunk_id,
        commitHash: commit_hash,
      });

      return res.status(201).json(vote);
    } catch (err) {
      if (err.code === 'INVALID_PHASE') return res.status(409).json({ error: { code: err.code, message: err.message } });
      if (err.code === 'DEADLINE_PASSED') return res.status(409).json({ error: { code: err.code, message: err.message } });
      if (err.code === 'SELF_VOTE') return res.status(403).json({ error: { code: err.code, message: err.message } });
      if (err.code === 'VOTE_LOCKED') return res.status(403).json({ error: { code: err.code, message: err.message } });
      if (err.code === 'FORBIDDEN') return forbiddenError(res, err.message);
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.code === 'WEIGHT_TOO_LOW') return res.status(403).json({ error: { code: err.code, message: err.message } });
      if (err.code === 'TIER_TOO_LOW') return res.status(403).json({ error: { code: err.code, message: err.message } });
      console.error('Error committing formal vote:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to commit vote' } });
    }
  }
);

// POST /votes/formal/reveal — reveal a previously committed vote
router.post(
  '/votes/formal/reveal',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { chunk_id, vote_value, reason_tag, salt } = req.body;

      if (!chunk_id || !UUID_RE.test(chunk_id)) {
        return validationError(res, 'chunk_id must be a valid UUID');
      }
      if (vote_value === undefined || vote_value === null) {
        return validationError(res, 'vote_value is required (-1, 0, or 1)');
      }
      if (!salt || typeof salt !== 'string') {
        return validationError(res, 'salt is required');
      }

      const vote = await formalVoteService.revealVote({
        accountId: req.account.id,
        chunkId: chunk_id,
        voteValue: vote_value,
        reasonTag: reason_tag,
        salt,
      });

      return res.status(200).json(vote);
    } catch (err) {
      if (err.code === 'INVALID_PHASE') return res.status(409).json({ error: { code: err.code, message: err.message } });
      if (err.code === 'DEADLINE_PASSED') return res.status(409).json({ error: { code: err.code, message: err.message } });
      if (err.code === 'HASH_MISMATCH') return res.status(400).json({ error: { code: err.code, message: err.message } });
      if (err.code === 'ALREADY_REVEALED') return res.status(409).json({ error: { code: err.code, message: err.message } });
      if (err.code === 'VALIDATION_ERROR') return validationError(res, err.message);
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      console.error('Error revealing formal vote:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reveal vote' } });
    }
  }
);

// GET /chunks/:id/votes — formal vote status (phase-aware visibility)
router.get(
  '/chunks/:id/votes',
  auth.authenticateOptional,
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Chunk ID must be a valid UUID');
      }

      const requestingAccountId = req.account ? req.account.id : null;
      const status = await formalVoteService.getVoteStatus(req.params.id, requestingAccountId);

      return res.json(status);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      console.error('Error getting vote status:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get vote status' } });
    }
  }
);

module.exports = router;
