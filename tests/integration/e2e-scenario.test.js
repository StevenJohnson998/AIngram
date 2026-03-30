/**
 * E2E Integration Test Scenario
 *
 * Tests the full user flow through the AIngram API:
 * register -> login -> create topic -> add chunk -> create message ->
 * vote (fail as provisional) -> activate -> vote (succeed) ->
 * get votes -> create flag -> check reputation -> create subscription ->
 * list subscriptions -> search -> health check
 *
 * All DB interactions are mocked. This verifies route wiring, auth flow,
 * and service contracts are correctly integrated.
 */

// Set env before any imports
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'e2e-test-jwt-secret-key';
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '5432';
process.env.DB_NAME = 'test';
process.env.DB_USER = 'test';
process.env.DB_PASSWORD = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// --- Mock database ---
const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();

mockConnect.mockResolvedValue({
  query: mockClientQuery,
  release: mockClientRelease,
});

jest.mock('../../src/config/database', () => ({
  getPool: () => ({
    query: mockQuery,
    connect: mockConnect,
  }),
  closePool: jest.fn(),
}));

// Mock Ollama embedding (subscription vector type needs it)
jest.mock('../../src/services/ollama', () => ({
  generateEmbedding: jest.fn().mockResolvedValue(null),
  checkOllamaHealth: jest.fn().mockResolvedValue(false),
}));

const { app } = require('../../src/index');

const JWT_SECRET = process.env.JWT_SECRET;

// --- Test data ---
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const TOPIC_ID = '22222222-2222-2222-2222-222222222222';
const CHUNK_ID = '33333333-3333-3333-3333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';
const VOTE_ID = '66666666-6666-6666-6666-666666666666';
const FLAG_ID = '77777777-7777-7777-7777-777777777777';
const SUBSCRIPTION_ID = '88888888-8888-8888-8888-888888888888';

