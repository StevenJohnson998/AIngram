const { Router } = require('express');
const jwt = require('jsonwebtoken');
const accountService = require('../services/account');
const chunkService = require('../services/chunk');
const changesetService = require('../services/changeset');
const connectionTokenService = require('../services/connection-token');
const { authenticateRequired } = require('../middleware/auth');
const { registrationLimiter, publicLimiter, authenticatedLimiter } = require('../middleware/rate-limit');
const { SECURITY_BASELINE_API } = require('../config/security-baseline');
const { isInstanceAdmin } = require('../utils/instance-admin');

const router = Router();

const JWT_SECRET = () => process.env.JWT_SECRET;
const TERMS_VERSION = process.env.TERMS_VERSION || '2026-03-21-v1';

const VALID_LANGS = [
  'en', 'fr', 'zh', 'hi', 'es', 'ar', 'ja', 'de', 'pt', 'ru', 'ko', 'it', 'nl', 'pl', 'sv', 'tr',
];

// Token TTL by account type
const TOKEN_TTL = {
  ai: '24h',
  human: '1h',
};

function generateToken(account) {
  return jwt.sign(
    { sub: account.id, type: account.type, status: account.status },
    JWT_SECRET(),
    { expiresIn: TOKEN_TTL[account.type] || '1h' }
  );
}

function setTokenCookie(res, token, isProduction) {
  res.cookie('aingram_token', token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
  });
}

function clearTokenCookie(res, isProduction) {
  res.clearCookie('aingram_token', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
  });
}

/**
 * POST /accounts/register
 */
router.post('/register', registrationLimiter, async (req, res) => {
  try {
    const { name, type, ownerEmail, password, termsAccepted, archetype } = req.body;

    // Terms acceptance is mandatory
    if (!termsAccepted) {
      return res.status(400).json({
        error: { code: 'TERMS_NOT_ACCEPTED', message: 'You must accept the Terms of Use to create an account. See /terms' },
      });
    }

    // Validation
    if (!name || !type || !ownerEmail || !password) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Missing required fields: name, type, ownerEmail, password' },
      });
    }

    if (!['ai', 'human'].includes(type)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'type must be "ai" or "human"' },
      });
    }

    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'name must be between 2 and 100 characters' },
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(ownerEmail)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid email format' },
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters' },
      });
    }

    if (archetype !== undefined && archetype !== null && !accountService.VALID_ARCHETYPES.includes(archetype)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `archetype must be one of: ${accountService.VALID_ARCHETYPES.join(', ')} (or omitted)` },
      });
    }

    // S5: capture registration metadata for Sybil detection (req.ip respects
    // the trust proxy setting at app level, so it returns the real client IP
    // even behind Caddy)
    const { account, apiKey } = await accountService.createAccount({
      name, type, ownerEmail, password,
      termsVersionAccepted: TERMS_VERSION,
      creatorIp: req.ip || null,
      registrationUserAgent: req.headers['user-agent'] || null,
      archetype: archetype ?? null,
    });

    return res.status(201).json({ account, apiKey, ...SECURITY_BASELINE_API });
  } catch (err) {
    if (err.code === 'CONFLICT') {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: err.message },
      });
    }
    console.error('Registration error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * POST /accounts/login
 */
router.post('/login', publicLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Missing required fields: email, password' },
      });
    }

    const account = await accountService.findByEmail(email);
    if (!account) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
      });
    }

    // System accounts (e.g. Guardian) can never log in. Checked before password
    // verification to avoid any timing/response leak about system account state.
    if (account.type === 'system') {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
      });
    }

    const valid = await accountService.verifyPassword(account, password);
    if (!valid) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
      });
    }

    if (account.status === 'banned') {
      const contestEmail = process.env.INSTANCE_CONTEST_EMAIL || process.env.INSTANCE_ADMIN_EMAIL || null;
      // Fetch the most recent active sanction for context
      let banReason = null;
      let bannedAt = null;
      try {
        const { getPool } = require('../config/database');
        const pool = getPool();
        const { rows } = await pool.query(
          `SELECT reason, issued_at FROM sanctions
           WHERE account_id = $1 AND active = true AND type = 'ban'
           ORDER BY issued_at DESC LIMIT 1`,
          [account.id]
        );
        if (rows.length > 0) { banReason = rows[0].reason; bannedAt = rows[0].issued_at; }
      } catch { /* ignore, still return the ban */ }
      return res.status(403).json({
        error: {
          code: 'ACCOUNT_BANNED',
          message: 'This account has been banned.',
          reason: banReason,
          banned_at: bannedAt,
          contest_email: contestEmail,
        },
      });
    }

    if (!account.email_confirmed) {
      return res.status(403).json({
        error: { code: 'EMAIL_NOT_CONFIRMED', message: 'Please confirm your email before logging in. Check your inbox.' },
      });
    }

    const token = generateToken(account);
    const isProduction = process.env.NODE_ENV === 'production';
    setTokenCookie(res, token, isProduction);

    return res.status(200).json({ account: accountService.toSafeAccount(account), ...SECURITY_BASELINE_API });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * POST /accounts/logout
 */
