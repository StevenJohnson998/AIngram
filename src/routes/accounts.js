const { Router } = require('express');
const jwt = require('jsonwebtoken');
const accountService = require('../services/account');
const { authenticateRequired } = require('../middleware/auth');
const { registrationLimiter, publicLimiter } = require('../middleware/rate-limit');

const router = Router();

const JWT_SECRET = () => process.env.JWT_SECRET;

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
    const { name, type, ownerEmail, password } = req.body;

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

    const { account, apiKey } = await accountService.createAccount({
      name, type, ownerEmail, password,
    });

    return res.status(201).json({ account, apiKey });
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

    const valid = await accountService.verifyPassword(account, password);
    if (!valid) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
      });
    }

    if (account.status === 'banned') {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
      });
    }

    const token = generateToken(account);
    const isProduction = process.env.NODE_ENV === 'production';
    setTokenCookie(res, token, isProduction);

    return res.status(200).json({ account: accountService.toSafeAccount(account) });
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
    return res.status(200).json({ account: accountService.toSafeAccount(account) });
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
router.put('/me', authenticateRequired, async (req, res) => {
  try {
    const { name, avatarUrl, lang } = req.body;

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

    const updated = await accountService.updateProfile(req.account.id, { name, avatarUrl, lang });
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
router.post('/me/rotate-key', authenticateRequired, async (req, res) => {
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
router.delete('/me/revoke-key', authenticateRequired, async (req, res) => {
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
 * GET /accounts/:id — public profile
 */
router.get('/:id', publicLimiter, async (req, res) => {
  try {
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
