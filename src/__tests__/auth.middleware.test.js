const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Mock database
const mockQuery = jest.fn();
jest.mock('../config/database', () => ({
  getPool: () => ({ query: mockQuery }),
}));

const { authenticateRequired, authenticateOptional, requireStatus } = require('../middleware/auth');

const JWT_SECRET = 'test-jwt-secret-for-testing';

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
});

beforeEach(() => {
  mockQuery.mockReset();
});

function mockReq(overrides = {}) {
  return {
    headers: {},
    cookies: {},
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(data) { res.body = data; return res; },
  };
  return res;
}

describe('authenticateRequired', () => {
  it('should authenticate with valid JWT cookie', async () => {
    const token = jwt.sign(
      { sub: 'uuid-1', type: 'ai', status: 'active' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-1', type: 'ai', status: 'active' }],
    });

    const req = mockReq({ cookies: { aingram_token: token } });
    const res = mockRes();
    const next = jest.fn();

    await authenticateRequired(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.account).toMatchObject({ id: 'uuid-1', type: 'ai', status: 'active', lang: 'en', parentId: null, tier: 0, badgeContribution: false, badgePolicing: false, badgeElite: false, reputationCopyright: 0.5 });
  });

  it('should authenticate with valid new-format Bearer API key', async () => {
    const secret = 'a'.repeat(24);
    const hash = await bcrypt.hash(secret, 4);
    const apiKey = `aingram_ab12cd34_${secret}`;

    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-2', type: 'human', status: 'active', api_key_hash: hash, api_key_prefix: 'ab12cd34' }],
    });

    const req = mockReq({
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });
    const res = mockRes();
    const next = jest.fn();

    await authenticateRequired(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.account).toMatchObject({ id: 'uuid-2', type: 'human', status: 'active', lang: 'en', parentId: null, tier: 0, badgeContribution: false, badgePolicing: false, badgeElite: false, reputationCopyright: 0.5 });
  });

  it('should reject missing auth', async () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await authenticateRequired(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('should reject expired JWT', async () => {
    const token = jwt.sign(
      { sub: 'uuid-1', type: 'ai', status: 'active' },
      JWT_SECRET,
      { expiresIn: '-1h' } // already expired
    );

    const req = mockReq({ cookies: { aingram_token: token } });
    const res = mockRes();
    const next = jest.fn();

    await authenticateRequired(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('should reject Bearer with unrecognized format and no X-Account-Email', async () => {
    const req = mockReq({
      headers: { authorization: 'Bearer somekey' },
    });
    const res = mockRes();
    const next = jest.fn();

    await authenticateRequired(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('should authenticate with legacy key + X-Account-Email (deprecated)', async () => {
    const apiKey = 'a'.repeat(64);
    const hash = await bcrypt.hash(apiKey, 4);

    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-3', type: 'ai', status: 'active', api_key_hash: hash }],
    });

    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

    const req = mockReq({
      headers: {
        authorization: `Bearer ${apiKey}`,
        'x-account-email': 'legacy@test.com',
      },
    });
    const res = mockRes();
    const next = jest.fn();

    await authenticateRequired(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.account).toMatchObject({ id: 'uuid-3', type: 'ai', status: 'active', lang: 'en', parentId: null, tier: 0, badgeContribution: false, badgePolicing: false, badgeElite: false, reputationCopyright: 0.5 });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('DEPRECATION'));

    consoleSpy.mockRestore();
  });

  it('should reject banned accounts', async () => {
    const token = jwt.sign(
      { sub: 'uuid-1', type: 'ai', status: 'banned' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-1', type: 'ai', status: 'banned' }],
    });

    const req = mockReq({ cookies: { aingram_token: token } });
    const res = mockRes();
    const next = jest.fn();

    await authenticateRequired(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('should reject wrong API key secret (new format)', async () => {
    const correctSecret = 'a'.repeat(24);
    const wrongSecret = 'b'.repeat(24);
    const hash = await bcrypt.hash(correctSecret, 4);

    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-2', type: 'ai', status: 'active', api_key_hash: hash, api_key_prefix: 'ab12cd34' }],
    });

    const req = mockReq({
      headers: {
        authorization: `Bearer aingram_ab12cd34_${wrongSecret}`,
      },
    });
    const res = mockRes();
    const next = jest.fn();

    await authenticateRequired(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('authenticateOptional', () => {
  it('should set req.account if valid JWT cookie present', async () => {
    const token = jwt.sign(
      { sub: 'uuid-1', type: 'human', status: 'active' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-1', type: 'human', status: 'active' }],
    });

    const req = mockReq({ cookies: { aingram_token: token } });
    const res = mockRes();
    const next = jest.fn();

    await authenticateOptional(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.account).toMatchObject({ id: 'uuid-1', type: 'human', status: 'active', lang: 'en', parentId: null, tier: 0, badgeContribution: false, badgePolicing: false, badgeElite: false, reputationCopyright: 0.5 });
  });

  it('should pass through without setting req.account if no auth', async () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await authenticateOptional(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.account).toBeUndefined();
  });

  it('should pass through on invalid token without error', async () => {
    const req = mockReq({ cookies: { aingram_token: 'invalidtoken' } });
    const res = mockRes();
    const next = jest.fn();

    await authenticateOptional(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.account).toBeUndefined();
  });
});

describe('requireStatus', () => {
  it('should pass when account status matches', () => {
    const middleware = requireStatus('active', 'provisional');
    const req = { account: { id: 'uuid-1', type: 'ai', status: 'active' } };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('should return 403 when status does not match', () => {
    const middleware = requireStatus('active');
    const req = { account: { id: 'uuid-1', type: 'ai', status: 'suspended' } };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('should return 401 when no account', () => {
    const middleware = requireStatus('active');
    const req = {};
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
