jest.mock('../../middleware/auth', () => require('../../middleware/auth-stub'));
jest.mock('../../services/agent-feedback');

const express = require('express');
const request = require('supertest');

const feedbackService = require('../../services/agent-feedback');
const feedbackRoutes = require('../feedback');
const { requireFeedbackEmitter } = require('../feedback');

const TARGET = 'aaaaaaaa-0000-0000-0000-000000000001';
const HUMAN2 = JSON.stringify({ id: 'h2', type: 'human', tier: 2 });
const HUMAN1 = JSON.stringify({ id: 'h1', type: 'human', tier: 1 });
const AGENT = JSON.stringify({ id: 'agent-x', type: 'ai', tier: 2 });

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', feedbackRoutes);
  return app;
}

describe('requireFeedbackEmitter', () => {
  const run = (account) => {
    const req = { account };
    let status = null;
    const res = { status: (s) => { status = s; return { json: () => {} }; } };
    let passed = false;
    requireFeedbackEmitter(req, res, () => { passed = true; });
    return { passed, status };
  };

  afterEach(() => { delete process.env.FEEDBACK_EMITTERS; });

  it('allows human tier 2, rejects human tier 1 and non-whitelisted ai', () => {
    expect(run({ id: 'h', type: 'human', tier: 2 }).passed).toBe(true);
    expect(run({ id: 'h', type: 'human', tier: 1 }).status).toBe(403);
    expect(run({ id: 'a', type: 'ai', tier: 2 }).status).toBe(403);
  });

  it('allows whitelisted ai accounts via FEEDBACK_EMITTERS', () => {
    process.env.FEEDBACK_EMITTERS = 'other-id, agent-x';
    expect(run({ id: 'agent-x', type: 'ai', tier: 0 }).passed).toBe(true);
    expect(run({ id: 'agent-y', type: 'ai', tier: 0 }).status).toBe(403);
  });
});

describe('feedback routes', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  afterEach(() => { delete process.env.FEEDBACK_EMITTERS; });

  describe('POST /accounts/:id/feedback', () => {
    it('201 for a trusted human emitter', async () => {
      feedbackService.issueFeedback.mockResolvedValue({
        id: 'f1', code: 'OFF_TOPIC', scope_type: 'global', scope_id: null,
        severity: 'notice', expires_at: 't1',
      });
      const res = await request(makeApp())
        .post(`/accounts/${TARGET}/feedback`)
        .set('x-test-account', HUMAN2)
        .send({ code: 'OFF_TOPIC' });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe('f1');
      expect(feedbackService.issueFeedback).toHaveBeenCalledWith(expect.objectContaining({
        targetAccountId: TARGET, code: 'OFF_TOPIC', issuedBy: 'h2',
      }));
    });

    it('403 for tier-1 human and non-whitelisted agent, service untouched', async () => {
      for (const account of [HUMAN1, AGENT]) {
        const res = await request(makeApp())
          .post(`/accounts/${TARGET}/feedback`)
          .set('x-test-account', account)
          .send({ code: 'OFF_TOPIC' });
        expect(res.status).toBe(403);
      }
      expect(feedbackService.issueFeedback).not.toHaveBeenCalled();
    });

    it('201 for whitelisted agent emitter', async () => {
      process.env.FEEDBACK_EMITTERS = 'agent-x';
      feedbackService.issueFeedback.mockResolvedValue({
        id: 'f2', code: 'OVERPOSTING_IN_THREAD', scope_type: 'debate', scope_id: 'topic-1',
        severity: 'warning', expires_at: 't1',
      });
      const res = await request(makeApp())
        .post(`/accounts/${TARGET}/feedback`)
        .set('x-test-account', AGENT)
        .send({ code: 'OVERPOSTING_IN_THREAD', scope: { type: 'debate', id: 'topic-1' }, severity: 'warning' });
      expect(res.status).toBe(201);
    });

    it('maps service CONFLICT to 409 with existing_id', async () => {
      feedbackService.issueFeedback.mockRejectedValue(
        Object.assign(new Error('dup'), { code: 'CONFLICT', existingId: 'f0' })
      );
      const res = await request(makeApp())
        .post(`/accounts/${TARGET}/feedback`)
        .set('x-test-account', HUMAN2)
        .send({ code: 'OFF_TOPIC' });
      expect(res.status).toBe(409);
      expect(res.body.existing_id).toBe('f0');
    });

    it('400 when code missing', async () => {
      const res = await request(makeApp())
        .post(`/accounts/${TARGET}/feedback`)
        .set('x-test-account', HUMAN2)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /accounts/me/feedback', () => {
    it('returns rendered pending feedback for the caller', async () => {
      feedbackService.listPendingForAccount.mockResolvedValue([
        { id: 'f1', code: 'OFF_TOPIC', message: 'msg' },
      ]);
      const res = await request(makeApp())
        .get('/accounts/me/feedback')
        .set('x-test-account', AGENT);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(feedbackService.listPendingForAccount).toHaveBeenCalledWith('agent-x');
    });
  });

  describe('POST /accounts/me/feedback/:fid/ack', () => {
    it('200 on success, 404 when nothing pending', async () => {
      feedbackService.ackFeedback.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const app = makeApp();
      expect((await request(app).post('/accounts/me/feedback/f1/ack').set('x-test-account', AGENT)).status).toBe(200);
      expect((await request(app).post('/accounts/me/feedback/f1/ack').set('x-test-account', AGENT)).status).toBe(404);
    });
  });

  describe('DELETE /accounts/:id/feedback/:fid', () => {
    it('204 on success, 403/404 on failures', async () => {
      feedbackService.revokeFeedback
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, reason: 'FORBIDDEN' })
        .mockResolvedValueOnce({ ok: false, reason: 'NOT_FOUND' });
      const app = makeApp();
      expect((await request(app).delete(`/accounts/${TARGET}/feedback/f1`).set('x-test-account', HUMAN2)).status).toBe(204);
      expect((await request(app).delete(`/accounts/${TARGET}/feedback/f1`).set('x-test-account', AGENT)).status).toBe(403);
      expect((await request(app).delete(`/accounts/${TARGET}/feedback/f1`).set('x-test-account', HUMAN2)).status).toBe(404);
    });
  });
});
