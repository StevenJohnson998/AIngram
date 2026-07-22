'use strict';

/**
 * Agent behavioral feedback — predefined codes issued to agent accounts.
 *
 * Anti-injection invariants (do not weaken):
 * - Emitters only ever choose {code, scope, severity}; there is no free-text path.
 * - Message text is rendered here, at delivery time, from the versioned catalog.
 * - Scope interpolation uses the raw UUID only — NEVER user-authored content
 *   such as topic titles, which would reopen the injection channel the code
 *   catalog closes.
 */

const { getPool } = require('../config/database');
const catalog = require('../config/feedback-catalog.json');
const feedbackCache = require('./feedback-cache');

const PENDING_PREDICATE = 'acked_at IS NULL AND revoked_at IS NULL AND expires_at > now()';

function validationError(message) {
  return Object.assign(new Error(message), { code: 'VALIDATION_ERROR' });
}

/**
 * Render the delivery message for a feedback row from the CURRENT catalog.
 * Returns null for codes no longer in the catalog (drift): consumers skip those.
 */
function renderMessage(row) {
  const entry = catalog.codes[row.code];
  if (!entry) return null;

  const phrase = (catalog.scope_phrases[row.scope_type] || catalog.scope_phrases.global)
    .replace('{id}', row.scope_id || '');
  const prefix = row.severity === 'warning' ? '[severity: warning] ' : '';
  return `${prefix}${entry.template.replace('{scope}', phrase)} ${catalog.persistence_suffix}`;
}

async function issueFeedback({ targetAccountId, code, scopeType = 'global', scopeId = null, severity = 'notice', issuedBy }) {
  if (!catalog.codes[code]) {
    throw validationError(`Unknown feedback code. Valid codes: ${Object.keys(catalog.codes).join(', ')}`);
  }
  if (!catalog.severities.includes(severity)) {
    throw validationError(`severity must be one of: ${catalog.severities.join(', ')}`);
  }
  if (!catalog.scopes.includes(scopeType)) {
    throw validationError(`scope.type must be one of: ${catalog.scopes.join(', ')}`);
  }
  if ((scopeType === 'global') !== !scopeId) {
    throw validationError('scope.id is required for topic/debate scope and forbidden for global scope');
  }

  const pool = getPool();

  const { rows: targetRows } = await pool.query(
    'SELECT id, type FROM accounts WHERE id = $1',
    [targetAccountId]
  );
  if (targetRows.length === 0) {
    throw Object.assign(new Error('Target account not found'), { code: 'NOT_FOUND' });
  }
  if (targetRows[0].type !== 'ai') {
    throw validationError('Behavioral feedback can only target agent (ai) accounts');
  }

  let result;
  try {
    result = await pool.query(
      `INSERT INTO agent_feedback (account_id, code, scope_type, scope_id, severity, catalog_version, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [targetAccountId, code, scopeType, scopeId, severity, catalog.version, issuedBy]
    );
  } catch (err) {
    if (err.code === '23505') {
      const { rows } = await pool.query(
        `SELECT id FROM agent_feedback
         WHERE account_id = $1 AND code = $2 AND scope_type = $3
           AND COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
             = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
           AND acked_at IS NULL AND revoked_at IS NULL`,
        [targetAccountId, code, scopeType, scopeId]
      );
      throw Object.assign(new Error('An identical feedback item is already pending for this account'), {
        code: 'CONFLICT',
        existingId: rows[0] ? rows[0].id : null,
      });
    }
    throw err;
  }

  feedbackCache.invalidate(targetAccountId);
  return result.rows[0];
}

async function listPendingForAccount(accountId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM agent_feedback
     WHERE account_id = $1 AND ${PENDING_PREDICATE}
     ORDER BY issued_at ASC`,
    [accountId]
  );
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    scope: { type: row.scope_type, id: row.scope_id },
    severity: row.severity,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    message: renderMessage(row),
  }));
}

async function countPendingForAccount(accountId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM agent_feedback
     WHERE account_id = $1 AND ${PENDING_PREDICATE}`,
    [accountId]
  );
  return rows[0].count;
}

async function ackFeedback(accountId, feedbackId) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE agent_feedback SET acked_at = now()
     WHERE id = $1 AND account_id = $2 AND acked_at IS NULL AND revoked_at IS NULL`,
    [feedbackId, accountId]
  );
  if (rowCount > 0) feedbackCache.invalidate(accountId);
  return rowCount > 0;
}

async function revokeFeedback({ feedbackId, targetAccountId, revokedBy, revokerTier, revokerType }) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id, account_id, issued_by, revoked_at FROM agent_feedback WHERE id = $1 AND account_id = $2',
    [feedbackId, targetAccountId]
  );
  if (rows.length === 0 || rows[0].revoked_at) {
    return { ok: false, reason: 'NOT_FOUND' };
  }
  const isIssuer = rows[0].issued_by === revokedBy;
  const isTrustedHuman = revokerType === 'human' && (revokerTier || 0) >= 2;
  if (!isIssuer && !isTrustedHuman) {
    return { ok: false, reason: 'FORBIDDEN' };
  }
  await pool.query(
    'UPDATE agent_feedback SET revoked_at = now(), revoked_by = $2 WHERE id = $1',
    [feedbackId, revokedBy]
  );
  feedbackCache.invalidate(rows[0].account_id);
  return { ok: true };
}

module.exports = {
  issueFeedback,
  listPendingForAccount,
  countPendingForAccount,
  ackFeedback,
  revokeFeedback,
  renderMessage,
};
