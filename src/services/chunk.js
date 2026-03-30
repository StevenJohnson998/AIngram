/**
 * Chunk service — CRUD operations for atomic knowledge units.
 * All state transitions enforced via domain/lifecycle.
 */

const { getPool } = require('../config/database');
const { generateEmbedding } = require('./ollama');
const trustConfig = require('../config/trust');
const { transition, retractReasonForEvent } = require('../domain');
const accountService = require('./account');
const { matchNewChunk } = require('./subscription-matcher');
const { dispatchNotification } = require('./notification');
const flagService = require('./flag');

/**
 * Match subscriptions and dispatch notifications for a chunk.
 * Fire-and-forget: never throws, logs errors.
 */
async function matchAndNotify(chunkId, triggerStatus) {
  try {
    const matches = await matchNewChunk(chunkId, triggerStatus);
    if (matches.length === 0) return;

    // Fetch full subscription records for matched IDs
    const { getPool: getDbPool } = require('../config/database');
    const pool = getDbPool();
    const subIds = matches.map(m => m.subscriptionId);
    const { rows: subscriptions } = await pool.query(
      'SELECT * FROM subscriptions WHERE id = ANY($1)',
      [subIds]
    );
    const subMap = new Map(subscriptions.map(s => [s.id, s]));

    // Get chunk content preview
    const { rows: chunkRows } = await pool.query(
      'SELECT content FROM chunks WHERE id = $1',
      [chunkId]
    );
    const contentPreview = chunkRows[0]?.content?.substring(0, 200) || '';

    for (const match of matches) {
      const subscription = subMap.get(match.subscriptionId);
      if (!subscription) continue;

      dispatchNotification(subscription, {
        chunkId,
        matchType: match.matchType,
        similarity: match.similarity,
        contentPreview,
      });
    }

    console.log(`Dispatched ${matches.length} notification(s) for chunk ${chunkId}`);
  } catch (err) {
    console.error(`Match-and-notify failed for chunk ${chunkId}:`, err.message);
  }
}

/**
 * Create a chunk and link it to a topic.
 * Initial trust_score uses Beta prior: α/(α+β) based on contributor tier.
 */
async function createChunk({ content, technicalDetail, topicId, createdBy, isElite = false, hasBadgeContribution = false, title = null, subtitle = null, adhp = null }) {
  const pool = getPool();
  const client = await pool.connect();

  // Beta prior based on contributor tier
  let prior;
  if (isElite) prior = trustConfig.CHUNK_PRIOR_ELITE;
  else if (hasBadgeContribution) prior = trustConfig.CHUNK_PRIOR_ESTABLISHED;
  else prior = trustConfig.CHUNK_PRIOR_NEW;
  const initialTrust = prior[0] / (prior[0] + prior[1]);

  try {
    // Near-duplicate detection: check if a very similar chunk already exists on this topic
    // Non-blocking: if embedding or DB check fails, we skip the guard (better to allow than to block on infra error)
    try {
      const embedding = await generateEmbedding(content);
      if (embedding) {
        const vectorStr = `[${embedding.join(',')}]`;
        const dupeResult = await pool.query(
          `SELECT c.id, 1 - (c.embedding <=> $1::vector) AS similarity
           FROM chunks c
           JOIN chunk_topics ct ON ct.chunk_id = c.id
           WHERE ct.topic_id = $2 AND c.status = 'published' AND c.embedding IS NOT NULL
             AND 1 - (c.embedding <=> $1::vector) >= $3
           LIMIT 1`,
          [vectorStr, topicId, trustConfig.DUPLICATE_SIMILARITY_THRESHOLD]
        );
        if (dupeResult.rows.length > 0) {
          throw Object.assign(
            new Error(`A very similar chunk already exists on this topic (similarity: ${dupeResult.rows[0].similarity.toFixed(3)})`),
            { code: 'DUPLICATE_CONTENT', existingChunkId: dupeResult.rows[0].id }
          );
        }
      }
    } catch (dupeErr) {
      if (dupeErr.code === 'DUPLICATE_CONTENT') throw dupeErr;
      // Embedding or DB unavailable — skip duplicate check, allow creation
    }

    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO chunks (content, technical_detail, has_technical_detail, created_by, trust_score, title, subtitle, adhp, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'proposed')
       RETURNING *`,
      [content, technicalDetail || null, technicalDetail != null, createdBy, initialTrust, title, subtitle, adhp ? JSON.stringify(adhp) : null]
    );

    const chunk = rows[0];

    // Link chunk to topic
    await client.query(
      `INSERT INTO chunk_topics (chunk_id, topic_id)
       VALUES ($1, $2)`,
      [chunk.id, topicId]
    );

    // Log activity
    await client.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'chunk_proposed', 'chunk', $2, $3)`,
      [createdBy, chunk.id, JSON.stringify({ topicId })]
    );

    await client.query('COMMIT');

    // Fire-and-forget: update interaction count + tier
    accountService.incrementInteractionAndUpdateTier(createdBy)
      .catch(err => console.error('Tier update failed:', err));

    // Fire-and-forget: match subscriptions and dispatch notifications
    matchAndNotify(chunk.id, 'proposed');

    return chunk;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get a chunk by ID with its sources.
 */
async function getChunkById(id) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT c.*,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', cs.id,
                  'source_url', cs.source_url,
                  'source_description', cs.source_description,
                  'added_by', cs.added_by,
                  'created_at', cs.created_at
                )
              ) FILTER (WHERE cs.id IS NOT NULL),
              '[]'::json
            ) AS sources
     FROM chunks c
     LEFT JOIN chunk_sources cs ON cs.chunk_id = c.id
     WHERE c.id = $1
     GROUP BY c.id`,
    [id]
  );

  return rows[0] || null;
}

/**
 * Update a chunk's content and/or technical detail.
 */
async function updateChunk(id, { content, technicalDetail }) {
  const pool = getPool();

  // Build dynamic update
  const setClauses = ['updated_at = now()'];
  const params = [];
  let idx = 1;

  if (content !== undefined) {
    setClauses.push(`content = $${idx++}`);
    params.push(content);
  }

  if (technicalDetail !== undefined) {
    setClauses.push(`technical_detail = $${idx++}`);
    params.push(technicalDetail);
    setClauses.push(`has_technical_detail = $${idx++}`);
    params.push(technicalDetail != null);
  }

  params.push(id);

  const { rows } = await pool.query(
    `UPDATE chunks SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );

  return rows[0] || null;
}

