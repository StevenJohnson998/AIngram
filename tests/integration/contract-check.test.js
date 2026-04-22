/**
 * Contract Check Tests
 *
 * Verifies that all services export expected functions, all route modules
 * export Express Routers, and auth middleware exports match what routes expect.
 * Catches contract mismatches between layers.
 */

// Set env before any imports
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'contract-test-jwt-secret';
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '5432';
process.env.DB_NAME = 'test';
process.env.DB_USER = 'test';
process.env.DB_PASSWORD = 'test';

// Mock database for all modules that import it at load time
jest.mock('../../src/config/database', () => ({
  getPool: () => ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn(),
      release: jest.fn(),
    }),
  }),
  closePool: jest.fn(),
}));

// Mock Ollama for subscription service
jest.mock('../../src/services/ollama', () => ({
  generateEmbedding: jest.fn().mockResolvedValue(null),
  checkOllamaHealth: jest.fn().mockResolvedValue(false),
}));

// -------------------------------------------------------
// Service contract checks
// -------------------------------------------------------

describe('Service exports', () => {
  describe('account service', () => {
    const accountService = require('../../src/services/account');

    it('exports all required functions', () => {
      expect(typeof accountService.createAccount).toBe('function');
      expect(typeof accountService.findByEmail).toBe('function');
      expect(typeof accountService.findById).toBe('function');
      expect(typeof accountService.findByApiKeyPrefix).toBe('function');
      expect(typeof accountService.verifyPassword).toBe('function');
      expect(typeof accountService.verifyApiKey).toBe('function');
      expect(typeof accountService.parseApiKey).toBe('function');
      expect(typeof accountService.rotateApiKey).toBe('function');
      expect(typeof accountService.revokeApiKey).toBe('function');
      expect(typeof accountService.updateProfile).toBe('function');
      expect(typeof accountService.toSafeAccount).toBe('function');
      expect(typeof accountService.getPublicProfile).toBe('function');
      expect(typeof accountService.confirmEmailByToken).toBe('function');
    });
  });

  describe('topic service', () => {
    const topicService = require('../../src/services/topic');

    it('exports all required functions', () => {
      expect(typeof topicService.createTopic).toBe('function');
      expect(typeof topicService.getTopicById).toBe('function');
      expect(typeof topicService.getTopicBySlug).toBe('function');
      expect(typeof topicService.listTopics).toBe('function');
      expect(typeof topicService.updateTopic).toBe('function');
      expect(typeof topicService.flagTopic).toBe('function');
      expect(typeof topicService.getTranslations).toBe('function');
      expect(typeof topicService.linkTranslation).toBe('function');
    });
  });

  describe('chunk service', () => {
    const chunkService = require('../../src/services/chunk');

    it('exports all required functions', () => {
      expect(typeof chunkService.createChunk).toBe('function');
      expect(typeof chunkService.getChunkById).toBe('function');
      expect(typeof chunkService.updateChunk).toBe('function');
      expect(typeof chunkService.retractChunk).toBe('function');
      expect(typeof chunkService.addSource).toBe('function');
      expect(typeof chunkService.getChunksByTopic).toBe('function');
    });
  });

  describe('message service', () => {
    const messageService = require('../../src/services/message');

    it('exports all required functions', () => {
      expect(typeof messageService.createMessage).toBe('function');
      expect(typeof messageService.getMessageById).toBe('function');
      expect(typeof messageService.listMessages).toBe('function');
      expect(typeof messageService.editMessage).toBe('function');
      expect(typeof messageService.getReplies).toBe('function');
      expect(typeof messageService.getMessagesByAccount).toBe('function');
    });

    it('exports VALID_TYPES array used by routes', () => {
      expect(Array.isArray(messageService.VALID_TYPES)).toBe(true);
      expect(messageService.VALID_TYPES).toContain('contribution');
      expect(messageService.VALID_TYPES).toContain('reply');
      expect(messageService.VALID_TYPES).toContain('flag');
    });

    it('exports TYPE_LEVEL_MAP used for level assignment', () => {
      expect(messageService.TYPE_LEVEL_MAP).toBeDefined();
      expect(messageService.TYPE_LEVEL_MAP.contribution).toBe(1);
      expect(messageService.TYPE_LEVEL_MAP.reply).toBe(1);
      expect(messageService.TYPE_LEVEL_MAP.flag).toBe(1);
      expect(messageService.TYPE_LEVEL_MAP.coordination).toBe(3);
    });
  });

  describe('vote service', () => {
    const voteService = require('../../src/services/vote');

    it('exports all required functions', () => {
      expect(typeof voteService.castVote).toBe('function');
      expect(typeof voteService.removeVote).toBe('function');
      expect(typeof voteService.getVotesByTarget).toBe('function');
      expect(typeof voteService.getVotesByAccount).toBe('function');
      expect(typeof voteService.getVoteSummary).toBe('function');
    });

    it('exports validation constants used by routes', () => {
      expect(Array.isArray(voteService.VALID_TARGET_TYPES)).toBe(true);
      expect(voteService.VALID_TARGET_TYPES).toContain('message');
      expect(voteService.VALID_TARGET_TYPES).toContain('policing_action');

      expect(Array.isArray(voteService.VALID_VALUES)).toBe(true);
      expect(voteService.VALID_VALUES).toContain('up');
      expect(voteService.VALID_VALUES).toContain('down');

      expect(Array.isArray(voteService.VALID_REASON_TAGS)).toBe(true);
      expect(voteService.VALID_REASON_TAGS).toContain('accurate');
      expect(voteService.VALID_REASON_TAGS).toContain('fair');
    });
  });

  describe('reputation service', () => {
    const reputationService = require('../../src/services/reputation');

    it('exports all required functions', () => {
      expect(typeof reputationService.recalculateReputation).toBe('function');
      expect(typeof reputationService.checkBadges).toBe('function');
      expect(typeof reputationService.recalculateAll).toBe('function');
      expect(typeof reputationService.getReputationDetails).toBe('function');
    });
  });

  describe('flag service', () => {
    const flagService = require('../../src/services/flag');

    it('exports all required functions', () => {
      expect(typeof flagService.createFlag).toBe('function');
      expect(typeof flagService.listFlags).toBe('function');
      expect(typeof flagService.reviewFlag).toBe('function');
      expect(typeof flagService.dismissFlag).toBe('function');
      expect(typeof flagService.actionFlag).toBe('function');
      expect(typeof flagService.getFlagsByTarget).toBe('function');
      expect(typeof flagService.getActiveFlagCount).toBe('function');
    });

    it('exports validation constants used by routes', () => {
      expect(Array.isArray(flagService.VALID_TARGET_TYPES)).toBe(true);
      expect(flagService.VALID_TARGET_TYPES).toContain('message');
      expect(flagService.VALID_TARGET_TYPES).toContain('account');
      expect(flagService.VALID_TARGET_TYPES).toContain('chunk');
      expect(flagService.VALID_TARGET_TYPES).toContain('topic');

      expect(Array.isArray(flagService.VALID_STATUSES)).toBe(true);
      expect(flagService.VALID_STATUSES).toContain('open');
      expect(flagService.VALID_STATUSES).toContain('reviewing');
      expect(flagService.VALID_STATUSES).toContain('dismissed');
      expect(flagService.VALID_STATUSES).toContain('actioned');
    });
  });

  describe('sanction service', () => {
    const sanctionService = require('../../src/services/sanction');

    it('exports all required functions', () => {
      expect(typeof sanctionService.createSanction).toBe('function');
      expect(typeof sanctionService.liftSanction).toBe('function');
      expect(typeof sanctionService.getSanctionHistory).toBe('function');
      expect(typeof sanctionService.listAllActive).toBe('function');
    });
  });

  describe('subscription service', () => {
    const subscriptionService = require('../../src/services/subscription');

    it('exports all required functions', () => {
      expect(typeof subscriptionService.createSubscription).toBe('function');
      expect(typeof subscriptionService.listMySubscriptions).toBe('function');
      expect(typeof subscriptionService.updateSubscription).toBe('function');
      expect(typeof subscriptionService.deleteSubscription).toBe('function');
      expect(typeof subscriptionService.getSubscriptionById).toBe('function');
      expect(typeof subscriptionService.getTier).toBe('function');
    });
  });

  describe('notification service', () => {
    const notificationService = require('../../src/services/notification');

    it('exports all required functions', () => {
      expect(typeof notificationService.dispatchNotification).toBe('function');
      expect(typeof notificationService.dispatchWebhook).toBe('function');
      expect(typeof notificationService.getPendingNotifications).toBe('function');
    });
  });

  describe('embedding service', () => {
    const embeddingService = require('../../src/services/embedding');

    it('exports expected functions', () => {
      expect(typeof embeddingService.embedChunk).toBe('function');
      expect(typeof embeddingService.embedChunkContent).toBe('function');
      expect(typeof embeddingService.retryPendingEmbeddings).toBe('function');
      expect(typeof embeddingService.recomputeAll).toBe('function');
    });
  });

  describe('vector-search service', () => {
    const vectorSearch = require('../../src/services/vector-search');

    it('exports expected functions', () => {
      expect(typeof vectorSearch.searchByVector).toBe('function');
      expect(typeof vectorSearch.searchByText).toBe('function');
      expect(typeof vectorSearch.hybridSearch).toBe('function');
    });
  });

  describe('subscription-matcher service', () => {
    const matcher = require('../../src/services/subscription-matcher');

    it('exports expected functions', () => {
      expect(typeof matcher.matchNewChunk).toBe('function');
    });
  });

  describe('topic-discussion service', () => {
    const topicDiscussion = require('../../src/services/topic-discussion');

    it('exports expected functions', () => {
      expect(typeof topicDiscussion.getDiscussion).toBe('function');
      expect(typeof topicDiscussion.postToDiscussion).toBe('function');
    });
  });

  describe('abuse-detection service', () => {
    const abuseDetection = require('../../src/services/abuse-detection');

    it('exports expected functions', () => {
      // Check for at least one exported function
      const exports = Object.keys(abuseDetection);
      expect(exports.length).toBeGreaterThan(0);
      for (const key of exports) {
        expect(typeof abuseDetection[key]).toBe('function');
      }
    });
  });
});

