/**
 * Copyright review service — parallel review track for copyright concerns (D66).
 * Three verdicts: clear, rewrite_required, takedown.
 * Separate from editorial disputes.
 */

const { getPool } = require('../config/database');
const {
  COPYRIGHT_PRIORITY_TOPIC_THRESHOLD,
  COPYRIGHT_PRIORITY_REPORTER_THRESHOLD,
  REPORTER_SUSPENSION_FP_THRESHOLD,
  REPORTER_SUSPENSION_MIN_REPORTS,
  REPORTER_SUSPENSION_DURATION_MS,
} = require('../config/protocol');

const VALID_VERDICTS = ['clear', 'rewrite_required', 'takedown'];
const VALID_STATUSES = ['pending', 'assigned', 'resolved'];

/** Reputation delta applied to false-positive reporters */
const REP_FALSE_POSITIVE_DELTA = -0.05;
/** Reputation delta applied to chunk author on takedown */
const REP_TAKEDOWN_AUTHOR_DELTA = -0.1;

/** Stop words excluded from similarity comparison */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'and', 'but', 'or', 'not', 'no', 'so', 'if',
  'this', 'that', 'it', 'its', 'my', 'your', 'his', 'her', 'their',
  'i', 'me', 'we', 'you', 'he', 'she', 'they', 'them',
]);

/**
 * Jaccard similarity on significant words between two texts.
 * Returns 0-1 (0 = completely different, 1 = identical claims).
 */
function reasonSimilarity(textA, textB) {
  const tokenize = (t) => {
    const words = t.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    return new Set(words.filter((w) => w.length > 2 && !STOP_WORDS.has(w)));
  };
  const setA = tokenize(textA);
  const setB = tokenize(textB);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Create a copyright review for a chunk.
 */
async function createCopyrightReview({ chunkId, reportId, flaggedBy, reason }) {
  if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
    throw Object.assign(new Error('Reason must be at least 10 characters'), { code: 'VALIDATION_ERROR' });
  }

  const pool = getPool();

  // Verify chunk exists
  const { rows: chunkRows } = await pool.query(
    'SELECT id, status FROM chunks WHERE id = $1',
    [chunkId]
  );
  if (chunkRows.length === 0) {
    throw Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' });
  }

  // Check reporter suspension (DSA Art. 23)
  if (flaggedBy) {
    const { rows: suspRows } = await pool.query(
      'SELECT id FROM reporter_suspensions WHERE account_id = $1 AND suspended_until > now() LIMIT 1',
      [flaggedBy]
    );
    if (suspRows.length > 0) {
      throw Object.assign(
        new Error('Your copyright reporting capability is suspended due to a high rate of unfounded notices (DSA Art. 23). Suspension will be lifted automatically.'),
        { code: 'REPORTER_SUSPENDED' }
      );
    }
  }

  // Prevent duplicate pending/assigned reviews on the same chunk
  const { rows: existing } = await pool.query(
    "SELECT id FROM copyright_reviews WHERE chunk_id = $1 AND status IN ('pending', 'assigned') LIMIT 1",
    [chunkId]
  );
  if (existing.length > 0) {
    throw Object.assign(
      new Error('A copyright review is already pending for this chunk'),
      { code: 'DUPLICATE_REVIEW', existingReviewId: existing[0].id }
    );
  }

  // Priority starts at normal, can be escalated by res judicata or volume anomalies
  let priority = 'normal';

  // Res judicata: reject re-filing of the SAME claim by the SAME reporter.
  // Different reporter = potentially different claim = always allowed (YouTube/GitHub model).
  // Same reporter + different claim = allowed but flagged for priority review.
  if (flaggedBy) {
    const { rows: clearedRows } = await pool.query(
      "SELECT id, reason FROM copyright_reviews WHERE chunk_id = $1 AND flagged_by = $2 AND verdict = 'clear' AND status = 'resolved'",
      [chunkId, flaggedBy]
    );
    if (clearedRows.length > 0) {
      const newReason = reason.trim();
      const isSameClaim = clearedRows.some(
        (prev) => reasonSimilarity(prev.reason, newReason) > 0.5
      );
      if (isSameClaim) {
        throw Object.assign(
          new Error('Your previous copyright claim on this chunk was reviewed and cleared, and this new claim appears substantially similar. To re-file, provide genuinely new evidence or a different basis for your claim.'),
          { code: 'ALREADY_CLEARED' }
        );
      }
      // Different claim from same reporter: allow but flag for priority review
      priority = 'high';
    }
  }

  // Detect priority escalation: volume anomalies

  // Check topic volume (>3 reports on same topic in 48h)
  const { rows: topicChunks } = await pool.query(
    'SELECT ct.topic_id FROM chunk_topics ct WHERE ct.chunk_id = $1 LIMIT 1',
    [chunkId]
  );
  if (topicChunks.length > 0) {
    const { rows: topicVolume } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM copyright_reviews cr
       JOIN chunk_topics ct ON ct.chunk_id = cr.chunk_id
       WHERE ct.topic_id = $1 AND cr.created_at > now() - interval '48 hours'`,
      [topicChunks[0].topic_id]
    );
    if (topicVolume[0].cnt >= COPYRIGHT_PRIORITY_TOPIC_THRESHOLD) {
      priority = 'high';
    }
  }

  // Check reporter volume (>5 reports from same account in 24h)
  if (flaggedBy && priority === 'normal') {
    const { rows: reporterVolume } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM copyright_reviews
       WHERE flagged_by = $1 AND created_at > now() - interval '24 hours'`,
      [flaggedBy]
    );
    if (reporterVolume[0].cnt >= COPYRIGHT_PRIORITY_REPORTER_THRESHOLD) {
      priority = 'high';
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO copyright_reviews (chunk_id, report_id, flagged_by, reason, priority)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [chunkId, reportId || null, flaggedBy || null, reason.trim(), priority]
  );

  // Log activity
  await pool.query(
    `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
     VALUES ($1, 'copyright_review_created', 'chunk', $2, $3)`,
    [flaggedBy || null, chunkId, JSON.stringify({ review_id: rows[0].id })]
  );

  return rows[0];
}