/**
 * Retract a chunk (soft delete) with lifecycle enforcement.
 * @param {string} id - chunk ID
 * @param {object} opts - { reason: 'withdrawn'|'timeout'|'admin'|'copyright', retractedBy?: string }
 */
async function retractChunk(id, { reason = 'withdrawn', retractedBy = null } = {}) {
  const pool = getPool();

  // Determine valid source states for this retraction reason
  const event = reason === 'timeout' ? 'TIMEOUT' : 'WITHDRAW';
  // proposed and under_review can WITHDRAW/TIMEOUT; validate statically
  const validFromStates = event === 'TIMEOUT'
    ? ['proposed', 'under_review', 'disputed']
    : ['proposed', 'under_review'];

  // Atomic: update only if in a valid source state (avoids TOCTOU)
  const { rows } = await pool.query(
    `UPDATE chunks SET status = 'retracted', retract_reason = $2, updated_at = now()
     WHERE id = $1 AND status = ANY($3)
     RETURNING *`,
    [id, reason, validFromStates]
  );

  if (rows.length === 0) {
    // Distinguish not-found from invalid transition
    const { rows: exists } = await pool.query('SELECT status FROM chunks WHERE id = $1', [id]);
    if (exists.length === 0) {
      throw Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' });
    }
    transition(exists[0].status, event); // throws LifecycleError with proper message
  }

  // Log activity
  await pool.query(
    `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
     VALUES ($1, 'chunk_retracted', 'chunk', $2, $3)`,
    [retractedBy, id, JSON.stringify({ reason })]
  );

  return rows[0];
}

/**
 * Add a source citation to a chunk.
 */
async function addSource(chunkId, { sourceUrl, sourceDescription, addedBy }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO chunk_sources (chunk_id, source_url, source_description, added_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [chunkId, sourceUrl || null, sourceDescription || null, addedBy]
  );

  return rows[0];
}

/**
 * Get chunks for a topic with pagination.
 */
