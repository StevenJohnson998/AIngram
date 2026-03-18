const rateLimit = require('express-rate-limit');

const isTest = process.env.NODE_ENV === 'test';

// In test environment, use pass-through middleware to avoid rate limit interference
function noopLimiter(_req, _res, next) { next(); }

/**
 * Registration: 3 requests per hour per IP.
 */
const registrationLimiter = isTest ? noopLimiter : rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  handler: (_req, res) => {
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Too many registration attempts. Try again later.' },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Authenticated requests: rate based on account status.
 * Uses account ID as key (falls back to IP if no account).
 */
const authenticatedLimiter = isTest ? noopLimiter : rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: (req) => {
    if (!req.account) return 10;
    switch (req.account.status) {
      case 'active': return 120;
      case 'provisional': return 30;
      case 'suspended': return 10;
      default: return 0;
    }
  },
  keyGenerator: (req) => (req.account ? req.account.id : req.ip),
  handler: (_req, res) => {
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded. Try again later.' },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Public endpoints: 10 requests per minute per IP.
 */
const publicLimiter = isTest ? noopLimiter : rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  handler: (_req, res) => {
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded. Try again later.' },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { registrationLimiter, authenticatedLimiter, publicLimiter };