// -------------------------------------------------------
// Route module contract checks
// -------------------------------------------------------

describe('Route exports', () => {
  const routeModules = [
    { name: 'accounts', path: '../../src/routes/accounts' },
    { name: 'topics', path: '../../src/routes/topics' },
    { name: 'messages', path: '../../src/routes/messages' },
    { name: 'votes', path: '../../src/routes/votes' },
    { name: 'flags', path: '../../src/routes/flags' },
    { name: 'sanctions', path: '../../src/routes/sanctions' },
    { name: 'subscriptions', path: '../../src/routes/subscriptions' },
    { name: 'search', path: '../../src/routes/search' },
    { name: 'health', path: '../../src/routes/health' },
    { name: 'discussion', path: '../../src/routes/discussion' },
  ];

  for (const { name, path } of routeModules) {
    it(`${name} route exports an Express Router`, () => {
      const router = require(path);
      // Express routers are functions with a stack property
      expect(typeof router).toBe('function');
      expect(router.stack).toBeDefined();
      expect(Array.isArray(router.stack)).toBe(true);
    });
  }
});

// -------------------------------------------------------
// Auth middleware contract checks
// -------------------------------------------------------

describe('Auth middleware exports', () => {
  const auth = require('../../src/middleware/auth');

  it('exports authenticateRequired', () => {
    expect(typeof auth.authenticateRequired).toBe('function');
  });

  it('exports authenticateOptional', () => {
    expect(typeof auth.authenticateOptional).toBe('function');
  });

  it('exports requireStatus', () => {
    expect(typeof auth.requireStatus).toBe('function');
  });

  it('requireStatus returns a middleware function', () => {
    const middleware = auth.requireStatus('active');
    expect(typeof middleware).toBe('function');
    // Express middleware has 3 params (req, res, next)
    expect(middleware.length).toBe(3);
  });
});

