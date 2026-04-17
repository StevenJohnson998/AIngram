const { getPool } = require('../config/database');
const { generateEmbedding } = require('./ollama');

/**
 * Embed a chunk by ID.
 * Reads chunk.content from DB (NEVER technical_detail — D51),
 * generates embedding via Ollama, and stores it.
 * If Ollama is unavailable, leaves embedding as NULL and logs a warning.
 */
async function embedChunk(chunkId) {
  const pool = getPool();

  const { rows } = await pool.query(
    'SELECT id, content FROM chunks WHERE id = $1',
    [chunkId]
  );

  if (rows.length === 0) {
    console.warn(`embedChunk: chunk ${chunkId} not found`);
    return null;
  }

  const chunk = rows[0];
  const embedding = await generateEmbedding(chunk.content);

  if (!embedding) {
    console.warn(`embedChunk: Ollama unavailable for chunk ${chunkId}, embedding left as NULL`);
    await pool.query(
      'UPDATE chunks SET embedding_attempts = embedding_attempts + 1, embedding_last_attempt_at = now(), embedding_last_error = $1 WHERE id = $2',
      ['Ollama unavailable at creation time', chunkId]
    );
    return null;
  }

  const vectorStr = `[${embedding.join(',')}]`;
  await pool.query(
    'UPDATE chunks SET embedding = $1::vector WHERE id = $2',
    [vectorStr, chunkId]
  );

  return embedding;
}

/**
 * Generate embedding for arbitrary text content (e.g. search queries).
 * Returns the embedding array or null.
 */
async function embedChunkContent(content) {
  return generateEmbedding(content);
}

const MAX_EMBEDDING_ATTEMPTS = 10;

/**
 * Retry embedding for chunks that have a NULL embedding.
 * Skips chunks that exceeded MAX_EMBEDDING_ATTEMPTS or are in backoff cooldown.
 * Returns { embedded, failed, skipped, total }.
 */
async function retryPendingEmbeddings() {
  const pool = getPool();
  const BATCH_LIMIT = 100;

  const { rows } = await pool.query(
    `SELECT id, content, embedding_attempts FROM chunks
     WHERE embedding IS NULL
       AND chunk_type NOT IN ('meta', 'summary')
       AND embedding_attempts < $1
       AND (embedding_last_attempt_at IS NULL
            OR embedding_last_attempt_at < now() - make_interval(mins => embedding_attempts * 5))
     ORDER BY created_at ASC
     LIMIT $2`,
    [MAX_EMBEDDING_ATTEMPTS, BATCH_LIMIT]
  );

  let embedded = 0;
  let failed = 0;

  for (const chunk of rows) {
    const embedding = await generateEmbedding(chunk.content);
    if (embedding) {
      const vectorStr = `[${embedding.join(',')}]`;
      await pool.query(
        'UPDATE chunks SET embedding = $1::vector, embedding_attempts = 0, embedding_last_error = NULL WHERE id = $2',
        [vectorStr, chunk.id]
      );
      embedded++;
    } else {
      const newAttempts = (chunk.embedding_attempts || 0) + 1;
      await pool.query(
        'UPDATE chunks SET embedding_attempts = $1, embedding_last_attempt_at = now(), embedding_last_error = $2 WHERE id = $3',
        [newAttempts, 'Ollama returned null', chunk.id]
      );
      if (newAttempts >= MAX_EMBEDDING_ATTEMPTS) {
        console.warn(`retryPendingEmbeddings: chunk ${chunk.id} exhausted ${MAX_EMBEDDING_ATTEMPTS} attempts, giving up`);
      }
      failed++;
    }
  }

  console.log(`retryPendingEmbeddings: ${embedded} embedded, ${failed} failed (batch: ${rows.length})`);
  return { embedded, failed, total: rows.length };
}

/**
 * Recompute ALL embeddings in batches of 10.
 * Returns the count of successfully recomputed embeddings.
 */
async function recomputeAll() {
  const pool = getPool();
  const BATCH_SIZE = 10;

  const { rows: countResult } = await pool.query('SELECT count(*) FROM chunks');
  const total = parseInt(countResult[0].count, 10);

  let recomputed = 0;
  let offset = 0;

  while (offset < total) {
    const { rows: batch } = await pool.query(
      'SELECT id, content FROM chunks ORDER BY created_at LIMIT $1 OFFSET $2',
      [BATCH_SIZE, offset]
    );

    for (const chunk of batch) {
      const embedding = await generateEmbedding(chunk.content);
      if (embedding) {
        const vectorStr = `[${embedding.join(',')}]`;
        await pool.query(
          'UPDATE chunks SET embedding = $1::vector WHERE id = $2',
          [vectorStr, chunk.id]
        );
        recomputed++;
      }
    }

    offset += BATCH_SIZE;
  }

  console.log(`recomputeAll: ${recomputed}/${total} chunks recomputed`);
  return recomputed;
}

module.exports = { embedChunk, embedChunkContent, retryPendingEmbeddings, recomputeAll };
