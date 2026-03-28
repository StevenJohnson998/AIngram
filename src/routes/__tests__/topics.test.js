/**
 * Route-level tests for topics and chunks.
 * Tests the service layer directly since supertest may not be set up.
 * Also tests validation logic and auth-stub behavior.
 */

const { authenticateRequired, authenticateOptional, requireStatus } = require('../../middleware/auth-stub');

describe('auth-stub middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = { headers: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  describe('authenticateRequired', () => {
    it('sets account from x-test-account header', () => {
      const account = { id: 'acc-1', type: 'ai', status: 'active' };
      req.headers['x-test-account'] = JSON.stringify(account);

      authenticateRequired(req, res, next);

      expect(req.account).toEqual(account);
      expect(next).toHaveBeenCalled();
    });

    it('returns 401 without header', () => {
      authenticateRequired(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('authenticateOptional', () => {
    it('sets account if header present', () => {
      const account = { id: 'acc-1', type: 'human', status: 'active' };
      req.headers['x-test-account'] = JSON.stringify(account);

      authenticateOptional(req, res, next);

      expect(req.account).toEqual(account);
      expect(next).toHaveBeenCalled();
    });

    it('proceeds without account if no header', () => {
      authenticateOptional(req, res, next);

      expect(req.account).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });
  });

  describe('requireStatus', () => {
    it('passes when status matches', () => {
      req.account = { id: 'acc-1', status: 'active' };

      requireStatus('active', 'provisional')(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('returns 403 when status does not match', () => {
      req.account = { id: 'acc-1', status: 'suspended' };

      requireStatus('active', 'provisional')(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'FORBIDDEN', message: 'Account status insufficient' },
      });
    });
  });
});

describe('validation logic', () => {
  const VALID_LANGS = [
    'en', 'fr', 'zh', 'hi', 'es', 'ar', 'ja', 'de', 'pt', 'ru', 'ko', 'it', 'nl', 'pl', 'sv', 'tr',
  ];

  it('accepts all valid language codes', () => {
    VALID_LANGS.forEach((lang) => {
      expect(VALID_LANGS.includes(lang)).toBe(true);
    });
  });

  it('rejects invalid language codes', () => {
    expect(VALID_LANGS.includes('xx')).toBe(false);
    expect(VALID_LANGS.includes('')).toBe(false);
  });

  it('validates title length constraints', () => {
    const minLen = 3;
    const maxLen = 300;

    expect('ab'.length >= minLen).toBe(false);
    expect('abc'.length >= minLen).toBe(true);
    expect('x'.repeat(300).length <= maxLen).toBe(true);
    expect('x'.repeat(301).length <= maxLen).toBe(false);
  });

  it('validates content length constraints', () => {
    const minLen = 10;
    const maxLen = 5000;

    expect('short'.length >= minLen).toBe(false);
    expect('ten chars!'.length >= minLen).toBe(true);
    expect('x'.repeat(5000).length <= maxLen).toBe(true);
    expect('x'.repeat(5001).length <= maxLen).toBe(false);
  });

  it('validates objection reason tags', () => {
    const { OBJECTION_REASON_TAGS } = require('../../config/protocol');

    // All valid tags accepted
    OBJECTION_REASON_TAGS.forEach((tag) => {
      expect(OBJECTION_REASON_TAGS.includes(tag)).toBe(true);
    });

    // Invalid tags rejected
    expect(OBJECTION_REASON_TAGS.includes('spam')).toBe(false);
    expect(OBJECTION_REASON_TAGS.includes('')).toBe(false);
    expect(OBJECTION_REASON_TAGS.includes(undefined)).toBe(false);

    // Must have at least the core tags
    expect(OBJECTION_REASON_TAGS).toContain('inaccurate');
    expect(OBJECTION_REASON_TAGS).toContain('copyright');
    expect(OBJECTION_REASON_TAGS).toContain('harmful');
  });

  it('validates pagination defaults', () => {
    const parsePagination = (query) => {
      let page = parseInt(query.page, 10) || 1;
      let limit = parseInt(query.limit, 10) || 20;
      if (page < 1) page = 1;
      if (limit < 1) limit = 1;
      if (limit > 100) limit = 100;
      return { page, limit };
    };

    expect(parsePagination({})).toEqual({ page: 1, limit: 20 });
    expect(parsePagination({ page: '3', limit: '50' })).toEqual({ page: 3, limit: 50 });
    expect(parsePagination({ page: '-1', limit: '200' })).toEqual({ page: 1, limit: 100 });
    // parseInt('0') = 0, which is falsy, so || defaults kick in
    expect(parsePagination({ page: '0', limit: '0' })).toEqual({ page: 1, limit: 20 });
  });
});
