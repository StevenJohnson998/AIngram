jest.mock('../../config/database');
jest.mock('../email', () => ({
  sendConfirmationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
}));

const { getPool } = require('../../config/database');
const accountService = require('../account');

describe('sub-account service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('createSubAccount', () => {
    it('creates active agent sub-account with key (default generateKey=true)', async () => {
      // findById for parent
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'parent-1', name: 'Human', type: 'human', owner_email: 'human@test.com',
          status: 'active', parent_id: null,
        }],
      });

      // INSERT sub-account
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'agent-1', name: 'MyBot', type: 'ai', owner_email: 'human@test.com',
          status: 'active', api_key_last4: 'abcd', parent_id: 'parent-1',
          created_at: '2026-03-18T00:00:00Z',
        }],
      });

      const result = await accountService.createSubAccount({ name: 'MyBot', parentId: 'parent-1' });

      expect(result.account.type).toBe('ai');
      expect(result.account.status).toBe('active');
      expect(result.account.parent_id).toBe('parent-1');
      expect(result.apiKey).toMatch(/^aingram_[0-9a-f]{8}_[0-9a-f]{24}$/);
    });

    it('creates pending agent sub-account without key when generateKey=false', async () => {
      // findById for parent
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'parent-1', name: 'Human', type: 'human', owner_email: 'human@test.com',
          status: 'active', parent_id: null,
        }],
      });

      // INSERT sub-account (pending)
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'agent-1', name: 'MyBot', type: 'ai', owner_email: 'human@test.com',
          status: 'pending', api_key_last4: null, parent_id: 'parent-1',
          created_at: '2026-03-18T00:00:00Z',
        }],
      });

      const result = await accountService.createSubAccount({ name: 'MyBot', parentId: 'parent-1', generateKey: false });

      expect(result.account.type).toBe('ai');
      expect(result.account.status).toBe('pending');
      expect(result.account.api_key_last4).toBeNull();
      expect(result.apiKey).toBeNull();

      // INSERT should not contain api_key_hash
      const insertCall = mockPool.query.mock.calls[1];
      expect(insertCall[0]).toContain("'pending'");
      expect(insertCall[0]).not.toContain('api_key_hash');
    });

    it('creates active assisted agent (autonomous=false) without API key', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'parent-1', name: 'Human', type: 'human', owner_email: 'human@test.com',
          status: 'active', parent_id: null,
        }],
      });

      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'agent-1', name: 'AssistBot', type: 'ai', owner_email: 'human@test.com',
          status: 'active', api_key_last4: null, parent_id: 'parent-1', autonomous: false,
          created_at: '2026-03-18T00:00:00Z',
        }],
      });

      const result = await accountService.createSubAccount({
        name: 'AssistBot', parentId: 'parent-1', autonomous: false,
      });

      expect(result.account.status).toBe('active');
      expect(result.account.autonomous).toBe(false);
      expect(result.apiKey).toBeNull();

      const insertCall = mockPool.query.mock.calls[1];
      expect(insertCall[0]).toContain("'active'");
      expect(insertCall[0]).toContain('autonomous');
      expect(insertCall[0]).not.toContain('api_key_hash');
    });

    it('rejects non-human parent', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'ai-1', type: 'ai', parent_id: null }],
      });

      await expect(
        accountService.createSubAccount({ name: 'Bot', parentId: 'ai-1' })
      ).rejects.toThrow('Only human accounts can create sub-accounts');
    });

    it('rejects sub-account creating sub-account', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'child-1', type: 'human', parent_id: 'parent-1' }],
      });

      await expect(
        accountService.createSubAccount({ name: 'Bot', parentId: 'child-1' })
      ).rejects.toThrow('Sub-accounts cannot create sub-accounts');
    });

    it('rejects missing parent', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        accountService.createSubAccount({ name: 'Bot', parentId: 'nonexistent' })
      ).rejects.toThrow('Parent account not found');
    });
  });

  describe('activateSubAccount', () => {
    it('generates API key and sets status active', async () => {
      // findById for sub-account
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'sub-1', name: 'MyBot', type: 'ai', owner_email: 'human@test.com',
          status: 'pending', parent_id: 'parent-1',
        }],
      });

      // UPDATE accounts
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'sub-1', name: 'MyBot', type: 'ai', owner_email: 'human@test.com',
          status: 'active', api_key_last4: 'abcd', parent_id: 'parent-1',
          created_at: '2026-03-18T00:00:00Z',
        }],
      });

      const result = await accountService.activateSubAccount('sub-1');

      expect(result.account.status).toBe('active');
      expect(result.apiKey).toMatch(/^aingram_[0-9a-f]{8}_[0-9a-f]{24}$/);

      // Verify UPDATE query sets status to active
      const updateCall = mockPool.query.mock.calls[1];
      expect(updateCall[0]).toContain("status = 'active'");
      expect(updateCall[0]).toContain('api_key_hash');
    });

    it('rejects non-existent sub-account', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        accountService.activateSubAccount('nonexistent')
      ).rejects.toThrow('Sub-account not found');
    });
  });

  describe('listSubAccounts', () => {
    it('returns sub-accounts for parent', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'agent-1', name: 'Bot1', status: 'active' },
          { id: 'agent-2', name: 'Bot2', status: 'pending' },
        ],
      });

      const result = await accountService.listSubAccounts('parent-1');
      expect(result).toHaveLength(2);
    });
  });

  describe('deactivateSubAccount', () => {
    it('bans a sub-account owned by caller', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'agent-1', name: 'Bot1', status: 'banned' }],
      });

      const result = await accountService.deactivateSubAccount('agent-1', 'parent-1');
      expect(result.status).toBe('banned');
    });

    it('rejects deactivation of non-owned sub-account', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        accountService.deactivateSubAccount('agent-1', 'wrong-parent')
      ).rejects.toThrow('Sub-account not found or not owned by you');
    });
  });

  describe('updateSubAccount', () => {
    it('renames a sub-account owned by caller', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'agent-1', name: 'NewName', type: 'ai', status: 'active',
          api_key_last4: 'abcd', autonomous: true, provider_id: null, description: null,
          created_at: '2026-03-18T00:00:00Z',
        }],
      });

      const result = await accountService.updateSubAccount('agent-1', 'parent-1', { name: 'NewName' });
      expect(result.name).toBe('NewName');
    });

    it('updates provider and description', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'agent-1', name: 'Bot', type: 'ai', status: 'active',
          api_key_last4: 'abcd', autonomous: false, provider_id: 'prov-1',
          description: 'A helpful bot', created_at: '2026-03-18T00:00:00Z',
        }],
      });

      const result = await accountService.updateSubAccount('agent-1', 'parent-1', {
        providerId: 'prov-1', description: 'A helpful bot',
      });
      expect(result.provider_id).toBe('prov-1');
      expect(result.description).toBe('A helpful bot');
    });

    it('clears provider with null', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'agent-1', name: 'Bot', type: 'ai', status: 'active',
          api_key_last4: null, autonomous: false, provider_id: null, description: null,
          created_at: '2026-03-18T00:00:00Z',
        }],
      });

      const result = await accountService.updateSubAccount('agent-1', 'parent-1', { providerId: null });
      expect(result.provider_id).toBeNull();
    });

    it('rejects not found sub-account', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        accountService.updateSubAccount('nonexistent', 'parent-1', { name: 'Foo' })
      ).rejects.toThrow('Sub-account not found or not owned by you');
    });

    it('rejects name too short', async () => {
      await expect(
        accountService.updateSubAccount('agent-1', 'parent-1', { name: 'A' })
      ).rejects.toThrow('name must be between 2 and 100 characters');
    });

    it('rejects no fields', async () => {
      await expect(
        accountService.updateSubAccount('agent-1', 'parent-1', {})
      ).rejects.toThrow('No fields to update');
    });

    it('rejects description too long', async () => {
      await expect(
        accountService.updateSubAccount('agent-1', 'parent-1', { description: 'x'.repeat(2001) })
      ).rejects.toThrow('Description must be at most 2000 characters');
    });
  });

  describe('reactivateSubAccount', () => {
    it('reactivates banned assisted agent to active', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'agent-1', status: 'banned', autonomous: false, api_key_last4: null }],
      });
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'agent-1', name: 'AssistBot', type: 'ai', status: 'active',
          api_key_last4: null, autonomous: false, created_at: '2026-03-18T00:00:00Z',
        }],
      });

      const result = await accountService.reactivateSubAccount('agent-1', 'parent-1');
      expect(result.status).toBe('active');
    });

    it('reactivates banned autonomous agent without key to pending', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'agent-1', status: 'banned', autonomous: true, api_key_last4: null }],
      });
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'agent-1', name: 'AutBot', type: 'ai', status: 'pending',
          api_key_last4: null, autonomous: true, created_at: '2026-03-18T00:00:00Z',
        }],
      });

      const result = await accountService.reactivateSubAccount('agent-1', 'parent-1');
      expect(result.status).toBe('pending');
      // Verify it set status to 'pending'
      const updateCall = mockPool.query.mock.calls[1];
      expect(updateCall[1][0]).toBe('pending');
    });

    it('rejects not found sub-account', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        accountService.reactivateSubAccount('nonexistent', 'parent-1')
      ).rejects.toThrow('Sub-account not found or not owned by you');
    });

    it('rejects non-banned sub-account', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'agent-1', status: 'active', autonomous: true, api_key_last4: 'abcd' }],
      });

      await expect(
        accountService.reactivateSubAccount('agent-1', 'parent-1')
      ).rejects.toThrow('Sub-account is not deactivated');
    });
  });
});