async function getChunksByTopic(topicId, { status = 'published', page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const [countResult, dataResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM chunk_topics ct
       JOIN chunks c ON c.id = ct.chunk_id
       WHERE ct.topic_id = $1 AND c.status = $2 AND c.hidden = false`,
      [topicId, status]
    ),
    pool.query(
      `SELECT c.*
       FROM chunk_topics ct
       JOIN chunks c ON c.id = ct.chunk_id
       WHERE ct.topic_id = $1 AND c.status = $2 AND c.hidden = false
       ORDER BY c.created_at DESC
       LIMIT $3 OFFSET $4`,
      [topicId, status, limit, offset]
    ),
  ]);
  const total = countResult.rows[0].total;

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

/**
 * Get chunks for a topic with sources included (single query, no N+1).
 * Used for topic detail views. Supports pagination.
 */
async function getChunksWithSourcesByTopic(topicId, { status = 'published', page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const [countResult, { rows }] = await Promise.all([
    pool.query(
      `SELECT COUNT(DISTINCT c.id)::int AS total
       FROM chunk_topics ct
       JOIN chunks c ON c.id = ct.chunk_id
       WHERE ct.topic_id = $1 AND c.status = $2 AND c.hidden = false`,
      [topicId, status]
    ),
    pool.query(
      `SELECT c.*,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', cs.id,
                    'source_url', cs.source_url,
                    'source_description', cs.source_description,
                    'added_by', cs.added_by,
                    'created_at', cs.created_at
                  )
                ) FILTER (WHERE cs.id IS NOT NULL),
                '[]'::json
              ) AS sources
       FROM chunk_topics ct
       JOIN chunks c ON c.id = ct.chunk_id
       LEFT JOIN chunk_sources cs ON cs.chunk_id = c.id
       WHERE ct.topic_id = $1 AND c.status = $2 AND c.hidden = false
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT $3 OFFSET $4`,
      [topicId, status, limit, offset]
    ),
  ]);

  const total = countResult.rows[0].total;
  return { data: rows, pagination: { page, limit, total } };
}

/**
 * Propose an edit to an existing chunk.
 * Creates a new chunk with status='proposed', linked via parent_chunk_id.
 */
async function proposeEdit({ originalChunkId, content, technicalDetail, proposedBy, topicId, isElite = false, hasBadgeContribution = false }) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get original chunk version
    const { rows: origRows } = await client.query(
      'SELECT version FROM chunks WHERE id = $1',
      [originalChunkId]
    );
    if (origRows.length === 0) {
      throw Object.assign(new Error('Original chunk not found'), { code: 'NOT_FOUND' });
    }
    const newVersion = origRows[0].version + 1;
    let prior;
    if (isElite) prior = trustConfig.CHUNK_PRIOR_ELITE;
    else if (hasBadgeContribution) prior = trustConfig.CHUNK_PRIOR_ESTABLISHED;
    else prior = trustConfig.CHUNK_PRIOR_NEW;
    const initialTrust = prior[0] / (prior[0] + prior[1]);

    const { rows } = await client.query(
      `INSERT INTO chunks (content, technical_detail, has_technical_detail, created_by, proposed_by,
                           status, version, parent_chunk_id, trust_score)
       VALUES ($1, $2, $3, $4, $4, 'proposed', $5, $6, $7)
       RETURNING *`,
      [content, technicalDetail || null, technicalDetail != null, proposedBy, newVersion, originalChunkId, initialTrust]
    );

    const chunk = rows[0];

    // Link proposed chunk to same topic
    if (topicId) {
      await client.query(
        'INSERT INTO chunk_topics (chunk_id, topic_id) VALUES ($1, $2)',
        [chunk.id, topicId]
      );
    }

    await client.query('COMMIT');
    return chunk;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Merge a proposed/under_review chunk: original → superseded, chunk → published.
 * Uses AUTO_MERGE event for proposed, VOTE_ACCEPT for under_review.
 */
async function mergeChunk(proposedChunkId, mergedById) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get the chunk (accept proposed or under_review)
    const { rows: propRows } = await client.query(
      "SELECT * FROM chunks WHERE id = $1 AND status IN ('proposed', 'under_review')",
      [proposedChunkId]
    );
    if (propRows.length === 0) {
      throw Object.assign(new Error('Chunk not found or not in proposed/under_review status'), { code: 'NOT_FOUND' });
    }
    const proposed = propRows[0];

    // Validate lifecycle transition
    const event = proposed.status === 'proposed' ? 'AUTO_MERGE' : 'VOTE_ACCEPT';
    transition(proposed.status, event);

    // Supersede the original
    if (proposed.parent_chunk_id) {
      // Validate supersede transition on parent
      const { rows: parentRows } = await client.query(
        'SELECT status FROM chunks WHERE id = $1',
        [proposed.parent_chunk_id]
      );
      if (parentRows.length > 0 && parentRows[0].status === 'published') {
        transition('published', 'SUPERSEDE');
        await client.query(
          "UPDATE chunks SET status = 'superseded', updated_at = now() WHERE id = $1",
          [proposed.parent_chunk_id]
        );
      }
    }

    // Activate the chunk
    const { rows: merged } = await client.query(
      `UPDATE chunks SET status = 'published', merged_at = now(), merged_by = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [mergedById, proposedChunkId]
    );

    // Log activity
    await client.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'chunk_merged', 'chunk', $2, $3)`,
      [mergedById, proposedChunkId, JSON.stringify({ event })]
    );

    await client.query('COMMIT');

    // Fire-and-forget: match subscriptions and dispatch notifications
    matchAndNotify(proposedChunkId, 'published');

    // Dissent bonus: if this chunk was previously rejected by formal vote
    // and is now accepted (resubmission path), reward accept-voters
    if (proposed.vote_score !== null && proposed.vote_score !== undefined) {
      const reputationService = require('./reputation');
      reputationService.awardDissentBonus(proposedChunkId, 'accept')
        .catch(err => console.error('Dissent bonus failed:', err.message));
    }

    return merged[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reject a proposed/under_review chunk via vote or manual rejection.
 */
async function rejectChunk(proposedChunkId, { reason, report, rejectedBy } = {}) {
  const pool = getPool();

  // Atomic: reject only if in proposed or under_review (avoids TOCTOU)
  const { rows } = await pool.query(
    `UPDATE chunks SET status = 'retracted', updated_at = now(),
            reject_reason = $2, rejected_by = $3, rejected_at = now(),
            retract_reason = CASE WHEN status = 'under_review' THEN 'rejected' ELSE 'withdrawn' END
     WHERE id = $1 AND status IN ('proposed', 'under_review')
     RETURNING *`,
    [proposedChunkId, reason || null, rejectedBy || null]
  );

  if (rows.length === 0) {
    const { rows: exists } = await pool.query('SELECT status FROM chunks WHERE id = $1', [proposedChunkId]);
    if (exists.length === 0) {
      throw Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' });
    }
    // Throw LifecycleError for the actual invalid transition
    const event = exists[0].status === 'under_review' ? 'VOTE_REJECT' : 'WITHDRAW';
    transition(exists[0].status, event);
  }

  // Log activity
  await pool.query(
    `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
     VALUES ($1, 'chunk_retracted', 'chunk', $2, $3)`,
    [rejectedBy, proposedChunkId, JSON.stringify({ reason: rows[0].retract_reason })]
  );

  if (report && reason && rejectedBy) {
    await flagService.createFlag({
      targetType: 'chunk',
      targetId: proposedChunkId,
      reason: '[SERIOUS] ' + reason,
      reporterId: rejectedBy,
    });
  }
  return rows[0];
}

/**
 * Propose reverting a chunk to a previous version.
 * Copies content from a historical chunk and creates a new proposed chunk.
 */
async function proposeRevert({ chunkId, targetVersion, reason, proposedBy, topicId }) {
  const pool = getPool();

  // Find the target version in the chunk lineage
  // Walk back through parent_chunk_id to find the version
  const { rows: targetRows } = await pool.query(
    `WITH RECURSIVE lineage AS (
       SELECT id, content, technical_detail, has_technical_detail, version, parent_chunk_id
       FROM chunks WHERE id = $1
       UNION ALL
       SELECT c.id, c.content, c.technical_detail, c.has_technical_detail, c.version, c.parent_chunk_id
       FROM chunks c JOIN lineage l ON c.id = l.parent_chunk_id
     )
     SELECT * FROM lineage WHERE version = $2`,
    [chunkId, targetVersion]
  );

  if (targetRows.length === 0) {
    throw Object.assign(new Error('Target version not found in chunk lineage'), { code: 'NOT_FOUND' });
  }

  const target = targetRows[0];
  return proposeEdit({
    originalChunkId: chunkId,
    content: target.content,
    technicalDetail: target.technical_detail,
    proposedBy,
    topicId,
  });
}

/**
 * Get version history for a topic (all chunk versions chronologically).
 */
async function getTopicHistory(topicId, { page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const [countResult, dataResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM chunk_topics ct
       JOIN chunks c ON c.id = ct.chunk_id
       WHERE ct.topic_id = $1`,
      [topicId]
    ),
    pool.query(
      `SELECT c.id AS "chunkId", c.version, c.status, c.parent_chunk_id AS "parentChunkId",
              c.content, c.trust_score,
              c.proposed_by, pa.name AS proposed_by_name,
              c.merged_by, ma.name AS merged_by_name,
              c.merged_at AS "mergedAt", c.created_at AS "createdAt"
       FROM chunk_topics ct
       JOIN chunks c ON c.id = ct.chunk_id
       LEFT JOIN accounts pa ON pa.id = c.proposed_by
       LEFT JOIN accounts ma ON ma.id = c.merged_by
       WHERE ct.topic_id = $1
       ORDER BY c.created_at DESC
       LIMIT $2 OFFSET $3`,
      [topicId, limit, offset]
    ),
  ]);
  const total = countResult.rows[0].total;

  const data = dataResult.rows.map(row => ({
    chunkId: row.chunkId,
    version: row.version,
    status: row.status,
    parentChunkId: row.parentChunkId,
    content: row.content,
    trustScore: row.trust_score,
    proposedBy: row.proposed_by ? { id: row.proposed_by, name: row.proposed_by_name } : null,
    mergedBy: row.merged_by ? { id: row.merged_by, name: row.merged_by_name } : null,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
  }));

  return { data, pagination: { page, limit, total } };
}

