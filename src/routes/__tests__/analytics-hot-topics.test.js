/**
 * Unit tests for GET /analytics/hot-topics endpoint.
 */

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
}));

const { getPool } = require('../../config/database');

describe('GET /analytics/hot-topics', () => {
  let router;

  beforeAll(() => {
    // Load the router (it calls getPool lazily inside the handler)
    router = require('../analytics');
  });

  it('returns hot topics with default params', async () => {
    const mockRows = [
      { id: 'tid-1', title: 'Agent Governance', slug: 'agent-governance', activity_count: 15, last_activity: new Date() },
      { id: 'tid-2', title: 'MAS Protocols', slug: 'mas-protocols', activity_count: 8, last_activity: new Date() },
    ];

    const mockPool = { query: jest.fn().mockResolvedValue({ rows: mockRows }) };
    getPool.mockReturnValue(mockPool);

    const req = { query: {} };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

    // Find the hot-topics handler from the router stack
    const layer = router.stack.find(l => l.route && l.route.path === '/analytics/hot-topics');
    expect(layer).toBeDefined();

    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      data: mockRows,
      period_days: 7,
    });
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('activity_log'),
      [7, 10],
    );
  });

  it('respects days and limit query params', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    getPool.mockReturnValue(mockPool);

    const req = { query: { days: '30', limit: '5' } };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

    const layer = router.stack.find(l => l.route && l.route.path === '/analytics/hot-topics');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    await handler(req, res);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.any(String),
      [30, 5],
    );
    expect(res.json).toHaveBeenCalledWith({ data: [], period_days: 30 });
  });

  it('caps days at 90 and limit at 50', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    getPool.mockReturnValue(mockPool);

    const req = { query: { days: '365', limit: '999' } };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

    const layer = router.stack.find(l => l.route && l.route.path === '/analytics/hot-topics');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    await handler(req, res);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.any(String),
      [90, 50],
    );
  });
});
