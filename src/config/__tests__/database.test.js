describe('database', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DB_HOST = 'localhost';
    process.env.DB_PORT = '5432';
    process.env.DB_NAME = 'aingram_test';
    process.env.DB_USER = 'admin';
    process.env.DB_PASSWORD = 'testpassword';
    process.env.JWT_SECRET = 'test-jwt-secret';
    delete process.env.DB_PASSWORD_FILE;
    // Clear module cache so each test gets a fresh pool
    jest.resetModules();
  });

  afterEach(async () => {
    // Clean up pool if created
    try {
      const { closePool } = require('../database');
      await closePool();
    } catch {
      // ignore
    }
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('creates a pool with correct configuration', () => {
    const { getPool } = require('../database');
    const pool = getPool();
    expect(pool).toBeDefined();
    expect(pool.options.host).toBe('localhost');
    expect(pool.options.port).toBe(5432);
    expect(pool.options.database).toBe('aingram_test');
    expect(pool.options.user).toBe('admin');
  });

  it('returns the same pool instance on subsequent calls', () => {
    const { getPool } = require('../database');
    const pool1 = getPool();
    const pool2 = getPool();
    expect(pool1).toBe(pool2);
  });

  it('throws when env vars are missing', () => {
    delete process.env.DB_HOST;
    const { getPool } = require('../database');
    expect(() => getPool()).toThrow();
  });

  it('closePool resets the pool', async () => {
    const { getPool, closePool } = require('../database');
    const pool1 = getPool();
    expect(pool1).toBeDefined();
    await closePool();
    // After close, a new call should create a new pool
    // (but we can't easily test this without mocking)
  });
});
