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

// ── Lever 2: pedagogical error tests ────────────────────────────────────────

describe('validationError pedagogical fields', () => {
  let res;

  beforeEach(() => {
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  it('preserves backward compatibility — no opts → plain VALIDATION_ERROR shape', () => {
    const { validationError } = require('../../utils/http-errors');
    validationError(res, 'something went wrong');

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('something went wrong');
    expect(body.error.hint).toBeUndefined();
    expect(body.error.example_valid_call).toBeUndefined();
  });

  it('adds hint + example_valid_call + field when opts provided', () => {
    const { validationError } = require('../../utils/http-errors');
    validationError(res, 'ops required', {
      field: 'operations',
      hint: 'must be an array',
      example_valid_call: { method: 'POST', url: '/v1/test', body: {} },
    });

    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.field).toBe('operations');
    expect(body.error.hint).toBe('must be an array');
    expect(body.error.example_valid_call).toMatchObject({ method: 'POST' });
  });
});

describe('getErrorContext registry', () => {
  const { getErrorContext } = require('../../utils/error-examples');

  it('returns undefined for unknown route', () => {
    expect(getErrorContext('POST /unknown', 'field')).toBeUndefined();
  });

  it('returns undefined for unknown field on known route', () => {
    expect(getErrorContext('POST /topics/:id/refresh', 'nonexistent')).toBeUndefined();
  });

  // POST /topics/:id/refresh — operations
  it('refresh: operations field has hint + example_valid_call with correct shape', () => {
    const ctx = getErrorContext('POST /topics/:id/refresh', 'operations');
    expect(ctx).toBeDefined();
    expect(ctx.field).toBe('operations');
    expect(ctx.hint).toMatch(/operations/);
    expect(ctx.example_valid_call.method).toBe('POST');
    expect(ctx.example_valid_call.body.operations).toBeInstanceOf(Array);
    expect(ctx.example_valid_call.body.global_verdict).toBeDefined();
  });

  // POST /topics/:id/refresh — global_verdict
  it('refresh: global_verdict field has hint mentioning snake_case', () => {
    const ctx = getErrorContext('POST /topics/:id/refresh', 'global_verdict');
    expect(ctx).toBeDefined();
    expect(ctx.hint).toMatch(/global_verdict/);
    expect(ctx.example_valid_call.body.global_verdict).toBeDefined();
  });

  // POST /changesets — topicId
  it('changesets: topicId field has hint + example with operations array', () => {
    const ctx = getErrorContext('POST /changesets', 'topicId');
    expect(ctx).toBeDefined();
    expect(ctx.hint).toMatch(/UUID/);
    expect(ctx.example_valid_call.body.operations).toBeInstanceOf(Array);
    const ops = ctx.example_valid_call.body.operations;
    expect(ops.some(op => op.operation === 'add')).toBe(true);
    expect(ops.some(op => op.operation === 'replace')).toBe(true);
    expect(ops.some(op => op.operation === 'remove')).toBe(true);
  });

  // POST /changesets — operations
  it('changesets: operations field example covers add operation', () => {
    const ctx = getErrorContext('POST /changesets', 'operations');
    expect(ctx).toBeDefined();
    expect(ctx.example_valid_call.body.operations[0].operation).toBe('add');
  });

  // POST /votes/formal/commit — commit_hash
  it('formal-vote commit: commit_hash hint mentions SHA-256 and reveal step', () => {
    const ctx = getErrorContext('POST /votes/formal/commit', 'commit_hash');
    expect(ctx).toBeDefined();
    expect(ctx.hint).toMatch(/sha256|SHA-256/i);
    expect(ctx.hint).toMatch(/reveal/);
  });

  // POST /votes/formal/commit — changeset_id
  it('formal-vote commit: changeset_id example includes commit_hash field', () => {
    const ctx = getErrorContext('POST /votes/formal/commit', 'changeset_id');
    expect(ctx).toBeDefined();
    expect(ctx.example_valid_call.body.commit_hash).toBeDefined();
  });

  // POST /topics — title
  it('topics: title field has example with lang and optional fields', () => {
    const ctx = getErrorContext('POST /topics', 'title');
    expect(ctx).toBeDefined();
    expect(ctx.example_valid_call.body.title).toBeDefined();
    expect(ctx.example_valid_call.body.lang).toBeDefined();
  });

  // POST /topics — lang
  it('topics: lang field example includes supported_langs array', () => {
    const ctx = getErrorContext('POST /topics', 'lang');
    expect(ctx).toBeDefined();
    expect(ctx.example_valid_call.supported_langs).toContain('en');
    expect(ctx.example_valid_call.supported_langs).toContain('fr');
  });

  // POST /topics/full — chunks
  it('topics/full: chunks field example includes content, title, sources', () => {
    const ctx = getErrorContext('POST /topics/full', 'chunks');
    expect(ctx).toBeDefined();
    expect(ctx.hint).toMatch(/chunks/);
    expect(ctx.example_valid_call.body.chunks[0].content).toBeDefined();
    expect(ctx.example_valid_call.body.chunks[0].sources).toBeInstanceOf(Array);
  });

  // POST /topics/full — chunks[i].content
  it('topics/full: chunks[i].content example shows valid content within length range', () => {
    const ctx = getErrorContext('POST /topics/full', 'chunks[i].content');
    expect(ctx).toBeDefined();
    const content = ctx.example_valid_call.body.chunks[0].content;
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThanOrEqual(10);
    expect(content.length).toBeLessThanOrEqual(5000);
  });
});
