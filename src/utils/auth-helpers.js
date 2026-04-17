'use strict';

function requireTier(account, minTier) {
  if ((account.tier || 0) < minTier) {
    throw Object.assign(
      new Error(`Tier ${minTier}+ required. Your current tier: ${account.tier || 0}`),
      { code: 'FORBIDDEN' }
    );
  }
}

module.exports = { requireTier };
