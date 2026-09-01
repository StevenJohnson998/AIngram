/**
 * Regression: changeset.js imports matchAndNotify from chunk.js.
 *
 * Prod incident (2026-08-03 → 2026-09-01, 648 occurrences): matchAndNotify was
 * defined in chunk.js but NOT exported, so changeset.js destructured `undefined`
 * and every post-merge pipeline logged "matchAndNotify is not a function" —
 * "published" notifications never reached the 436 subscriptions. The existing
 * changeset tests mock '../chunk' with matchAndNotify: jest.fn(), which hid it.
 *
 * These tests load the REAL chunk module (only infra is mocked).
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
jest.mock('../ollama', () => ({
  generateEmbedding: jest.fn().mockResolvedValue(null),
}));
jest.mock('../account', () => ({
  incrementInteractionAndUpdateTier: jest.fn().mockResolvedValue(0),
}));
jest.mock('../url-checker', () => ({
  checkUrl: jest.fn().mockResolvedValue('link_exists'),
}));
jest.mock('../injection-detector', () => ({
  analyzeContent: jest.fn().mockReturnValue({ score: 0, flags: [], suspicious: false }),
}));

describe('chunk.js ↔ changeset.js notification wiring', () => {
  it('chunk.js exports matchAndNotify as a function (real module, not mocked)', () => {
    const chunk = require('../chunk');
    expect(typeof chunk.matchAndNotify).toBe('function');
  });

  it('changeset.js resolves a callable matchAndNotify at require time', () => {
    // Destructured at module load: `const { matchAndNotify } = require('./chunk')`.
    // If the export is missing, the binding is undefined and only fails at runtime.
    jest.isolateModules(() => {
      const chunk = require('../chunk');
      const spy = jest.spyOn(chunk, 'matchAndNotify');
      expect(() => require('../changeset')).not.toThrow();
      expect(spy).toBeDefined();
      expect(chunk.matchAndNotify).toBe(spy);
    });
  });
});

describe('createChangeset — post-COMMIT notification can never fail the request', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      // Generic row satisfies every INSERT ... RETURNING / SELECT in the add path.
      query: jest.fn().mockResolvedValue({
        rows: [{ id: 'row-1', status: 'proposed', topic_id: 'topic-1', changeset_id: 'cs-1' }],
      }),
      release: jest.fn(),
    };
  });

  async function runCreateWith(matchAndNotifyImpl) {
    let changesetService;
    // isolateModules gives a fresh registry: the database mock must be wired
    // inside it, otherwise changeset.js sees an unconfigured getPool.
    jest.isolateModules(() => {
      jest.doMock('../chunk', () => ({ matchAndNotify: matchAndNotifyImpl }));
      const db = require('../../config/database');
      db.getPool.mockReturnValue({
        query: jest.fn().mockResolvedValue({ rows: [] }),
        connect: jest.fn().mockResolvedValue(mockClient),
      });
      changesetService = require('../changeset');
    });
    const result = await changesetService.createChangeset({
      topicId: 'topic-1',
      proposedBy: 'acc-1',
      description: 'wiring test',
      operations: [{ operation: 'add', content: 'A new chunk with enough content to be valid.' }],
    });
    // Let the fire-and-forget promise chain settle.
    await new Promise(resolve => setImmediate(resolve));
    return result;
  }

  it('a synchronous throw in matchAndNotify (e.g. "not a function") does not reject or ROLLBACK', async () => {
    const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runCreateWith(() => { throw new TypeError('matchAndNotify is not a function'); });

    expect(result).toHaveProperty('changeset');
    const sql = mockClient.query.mock.calls.map(c => c[0]);
    expect(sql).toContain('COMMIT');
    expect(sql).not.toContain('ROLLBACK');
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining('Subscription matching failed for chunk'),
      'matchAndNotify is not a function'
    );
    consoleErr.mockRestore();
  });

  it('a rejected matchAndNotify is logged, not unhandled', async () => {
    const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => {});
    await runCreateWith(jest.fn().mockRejectedValue(new Error('db down')));
    expect(consoleErr).toHaveBeenCalledWith(expect.stringContaining('Subscription matching failed'), 'db down');
    consoleErr.mockRestore();
  });

  it('calls matchAndNotify with the new chunk id and "proposed"', async () => {
    const spy = jest.fn().mockResolvedValue(undefined);
    await runCreateWith(spy);
    expect(spy).toHaveBeenCalledWith('row-1', 'proposed');
  });
});
