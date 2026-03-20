jest.mock('../../config/database');

const { getPool } = require('../../config/database');
const aiProviderService = require('../ai-provider');

describe('ai-provider service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
    process.env.JWT_SECRET = 'test-secret-for-encryption';
  });

  describe('createProvider', () => {
    it('creates a provider and returns it without api_key_encrypted', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // unset defaults (if isDefault)
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'prov-1', account_id: 'acc-1', name: 'My Claude',
          provider_type: 'claude', model: 'claude-sonnet-4-6',
          is_default: true, created_at: '2026-03-18T00:00:00Z',
        }],
      });

      const result = await aiProviderService.createProvider({
        accountId: 'acc-1', name: 'My Claude', providerType: 'claude',
        model: 'claude-sonnet-4-6', apiKey: 'sk-test', isDefault: true,
      });

      expect(result.name).toBe('My Claude');
      expect(result.provider_type).toBe('claude');
      expect(result.is_default).toBe(true);
      // Should not expose api_key_encrypted in the RETURNING clause
      expect(result.api_key_encrypted).toBeUndefined();
    });

    it('uses default endpoint for known provider types', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'prov-1', account_id: 'acc-1', name: 'Groq',
          provider_type: 'groq', api_endpoint: 'https://api.groq.com/openai/v1/chat/completions',
          model: 'llama3', is_default: false, created_at: '2026-03-18T00:00:00Z',
        }],
      });

      await aiProviderService.createProvider({
        accountId: 'acc-1', name: 'Groq', providerType: 'groq',
        model: 'llama3', apiKey: 'gsk-test',
      });

      const insertCall = mockPool.query.mock.calls[0];
      // The 4th param should be the default groq endpoint
      expect(insertCall[1][3]).toBe('https://api.groq.com/openai/v1/chat/completions');
    });
  });

  describe('listProviders', () => {
    it('returns providers sorted by default first', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'p1', name: 'Default', is_default: true },
          { id: 'p2', name: 'Other', is_default: false },
        ],
      });

      const result = await aiProviderService.listProviders('acc-1');
      expect(result).toHaveLength(2);
      expect(result[0].is_default).toBe(true);
    });
  });

  describe('getDefaultProvider', () => {
    it('returns the default provider', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'p1', name: 'Default', is_default: true }],
      });

      const result = await aiProviderService.getDefaultProvider('acc-1');
      expect(result.id).toBe('p1');
    });

    it('returns null when no providers exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await aiProviderService.getDefaultProvider('acc-1');
      expect(result).toBeNull();
    });
  });

  describe('updateProvider', () => {
    it('updates specified fields and sets updated_at', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'p1', name: 'Updated', model: 'new-model' }],
      });

      const result = await aiProviderService.updateProvider('p1', 'acc-1', {
        name: 'Updated', model: 'new-model',
      });

      expect(result.name).toBe('Updated');
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });

    it('returns null when no fields to update', async () => {
      const result = await aiProviderService.updateProvider('p1', 'acc-1', {});
      expect(result).toBeNull();
    });

    it('unsets other defaults when isDefault is true', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // unset defaults
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'p1', is_default: true }],
      });

      await aiProviderService.updateProvider('p1', 'acc-1', { isDefault: true });

      // First call should unset other defaults
      expect(mockPool.query.mock.calls[0][0]).toContain('is_default = false');
    });
  });

  describe('deleteProvider', () => {
    it('returns true when provider deleted', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'p1' }] });
      const result = await aiProviderService.deleteProvider('p1', 'acc-1');
      expect(result).toBe(true);
    });

    it('returns false when provider not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await aiProviderService.deleteProvider('p1', 'acc-1');
      expect(result).toBe(false);
    });
  });

  describe('module exports', () => {
    it('does not export decrypt (internal only)', () => {
      expect(aiProviderService.decrypt).toBeUndefined();
    });
  });
});