function makeToken(overrides = {}) {
  return jwt.sign(
    { sub: ACCOUNT_ID, type: 'ai', status: 'provisional', ...overrides },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function mockAuthLookup(status = 'provisional') {
  mockQuery.mockResolvedValueOnce({
    rows: [{ id: ACCOUNT_ID, type: 'ai', status }],
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockClientQuery.mockReset();
  mockConnect.mockClear();
  mockClientRelease.mockClear();
});

describe('E2E Integration Scenario', () => {
  let authToken;
  let activeToken;

  // -------------------------------------------------------
  // Step 1: Register agent
  // -------------------------------------------------------
  describe('Step 1: Register agent', () => {
    it('POST /accounts/register creates account with provisional status', async () => {
      // Check for existing account -> none found
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // INSERT RETURNING
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: ACCOUNT_ID,
          name: 'TestAgent',
          type: 'ai',
          owner_email: 'agent@test.ai',
          status: 'provisional',
          api_key_last4: 'abcd',
          email_confirmed: false,
          created_at: '2026-03-18T00:00:00.000Z',
        }],
      });

      const res = await request(app)
        .post('/accounts/register')
        .send({
          name: 'TestAgent',
          type: 'ai',
          ownerEmail: 'agent@test.ai',
          password: 'securepass123',
        });

      expect(res.status).toBe(201);
      expect(res.body.account).toBeDefined();
      expect(res.body.account.status).toBe('provisional');
      expect(res.body.account.id).toBe(ACCOUNT_ID);
      expect(res.body.apiKey).toBeDefined();
      expect(res.body.apiKey).toMatch(/^aingram_[0-9a-f]{8}_[0-9a-f]{24}$/);
    });
  });

  // -------------------------------------------------------
  // Step 2: Login
  // -------------------------------------------------------
  describe('Step 2: Login', () => {
    it('POST /accounts/login returns JWT cookie', async () => {
      const passwordHash = await bcrypt.hash('securepass123', 4);

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: ACCOUNT_ID,
          name: 'TestAgent',
          type: 'ai',
          owner_email: 'agent@test.ai',
          password_hash: passwordHash,
          api_key_hash: null,
          status: 'provisional',
          email_confirmed: true,
          reputation_contribution: 0,
          reputation_policing: 0,
          badge_contribution: false,
          badge_policing: false,
        }],
      });

      const res = await request(app)
        .post('/accounts/login')
        .send({ email: 'agent@test.ai', password: 'securepass123' });

      expect(res.status).toBe(200);
      expect(res.body.account).toBeDefined();
      expect(res.body.account.password_hash).toBeUndefined();
      expect(res.body.account.api_key_hash).toBeUndefined();

      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies[0]).toContain('aingram_token');

      // Extract token for subsequent requests
      const tokenMatch = cookies[0].match(/aingram_token=([^;]+)/);
      expect(tokenMatch).toBeTruthy();
      authToken = tokenMatch[1];

      // Verify token is valid JWT
      const payload = jwt.verify(authToken, JWT_SECRET);
      expect(payload.sub).toBe(ACCOUNT_ID);
    });
  });

  // -------------------------------------------------------
  // Step 3: Create topic
  // -------------------------------------------------------
  describe('Step 3: Create topic', () => {
    it('POST /topics creates topic with slug', async () => {
      const token = makeToken({ status: 'provisional' });

      // Auth lookup
      mockAuthLookup('provisional');
      // ensureUniqueSlug: check if slug exists -> no
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // INSERT topic
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: TOPIC_ID,
          title: 'Machine Learning Basics',
          slug: 'machine-learning-basics',
          lang: 'en',
          summary: 'Intro to ML concepts',
          sensitivity: 'low',
          status: 'active',
          created_by: ACCOUNT_ID,
          created_at: '2026-03-18T00:00:00.000Z',
        }],
      });

      const res = await request(app)
        .post('/topics')
        .set('Cookie', `aingram_token=${token}`)
        .send({
          title: 'Machine Learning Basics',
          lang: 'en',
          summary: 'Intro to ML concepts',
        });

      expect(res.status).toBe(201);
      expect(res.body.slug).toBe('machine-learning-basics');
      expect(res.body.title).toBe('Machine Learning Basics');
      expect(res.body.created_by).toBe(ACCOUNT_ID);
    });
  });

  // -------------------------------------------------------
  // Step 4: Add chunk to topic
  // -------------------------------------------------------
  describe('Step 4: Add chunk', () => {
    it('POST /topics/:id/chunks creates chunk linked to topic', async () => {
      const token = makeToken({ status: 'provisional' });

      // Auth lookup
      mockAuthLookup('provisional');
      // getTopicById (verify topic exists)
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: TOPIC_ID,
          title: 'Machine Learning Basics',
          status: 'active',
          created_by: ACCOUNT_ID,
          chunk_count: 0,
        }],
      });

      // findById for elite badge check
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: ACCOUNT_ID,
          name: 'TestAgent',
          type: 'ai',
          status: 'provisional',
          badge_elite: false,
        }],
      });

      // createChunk uses pool.connect() for transaction
      // BEGIN
      mockClientQuery.mockResolvedValueOnce({});
      // INSERT chunk
      mockClientQuery.mockResolvedValueOnce({
        rows: [{
          id: CHUNK_ID,
          content: 'Machine learning is a subset of artificial intelligence that focuses on algorithms.',
          technical_detail: null,
          has_technical_detail: false,
          status: 'active',
          created_by: ACCOUNT_ID,
          created_at: '2026-03-18T00:00:00.000Z',
        }],
      });
      // INSERT chunk_topics
      mockClientQuery.mockResolvedValueOnce({});
      // COMMIT
      mockClientQuery.mockResolvedValueOnce({});

      const res = await request(app)
        .post(`/topics/${TOPIC_ID}/chunks`)
        .set('Cookie', `aingram_token=${token}`)
        .send({
          content: 'Machine learning is a subset of artificial intelligence that focuses on algorithms.',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe(CHUNK_ID);
      expect(res.body.content).toContain('Machine learning');
      expect(res.body.created_by).toBe(ACCOUNT_ID);
    });
  });

  // -------------------------------------------------------
  // Step 5: Create message (contribution, level 1)
  // -------------------------------------------------------
  describe('Step 5: Create message', () => {
    it('POST /topics/:id/messages creates level-1 contribution', async () => {
      const token = makeToken({ status: 'provisional' });

      // Auth lookup
      mockAuthLookup('provisional');
      // createMessage INSERT
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: MESSAGE_ID,
          topic_id: TOPIC_ID,
          account_id: ACCOUNT_ID,
          content: 'Great initial content on ML basics',
          level: 1,
          type: 'contribution',
          parent_id: null,
          status: 'active',
          created_at: '2026-03-18T00:00:00.000Z',
        }],
      });

      const res = await request(app)
        .post(`/topics/${TOPIC_ID}/messages`)
        .set('Cookie', `aingram_token=${token}`)
        .send({
          type: 'contribution',
          content: 'Great initial content on ML basics',
        });

      expect(res.status).toBe(201);
      expect(res.body.level).toBe(1);
      expect(res.body.type).toBe('contribution');
      expect(res.body.topic_id).toBe(TOPIC_ID);
    });
  });

  // -------------------------------------------------------
  // Step 6: Cast vote (should FAIL - provisional, no first_contribution_at)
  // -------------------------------------------------------
  describe('Step 6: Vote fails for provisional account', () => {
    it('POST /votes returns 403 for provisional account without first_contribution_at', async () => {
      const token = makeToken({ status: 'provisional' });

      // Auth lookup
      mockAuthLookup('provisional');

      // castVote: lookup account -> no first_contribution_at
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: ACCOUNT_ID,
          status: 'provisional',
          first_contribution_at: null,
          created_at: '2026-03-18T00:00:00.000Z',
        }],
      });

      const res = await request(app)
        .post('/votes')
        .set('Cookie', `aingram_token=${token}`)
        .send({
          target_type: 'message',
          target_id: MESSAGE_ID,
          value: 'up',
        });

      // Vote service throws VOTE_LOCKED (first_contribution_at required) -> 403
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('VOTE_LOCKED');
    });
  });

  // -------------------------------------------------------
  // Step 7: Simulate activation (DB update via service)
  // This is simulated by using a token with status='active'
  // and mocking the DB to return an activated account
  // -------------------------------------------------------

  // -------------------------------------------------------
  // Step 8: Cast vote (should succeed with active account)
  // -------------------------------------------------------
  describe('Step 8: Vote succeeds for active account', () => {
    it('POST /votes creates vote with weight', async () => {
      activeToken = makeToken({ status: 'active' });

      // Auth lookup
      mockAuthLookup('active');

      // castVote: lookup account -> active, has first_contribution_at
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: ACCOUNT_ID,
          status: 'active',
          first_contribution_at: '2026-03-01T00:00:00.000Z',
          created_at: '2026-02-01T00:00:00.000Z',
        }],
      });

      // castVote: check message ownership (not self-vote)
      mockQuery.mockResolvedValueOnce({
        rows: [{
          account_id: OTHER_ACCOUNT_ID,
          status: 'active',
        }],
      });

      // castVote: upsert vote
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: VOTE_ID,
          account_id: ACCOUNT_ID,
          target_type: 'message',
          target_id: MESSAGE_ID,
          value: 'up',
          reason_tag: 'accurate',
          weight: 1.0,
          created_at: '2026-03-18T00:00:00.000Z',
        }],
      });

      const res = await request(app)
        .post('/votes')
        .set('Cookie', `aingram_token=${activeToken}`)
        .send({
          target_type: 'message',
          target_id: MESSAGE_ID,
          value: 'up',
          reason_tag: 'accurate',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe(VOTE_ID);
      expect(res.body.value).toBe('up');
      expect(res.body.weight).toBe(1.0);
      expect(res.body.reason_tag).toBe('accurate');
    });
  });

  // -------------------------------------------------------
  // Step 9: Get vote summary
  // -------------------------------------------------------
  describe('Step 9: Get votes on target', () => {
    it('GET /votes?target_type=message&target_id=... returns votes', async () => {
      // No auth required (authenticateOptional)
      // getVotesByTarget: count
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: 1 }],
      });
      // getVotesByTarget: data
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: VOTE_ID,
          account_id: ACCOUNT_ID,
          target_type: 'message',
          target_id: MESSAGE_ID,
          value: 'up',
          weight: 1.0,
          created_at: '2026-03-18T00:00:00.000Z',
        }],
      });

      const res = await request(app)
        .get(`/votes?target_type=message&target_id=${MESSAGE_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].value).toBe('up');
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.total).toBe(1);
    });
  });

  // -------------------------------------------------------
  // Step 10: Create flag
  // -------------------------------------------------------
  describe('Step 10: Create flag', () => {
    it('POST /flags creates flag on a message', async () => {
      const token = makeToken({ status: 'active' });

      // Auth lookup
      mockAuthLookup('active');
      // createFlag INSERT
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: FLAG_ID,
          reporter_id: ACCOUNT_ID,
          target_type: 'message',
          target_id: MESSAGE_ID,
          reason: 'Contains hallucinated facts',
          detection_type: 'manual',
          status: 'open',
          created_at: '2026-03-18T00:00:00.000Z',
        }],
      });

      const res = await request(app)
        .post('/flags')
        .set('Cookie', `aingram_token=${token}`)
        .send({
          targetType: 'message',
          targetId: MESSAGE_ID,
          reason: 'Contains hallucinated facts',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe(FLAG_ID);
      expect(res.body.target_type).toBe('message');
      expect(res.body.status).toBe('open');
      expect(res.body.reporter_id).toBe(ACCOUNT_ID);
    });
  });

  // -------------------------------------------------------
  // Step 11: Check reputation
  // -------------------------------------------------------
  describe('Step 11: Check reputation', () => {
    it('GET /accounts/:id/reputation returns reputation structure', async () => {
      // No auth required for reputation (authenticateOptional)

      // getReputationDetails: account lookup
      mockQuery.mockResolvedValueOnce({
        rows: [{
          reputation_contribution: 0.75,
          reputation_policing: 0,
          badge_contribution: false,
          badge_policing: false,
        }],
      });
      // Contribution vote count
      mockQuery.mockResolvedValueOnce({
        rows: [{ vote_count: 3 }],
      });
      // Contribution topic count
      mockQuery.mockResolvedValueOnce({
        rows: [{ topic_count: 1 }],
      });
      // Policing vote count
      mockQuery.mockResolvedValueOnce({
        rows: [{ vote_count: 0 }],
      });

      const res = await request(app)
        .get(`/accounts/${ACCOUNT_ID}/reputation`);

      expect(res.status).toBe(200);
      expect(res.body.contribution).toBeDefined();
      expect(res.body.contribution.score).toBe(0.75);
      expect(res.body.contribution.voteCount).toBe(3);
      expect(res.body.contribution.topicCount).toBe(1);
      expect(res.body.policing).toBeDefined();
      expect(res.body.policing.score).toBe(0);
      expect(res.body.badges).toBeDefined();
      expect(res.body.badges.contribution).toBe(false);
      expect(res.body.badges.policing).toBe(false);
    });
  });

  // -------------------------------------------------------
  // Step 12: Create subscription (keyword type with polling)
  // -------------------------------------------------------
  describe('Step 12: Create subscription', () => {
    it('POST /subscriptions creates keyword subscription', async () => {
      const token = makeToken({ status: 'provisional' });

      // Auth lookup
      mockAuthLookup('provisional');

      // getTier: account lookup
      mockQuery.mockResolvedValueOnce({
        rows: [{
          reputation_contribution: 0,
          badge_contribution: false,
          first_contribution_at: null,
        }],
      });
      // Count active subscriptions
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: 0 }],
      });
      // INSERT subscription
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: SUBSCRIPTION_ID,
          account_id: ACCOUNT_ID,
          type: 'keyword',
          topic_id: null,
          keyword: 'machine learning',
          similarity_threshold: null,
          lang: null,
          notification_method: 'polling',
          webhook_url: null,
          active: true,
          created_at: '2026-03-18T00:00:00.000Z',
        }],
      });

      const res = await request(app)
        .post('/subscriptions')
        .set('Cookie', `aingram_token=${token}`)
        .send({
          type: 'keyword',
          keyword: 'machine learning',
          notificationMethod: 'polling',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe(SUBSCRIPTION_ID);
      expect(res.body.type).toBe('keyword');
      expect(res.body.keyword).toBe('machine learning');
      expect(res.body.notification_method).toBe('polling');
      expect(res.body.active).toBe(true);
    });
  });

  // -------------------------------------------------------
  // Step 13: List subscriptions
  // -------------------------------------------------------
  describe('Step 13: List subscriptions', () => {
    it('GET /subscriptions/me lists my subscriptions', async () => {
      const token = makeToken({ status: 'provisional' });

      // Auth lookup
      mockAuthLookup('provisional');

      // listMySubscriptions: data + count (Promise.all)
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: SUBSCRIPTION_ID,
          account_id: ACCOUNT_ID,
          type: 'keyword',
          topic_id: null,
          keyword: 'machine learning',
          similarity_threshold: null,
          lang: null,
          notification_method: 'polling',
          webhook_url: null,
          active: true,
          created_at: '2026-03-18T00:00:00.000Z',
        }],
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: 1 }],
      });

      const res = await request(app)
        .get('/subscriptions/me')
        .set('Cookie', `aingram_token=${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].keyword).toBe('machine learning');
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.total).toBe(1);
    });
  });

  // -------------------------------------------------------
  // Step 14: Search
  // -------------------------------------------------------
  describe('Step 14: Search', () => {
    it('GET /search?q=test returns results with text search', async () => {
      // search uses authenticateOptional (no mock needed if no cookie sent)

      // Count query
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: 1 }],
      });
      // Data query
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: CHUNK_ID,
          content: 'Machine learning is a subset of artificial intelligence.',
          status: 'published',
          rank: 0.5,
          topic_id: TOPIC_ID,
          topic_title: 'Machine Learning Basics',
          topic_slug: 'machine-learning-basics',
          topic_lang: 'en',
        }],
      });

      const res = await request(app)
        .get('/search?q=machine+learning');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].topic_title).toBe('Machine Learning Basics');
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.total).toBe(1);
    });
  });

  // -------------------------------------------------------
  // Step 15: Health check
  // -------------------------------------------------------
  describe('Step 15: Health check', () => {
    it('GET /health returns status ok when DB is healthy', async () => {
      // DB check: SELECT 1
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBeDefined();
      expect(res.body.database).toBeDefined();
      expect(res.body.database.status).toBe('ok');
    });
  });

  // -------------------------------------------------------
  // Additional cross-cutting tests
  // -------------------------------------------------------
  describe('Cross-cutting: Auth enforcement', () => {
    it('returns 401 for protected endpoints without auth', async () => {
      const endpoints = [
        { method: 'post', path: '/topics' },
        { method: 'post', path: `/topics/${TOPIC_ID}/messages` },
        { method: 'post', path: '/votes' },
        { method: 'post', path: '/flags' },
        { method: 'post', path: '/subscriptions' },
        { method: 'get', path: '/subscriptions/me' },
        { method: 'get', path: '/accounts/me' },
      ];

      for (const { method, path } of endpoints) {
        const res = await request(app)[method](path).send({});
        expect(res.status).toBe(401);
      }
    });
  });

  describe('Cross-cutting: 404 for unknown routes', () => {
    it('returns 404 for non-existent endpoint', async () => {
      const res = await request(app).get('/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Cross-cutting: Status enforcement on flags', () => {
    it('POST /flags requires active status (provisional rejected)', async () => {
      const token = makeToken({ status: 'provisional' });
      mockAuthLookup('provisional');

      const res = await request(app)
        .post('/flags')
        .set('Cookie', `aingram_token=${token}`)
        .send({
          targetType: 'message',
          targetId: MESSAGE_ID,
          reason: 'Spam content',
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('Cross-cutting: Vote self-vote prevention', () => {
    it('POST /votes rejects voting on own content', async () => {
      const token = makeToken({ status: 'active' });
      mockAuthLookup('active');

      // castVote: lookup account -> active, has first_contribution_at
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: ACCOUNT_ID,
          status: 'active',
          first_contribution_at: '2026-03-01T00:00:00.000Z',
          created_at: '2026-02-01T00:00:00.000Z',
        }],
      });

      // castVote: check message ownership -> SAME account (self-vote)
      mockQuery.mockResolvedValueOnce({
        rows: [{
          account_id: ACCOUNT_ID,
          status: 'active',
        }],
      });

      const res = await request(app)
        .post('/votes')
        .set('Cookie', `aingram_token=${token}`)
        .send({
          target_type: 'message',
          target_id: MESSAGE_ID,
          value: 'up',
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SELF_VOTE');
    });
  });
});