router.post('/logout', (_req, res) => {
  const isProduction = process.env.NODE_ENV === 'production';
  clearTokenCookie(res, isProduction);
  return res.status(200).json({ message: 'Logged out' });
});

/**
 * GET /accounts/me
 */
router.get('/me', authenticateRequired, async (req, res) => {
  try {
    const account = await accountService.findById(req.account.id);
    if (!account) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Account not found' },
      });
    }
    const safe = accountService.toSafeAccount(account);
    // Inject instance admin flag (only on private /me, never on public profile views)
    safe.is_instance_admin = isInstanceAdmin(account);
    return res.status(200).json({ account: safe });
  } catch (err) {
    console.error('Get profile error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * PUT /accounts/me
 */
router.put('/me', authenticateRequired, authenticatedLimiter, async (req, res) => {
  try {
    const { name, avatarUrl, lang, archetype } = req.body;

    if (name !== undefined && (name.length < 2 || name.length > 100)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'name must be between 2 and 100 characters' },
      });
    }

    if (lang !== undefined && !VALID_LANGS.includes(lang)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `lang must be one of: ${VALID_LANGS.join(', ')}` },
      });
    }

    if (avatarUrl !== undefined && avatarUrl !== null) {
      if (typeof avatarUrl !== 'string' || avatarUrl.length > 2048 || !/^https?:\/\/.+/.test(avatarUrl)) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'avatarUrl must be a valid HTTP(S) URL (max 2048 chars)' },
        });
      }
    }

    if (archetype !== undefined && archetype !== null && !accountService.VALID_ARCHETYPES.includes(archetype)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `archetype must be one of: ${accountService.VALID_ARCHETYPES.join(', ')} (or null to unset)` },
      });
    }

    const updated = await accountService.updateProfile(req.account.id, { name, avatarUrl, lang, archetype });
    if (!updated) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'No fields to update' },
      });
    }
    return res.status(200).json({ account: updated });
  } catch (err) {
    console.error('Update profile error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * POST /accounts/me/rotate-key
 */
router.post('/me/rotate-key', authenticateRequired, authenticatedLimiter, async (req, res) => {
  try {
    const { apiKey, apiKeyLast4 } = await accountService.rotateApiKey(req.account.id);
    return res.status(200).json({ apiKey, apiKeyLast4 });
  } catch (err) {
    console.error('Rotate key error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * DELETE /accounts/me/revoke-key
 */
router.delete('/me/revoke-key', authenticateRequired, authenticatedLimiter, async (req, res) => {
  try {
    await accountService.revokeApiKey(req.account.id);
    return res.status(200).json({ message: 'API key revoked' });
  } catch (err) {
    console.error('Revoke key error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * POST /accounts/me/agents — create agent persona (pending, no API key)
 */
router.post('/me/agents', authenticateRequired, authenticatedLimiter, async (req, res) => {
  try {
    const { name, autonomous, providerId, description } = req.body;

    if (!name || typeof name !== 'string' || name.length < 2 || name.length > 100) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'name must be between 2 and 100 characters' },
      });
    }

    if (req.account.type !== 'human') {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Only human accounts can create sub-accounts' },
      });
    }

    if (req.account.parentId) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Sub-accounts cannot create sub-accounts' },
      });
    }

    // autonomous=false -> assisted agent (active immediately, no key)
    // autonomous=true (default) -> autonomous agent (pending, needs connection token)
    const isAutonomous = autonomous !== false;

    const { account } = await accountService.createSubAccount({
      name,
      parentId: req.account.id,
      generateKey: false,
      autonomous: isAutonomous,
      providerId: providerId || null,
      description: description || null,
    });

    return res.status(201).json({ account });
  } catch (err) {
    if (err.code === 'FORBIDDEN') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: err.message } });
    }
    console.error('Create sub-account error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * GET /accounts/me/agents — list my agent sub-accounts
 */
router.get('/me/agents', authenticateRequired, async (req, res) => {
  try {
    const agents = await accountService.listSubAccounts(req.account.id);
    return res.status(200).json({ agents });
  } catch (err) {
    console.error('List sub-accounts error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * GET /accounts/me/chunks — list chunks proposed by the current account (legacy, pre-changeset)
 */
router.get('/me/chunks', authenticateRequired, async (req, res) => {
  try {
    const { status, page, limit } = req.query;
    const validStatuses = ['proposed', 'published', 'retracted', 'rejected', 'under_review', 'disputed'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        error: { code: 'INVALID_STATUS', message: 'Invalid status filter. Use: ' + validStatuses.join(', ') },
      });
    }
    const result = await chunkService.getChunksByAccount(req.account.id, {
      status: status || undefined,
      page: parseInt(page) || 1,
      limit: Math.min(parseInt(limit) || 20, 100),
    });
    return res.status(200).json({ data: result.data, pagination: result.pagination });
  } catch (err) {
    console.error('List account chunks error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * GET /accounts/me/contributions — list changesets proposed by the current account
 */
router.get('/me/contributions', authenticateRequired, async (req, res) => {
  try {
    const { status, page, limit } = req.query;
    const validStatuses = ['proposed', 'merged', 'rejected', 'retracted', 'under_review'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        error: { code: 'INVALID_STATUS', message: 'Invalid status filter. Use: ' + validStatuses.join(', ') },
      });
    }
    const result = await changesetService.listChangesetsByAccount(req.account.id, {
      status: status || undefined,
      page: parseInt(page) || 1,
      limit: Math.min(parseInt(limit) || 20, 100),
    });
    return res.status(200).json({ data: result.data, pagination: result.pagination });
  } catch (err) {
    console.error('List account contributions error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * DELETE /accounts/me/agents/:id — deactivate agent sub-account
 */
router.delete('/me/agents/:id', authenticateRequired, authenticatedLimiter, async (req, res) => {
  try {
    const result = await accountService.deactivateSubAccount(req.params.id, req.account.id);
    return res.status(200).json({ account: result });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
    }
    console.error('Deactivate sub-account error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * PUT /accounts/me/agents/:id — rename agent sub-account
 */
router.put('/me/agents/:id', authenticateRequired, authenticatedLimiter, async (req, res) => {
  try {
    const { name, providerId, description } = req.body;
    const account = await accountService.updateSubAccount(req.params.id, req.account.id, { name, providerId, description });
    return res.status(200).json({ account });
  } catch (err) {
    if (err.code === 'VALIDATION_ERROR') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
    }
    console.error('Update sub-account error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * POST /accounts/me/agents/:id/reactivate — reactivate a banned agent
 */
router.post('/me/agents/:id/reactivate', authenticateRequired, authenticatedLimiter, async (req, res) => {
  try {
    const account = await accountService.reactivateSubAccount(req.params.id, req.account.id);
    return res.status(200).json({ account });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
    }
    if (err.code === 'VALIDATION_ERROR') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    console.error('Reactivate sub-account error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * POST /accounts/me/agents/:id/connection-token — generate token for a specific agent
 */
router.post('/me/agents/:id/connection-token', authenticateRequired, publicLimiter, async (req, res) => {
  try {
    if (req.account.type !== 'human') {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Only human accounts can generate connection tokens' },
      });
    }
    if (req.account.parentId) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Sub-accounts cannot generate connection tokens' },
      });
    }

    const { token, expiresAt } = await connectionTokenService.createConnectionToken(req.account.id, req.params.id);

    return res.status(201).json({ token, expiresAt });
  } catch (err) {
    if (err.code === 'RATE_LIMITED') {
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: err.message } });
    }
    if (err.code === 'FORBIDDEN') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: err.message } });
    }
    console.error('Create connection token error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * POST /accounts/resend-confirmation — resend email confirmation link
 */
router.post('/resend-confirmation', publicLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Missing required field: email' },
      });
    }

    // Always return same response regardless of email existence (anti-enumeration)
    await accountService.resendConfirmation(email);

    return res.status(200).json({ message: 'If an unconfirmed account exists with this email, a confirmation link has been sent.' });
  } catch (err) {
    console.error('Resend confirmation error:', err.message);
    return res.status(200).json({ message: 'If an unconfirmed account exists with this email, a confirmation link has been sent.' });
  }
});

/**
 * GET /accounts/confirm-email?token=xxx
 */
router.get('/confirm-email', publicLimiter, async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Missing required query parameter: token' },
      });
    }

    const account = await accountService.confirmEmailByToken(token);
    if (!account) {
      return res.status(400).json({
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired confirmation token' },
      });
    }

    return res.status(200).json({ message: 'Email confirmed successfully', account });
  } catch (err) {
    console.error('Confirm email error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * POST /accounts/confirm-email — same as GET but with token in body (agent-friendly)
 */
router.post('/confirm-email', publicLimiter, async (req, res) => {
  try {
    const token = req.body.token || req.query.token;
    if (!token) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Missing required field: token' },
      });
    }

    const account = await accountService.confirmEmailByToken(token);
    if (!account) {
      return res.status(400).json({
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired confirmation token' },
      });
    }

    return res.status(200).json({ message: 'Email confirmed successfully', account });
  } catch (err) {
    console.error('Confirm email error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * GET /accounts/:id — public profile
 */
router.get('/:id', publicLimiter, async (req, res) => {
  try {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Account ID must be a valid UUID' },
      });
    }
    res.set('X-Robots-Tag', 'noindex');
    const profile = await accountService.getPublicProfile(req.params.id);
    if (!profile) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Account not found' },
      });
    }
    return res.status(200).json({ account: profile });
  } catch (err) {
    console.error('Get public profile error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * POST /accounts/reset-password — request a password reset email
 */
router.post('/reset-password', publicLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Missing required field: email' },
      });
    }

    // Always return same response regardless of email existence (anti-enumeration)
    await accountService.requestPasswordReset(email);

    return res.status(200).json({ message: 'If an account exists with this email, a reset link has been sent.' });
  } catch (err) {
    console.error('Request password reset error:', err.message);
    // Still return 200 to avoid leaking info
    return res.status(200).json({ message: 'If an account exists with this email, a reset link has been sent.' });
  }
});

/**
 * POST /accounts/connect — redeem connection token (no auth required)
 */
router.post('/connect', registrationLimiter, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Missing required field: token' },
      });
    }

    const { account, apiKey } = await connectionTokenService.redeemConnectionToken(token);

    // Build docs URL from request origin
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const docs = `${proto}://${host}/llms.txt`;

    return res.status(201).json({ account, apiKey, docs, ...SECURITY_BASELINE_API });
  } catch (err) {
    if (err.code === 'INVALID_TOKEN') {
      return res.status(400).json({ error: { code: 'INVALID_TOKEN', message: err.message } });
    }
    if (err.code === 'FORBIDDEN') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: err.message } });
    }
    console.error('Redeem connection token error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * PUT /accounts/reset-password — validate token and set new password
 */
router.put('/reset-password', publicLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Missing required fields: token, password' },
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters' },
      });
    }

    const account = await accountService.resetPassword(token, password);
    if (!account) {
      return res.status(400).json({
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired reset token' },
      });
    }

    return res.status(200).json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

module.exports = router;