/**
 * Get proposed edits for a chunk.
 */
async function getProposedEdits(chunkId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT c.*, a.name AS proposed_by_name
     FROM chunks c
     LEFT JOIN accounts a ON a.id = c.proposed_by
     WHERE c.parent_chunk_id = $1 AND c.status = 'proposed'
     ORDER BY c.created_at DESC`,
    [chunkId]
  );
  return rows;
}

/**
 * Get all pending proposed chunks (for review queue).
 */
async function listPendingProposals({ page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const countResult = await pool.query(
    "SELECT COUNT(*)::int AS total FROM chunks WHERE status = 'proposed'"
  );
  const total = countResult.rows[0].total;

  const dataResult = await pool.query(
    `SELECT c.*, a.name AS proposed_by_name,
            pc.content AS original_content,
            t.id AS topic_id, t.title AS topic_title, t.slug AS topic_slug,
            t.lang AS topic_lang, t.agorai_conversation_id
     FROM chunks c
     LEFT JOIN accounts a ON a.id = c.proposed_by
     LEFT JOIN chunks pc ON pc.id = c.parent_chunk_id
     LEFT JOIN chunk_topics ct ON ct.chunk_id = c.id
     LEFT JOIN topics t ON t.id = ct.topic_id
     WHERE c.status = 'proposed'
     ORDER BY c.created_at ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return { data: dataResult.rows, pagination: { page, limit, total } };
}

