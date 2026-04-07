/**
 * Report service — public content reports for LCEN/DSA compliance.
 * Separate from flags (internal governance, auth required).
 */

const { getPool } = require('../config/database');

const VALID_CONTENT_TYPES = ['topic', 'chunk'];
const VALID_STATUSES = ['pending', 'reviewing', 'resolved', 'dismissed', 'taken_down', 'counter_noticed', 'restored'];

/**
 * Create a public report. No auth required.
 */
async function createReport({ contentId, contentType, reason, reporterEmail }) {
  if (!VALID_CONTENT_TYPES.includes(contentType)) {
    const err = new Error(`contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}`);
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
    const err = new Error('reason is required (minimum 10 characters)');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  if (!reporterEmail || typeof reporterEmail !== 'string' || !reporterEmail.includes('@')) {
    const err = new Error('A valid reporter email is required');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const pool = getPool();

  // Verify content exists
  const TABLE_MAP = { topic: 'topics', chunk: 'chunks' };
  const table = TABLE_MAP[contentType];
  if (!table) {
    const err = new Error(`Invalid content type: ${contentType}`);
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  const exists = await pool.query(`SELECT id FROM ${table} WHERE id = $1`, [contentId]);
  if (exists.rows.length === 0) {
    const err = new Error(`${contentType} not found`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  const result = await pool.query(
    `INSERT INTO reports (content_id, content_type, reason, reporter_email)
     VALUES ($1, $2, $3, $4)
     RETURNING id, content_id, content_type, status, created_at`,
    [contentId, contentType, reason.trim(), reporterEmail.trim().toLowerCase()]
  );
  return result.rows[0];
}

/**
 * List reports (admin). Filtered by status, paginated.
 */
async function listReports({ status = 'pending', page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (status && VALID_STATUSES.includes(status)) {
    conditions.push(`r.status = $${paramIdx++}`);
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM reports r ${where}`,
    params
  );
  const total = countResult.rows[0].total;

  const dataResult = await pool.query(
    `SELECT r.*,
       CASE WHEN r.content_type = 'topic' THEN t.title ELSE NULL END AS topic_title,
       CASE WHEN r.content_type = 'chunk' THEN LEFT(c.content, 100) ELSE NULL END AS chunk_preview
     FROM reports r
     LEFT JOIN topics t ON r.content_type = 'topic' AND r.content_id = t.id
     LEFT JOIN chunks c ON r.content_type = 'chunk' AND r.content_id = c.id
     ${where}
     ORDER BY r.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, limit, offset]
  );

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

/**
 * Resolve or dismiss a report (admin action).
 */
async function resolveReport(reportId, { status, adminNotes, resolvedBy }) {
  if (!['resolved', 'dismissed'].includes(status)) {
    const err = new Error('status must be resolved or dismissed');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const pool = getPool();
  const result = await pool.query(
    `UPDATE reports SET status = $1, admin_notes = $2, resolved_by = $3, resolved_at = now()
     WHERE id = $4 AND status IN ('pending', 'reviewing')
     RETURNING *`,
    [status, adminNotes || null, resolvedBy, reportId]
  );

  if (result.rows.length === 0) {
    const err = new Error('Report not found or already resolved');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return result.rows[0];
}

/**
 * Takedown a reported chunk — hides it immediately (DMCA / Art. 17).
 * Fast-track: requires reviewer reputation_copyright >= MIN_REP_COPYRIGHT_FAST_TAKEDOWN.
 * Only works on reports targeting chunks, in 'pending' or 'reviewing' status.
 * Always notifies the chunk author with reason and appeal instructions.
 */
async function takedownReport(reportId, { takenDownBy, reviewerCopyrightRep }) {
  const { MIN_REP_COPYRIGHT_FAST_TAKEDOWN } = require('../config/protocol');

  // Gate: only high-rep copyright reviewers can fast-track takedown
  if (typeof reviewerCopyrightRep === 'number' && reviewerCopyrightRep < MIN_REP_COPYRIGHT_FAST_TAKEDOWN) {
    throw Object.assign(
      new Error(`Fast-track takedown requires reputation_copyright >= ${MIN_REP_COPYRIGHT_FAST_TAKEDOWN} (yours: ${reviewerCopyrightRep.toFixed(2)}). Use the review queue instead.`),
      { code: 'INSUFFICIENT_REPUTATION' }
    );
  }

  const pool = getPool();

  // Atomically transition report to taken_down
  const { rows } = await pool.query(
    `UPDATE reports
     SET status = 'taken_down', takedown_at = now(), takedown_by = $1
     WHERE id = $2 AND status IN ('pending', 'reviewing') AND content_type = 'chunk'
     RETURNING *`,
    [takenDownBy, reportId]
  );

  if (rows.length === 0) {
    // Check why it failed
    const { rows: exists } = await pool.query('SELECT status, content_type FROM reports WHERE id = $1', [reportId]);
    if (exists.length === 0) {
      throw Object.assign(new Error('Report not found'), { code: 'NOT_FOUND' });
    }
    if (exists[0].content_type !== 'chunk') {
      throw Object.assign(new Error('Takedown only applies to chunk reports'), { code: 'VALIDATION_ERROR' });
    }
    throw Object.assign(new Error(`Report cannot be taken down (current status: ${exists[0].status})`), { code: 'VALIDATION_ERROR' });
  }

  const report = rows[0];

  // Hide the chunk and notify author
  await hideChunkAndNotifyAuthor(pool, report.content_id, {
    reason: report.reason,
    reportId,
    action: 'chunk_takedown',
    triggeredBy: takenDownBy,
    method: 'fast_track',
  });

  return report;
}

/**
 * Hide a chunk and notify its author. Shared by fast-track takedown and auto-hide timeout.
 * @param {Pool} pool
 * @param {string} chunkId
 * @param {object} opts - reason, reportId, action, triggeredBy, method
 */
async function hideChunkAndNotifyAuthor(pool, chunkId, { reason, reportId, action, triggeredBy, method }) {
  // Hide the chunk
  await pool.query(
    'UPDATE chunks SET hidden = true, updated_at = now() WHERE id = $1',
    [chunkId]
  );

  // Get chunk author
  const { rows: chunkRows } = await pool.query(
    'SELECT created_by FROM chunks WHERE id = $1',
    [chunkId]
  );
  const authorId = chunkRows[0]?.created_by;

  // Log takedown activity (public feed)
  await pool.query(
    `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, 'chunk', $3, $4)`,
    [triggeredBy, action, chunkId, JSON.stringify({ report_id: reportId, reason, method })]
  );

  // Notify the author (activity_log entry addressed to them)
  if (authorId) {
    await pool.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'copyright_notice_received', 'chunk', $2, $3)`,
      [authorId, chunkId, JSON.stringify({
        report_id: reportId,
        reason,
        method,
        message: 'Your content has been hidden following a copyright report. You can file a counter-notice via POST /v1/reports/' + reportId + '/counter-notice to contest this decision.',
      })]
    );
  }
}

/**
 * Auto-hide a chunk from a pending copyright report (called by timeout enforcer).
 * Used when a report is not reviewed within T_COPYRIGHT_REVIEW_DEADLINE_MS.
 */
async function autoHideFromReport(reportId) {
  const pool = getPool();

  const { rows } = await pool.query(
    `UPDATE reports
     SET status = 'taken_down', takedown_at = now()
     WHERE id = $1 AND status = 'pending' AND content_type = 'chunk'
     RETURNING *`,
    [reportId]
  );

  if (rows.length === 0) return null;

  const report = rows[0];

  await hideChunkAndNotifyAuthor(pool, report.content_id, {
    reason: report.reason,
    reportId,
    action: 'chunk_auto_hidden',
    triggeredBy: null,
    method: 'review_deadline_exceeded',
  });

  return report;
}

/**
 * File a counter-notice contesting a takedown.
 * Public endpoint — the original content creator or rights holder can contest.
 */
async function counterNotice(reportId, { email, reason }) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw Object.assign(new Error('A valid email is required for counter-notice'), { code: 'VALIDATION_ERROR' });
  }
  if (!reason || typeof reason !== 'string' || reason.trim().length < 50) {
    throw Object.assign(new Error('Counter-notice reason must be at least 50 characters'), { code: 'VALIDATION_ERROR' });
  }

  const { T_COUNTER_NOTICE_DELAY_MS } = require('../config/protocol');
  const pool = getPool();

  const { rows } = await pool.query(
    `UPDATE reports
     SET status = 'counter_noticed',
         counter_notice_at = now(),
         counter_notice_email = $1,
         counter_notice_reason = $2,
         restoration_eligible_at = now() + ($3 || ' milliseconds')::interval
     WHERE id = $4 AND status = 'taken_down'
     RETURNING *`,
    [email.trim().toLowerCase(), reason.trim(), String(T_COUNTER_NOTICE_DELAY_MS), reportId]
  );

  if (rows.length === 0) {
    const { rows: exists } = await pool.query('SELECT status FROM reports WHERE id = $1', [reportId]);
    if (exists.length === 0) {
      throw Object.assign(new Error('Report not found'), { code: 'NOT_FOUND' });
    }
    throw Object.assign(new Error(`Counter-notice only applies to taken-down reports (current status: ${exists[0].status})`), { code: 'VALIDATION_ERROR' });
  }

  return rows[0];
}

/**
 * Restore a chunk after counter-notice delay has elapsed.
 * Called by the restoration worker or manually by admin.
 */
async function restoreAfterCounterNotice(reportId, { restoredBy }) {
  const pool = getPool();

  const { rows } = await pool.query(
    `UPDATE reports
     SET status = 'restored', restored_at = now(), restored_by = $1
     WHERE id = $2 AND status = 'counter_noticed' AND restoration_eligible_at <= now()
     RETURNING *`,
    [restoredBy, reportId]
  );

  if (rows.length === 0) {
    const { rows: exists } = await pool.query(
      'SELECT status, restoration_eligible_at FROM reports WHERE id = $1',
      [reportId]
    );
    if (exists.length === 0) {
      throw Object.assign(new Error('Report not found'), { code: 'NOT_FOUND' });
    }
    if (exists[0].status !== 'counter_noticed') {
      throw Object.assign(new Error(`Report is not in counter_noticed status (current: ${exists[0].status})`), { code: 'VALIDATION_ERROR' });
    }
    throw Object.assign(new Error('Restoration delay has not elapsed yet'), { code: 'VALIDATION_ERROR' });
  }

  const report = rows[0];

  // Unhide the chunk
  await pool.query(
    'UPDATE chunks SET hidden = false, updated_at = now() WHERE id = $1',
    [report.content_id]
  );

  // Log activity
  await pool.query(
    `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
     VALUES ($1, 'chunk_restored', 'chunk', $2, $3)`,
    [restoredBy, report.content_id, JSON.stringify({ report_id: reportId })]
  );

  return report;
}

module.exports = {
  createReport,
  listReports,
  resolveReport,
  takedownReport,
  counterNotice,
  restoreAfterCounterNotice,
  autoHideFromReport,
  VALID_CONTENT_TYPES,
  VALID_STATUSES,
};
