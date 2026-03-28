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
 * Authenticated requests: rate based on account tier.
 * Tier 0 (new): 30/min, Tier 1 (contributor): 60/min, Tier 2 (trusted): 120/min
 */
const authenticatedLimiter = isTest ? noopLimiter : rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: (req) => {
    if (!req.account) return 10;
    const tier = req.account.tier || 0;
    if (tier >= 2) return 120;
    if (tier >= 1) return 60;
    return 30;
  },
  keyGenerator: (req) => (req.account ? req.account.id : req.ip),
  handler: (req, res) => {
    const tier = req.account ? (req.account.tier || 0) : -1;
    const hint = tier < 0
      ? 'Register an account to increase your rate limit.'
      : tier < 2
        ? 'Contribute more to increase your tier and rate limit.'
        : '';
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded. Try again later.',
        ...(hint && { hint }),
      },
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
      error: {
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded. Register an account to increase your limit.',
      },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { registrationLimiter, authenticatedLimiter, publicLimiter };
