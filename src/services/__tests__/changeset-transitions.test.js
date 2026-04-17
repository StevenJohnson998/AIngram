jest.mock('../../config/database');
jest.mock('../../config/trust', () => ({
  CHUNK_PRIOR_NEW: [1, 1],
  CHUNK_PRIOR_ESTABLISHED: [2, 1],
  CHUNK_PRIOR_ELITE: [3, 1],
}));
jest.mock('../injection-detector', () => ({
  analyzeContent: jest.fn().mockReturnValue({ score: 0, flags: [], suspicious: false }),
}));
jest.mock('../chunk', () => ({
  matchAndNotify: jest.fn(),
}));

const { getPool } = require('../../config/database');
const changesetService = require('../changeset');

describe('changeset — transition() LifecycleError on invalid status', () => {
  let mockPool;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    mockPool = {
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(mockClient),
    };
    getPool.mockReturnValue(mockPool);
  });

  it('mergeChangeset throws LifecycleError for published changeset', async () => {
    // First query: SELECT ... WHERE status IN ('proposed','under_review') → empty
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE (no match — wrong status)
      .mockResolvedValueOnce({ rows: [{ status: 'published' }] }); // SELECT status (exists check)

    await expect(
      changesetService.mergeChangeset('cs-1', 'system')
    ).rejects.toMatchObject({ name: 'LifecycleError' });
  });

  it('rejectChangeset throws LifecycleError for published changeset', async () => {
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE (no match)
      .mockResolvedValueOnce({ rows: [{ status: 'published' }] }); // exists check

    await expect(
      changesetService.rejectChangeset('cs-1', { reason: 'test', rejectedBy: 'system' })
    ).rejects.toMatchObject({ name: 'LifecycleError' });
  });

  it('retractChangeset throws LifecycleError for published changeset', async () => {
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'cs-1', status: 'published', proposed_by: 'acc-1' }] }); // SELECT FOR UPDATE

    await expect(
      changesetService.retractChangeset('cs-1', 'acc-1', { reason: 'changed mind' })
    ).rejects.toMatchObject({ name: 'LifecycleError' });
  });

  it('resubmitChangeset throws LifecycleError for proposed changeset', async () => {
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'cs-1', status: 'proposed', proposed_by: 'acc-1' }] }); // SELECT FOR UPDATE

    await expect(
      changesetService.resubmitChangeset('cs-1', 'acc-1', {})
    ).rejects.toMatchObject({ name: 'LifecycleError' });
  });

  it('escalateToReview throws LifecycleError for retracted changeset', async () => {
    // escalateToReview uses pool.query (not client transaction)
    mockPool.query
      .mockResolvedValueOnce({ rows: [] }) // UPDATE ... WHERE status='proposed' → no match
      .mockResolvedValueOnce({ rows: [{ status: 'retracted' }] }); // exists check

    await expect(
      changesetService.escalateToReview('cs-1', 'acc-1')
    ).rejects.toMatchObject({ name: 'LifecycleError' });
  });
});