/**
 * List copyright reviews with pagination.
 */
async function listCopyrightReviews({ status = 'pending', page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];
  let idx = 1;

  if (status && VALID_STATUSES.includes(status)) {
    conditions.push(`cr.status = $${idx++}`);
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countResult, dataResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total FROM copyright_reviews cr ${where}`,
      params
    ),
    pool.query(
      `SELECT cr.*,
              LEFT(c.content, 200) AS chunk_preview,
              c.status AS chunk_status,
              c.created_by AS chunk_author,
              a.reputation_copyright AS flagger_copyright_rep
       FROM copyright_reviews cr
       JOIN chunks c ON c.id = cr.chunk_id
       LEFT JOIN accounts a ON a.id = cr.flagged_by
       ${where}
       ORDER BY COALESCE(a.reputation_copyright, 0.5) DESC, cr.created_at ASC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    ),
  ]);

  return {
    data: dataResult.rows,
    pagination: { page, limit, total: countResult.rows[0].total },
  };
}

/**
 * Assign a reviewer to a copyright review.
 */
async function assignReview(reviewId, { assignedTo }) {
  const pool = getPool();

  const { rows } = await pool.query(
    `UPDATE copyright_reviews
     SET status = 'assigned', assigned_to = $1, assigned_at = now()
     WHERE id = $2 AND status = 'pending'
     RETURNING *`,
    [assignedTo, reviewId]
  );

  if (rows.length === 0) {
    const { rows: exists } = await pool.query('SELECT status FROM copyright_reviews WHERE id = $1', [reviewId]);
    if (exists.length === 0) {
      throw Object.assign(new Error('Copyright review not found'), { code: 'NOT_FOUND' });
    }
    throw Object.assign(new Error(`Review cannot be assigned (current status: ${exists[0].status})`), { code: 'VALIDATION_ERROR' });
  }

  return rows[0];
}

/**
 * Resolve a copyright review with a verdict.
 * - clear: no issue, reporter reputation_copyright decreases
 * - rewrite_required: chunk hidden pending edit
 * - takedown: chunk retracted with retract_reason='copyright'
 */
async function resolveCopyrightReview(reviewId, { verdict, verdictNotes, resolvedBy }) {
  if (!VALID_VERDICTS.includes(verdict)) {
    throw Object.assign(
      new Error(`Verdict must be one of: ${VALID_VERDICTS.join(', ')}`),
      { code: 'VALIDATION_ERROR' }
    );
  }

  const pool = getPool();

  const { rows } = await pool.query(
    `UPDATE copyright_reviews
     SET status = 'resolved', verdict = $1, verdict_notes = $2,
         resolved_by = $3, resolved_at = now()
     WHERE id = $4 AND status IN ('pending', 'assigned')
     RETURNING *`,
    [verdict, verdictNotes || null, resolvedBy, reviewId]
  );

  if (rows.length === 0) {
    const { rows: exists } = await pool.query('SELECT status FROM copyright_reviews WHERE id = $1', [reviewId]);
    if (exists.length === 0) {
      throw Object.assign(new Error('Copyright review not found'), { code: 'NOT_FOUND' });
    }
    throw Object.assign(new Error(`Review already resolved`), { code: 'VALIDATION_ERROR' });
  }

  const review = rows[0];

  // Apply verdict effects
  if (verdict === 'clear') {
    // False positive: decrease reporter's copyright reputation
    if (review.flagged_by) {
      await updateCopyrightReputation(review.flagged_by, REP_FALSE_POSITIVE_DELTA);
      // Check if reporter should be suspended (DSA Art. 23)
      await checkAndSuspendReporter(review.flagged_by);
    }
  } else if (verdict === 'rewrite_required') {
    // Hide chunk pending rewrite
    await pool.query(
      'UPDATE chunks SET hidden = true, updated_at = now() WHERE id = $1',
      [review.chunk_id]
    );
  } else if (verdict === 'takedown') {
    // Retract chunk permanently for copyright
    await pool.query(
      "UPDATE chunks SET status = 'retracted', retract_reason = 'copyright', hidden = true, updated_at = now() WHERE id = $1",
      [review.chunk_id]
    );
    // Decrease chunk author's copyright reputation
    const { rows: chunkRows } = await pool.query(
      'SELECT created_by FROM chunks WHERE id = $1',
      [review.chunk_id]
    );
    if (chunkRows.length > 0 && chunkRows[0].created_by) {
      await updateCopyrightReputation(chunkRows[0].created_by, REP_TAKEDOWN_AUTHOR_DELTA);
    }
  }

  // Log activity
  await pool.query(
    `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
     VALUES ($1, 'copyright_review_resolved', 'chunk', $2, $3)`,
    [resolvedBy, review.chunk_id, JSON.stringify({ review_id: reviewId, verdict })]
  );

  return review;
}