/**
 * Escalate a proposed chunk to formal review (under_review).
 * Triggered when an objection is filed by a Tier 1+ reviewer.
 */
async function escalateToReview(chunkId, escalatedBy) {
  const pool = getPool();

  // Atomic: only escalate if currently proposed
  const { rows } = await pool.query(
    `UPDATE chunks SET status = 'under_review', under_review_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'proposed'
     RETURNING *`,
    [chunkId]
  );

  if (rows.length === 0) {
    const { rows: exists } = await pool.query('SELECT status FROM chunks WHERE id = $1', [chunkId]);
    if (exists.length === 0) {
      throw Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' });
    }
    transition(exists[0].status, 'OBJECT'); // throws LifecycleError
  }

  await pool.query(
    `INSERT INTO activity_log (account_id, action, target_type, target_id)
     VALUES ($1, 'chunk_escalated', 'chunk', $2)`,
    [escalatedBy, chunkId]
  );

  // Sprint 3: start formal vote commit phase (must succeed or escalation fails)
  const formalVoteService = require('./formal-vote');
  await formalVoteService.startCommitPhase(chunkId);

  return rows[0];
}

/**
 * Resubmit a retracted chunk (retracted → proposed).
 */
const { MAX_RESUBMIT_COUNT } = require('../config/protocol');

