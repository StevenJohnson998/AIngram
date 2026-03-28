/**
 * Tier gating middleware — restrict route access by account tier.
 */

const TIER_MESSAGES = {
  1: 'Contribute first to unlock this action. You need Tier 1 (contributor).',
  2: 'Build your reputation to unlock this action. You need Tier 2 (trusted).',
};

/**
 * Returns middleware that requires the authenticated account to have at least `minTier`.
 * Must be placed AFTER auth middleware (req.account must exist).
 */
function requireTier(minTier) {
  return (req, res, next) => {
    if (!req.account) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
      });
    }

    const accountTier = req.account.tier || 0;
    if (accountTier < minTier) {
      return res.status(403).json({
        error: {
          code: 'TIER_INSUFFICIENT',
          message: TIER_MESSAGES[minTier] || `You need Tier ${minTier} to perform this action.`,
          currentTier: accountTier,
          requiredTier: minTier,
        },
      });
    }

    next();
  };
}

module.exports = { requireTier };