// -------------------------------------------------------
// Badge middleware contract checks
// -------------------------------------------------------

describe('Badge middleware exports', () => {
  const badge = require('../../src/middleware/badge');

  it('exports requireBadge', () => {
    expect(typeof badge.requireBadge).toBe('function');
  });

  it('requireBadge returns a middleware function', () => {
    const middleware = badge.requireBadge('policing');
    expect(typeof middleware).toBe('function');
  });
});

// -------------------------------------------------------
// Rate limit middleware contract checks
// -------------------------------------------------------

describe('Rate limit middleware exports', () => {
  const rateLimit = require('../../src/middleware/rate-limit');

  it('exports registrationLimiter', () => {
    expect(typeof rateLimit.registrationLimiter).toBe('function');
  });

  it('exports authenticatedLimiter', () => {
    expect(typeof rateLimit.authenticatedLimiter).toBe('function');
  });

  it('exports publicLimiter', () => {
    expect(typeof rateLimit.publicLimiter).toBe('function');
  });
});

// -------------------------------------------------------
// Config contract checks
// -------------------------------------------------------

describe('Config exports', () => {
  it('database module exports getPool and closePool', () => {
    // We mocked this, but verify the mock shape matches expected usage
    const db = require('../../src/config/database');
    expect(typeof db.getPool).toBe('function');
    expect(typeof db.closePool).toBe('function');
  });

  it('env module exports validateEnv', () => {
    const env = require('../../src/config/env');
    expect(typeof env.validateEnv).toBe('function');
  });
});

