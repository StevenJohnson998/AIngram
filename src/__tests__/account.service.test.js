const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Mock database
const mockQuery = jest.fn();
jest.mock('../config/database', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Mock email service
const mockSendConfirmation = jest.fn();
const mockSendPasswordReset = jest.fn();
jest.mock('../services/email', () => ({
  sendConfirmationEmail: (...args) => mockSendConfirmation(...args),
  sendPasswordResetEmail: (...args) => mockSendPasswordReset(...args),
  isConfigured: () => false,
}));

const accountService = require('../services/account');

beforeEach(() => {
  mockQuery.mockReset();
  mockSendConfirmation.mockReset();
  mockSendPasswordReset.mockReset();
});

describe('accountService', () => {
  describe('createAccount', () => {
    it('should create account with hashed password and new-format API key', async () => {
      // No existing account
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // INSERT returns account
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'test-uuid',
          name: 'TestAgent',
          type: 'ai',
          owner_email: 'agent@test.com',
          status: 'provisional',
          api_key_last4: 'abcd',
          email_confirmed: false,
          created_at: new Date().toISOString(),
        }],
      });

      const result = await accountService.createAccount({
        name: 'TestAgent',
        type: 'ai',
        ownerEmail: 'agent@test.com',
        password: 'securepassword123',
      });

      expect(result.account).toBeDefined();
      expect(result.apiKey).toBeDefined();
      // New format: aingram_<8hex>_<24hex> = 8 + 1 + 8 + 1 + 24 = 42 chars
      expect(result.apiKey).toMatch(/^aingram_[0-9a-f]{8}_[0-9a-f]{24}$/);
      expect(result.account.name).toBe('TestAgent');
      expect(result.account.type).toBe('ai');

      // Check that INSERT was called with hashed values
      const insertCall = mockQuery.mock.calls[1];
      const [, params] = insertCall;
      // params: name, type, ownerEmail, passwordHash, apiKeyHash, prefix, apiKeyLast4, expiresAt, confirmTokenHash, confirmTokenExpires
      expect(params[0]).toBe('TestAgent');
      expect(params[1]).toBe('ai');
      expect(params[2]).toBe('agent@test.com');
      // Password hash should start with $2a$ or $2b$
      expect(params[3]).toMatch(/^\$2[ab]\$/);
      // API key hash (of secret part only)
      expect(params[4]).toMatch(/^\$2[ab]\$/);
      // Prefix: 8 hex chars
      expect(params[5]).toMatch(/^[0-9a-f]{8}$/);
      // Last 4 chars
      expect(params[6]).toHaveLength(4);
      // Confirmation token hash (SHA-256 = 64 hex chars)
      expect(params[8]).toMatch(/^[0-9a-f]{64}$/);
      // Confirmation token expiry
      expect(params[9]).toBeInstanceOf(Date);

      // Email should have been called
      expect(mockSendConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({ owner_email: 'agent@test.com' }),
        expect.stringMatching(/^[0-9a-f]{64}$/)
      );
    });

    it('should throw CONFLICT if email already exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }] });

      await expect(
        accountService.createAccount({
          name: 'Test',
          type: 'human',
          ownerEmail: 'existing@test.com',
          password: 'password123',
        })
      ).rejects.toThrow('An account with this email already exists');
    });
  });

  describe('findByEmail', () => {
    it('should return account when found', async () => {
      const mockAccount = { id: 'uuid-1', name: 'Agent1', owner_email: 'a@b.com' };
      mockQuery.mockResolvedValueOnce({ rows: [mockAccount] });

      const result = await accountService.findByEmail('a@b.com');
      expect(result).toEqual(mockAccount);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('owner_email'),
        ['a@b.com']
      );
    });

    it('should return null when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await accountService.findByEmail('nobody@test.com');
      expect(result).toBeNull();
    });
  });

  describe('findById', () => {
    it('should return account when found', async () => {
      const mockAccount = { id: 'uuid-1', name: 'Agent1' };
      mockQuery.mockResolvedValueOnce({ rows: [mockAccount] });

      const result = await accountService.findById('uuid-1');
      expect(result).toEqual(mockAccount);
    });

    it('should return null when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await accountService.findById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('verifyPassword', () => {
    it('should return true for correct password', async () => {
      const hash = await bcrypt.hash('mypassword', 4); // low rounds for speed
      const account = { password_hash: hash };
      const result = await accountService.verifyPassword(account, 'mypassword');
      expect(result).toBe(true);
    });

    it('should return false for wrong password', async () => {
      const hash = await bcrypt.hash('mypassword', 4);
      const account = { password_hash: hash };
      const result = await accountService.verifyPassword(account, 'wrongpassword');
      expect(result).toBe(false);
    });

    it('should return false if no password_hash', async () => {
      const result = await accountService.verifyPassword({}, 'password');
      expect(result).toBe(false);
    });
  });

  describe('verifyApiKey', () => {
    it('should return true for correct secret', async () => {
      const secret = 'a'.repeat(24);
      const hash = await bcrypt.hash(secret, 4);
      const account = { api_key_hash: hash };
      const result = await accountService.verifyApiKey(account, secret);
      expect(result).toBe(true);
    });

    it('should return false for wrong secret', async () => {
      const hash = await bcrypt.hash('correctsecret', 4);
      const account = { api_key_hash: hash };
      const result = await accountService.verifyApiKey(account, 'wrongsecret');
      expect(result).toBe(false);
    });

    it('should return false if no api_key_hash', async () => {
      const result = await accountService.verifyApiKey({}, 'key');
      expect(result).toBe(false);
    });
  });

  describe('parseApiKey', () => {
    it('should parse valid new-format key', () => {
      const result = accountService.parseApiKey('aingram_ab12cd34_' + 'a'.repeat(24));
      expect(result).toEqual({ prefix: 'ab12cd34', secret: 'a'.repeat(24) });
    });

    it('should return null for legacy hex key', () => {
      const result = accountService.parseApiKey('a'.repeat(64));
      expect(result).toBeNull();
    });

    it('should return null for null/undefined', () => {
      expect(accountService.parseApiKey(null)).toBeNull();
      expect(accountService.parseApiKey(undefined)).toBeNull();
    });

    it('should return null for malformed key', () => {
      expect(accountService.parseApiKey('aingram_short_key')).toBeNull();
      expect(accountService.parseApiKey('aingram_ab12cd34')).toBeNull();
      expect(accountService.parseApiKey('notaingram_ab12cd34_' + 'a'.repeat(24))).toBeNull();
    });
  });

  describe('findByApiKeyPrefix', () => {
    it('should return account when prefix matches', async () => {
      const mockAccount = { id: 'uuid-1', name: 'Agent1', api_key_prefix: 'ab12cd34' };
      mockQuery.mockResolvedValueOnce({ rows: [mockAccount] });

      const result = await accountService.findByApiKeyPrefix('ab12cd34');
      expect(result).toEqual(mockAccount);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('api_key_prefix'),
        ['ab12cd34']
      );
    });

    it('should return null when no match', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await accountService.findByApiKeyPrefix('deadbeef');
      expect(result).toBeNull();
    });
  });

  describe('rotateApiKey', () => {
    it('should generate new-format key and update database', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await accountService.rotateApiKey('uuid-1');
      expect(result.apiKey).toMatch(/^aingram_[0-9a-f]{8}_[0-9a-f]{24}$/);
      expect(result.apiKeyLast4).toHaveLength(4);
      expect(result.apiKey.endsWith(result.apiKeyLast4)).toBe(true);

      // Check UPDATE was called with prefix
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('api_key_prefix'),
        expect.arrayContaining(['uuid-1'])
      );
    });
  });

  describe('revokeApiKey', () => {
    it('should null out api_key fields including prefix', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await accountService.revokeApiKey('uuid-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('api_key_hash = NULL'),
        ['uuid-1']
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('api_key_prefix = NULL'),
        ['uuid-1']
      );
    });
  });

  describe('updateProfile', () => {
    it('should update name and avatarUrl', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', name: 'NewName', avatar_url: 'https://example.com/avatar.png' }],
      });

      const result = await accountService.updateProfile('uuid-1', {
        name: 'NewName',
        avatarUrl: 'https://example.com/avatar.png',
      });

      expect(result.name).toBe('NewName');
    });

    it('should return null if no fields provided', async () => {
      const result = await accountService.updateProfile('uuid-1', {});
      expect(result).toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('getPublicProfile', () => {
    it('should return only safe fields', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'uuid-1',
          name: 'Public',
          type: 'ai',
          avatar_url: null,
          reputation_contribution: 0.5,
          reputation_policing: 0.3,
          badge_contribution: true,
          badge_policing: false,
          created_at: '2026-01-01',
        }],
      });

      const result = await accountService.getPublicProfile('uuid-1');
      expect(result).toBeDefined();
      expect(result.id).toBe('uuid-1');
      // Should NOT contain sensitive fields
      expect(result.password_hash).toBeUndefined();
      expect(result.api_key_hash).toBeUndefined();
      expect(result.owner_email).toBeUndefined();
    });
  });

  describe('toSafeAccount', () => {
    it('should strip password_hash and api_key_hash', () => {
      const account = {
        id: 'uuid-1',
        name: 'Test',
        password_hash: '$2b$12$xxx',
        api_key_hash: '$2b$10$yyy',
        owner_email: 'test@test.com',
      };
      const safe = accountService.toSafeAccount(account);
      expect(safe.password_hash).toBeUndefined();
      expect(safe.api_key_hash).toBeUndefined();
      expect(safe.id).toBe('uuid-1');
      expect(safe.owner_email).toBe('test@test.com');
    });

    it('should return null for null input', () => {
      expect(accountService.toSafeAccount(null)).toBeNull();
    });
  });

  describe('confirmEmailByToken', () => {
    it('should confirm email with valid token', async () => {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'uuid-1',
          name: 'Test',
          type: 'ai',
          owner_email: 'test@test.com',
          status: 'provisional',
          email_confirmed: true,
        }],
      });

      const result = await accountService.confirmEmailByToken(token);
      expect(result).toBeDefined();
      expect(result.email_confirmed).toBe(true);

      // Check the query used the hashed token
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('email_confirm_token_hash'),
        [tokenHash]
      );
    });

    it('should return null for invalid/expired token', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await accountService.confirmEmailByToken('invalid-token');
      expect(result).toBeNull();
    });
  });

  describe('requestPasswordReset', () => {
    it('should store hashed token and send email for existing account', async () => {
      // findByEmail returns account
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'uuid-1',
          name: 'Test',
          owner_email: 'test@test.com',
          password_hash: '$2b$12$hash',
        }],
      });
      // UPDATE stores token
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await accountService.requestPasswordReset('test@test.com');

      // Should have called UPDATE with hashed token
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain('password_reset_token_hash');
      // Token hash should be 64 hex chars
      expect(updateCall[1][0]).toMatch(/^[0-9a-f]{64}$/);
      // Expiry should be a Date
      expect(updateCall[1][1]).toBeInstanceOf(Date);

      // Email should have been sent
      expect(mockSendPasswordReset).toHaveBeenCalledWith(
        'test@test.com',
        expect.stringMatching(/^[0-9a-f]{64}$/)
      );
    });

    it('should silently do nothing for non-existent email', async () => {
      // findByEmail returns null
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await accountService.requestPasswordReset('nobody@test.com');

      // Only the SELECT was called, no UPDATE
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockSendPasswordReset).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('should reset password with valid token', async () => {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      // Lookup by token hash
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'uuid-1' }],
      });
      // UPDATE password
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'uuid-1',
          name: 'Test',
          type: 'human',
          owner_email: 'test@test.com',
          status: 'active',
          email_confirmed: true,
        }],
      });

      const result = await accountService.resetPassword(token, 'newpassword123');
      expect(result).toBeDefined();
      expect(result.id).toBe('uuid-1');

      // Check lookup used hashed token
      expect(mockQuery.mock.calls[0][1]).toEqual([tokenHash]);

      // Check UPDATE stored a bcrypt hash
      const updateParams = mockQuery.mock.calls[1][1];
      expect(updateParams[0]).toMatch(/^\$2[ab]\$/);
      expect(updateParams[1]).toBe('uuid-1');
    });

    it('should return null for invalid/expired token', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await accountService.resetPassword('bad-token', 'newpassword123');
      expect(result).toBeNull();
      // Only the lookup query, no UPDATE
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });
});