async function resubmitChunk(chunkId, resubmittedBy) {
  const pool = getPool();

  // Atomic: only resubmit if retracted and under max resubmit limit
  const { rows } = await pool.query(
    `UPDATE chunks SET status = 'proposed', retract_reason = NULL, updated_at = now(),
            resubmit_count = resubmit_count + 1
     WHERE id = $1 AND status = 'retracted' AND resubmit_count < $2
     RETURNING *`,
    [chunkId, MAX_RESUBMIT_COUNT]
  );

  if (rows.length === 0) {
    const { rows: exists } = await pool.query('SELECT status, resubmit_count FROM chunks WHERE id = $1', [chunkId]);
    if (exists.length === 0) {
      throw Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' });
    }
    if (exists[0].resubmit_count >= MAX_RESUBMIT_COUNT) {
      throw Object.assign(new Error(`Maximum resubmission limit reached (${MAX_RESUBMIT_COUNT})`), { code: 'RESUBMIT_LIMIT' });
    }
    transition(exists[0].status, 'RESUBMIT'); // throws LifecycleError
  }

  await pool.query(
    `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
     VALUES ($1, 'chunk_resubmitted', 'chunk', $2, $3)`,
    [resubmittedBy, chunkId, JSON.stringify({ resubmitCount: rows[0].resubmit_count })]
  );

  return rows[0];
}

/**
 * Create a suggestion chunk — a process improvement proposal.
 * Suggestions never fast-track; they always require formal vote.
 */
async function createSuggestion({ content, topicId, createdBy, suggestionCategory, rationale, title = null }) {
  const pool = getPool();
  const client = await pool.connect();

  const initialTrust = trustConfig.CHUNK_PRIOR_NEW[0] / (trustConfig.CHUNK_PRIOR_NEW[0] + trustConfig.CHUNK_PRIOR_NEW[1]);

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO chunks (content, created_by, trust_score, title, status, chunk_type, suggestion_category, rationale)
       VALUES ($1, $2, $3, $4, 'proposed', 'suggestion', $5, $6)
       RETURNING *`,
      [content, createdBy, initialTrust, title, suggestionCategory, rationale || null]
    );

    const chunk = rows[0];

    // Link chunk to topic
    await client.query(
      'INSERT INTO chunk_topics (chunk_id, topic_id) VALUES ($1, $2)',
      [chunk.id, topicId]
    );

    // Log activity
    await client.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'suggestion_proposed', 'chunk', $2, $3)`,
      [createdBy, chunk.id, JSON.stringify({ topicId, category: suggestionCategory })]
    );

    await client.query('COMMIT');

    // Fire-and-forget: update interaction count + tier
    accountService.incrementInteractionAndUpdateTier(createdBy)
      .catch(err => console.error('Tier update failed:', err));

    return chunk;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * List suggestions with pagination and filters.
 */
async function listSuggestions({ status = 'proposed', category = null, page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const conditions = ["c.chunk_type = 'suggestion'"];
  const params = [];
  let idx = 1;

  if (status) {
    conditions.push(`c.status = $${idx++}`);
    params.push(status);
  }
  if (category) {
    conditions.push(`c.suggestion_category = $${idx++}`);
    params.push(category);
  }

  const where = conditions.join(' AND ');

  const [countResult, dataResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total FROM chunks c WHERE ${where}`,
      params
    ),
    pool.query(
      `SELECT c.*, a.name AS author_name,
              t.id AS topic_id, t.title AS topic_title, t.slug AS topic_slug
       FROM chunks c
       LEFT JOIN accounts a ON a.id = c.created_by
       LEFT JOIN chunk_topics ct ON ct.chunk_id = c.id
       LEFT JOIN topics t ON t.id = ct.topic_id
       WHERE ${where}
       ORDER BY c.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    ),
  ]);

  return {
    data: dataResult.rows,
    pagination: { page, limit, total: countResult.rows[0].total },
  };
}

module.exports = {
  createChunk,
  createSuggestion,
  getChunkById,
  updateChunk,
  retractChunk,
  addSource,
  getChunksByTopic,
  getChunksWithSourcesByTopic,
  proposeEdit,
  mergeChunk,
  rejectChunk,
  proposeRevert,
  getTopicHistory,
  getProposedEdits,
  listPendingProposals,
  listSuggestions,
  escalateToReview,
  resubmitChunk,
};
