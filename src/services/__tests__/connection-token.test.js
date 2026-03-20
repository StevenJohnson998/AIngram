jest.mock('../../config/database');
jest.mock('../email', () => ({
  sendConfirmationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
}));

const { getPool } = require('../../config/database');
const connectionTokenService = require('../connection-token');

describe('connection-token service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('createConnectionToken', () => {
    it('creates a token linked to a sub-account', async () => {
      // findById for sub-account (ownership check)
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'sub-1', parent_id: 'parent-1', type: 'ai', status: 'pending' }],
      });
      // COUNT query
      mockPool.query.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
      // INSERT
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await connectionTokenService.createConnectionToken('parent-1', 'sub-1');

      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Verify INSERT includes sub_account_id
      const insertCall = mockPool.query.mock.calls[2];
      expect(insertCall[0]).toContain('INSERT INTO connection_tokens');
      expect(insertCall[1][0]).toBe('parent-1');
      // token_hash should be 64 hex chars (SHA-256)
      expect(insertCall[1][1]).toMatch(/^[0-9a-f]{64}$/);
      // Should NOT be the plaintext token
      expect(insertCall[1][1]).not.toBe(result.token);
      // sub_account_id
      expect(insertCall[1][3]).toBe('sub-1');
    });

    it('rejects when sub-account does not belong to parent', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'sub-1', parent_id: 'other-parent', type: 'ai', status: 'pending' }],
      });

      await expect(
        connectionTokenService.createConnectionToken('parent-1', 'sub-1')
      ).rejects.toThrow('Sub-account not found or not owned by you');
    });

    it('rejects when sub-account not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        connectionTokenService.createConnectionToken('parent-1', 'nonexistent')
      ).rejects.toThrow('Sub-account not found or not owned by you');
    });

    it('rejects when at max unused tokens', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'sub-1', parent_id: 'parent-1', type: 'ai', status: 'pending' }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [{ cnt: '5' }] });

      await expect(
        connectionTokenService.createConnectionToken('parent-1', 'sub-1')
      ).rejects.toThrow('Too many active connection tokens');
    });

    it('allows creation when existing tokens are below limit', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'sub-1', parent_id: 'parent-1', type: 'ai', status: 'pending' }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [{ cnt: '4' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await connectionTokenService.createConnectionToken('parent-1', 'sub-1');
      expect(result.token).toBeTruthy();
    });
  });

  describe('redeemConnectionToken', () => {
    it('redeems valid token and activates sub-account', async () => {
      // UPDATE connection_tokens (mark used)
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'token-1', account_id: 'parent-1', sub_account_id: 'sub-1' }],
      });

      // findById for sub-account (called by activateSubAccount)
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'sub-1', name: 'MyBot', type: 'ai', owner_email: 'human@test.com',
          status: 'pending', parent_id: 'parent-1',
        }],
      });

      // UPDATE accounts (activate)
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'sub-1', name: 'MyBot', type: 'ai', owner_email: 'human@test.com',
          status: 'active', api_key_last4: 'abcd', parent_id: 'parent-1',
          created_at: '2026-03-18T00:00:00Z',
        }],
      });

      const result = await connectionTokenService.redeemConnectionToken('a'.repeat(64));

      expect(result.account.type).toBe('ai');
      expect(result.account.status).toBe('active');
      expect(result.account.parent_id).toBe('parent-1');
      expect(result.apiKey).toMatch(/^aingram_[0-9a-f]{8}_[0-9a-f]{24}$/);
    });

    it('rejects invalid/expired/used token', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        connectionTokenService.redeemConnectionToken('bad-token')
      ).rejects.toThrow('Invalid, expired, or already used connection token');
    });

    it('marks token as used atomically (UPDATE with WHERE)', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'token-1', account_id: 'parent-1', sub_account_id: 'sub-1' }],
      });
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'sub-1', type: 'ai', owner_email: 'h@t.com', status: 'pending', parent_id: 'parent-1' }],
      });
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'sub-1', name: 'Bot', type: 'ai', status: 'active', parent_id: 'parent-1' }],
      });

      await connectionTokenService.redeemConnectionToken('a'.repeat(64));

      // First query should be the atomic UPDATE
      const updateCall = mockPool.query.mock.calls[0];
      expect(updateCall[0]).toContain('UPDATE connection_tokens');
      expect(updateCall[0]).toContain('SET used_at = NOW()');
      expect(updateCall[0]).toContain('used_at IS NULL');
      expect(updateCall[0]).toContain('expires_at > NOW()');
    });
  });
});
