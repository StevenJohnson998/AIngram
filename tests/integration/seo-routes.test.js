/**
 * SEO routes integration tests
 *
 * Covers the three discovery-layer routes added for GEO/SEO:
 *   - GET /robots.txt
 *   - GET /sitemap.xml
 *   - GET /topic.html (SSR: meta tags + JSON-LD)
 *
 * All DB/service calls are mocked; these are route-level tests.
 */

'use strict';

// --- env must be set before loading app ---
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'seo-routes-test-jwt-secret';
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '5432';
process.env.DB_NAME = 'test';
process.env.DB_USER = 'test';
process.env.DB_PASSWORD = 'test';

// --- mock DB (for sitemap.xml query) ---
const mockPoolQuery = jest.fn();
jest.mock('../../src/config/database', () => ({
  getPool: () => ({ query: mockPoolQuery, connect: jest.fn() }),
  closePool: jest.fn(),
}));

// --- mock Ollama (loaded transitively by subscription service) ---
jest.mock('../../src/services/ollama', () => ({
  generateEmbedding: jest.fn().mockResolvedValue(null),
  checkOllamaHealth: jest.fn().mockResolvedValue(false),
}));

// --- mock topic service (for SSR topic.html) ---
const mockGetTopicById = jest.fn();
const mockGetTopicBySlug = jest.fn();
jest.mock('../../src/services/topic', () => {
  const actual = jest.requireActual('../../src/services/topic');
  return {
    ...actual,
    getTopicById: (...args) => mockGetTopicById(...args),
    getTopicBySlug: (...args) => mockGetTopicBySlug(...args),
  };
});

const request = require('supertest');
const { app } = require('../../src/index');

// -------------------------------------------------------
// /robots.txt
// -------------------------------------------------------

describe('GET /robots.txt', () => {
  const originalOrigin = process.env.AINGRAM_GUI_ORIGIN;

  afterEach(() => {
    if (originalOrigin === undefined) {
      delete process.env.AINGRAM_GUI_ORIGIN;
    } else {
      process.env.AINGRAM_GUI_ORIGIN = originalOrigin;
    }
  });

  it('returns 200 text/plain with User-agent and Disallow lines', async () => {
    delete process.env.AINGRAM_GUI_ORIGIN;
    const res = await request(app).get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toMatch(/^User-agent: \*/m);
    expect(res.text).toMatch(/^Disallow: \/v1\/accounts\//m);
    expect(res.text).toMatch(/^Disallow: \/admin\.html/m);
    expect(res.text).toMatch(/^Disallow: \/settings\.html/m);
  });

  it('omits the Sitemap directive when AINGRAM_GUI_ORIGIN is unset', async () => {
    delete process.env.AINGRAM_GUI_ORIGIN;
    const res = await request(app).get('/robots.txt');
    expect(res.text).not.toMatch(/^Sitemap:/m);
  });

  it('emits Sitemap directive built from AINGRAM_GUI_ORIGIN when set', async () => {
    process.env.AINGRAM_GUI_ORIGIN = 'https://example.test';
    const res = await request(app).get('/robots.txt');
    expect(res.text).toMatch(/^Sitemap: https:\/\/example\.test\/sitemap\.xml$/m);
  });

  it('strips trailing slash from origin in Sitemap directive', async () => {
    process.env.AINGRAM_GUI_ORIGIN = 'https://example.test/';
    const res = await request(app).get('/robots.txt');
    expect(res.text).toMatch(/^Sitemap: https:\/\/example\.test\/sitemap\.xml$/m);
  });
});

// -------------------------------------------------------
// /sitemap.xml
// -------------------------------------------------------

describe('GET /sitemap.xml', () => {
  const originalOrigin = process.env.AINGRAM_GUI_ORIGIN;

  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  afterEach(() => {
    if (originalOrigin === undefined) {
      delete process.env.AINGRAM_GUI_ORIGIN;
    } else {
      process.env.AINGRAM_GUI_ORIGIN = originalOrigin;
    }
  });

  it('returns 503 when AINGRAM_GUI_ORIGIN is not configured', async () => {
    delete process.env.AINGRAM_GUI_ORIGIN;
    const res = await request(app).get('/sitemap.xml');
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it('returns a well-formed sitemap with static + topic URLs', async () => {
    process.env.AINGRAM_GUI_ORIGIN = 'https://example.test';
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: '11111111-1111-1111-1111-111111111111', topic_type: 'knowledge', updated_at: new Date('2026-04-20T12:00:00Z') },
        { id: '22222222-2222-2222-2222-222222222222', topic_type: 'course', updated_at: new Date('2026-04-15T12:00:00Z') },
      ],
    });

    const res = await request(app).get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.headers['cache-control']).toMatch(/max-age=3600/);

    // Structural
    expect(res.text).toMatch(/^<\?xml version="1\.0"/);
    expect(res.text).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(res.text).toContain('</urlset>');

    // Static URLs
    expect(res.text).toContain('<loc>https://example.test/</loc>');
    expect(res.text).toContain('<loc>https://example.test/search.html</loc>');
    expect(res.text).toContain('<loc>https://example.test/debates.html</loc>');
    expect(res.text).toContain('<loc>https://example.test/search.html?topicType=course</loc>');

    // Topic URLs with lastmod
    expect(res.text).toContain('<loc>https://example.test/topic.html?id=11111111-1111-1111-1111-111111111111</loc>');
    expect(res.text).toContain('<lastmod>2026-04-20</lastmod>');

    // Course gets higher priority than knowledge topic
    expect(res.text).toContain('<loc>https://example.test/topic.html?id=22222222-2222-2222-2222-222222222222</loc>');

    // Balanced <url> tags
    const open = (res.text.match(/<url>/g) || []).length;
    const close = (res.text.match(/<\/url>/g) || []).length;
    expect(open).toBe(close);
    expect(open).toBeGreaterThanOrEqual(7 + 2); // static + 2 topics
  });

  it('serves from in-memory cache on a subsequent request (no extra DB query)', async () => {
    process.env.AINGRAM_GUI_ORIGIN = 'https://example.test';
    mockPoolQuery.mockResolvedValue({ rows: [] });

    // Warm the cache first; the sitemap route may already be cached from a previous
    // test (module-level state), so we can't assume the first call hits the DB.
    await request(app).get('/sitemap.xml');
    // Now the cache is guaranteed populated; the next call must not touch the DB.
    mockPoolQuery.mockClear();
    await request(app).get('/sitemap.xml');
    expect(mockPoolQuery).toHaveBeenCalledTimes(0);
  });
});