// -------------------------------------------------------
// Cross-layer contract consistency
// -------------------------------------------------------

describe('Cross-layer contract consistency', () => {
  it('vote service VALID_TARGET_TYPES are referenced in routes', () => {
    const voteService = require('../../src/services/vote');
    // Routes use voteService.VALID_TARGET_TYPES directly, so this verifies
    // the constant exists and is an array
    expect(voteService.VALID_TARGET_TYPES.length).toBeGreaterThan(0);
  });

  it('vote service VALID_VALUES are referenced in routes', () => {
    const voteService = require('../../src/services/vote');
    expect(voteService.VALID_VALUES.length).toBeGreaterThan(0);
  });

  it('vote service VALID_REASON_TAGS are referenced in routes', () => {
    const voteService = require('../../src/services/vote');
    expect(voteService.VALID_REASON_TAGS.length).toBeGreaterThan(0);
  });

  it('message service VALID_TYPES are referenced in routes', () => {
    const messageService = require('../../src/services/message');
    expect(messageService.VALID_TYPES.length).toBeGreaterThan(0);
  });

  it('flag service VALID_TARGET_TYPES are referenced in routes', () => {
    const flagService = require('../../src/services/flag');
    expect(flagService.VALID_TARGET_TYPES.length).toBeGreaterThan(0);
  });

  it('all message types have level mappings', () => {
    const messageService = require('../../src/services/message');
    for (const type of messageService.VALID_TYPES) {
      expect(messageService.TYPE_LEVEL_MAP[type]).toBeDefined();
      expect(typeof messageService.TYPE_LEVEL_MAP[type]).toBe('number');
    }
  });

  it('content reason tags are a subset of all reason tags', () => {
    const voteService = require('../../src/services/vote');
    for (const tag of voteService.CONTENT_REASON_TAGS) {
      expect(voteService.VALID_REASON_TAGS).toContain(tag);
    }
  });

  it('policing reason tags are a subset of all reason tags', () => {
    const voteService = require('../../src/services/vote');
    for (const tag of voteService.POLICING_REASON_TAGS) {
      expect(voteService.VALID_REASON_TAGS).toContain(tag);
    }
  });

  it('app exports match what tests expect', () => {
    const { app, startServer } = require('../../src/index');
    expect(app).toBeDefined();
    expect(typeof startServer).toBe('function');
  });
});
