/**
 * Sources follow chunk versions.
 *
 * Prod finding (2026-09-03): chunk_sources is keyed by chunk id, i.e. by VERSION.
 * Neither merge path copied the parent's sources onto the merged version, so every
 * merged edit published a version with zero sources (10/10 that evening) while the
 * citations stayed on the superseded parent. These tests load the REAL chunk module
 * (only infra is mocked) and assert the copy happens inside both merge transactions.
 */
jest.mock('../../config/database');
jest.mock('../../config/trust', () => ({
  CHUNK_PRIOR_NEW: [1, 1],
  CHUNK_PRIOR_ESTABLISHED: [3, 1],
  CHUNK_PRIOR_ELITE: [5, 1],
  DUPLICATE_SIMILARITY_THRESHOLD: 0.95,
  SOURCE_BONUS_PER_SOURCE: 0.75,
  SOURCE_BONUS_CAP: 3.0,
}));
jest.mock('../ollama', () => ({ generateEmbedding: jest.fn().mockResolvedValue(null) }));
jest.mock('../embedding', () => ({ embedChunk: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../account', () => ({ incrementInteractionAndUpdateTier: jest.fn().mockResolvedValue(0) }));
jest.mock('../url-checker', () => ({ checkUrl: jest.fn().mockResolvedValue('link_exists') }));
jest.mock('../injection-detector', () => ({
  analyzeContent: jest.fn().mockReturnValue({ score: 0, flags: [], suspicious: false }),
}));
jest.mock('../reputation', () => ({ awardDissentBonus: jest.fn().mockResolvedValue(undefined) }));

const { getPool } = require('../../config/database');
const chunkService = require('../chunk');
const changesetService = require('../changeset');

const COPY_SQL = /INSERT INTO chunk_sources[\s\S]*SELECT \$2, s\.source_url[\s\S]*NOT EXISTS/;

function copyCalls(client) {
  return client.query.mock.calls.filter(([sql]) => typeof sql === 'string' && COPY_SQL.test(sql));
}

describe('carryOverSources', () => {
  it('copies the parent sources the new version does not already carry, inside the caller transaction', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rowCount: 2, rows: [] }) };
    await expect(chunkService.carryOverSources(client, 'parent-1', 'child-2')).resolves.toBe(2);
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toMatch(COPY_SQL);
    expect(sql).toMatch(/IS NOT DISTINCT FROM/); // NULL urls (description-only sources) dedupe too
    expect(params).toEqual(['parent-1', 'child-2']);
  });

  it('is a no-op without a parent or when copying onto itself', async () => {
    const client = { query: jest.fn() };
    await expect(chunkService.carryOverSources(client, null, 'child-2')).resolves.toBe(0);
    await expect(chunkService.carryOverSources(client, 'same', 'same')).resolves.toBe(0);
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('mergeChunk — the merged version inherits the superseded parent sources', () => {
  let client, pool;

  beforeEach(() => {
    jest.clearAllMocks();
    // SQL-driven fake: every statement gets a plausible row; the copy is asserted by SQL text.
    client = {
      query: jest.fn(async (sql) => {
        if (/FROM chunks WHERE id = \$1 AND status IN \('proposed', 'under_review'\)/.test(sql)) {
          return { rows: [{ id: 'v2', status: 'proposed', parent_chunk_id: 'v1', chunk_type: 'text', vote_score: null }] };
        }
        if (/SELECT status FROM chunks WHERE id = \$1/.test(sql)) return { rows: [{ status: 'published' }] };
        if (/UPDATE chunks SET status = 'published'/.test(sql)) return { rows: [{ id: 'v2', status: 'published' }] };
        return { rows: [], rowCount: 1 };
      }),
      release: jest.fn(),
    };
    pool = { query: jest.fn().mockResolvedValue({ rows: [] }), connect: jest.fn().mockResolvedValue(client) };
    getPool.mockReturnValue(pool);
  });

  it('copies v1 sources onto v2 after superseding v1 and before COMMIT', async () => {
    const merged = await chunkService.mergeChunk('v2', 'sentinel');
    expect(merged).toMatchObject({ id: 'v2', status: 'published' });
    const calls = client.query.mock.calls.map(([sql]) => sql);
    const supersede = calls.findIndex(sql => /SET status = 'superseded'/.test(sql));
    const copy = calls.findIndex(sql => COPY_SQL.test(sql));
    const commit = calls.findIndex(sql => sql === 'COMMIT');
    expect(supersede).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(supersede);
    expect(copy).toBeLessThan(commit);
    expect(copyCalls(client)[0][1]).toEqual(['v1', 'v2']);
  });

  it('does not copy anything for a first version (no parent)', async () => {
    client.query.mockImplementation(async (sql) => {
      if (/status IN \('proposed', 'under_review'\)/.test(sql)) {
        return { rows: [{ id: 'c1', status: 'proposed', parent_chunk_id: null, chunk_type: 'text', vote_score: null }] };
      }
      if (/UPDATE chunks SET status = 'published'/.test(sql)) return { rows: [{ id: 'c1', status: 'published' }] };
      return { rows: [], rowCount: 0 };
    });
    await chunkService.mergeChunk('c1', 'sentinel');
    expect(copyCalls(client)).toHaveLength(0);
  });
});

describe('mergeChangeset — replace operations carry the target sources to the new chunk', () => {
  let client, pool;

  beforeEach(() => {
    jest.clearAllMocks();
    client = {
      query: jest.fn(async (sql) => {
        if (/FROM changesets WHERE id = \$1 AND status IN/.test(sql)) {
          return { rows: [{ id: 'cs-1', status: 'proposed', proposed_by: 'acc-1', topic_id: 't1' }] };
        }
        if (/SELECT badge_elite, badge_contribution FROM accounts/.test(sql)) {
          return { rows: [{ badge_elite: false, badge_contribution: true }] };
        }
        if (/FROM changeset_operations WHERE changeset_id/.test(sql)) {
          return { rows: [
            { operation: 'replace', chunk_id: 'new-a', target_chunk_id: 'old-a' },
            { operation: 'add', chunk_id: 'new-b', target_chunk_id: null },
            { operation: 'remove', chunk_id: null, target_chunk_id: 'old-c' },
          ] };
        }
        if (/UPDATE changesets SET status = 'published'/.test(sql)) return { rows: [{ id: 'cs-1', status: 'published' }] };
        return { rows: [], rowCount: 1 };
      }),
      release: jest.fn(),
    };
    pool = { query: jest.fn().mockResolvedValue({ rows: [] }), connect: jest.fn().mockResolvedValue(client) };
    getPool.mockReturnValue(pool);
  });

  it('copies exactly once per replace op, from the superseded target to the published chunk', async () => {
    await changesetService.mergeChangeset('cs-1', 'sentinel');
    const copies = copyCalls(client);
    expect(copies).toHaveLength(1);
    expect(copies[0][1]).toEqual(['old-a', 'new-a']);
    const calls = client.query.mock.calls.map(([sql]) => sql);
    expect(calls.indexOf(copies[0][0])).toBeLessThan(calls.indexOf('COMMIT'));
  });
});
