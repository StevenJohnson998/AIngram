// Set env before any imports (rate-limit reads NODE_ENV at module load time)
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '5432';
process.env.DB_NAME = 'test';
process.env.DB_USER = 'test';
process.env.DB_PASSWORD = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Mock database
const mockQuery = jest.fn();
jest.mock('../config/database', () => ({
  getPool: () => ({ query: mockQuery }),
  closePool: jest.fn(),
}));

// Mock email service
jest.mock('../services/email', () => ({
  sendConfirmationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
  isConfigured: () => false,
}));

const JWT_SECRET = process.env.JWT_SECRET;

// Import app after env is set
const { app } = require('../index');

beforeEach(() => {
  mockQuery.mockReset();
});

describe('POST /accounts/register', () => {
  it('should register a new account', async () => {
    // No existing account
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // INSERT returns account
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-new',
        name: 'NewAgent',
        type: 'ai',
        owner_email: 'new@test.com',
        status: 'provisional',
        api_key_last4: 'abcd',
        email_confirmed: false,
        created_at: '2026-01-01T00:00:00.000Z',
      }],
    });

    const res = await request(app)
      .post('/accounts/register')
      .send({
        name: 'NewAgent',
        type: 'ai',
        ownerEmail: 'new@test.com',
        password: 'securepass123',
      });

    expect(res.status).toBe(201);
    expect(res.body.account).toBeDefined();
    expect(res.body.apiKey).toBeDefined();
    expect(res.body.apiKey).toMatch(/^aingram_[0-9a-f]{8}_[0-9a-f]{24}$/);
    expect(res.body.account.name).toBe('NewAgent');
  });

  it('should reject missing fields', async () => {
    const res = await request(app)
      .post('/accounts/register')
      .send({ name: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should reject invalid type', async () => {
    const res = await request(app)
      .post('/accounts/register')
      .send({
        name: 'Test',
        type: 'robot',
        ownerEmail: 'test@test.com',
        password: 'securepass123',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should reject short password', async () => {
    const res = await request(app)
      .post('/accounts/register')
      .send({
        name: 'Test',
        type: 'ai',
        ownerEmail: 'test@test.com',
        password: 'short',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should reject invalid email', async () => {
    const res = await request(app)
      .post('/accounts/register')
      .send({
        name: 'Test',
        type: 'ai',
        ownerEmail: 'not-an-email',
        password: 'securepass123',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 409 for duplicate email', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }] });

    const res = await request(app)
      .post('/accounts/register')
      .send({
        name: 'Test',
        type: 'ai',
        ownerEmail: 'existing@test.com',
        password: 'securepass123',
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});

describe('POST /accounts/login', () => {
  it('should login with valid credentials and set cookie', async () => {
    const passwordHash = await bcrypt.hash('password123', 4);
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1',
        name: 'TestUser',
        type: 'human',
        owner_email: 'user@test.com',
        password_hash: passwordHash,
        api_key_hash: null,
        status: 'active',
      }],
    });

    const res = await request(app)
      .post('/accounts/login')
      .send({ email: 'user@test.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.account).toBeDefined();
    expect(res.body.account.password_hash).toBeUndefined();
    expect(res.body.account.api_key_hash).toBeUndefined();
    // Check cookie was set
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(cookies[0]).toContain('aingram_token');
  });

  it('should reject wrong password', async () => {
    const passwordHash = await bcrypt.hash('password123', 4);
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1',
        type: 'human',
        owner_email: 'user@test.com',
        password_hash: passwordHash,
        status: 'active',
      }],
    });

    const res = await request(app)
      .post('/accounts/login')
      .send({ email: 'user@test.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('should reject non-existent user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/accounts/login')
      .send({ email: 'nobody@test.com', password: 'password123' });

    expect(res.status).toBe(401);
  });

  it('should reject banned user', async () => {
    const passwordHash = await bcrypt.hash('password123', 4);
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1',
        type: 'human',
        owner_email: 'banned@test.com',
        password_hash: passwordHash,
        status: 'banned',
      }],
    });

    const res = await request(app)
      .post('/accounts/login')
      .send({ email: 'banned@test.com', password: 'password123' });

    expect(res.status).toBe(401);
  });
});

describe('POST /accounts/logout', () => {
  it('should clear the cookie', async () => {
    const res = await request(app).post('/accounts/logout');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Logged out');
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    // Cookie should be cleared (expires in past)
    expect(cookies[0]).toContain('aingram_token');
  });
});

describe('GET /accounts/me', () => {
  it('should return current account with valid JWT', async () => {
    const token = jwt.sign(
      { sub: 'uuid-1', type: 'ai', status: 'active' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Auth middleware lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-1', type: 'ai', status: 'active' }],
    });
    // findById in route handler
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1',
        name: 'MyAgent',
        type: 'ai',
        owner_email: 'agent@test.com',
        password_hash: '$2b$12$hash',
        api_key_hash: '$2b$10$hash',
        status: 'active',
      }],
    });

    const res = await request(app)
      .get('/accounts/me')
      .set('Cookie', `aingram_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.account).toBeDefined();
    expect(res.body.account.id).toBe('uuid-1');
    // Sensitive fields stripped
    expect(res.body.account.password_hash).toBeUndefined();
    expect(res.body.account.api_key_hash).toBeUndefined();
  });

  it('should return 401 without auth', async () => {
    const res = await request(app).get('/accounts/me');
    expect(res.status).toBe(401);
  });
});

describe('PUT /accounts/me', () => {
  it('should update profile', async () => {
    const token = jwt.sign(
      { sub: 'uuid-1', type: 'human', status: 'active' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Auth lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-1', type: 'human', status: 'active' }],
    });
    // updateProfile
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-1', name: 'UpdatedName', type: 'human', status: 'active' }],
    });

    const res = await request(app)
      .put('/accounts/me')
      .set('Cookie', `aingram_token=${token}`)
      .send({ name: 'UpdatedName' });

    expect(res.status).toBe(200);
    expect(res.body.account.name).toBe('UpdatedName');
  });
});

describe('POST /accounts/me/rotate-key', () => {
  it('should rotate API key', async () => {
    const token = jwt.sign(
      { sub: 'uuid-1', type: 'ai', status: 'active' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Auth lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-1', type: 'ai', status: 'active' }],
    });
    // rotateApiKey UPDATE
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .post('/accounts/me/rotate-key')
      .set('Cookie', `aingram_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBeDefined();
    expect(res.body.apiKey).toMatch(/^aingram_[0-9a-f]{8}_[0-9a-f]{24}$/);
    expect(res.body.apiKeyLast4).toBeDefined();
    expect(res.body.apiKeyLast4).toHaveLength(4);
  });
});

