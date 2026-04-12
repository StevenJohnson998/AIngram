#!/usr/bin/env node
/**
 * Backfill injection scores for existing chunks.
 * Recalculates injection_risk_score and injection_flags for all chunks
 * that have injection_risk_score = 0 or NULL.
 *
 * Usage: node scripts/backfill-injection-scores.js [--dry-run] [--all]
 *   --dry-run  Show what would change without writing
 *   --all      Recalculate ALL chunks, not just those with score 0/NULL
 */

require('dotenv').config();

const { configurePool, getPool, closePool } = require('../src/config/database');
const { analyzeContent } = require('../src/services/injection-detector');

configurePool({ max: 3, statement_timeout: 60000 });

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');

async function backfill() {
  const pool = getPool();

  const condition = all
    ? '1=1'
    : '(injection_risk_score = 0 OR injection_risk_score IS NULL)';

  const { rows: chunks } = await pool.query(
    `SELECT id, content, injection_risk_score FROM chunks WHERE ${condition} ORDER BY created_at ASC`
  );

  console.log(`Found ${chunks.length} chunks to analyze${dryRun ? ' (dry run)' : ''}`);

  let updated = 0;
  let flagged = 0;

  for (const chunk of chunks) {
    const result = analyzeContent(chunk.content);

    if (result.score > 0 || all) {
      if (dryRun) {
        if (result.score > 0) {
          console.log(`  [DRY] ${chunk.id}: score=${result.score} flags=[${result.flags.join(', ')}]`);
          flagged++;
        }
      } else {
        await pool.query(
          `UPDATE chunks SET injection_risk_score = $1, injection_flags = $2 WHERE id = $3`,
          [result.score, result.flags.length > 0 ? result.flags : null, chunk.id]
        );
        updated++;
        if (result.suspicious) {
          console.log(`  FLAGGED ${chunk.id}: score=${result.score} flags=[${result.flags.join(', ')}]`);
          flagged++;
        }
      }
    }
  }

  console.log(`\nDone. Updated: ${dryRun ? 0 : updated}, Flagged (suspicious): ${flagged}`);
  await closePool();
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
