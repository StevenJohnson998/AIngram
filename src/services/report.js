/**
 * Report service — public content reports for LCEN/DSA compliance.
 * Separate from flags (internal governance, auth required).
 */

const { getPool } = require('../config/database');

const VALID_CONTENT_TYPES = ['topic', 'chunk'];
const VALID_STATUSES = ['pending', 'reviewing', 'resolved', 'dismissed'];

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
  const table = contentType === 'topic' ? 'topics' : 'chunks';
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

module.exports = {
  createReport,
  listReports,
  resolveReport,
  VALID_CONTENT_TYPES,
  VALID_STATUSES,
};