describe('DELETE /accounts/me/revoke-key', () => {
  it('should revoke API key', async () => {
    const token = jwt.sign(
      { sub: 'uuid-1', type: 'ai', status: 'active' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Auth lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-1', type: 'ai', status: 'active' }],
    });
    // revokeApiKey UPDATE
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .delete('/accounts/me/revoke-key')
      .set('Cookie', `aingram_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('API key revoked');
  });
});

describe('GET /accounts/:id', () => {
  it('should return public profile', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1',
        name: 'PublicAgent',
        type: 'ai',
        avatar_url: null,
        reputation_contribution: 0.8,
        reputation_policing: 0.5,
        badge_contribution: true,
        badge_policing: false,
        created_at: '2026-01-01',
      }],
    });

    const res = await request(app).get('/accounts/uuid-1');

    expect(res.status).toBe(200);
    expect(res.body.account.name).toBe('PublicAgent');
    // No sensitive fields
    expect(res.body.account.password_hash).toBeUndefined();
    expect(res.body.account.api_key_hash).toBeUndefined();
    expect(res.body.account.owner_email).toBeUndefined();
  });

  it('should return 404 for unknown account', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/accounts/nonexistent-uuid');
    expect(res.status).toBe(404);
  });
});

describe('GET /accounts/confirm-email', () => {
  it('should confirm email with valid token', async () => {
    // confirmEmailByToken returns updated account
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

    const res = await request(app)
      .get('/accounts/confirm-email')
      .query({ token: 'a'.repeat(64) });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Email confirmed successfully');
    expect(res.body.account).toBeDefined();
  });

  it('should return 400 for missing token', async () => {
    const res = await request(app).get('/accounts/confirm-email');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 for invalid/expired token', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/accounts/confirm-email')
      .query({ token: 'invalid-token' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });
});

describe('POST /accounts/reset-password', () => {
  it('should accept reset request (anti-enumeration)', async () => {
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

    const res = await request(app)
      .post('/accounts/reset-password')
      .send({ email: 'test@test.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('reset link');
  });

  it('should return 200 even for non-existent email', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/accounts/reset-password')
      .send({ email: 'nobody@test.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('reset link');
  });

  it('should return 400 for missing email', async () => {
    const res = await request(app)
      .post('/accounts/reset-password')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PUT /accounts/reset-password', () => {
  it('should reset password with valid token', async () => {
    // Lookup by token hash
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-1' }] });
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

    const res = await request(app)
      .put('/accounts/reset-password')
      .send({ token: 'a'.repeat(64), password: 'newpassword123' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Password reset successfully');
  });

  it('should return 400 for invalid/expired token', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/accounts/reset-password')
      .send({ token: 'bad-token', password: 'newpassword123' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('should return 400 for missing fields', async () => {
    const res = await request(app)
      .put('/accounts/reset-password')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 for short password', async () => {
    const res = await request(app)
      .put('/accounts/reset-password')
      .send({ token: 'a'.repeat(64), password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /health', () => {
  it('should return health status', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBeDefined();
    expect(res.body.database).toBeDefined();
  });
});
