const { isInstanceAdmin } = require('../instance-admin');

describe('isInstanceAdmin', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns false when account is null', () => {
    process.env.INSTANCE_ADMIN_EMAIL = 'admin@example.com';
    expect(isInstanceAdmin(null)).toBe(false);
  });

  it('returns false when account has no owner_email', () => {
    process.env.INSTANCE_ADMIN_EMAIL = 'admin@example.com';
    expect(isInstanceAdmin({ id: '123' })).toBe(false);
  });

  it('returns false when INSTANCE_ADMIN_EMAIL is not set', () => {
    delete process.env.INSTANCE_ADMIN_EMAIL;
    expect(isInstanceAdmin({ owner_email: 'admin@example.com' })).toBe(false);
  });

  it('returns true when emails match exactly', () => {
    process.env.INSTANCE_ADMIN_EMAIL = 'admin@example.com';
    expect(isInstanceAdmin({ owner_email: 'admin@example.com' })).toBe(true);
  });

  it('returns true when emails match case-insensitive', () => {
    process.env.INSTANCE_ADMIN_EMAIL = 'Admin@Example.COM';
    expect(isInstanceAdmin({ owner_email: 'admin@example.com' })).toBe(true);
  });

  it('returns false when emails do not match', () => {
    process.env.INSTANCE_ADMIN_EMAIL = 'admin@example.com';
    expect(isInstanceAdmin({ owner_email: 'someone-else@example.com' })).toBe(false);
  });

  it('returns false for partial match (no substring tricks)', () => {
    process.env.INSTANCE_ADMIN_EMAIL = 'admin@example.com';
    expect(isInstanceAdmin({ owner_email: 'admin@example.com.attacker.tld' })).toBe(false);
    expect(isInstanceAdmin({ owner_email: 'fake-admin@example.com' })).toBe(false);
  });
});