/**
 * Update an account's copyright reputation with clamping to [0.0, 1.0].
 */
async function updateCopyrightReputation(accountId, delta) {
  const pool = getPool();
  await pool.query(
    `UPDATE accounts
     SET reputation_copyright = GREATEST(0.0, LEAST(1.0, COALESCE(reputation_copyright, 0.5) + $1))
     WHERE id = $2`,
    [delta, accountId]
  );
}

/**
 * Verbatim search — find chunks containing an exact substring.
 * Used by copyright reviewers to detect copied content.
 */
async function verbatimSearch(text, { minLength = 30, limit = 20 } = {}) {
  if (!text || text.trim().length < minLength) {
    throw Object.assign(
      new Error(`Search text must be at least ${minLength} characters`),
      { code: 'VALIDATION_ERROR' }
    );
  }

  const pool = getPool();
  const searchText = text.trim();

  const { rows } = await pool.query(
    `SELECT c.id, c.content, c.status, c.created_by, c.created_at,
            POSITION(LOWER($1) IN LOWER(c.content)) AS match_position
     FROM chunks c
     WHERE LOWER(c.content) LIKE '%' || LOWER($1) || '%'
       AND c.status IN ('active', 'proposed', 'under_review')
       AND c.hidden = false
     ORDER BY c.created_at DESC
     LIMIT $2`,
    [searchText, limit]
  );

  return rows;
}

/**
 * Check source resolvability for a chunk's citations.
 * Returns each source with its resolution status.
 */
async function checkSources(chunkId) {
  const pool = getPool();

  const { rows: sources } = await pool.query(
    'SELECT id, source_url, source_description FROM chunk_sources WHERE chunk_id = $1',
    [chunkId]
  );

  if (sources.length === 0) {
    return { chunkId, sources: [], warning: 'No sources cited for this chunk' };
  }

  const results = [];
  for (const source of sources) {
    const result = { id: source.id, url: source.source_url, description: source.source_description, status: 'unknown' };

    if (source.source_url) {
      // Check if URL is a DOI
      const doiMatch = source.source_url.match(/(?:doi\.org\/|doi:)(10\.\d{4,}\/[^\s]+)/i);
      if (doiMatch) {
        result.type = 'doi';
        result.doi = doiMatch[1];
      } else {
        result.type = 'url';
      }
      result.status = 'cited';
    } else {
      result.type = 'description_only';
      result.status = 'unverifiable';
    }

    results.push(result);
  }

  return { chunkId, sources: results };
}

/**
 * Check if a reporter should be suspended based on false positive rate.
 * DSA Art. 23: suspend reporters who frequently submit manifestly unfounded notices.
 */
async function checkAndSuspendReporter(accountId) {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE verdict = 'clear')::int AS false_positives
     FROM copyright_reviews
     WHERE flagged_by = $1 AND status = 'resolved'`,
    [accountId]
  );

  const { total, false_positives } = rows[0];
  if (total < REPORTER_SUSPENSION_MIN_REPORTS) return;

  const fpRate = false_positives / total;
  if (fpRate < REPORTER_SUSPENSION_FP_THRESHOLD) return;

  // Check not already suspended
  const { rows: existing } = await pool.query(
    'SELECT id FROM reporter_suspensions WHERE account_id = $1 AND suspended_until > now() LIMIT 1',
    [accountId]
  );
  if (existing.length > 0) return;

  const suspendedUntil = new Date(Date.now() + REPORTER_SUSPENSION_DURATION_MS);

  await pool.query(
    `INSERT INTO reporter_suspensions (account_id, reason, false_positive_rate, total_reports, suspended_until)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      accountId,
      `Suspended per DSA Art. 23: ${(fpRate * 100).toFixed(0)}% false positive rate on ${total} reports.`,
      fpRate,
      total,
      suspendedUntil,
    ]
  );

  console.log(`Copyright review: suspended reporter ${accountId} until ${suspendedUntil.toISOString()} (FP rate: ${(fpRate * 100).toFixed(0)}%)`);
}

module.exports = {
  createCopyrightReview,
  listCopyrightReviews,
  assignReview,
  resolveCopyrightReview,
  updateCopyrightReputation,
  verbatimSearch,
  checkSources,
  checkAndSuspendReporter,
  VALID_VERDICTS,
  VALID_STATUSES,
};
