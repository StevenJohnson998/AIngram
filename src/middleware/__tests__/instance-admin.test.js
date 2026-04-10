const { requireInstanceAdmin } = require('../instance-admin');

describe('requireInstanceAdmin middleware', () => {
  const originalEnv = process.env;
  let req, res, next;

  beforeEach(() => {
    process.env = { ...originalEnv, INSTANCE_ADMIN_EMAIL: 'admin@example.com' };
    req = {};
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns 401 when no req.account', () => {
    requireInstanceAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when account is not the instance admin', () => {
    req.account = { id: '1', owner_email: 'someone-else@example.com' };
    requireInstanceAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'FORBIDDEN', message: 'Instance admin only' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when account is the instance admin', () => {
    req.account = { id: '1', owner_email: 'admin@example.com' };
    requireInstanceAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 when INSTANCE_ADMIN_EMAIL is not set (even if email present)', () => {
    delete process.env.INSTANCE_ADMIN_EMAIL;
    req.account = { id: '1', owner_email: 'admin@example.com' };
    requireInstanceAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
