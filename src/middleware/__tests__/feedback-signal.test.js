jest.mock('../../services/agent-feedback', () => ({
  countPendingForAccount: jest.fn().mockResolvedValue(2),
}));

const feedbackCache = require('../../services/feedback-cache');
const service = require('../../services/agent-feedback');
const feedbackSignal = require('../feedback-signal');

const ACCOUNT = 'aaaaaaaa-0000-0000-0000-000000000001';

function makeReqRes({ account = { id: ACCOUNT }, statusCode = 200 } = {}) {
  const sent = [];
  const res = {
    statusCode,
    headersSent: false,
    json: (body) => { sent.push(body); return res; },
  };
  const req = { account };
  return { req, res, sent };
}

describe('feedback-signal middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    feedbackCache.clear();
  });

  it('injects _pending_feedback when cache is warm and count > 0', () => {
    feedbackCache.set(ACCOUNT, 3);
    const { req, res, sent } = makeReqRes();
    feedbackSignal(req, res, () => {});
    res.json({ data: [] });
    expect(sent[0]._pending_feedback).toEqual({ count: 3, fetch: '/v1/accounts/me/feedback' });
    expect(sent[0].data).toEqual([]);
  });

  it('does not inject when count is 0', () => {
    feedbackCache.set(ACCOUNT, 0);
    const { req, res, sent } = makeReqRes();
    feedbackSignal(req, res, () => {});
    res.json({ ok: true });
    expect(sent[0]._pending_feedback).toBeUndefined();
  });

  it('on cold cache: triggers async refresh, injects nothing this request', () => {
    const { req, res, sent } = makeReqRes();
    feedbackSignal(req, res, () => {});
    res.json({ ok: true });
    expect(sent[0]._pending_feedback).toBeUndefined();
    expect(service.countPendingForAccount).toHaveBeenCalledWith(ACCOUNT);
  });

  it('skips unauthenticated requests without any service call', () => {
    const { req, res, sent } = makeReqRes({ account: null });
    feedbackSignal(req, res, () => {});
    res.json({ public: true });
    expect(sent[0]._pending_feedback).toBeUndefined();
    expect(service.countPendingForAccount).not.toHaveBeenCalled();
  });

  it('skips error responses', () => {
    feedbackCache.set(ACCOUNT, 3);
    const { req, res, sent } = makeReqRes({ statusCode: 403 });
    feedbackSignal(req, res, () => {});
    res.json({ error: { code: 'FORBIDDEN' } });
    expect(sent[0]._pending_feedback).toBeUndefined();
  });

  it('skips top-level array bodies', () => {
    feedbackCache.set(ACCOUNT, 3);
    const { req, res, sent } = makeReqRes();
    feedbackSignal(req, res, () => {});
    res.json([1, 2, 3]);
    expect(Array.isArray(sent[0])).toBe(true);
    expect(sent[0]._pending_feedback).toBeUndefined();
  });

  it('is idempotent when mounted twice (double-mount belt and braces)', () => {
    feedbackCache.set(ACCOUNT, 1);
    const { req, res, sent } = makeReqRes();
    feedbackSignal(req, res, () => {});
    feedbackSignal(req, res, () => {});
    res.json({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]._pending_feedback).toEqual({ count: 1, fetch: '/v1/accounts/me/feedback' });
  });

  it('never overwrites an existing _pending_feedback key', () => {
    feedbackCache.set(ACCOUNT, 5);
    const { req, res, sent } = makeReqRes();
    feedbackSignal(req, res, () => {});
    res.json({ _pending_feedback: { count: 1, fetch: 'x' } });
    expect(sent[0]._pending_feedback).toEqual({ count: 1, fetch: 'x' });
  });
});
