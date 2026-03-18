const { validateEnv } = require('../env');

describe('validateEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Set all required vars
    process.env.DB_HOST = 'localhost';
    process.env.DB_PORT = '5432';
    process.env.DB_NAME = 'aingram_test';
    process.env.DB_USER = 'admin';
    process.env.DB_PASSWORD = 'testpassword';
    process.env.JWT_SECRET = 'test-jwt-secret';
    delete process.env.DB_PASSWORD_FILE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns config when all vars are set', () => {
    const config = validateEnv();
    expect(config.DB_HOST).toBe('localhost');
    expect(config.DB_PORT).toBe(5432);
    expect(config.DB_NAME).toBe('aingram_test');
    expect(config.DB_USER).toBe('admin');
    expect(config.DB_PASSWORD).toBe('testpassword');
  });

  it('throws when DB_HOST is missing', () => {
    delete process.env.DB_HOST;
    expect(() => validateEnv()).toThrow('Missing required environment variables');
    expect(() => validateEnv()).toThrow('DB_HOST');
  });

  it('throws when DB_PORT is missing', () => {
    delete process.env.DB_PORT;
    expect(() => validateEnv()).toThrow('DB_PORT');
  });

  it('throws when DB_NAME is missing', () => {
    delete process.env.DB_NAME;
    expect(() => validateEnv()).toThrow('DB_NAME');
  });

  it('throws when DB_USER is missing', () => {
    delete process.env.DB_USER;
    expect(() => validateEnv()).toThrow('DB_USER');
  });

  it('throws when both DB_PASSWORD and DB_PASSWORD_FILE are missing', () => {
    delete process.env.DB_PASSWORD;
    expect(() => validateEnv()).toThrow('Missing DB password');
  });

  it('throws when DB_PASSWORD_FILE points to nonexistent file', () => {
    delete process.env.DB_PASSWORD;
    process.env.DB_PASSWORD_FILE = '/nonexistent/path/password.txt';
    expect(() => validateEnv()).toThrow('DB_PASSWORD_FILE not found');
  });

  it('reads password from DB_PASSWORD_FILE when set', () => {
    const fs = require('fs');
    const path = require('path');
    const tmpFile = path.join(__dirname, '.tmp_test_password');
    fs.writeFileSync(tmpFile, 'file-password\n');

    delete process.env.DB_PASSWORD;
    process.env.DB_PASSWORD_FILE = tmpFile;

    const config = validateEnv();
    expect(config.DB_PASSWORD).toBe('file-password');

    fs.unlinkSync(tmpFile);
  });

  it('reports all missing vars at once', () => {
    delete process.env.DB_HOST;
    delete process.env.DB_PORT;
    delete process.env.DB_NAME;
    expect(() => validateEnv()).toThrow('DB_HOST');
  });
});