// -------------------------------------------------------
// /topic.html SSR
// -------------------------------------------------------

describe('GET /topic.html (SSR enhancement)', () => {
  const originalOrigin = process.env.AINGRAM_GUI_ORIGIN;

  beforeEach(() => {
    mockGetTopicById.mockReset();
    mockGetTopicBySlug.mockReset();
    process.env.AINGRAM_GUI_ORIGIN = 'https://example.test';
  });

  afterEach(() => {
    if (originalOrigin === undefined) {
      delete process.env.AINGRAM_GUI_ORIGIN;
    } else {
      process.env.AINGRAM_GUI_ORIGIN = originalOrigin;
    }
  });

  it('falls through to static HTML when no id or slug', async () => {
    const res = await request(app).get('/topic.html');
    expect(res.status).toBe(200);
    // Static title is "AIngram - Article"
    expect(res.text).toContain('<title>AIngram - Article</title>');
    expect(res.text).not.toContain('application/ld+json');
    expect(mockGetTopicById).not.toHaveBeenCalled();
  });

  it('falls through to static when id is not a valid UUID', async () => {
    const res = await request(app).get('/topic.html?id=not-a-uuid');
    expect(res.text).toContain('<title>AIngram - Article</title>');
    expect(mockGetTopicById).not.toHaveBeenCalled();
  });

  it('falls through to static when the topic is not found', async () => {
    mockGetTopicById.mockResolvedValueOnce(null);
    const res = await request(app).get('/topic.html?id=11111111-1111-1111-1111-111111111111');
    expect(res.text).toContain('<title>AIngram - Article</title>');
    expect(mockGetTopicById).toHaveBeenCalledTimes(1);
  });

  it('renders SSR metadata + JSON-LD Article when a knowledge topic is found', async () => {
    mockGetTopicById.mockResolvedValueOnce({
      id: '11111111-1111-1111-1111-111111111111',
      title: 'Memory Patterns for AI Agents',
      slug: 'memory-patterns-for-ai-agents',
      summary: 'A guide to scratchpad, episodic, semantic, and procedural memory.',
      lang: 'en',
      topic_type: 'knowledge',
      created_at: new Date('2026-04-10T00:00:00Z'),
      updated_at: new Date('2026-04-20T00:00:00Z'),
    });

    const res = await request(app).get('/topic.html?id=11111111-1111-1111-1111-111111111111');
    expect(res.status).toBe(200);

    // Dynamic title replaces the static one
    expect(res.text).toContain('<title>Memory Patterns for AI Agents · AIngram</title>');
    expect(res.text).not.toContain('<title>AIngram - Article</title>');

    // Meta description from summary
    expect(res.text).toMatch(/<meta name="description" content="A guide to scratchpad/);

    // Canonical
    expect(res.text).toContain('<link rel="canonical" href="https://example.test/topic.html?id=11111111-1111-1111-1111-111111111111">');

    // OpenGraph set
    expect(res.text).toContain('<meta property="og:title" content="Memory Patterns for AI Agents">');
    expect(res.text).toContain('<meta property="og:type" content="article">');
    expect(res.text).toContain('<meta property="og:url" content="https://example.test/topic.html?id=11111111-1111-1111-1111-111111111111">');
    expect(res.text).toContain('<meta property="og:locale" content="en">');

    // Twitter card
    expect(res.text).toContain('<meta name="twitter:card" content="summary">');

    // JSON-LD with Article type
    const ldMatch = res.text.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/);
    expect(ldMatch).not.toBeNull();
    const ld = JSON.parse(ldMatch[1]);
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('Article');
    expect(ld.headline).toBe('Memory Patterns for AI Agents');
    expect(ld.inLanguage).toBe('en');
    expect(ld.datePublished).toBe('2026-04-10T00:00:00.000Z');
    expect(ld.dateModified).toBe('2026-04-20T00:00:00.000Z');
    expect(ld.author).toEqual({ '@type': 'Organization', name: 'AIngram' });
  });

  it('emits JSON-LD @type=Course when topic_type is course', async () => {
    mockGetTopicById.mockResolvedValueOnce({
      id: '22222222-2222-2222-2222-222222222222',
      title: 'AI Agents Demystified',
      slug: 'ai-agents-demystified',
      summary: 'A 6-chapter course on AI agents.',
      lang: 'en',
      topic_type: 'course',
      created_at: new Date('2026-04-19T00:00:00Z'),
      updated_at: new Date('2026-04-19T00:00:00Z'),
    });

    const res = await request(app).get('/topic.html?id=22222222-2222-2222-2222-222222222222');
    expect(res.text).toContain('<title>AI Agents Demystified · Course · AIngram</title>');

    const ldMatch = res.text.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/);
    const ld = JSON.parse(ldMatch[1]);
    expect(ld['@type']).toBe('Course');
    expect(ld.provider).toEqual({ '@type': 'Organization', name: 'AIngram' });
  });

  it('supports ?slug=&lang= lookups', async () => {
    mockGetTopicBySlug.mockResolvedValueOnce({
      id: '33333333-3333-3333-3333-333333333333',
      title: 'Vector Search Primer',
      slug: 'vector-search-primer',
      summary: 'How embeddings and ANN indexes work in agent KBs.',
      lang: 'en',
      topic_type: 'knowledge',
      created_at: new Date('2026-04-01T00:00:00Z'),
      updated_at: new Date('2026-04-01T00:00:00Z'),
    });

    const res = await request(app).get('/topic.html?slug=vector-search-primer&lang=en');
    expect(res.text).toContain('<title>Vector Search Primer · AIngram</title>');
    expect(mockGetTopicBySlug).toHaveBeenCalledWith('vector-search-primer', 'en');
  });

  it('strips markdown / citation markup from the meta description', async () => {
    mockGetTopicById.mockResolvedValueOnce({
      id: '44444444-4444-4444-4444-444444444444',
      title: 'Noisy Summary',
      summary: 'Quick guide **bold** [[linked-topic]] with [ref:Paper;url:https://example.com/p] citation. End.',
      lang: 'en',
      topic_type: 'knowledge',
      created_at: new Date('2026-04-01T00:00:00Z'),
      updated_at: new Date('2026-04-01T00:00:00Z'),
    });

    const res = await request(app).get('/topic.html?id=44444444-4444-4444-4444-444444444444');
    const descMatch = res.text.match(/<meta name="description" content="([^"]+)"/);
    expect(descMatch).not.toBeNull();
    const desc = descMatch[1];
    expect(desc).not.toMatch(/\[ref:/);
    expect(desc).not.toMatch(/\[\[/);
    expect(desc).not.toMatch(/\*\*/);
    expect(desc).toContain('linked-topic'); // preserves the visible token from [[slug]]
  });
});
