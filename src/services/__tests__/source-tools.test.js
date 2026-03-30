/**
 * Tests for Wayback Machine and License detection in copyright-review source tools.
 * All external HTTP calls are mocked — no real network requests.
 */

// Mock database
jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
}));

const { getPool } = require('../../config/database');

// We need to mock global fetch for Wayback + license detection
const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

// Import after mocks are set up
const { checkSources } = require('../copyright-review');

describe('checkSources with Wayback and License detection', () => {
  const chunkId = 'chunk-1';

  function mockPool(sources) {
    const pool = { query: jest.fn().mockResolvedValue({ rows: sources }) };
    getPool.mockReturnValue(pool);
    return pool;
  }

  it('returns wayback data when archive.org has a snapshot', async () => {
    mockPool([{ id: 's1', source_url: 'https://example.com/article', source_description: null }]);

    // Wayback response
    global.fetch
      .mockResolvedValueOnce({
        json: () => Promise.resolve({
          archived_snapshots: {
            closest: { available: true, url: 'https://web.archive.org/web/2025/https://example.com/article', timestamp: '20250101120000' }
          }
        }),
      })
      // License HEAD response (non-HTML)
      .mockResolvedValueOnce({
        headers: { get: () => 'application/pdf' },
      });

    const result = await checkSources(chunkId);
    expect(result.sources[0].wayback).toEqual({
      available: true,
      url: 'https://web.archive.org/web/2025/https://example.com/article',
      timestamp: '20250101120000',
    });
  });

  it('handles Wayback Machine timeout gracefully', async () => {
    mockPool([{ id: 's1', source_url: 'https://example.com/slow', source_description: null }]);

    global.fetch
      .mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
      .mockResolvedValueOnce({ headers: { get: () => 'text/plain' } });

    const result = await checkSources(chunkId);
    expect(result.sources[0].wayback).toEqual({
      available: false, url: null, timestamp: null,
    });
  });

  it('detects Creative Commons license via link rel tag', async () => {
    mockPool([{ id: 's1', source_url: 'https://example.com/page', source_description: null }]);

    const html = '<html><head><link rel="license" href="https://creativecommons.org/licenses/by-sa/4.0/"></head><body>Content</body></html>';

    global.fetch
      // Wayback
      .mockResolvedValueOnce({ json: () => Promise.resolve({ archived_snapshots: {} }) })
      // License HEAD
      .mockResolvedValueOnce({ headers: { get: () => 'text/html; charset=utf-8' } })
      // License GET
      .mockResolvedValueOnce({
        body: { getReader: () => mockReader(html) },
      });

    const result = await checkSources(chunkId);
    expect(result.sources[0].license).toEqual({
      license: 'CC BY-SA',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    });
  });

  it('detects MIT license from body text', async () => {
    mockPool([{ id: 's1', source_url: 'https://example.com/repo', source_description: null }]);

    const html = '<html><body><footer>Released under the MIT License. Copyright 2025.</footer></body></html>';

    global.fetch
      .mockResolvedValueOnce({ json: () => Promise.resolve({ archived_snapshots: {} }) })
      .mockResolvedValueOnce({ headers: { get: () => 'text/html' } })
      .mockResolvedValueOnce({ body: { getReader: () => mockReader(html) } });

    const result = await checkSources(chunkId);
    expect(result.sources[0].license).toEqual({ license: 'MIT', licenseUrl: null });
  });

  it('returns null license for non-HTML content', async () => {
    mockPool([{ id: 's1', source_url: 'https://example.com/data.json', source_description: null }]);

    global.fetch
      .mockResolvedValueOnce({ json: () => Promise.resolve({ archived_snapshots: {} }) })
      .mockResolvedValueOnce({ headers: { get: () => 'application/json' } });

    const result = await checkSources(chunkId);
    expect(result.sources[0].license).toEqual({ license: null, licenseUrl: null });
  });

  it('returns null license when no license found in HTML', async () => {
    mockPool([{ id: 's1', source_url: 'https://example.com/plain', source_description: null }]);

    const html = '<html><body><p>Just some content with no license info.</p></body></html>';

    global.fetch
      .mockResolvedValueOnce({ json: () => Promise.resolve({ archived_snapshots: {} }) })
      .mockResolvedValueOnce({ headers: { get: () => 'text/html' } })
      .mockResolvedValueOnce({ body: { getReader: () => mockReader(html) } });

    const result = await checkSources(chunkId);
    expect(result.sources[0].license).toEqual({ license: null, licenseUrl: null });
  });

  it('handles license detection network error gracefully', async () => {
    mockPool([{ id: 's1', source_url: 'https://example.com/down', source_description: null }]);

    global.fetch
      .mockResolvedValueOnce({ json: () => Promise.resolve({ archived_snapshots: {} }) })
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await checkSources(chunkId);
    expect(result.sources[0].license).toEqual({ license: null, licenseUrl: null });
  });

  it('skips Wayback and license for description-only sources', async () => {
    mockPool([{ id: 's1', source_url: null, source_description: 'A book from 1995' }]);

    const result = await checkSources(chunkId);
    expect(result.sources[0].type).toBe('description_only');
    expect(result.sources[0].wayback).toBeUndefined();
    expect(result.sources[0].license).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('checks Wayback but skips license for DOI sources', async () => {
    mockPool([{ id: 's1', source_url: 'https://doi.org/10.1234/test', source_description: null }]);

    global.fetch
      .mockResolvedValueOnce({
        json: () => Promise.resolve({
          archived_snapshots: { closest: { available: true, url: 'https://web.archive.org/doi', timestamp: '20240601' } }
        }),
      });

    const result = await checkSources(chunkId);
    expect(result.sources[0].type).toBe('doi');
    expect(result.sources[0].wayback.available).toBe(true);
    expect(result.sources[0].license).toBeUndefined(); // DOIs don't get license detection
  });

  it('returns empty sources array with warning when chunk has no sources', async () => {
    mockPool([]);
    const result = await checkSources(chunkId);
    expect(result.sources).toEqual([]);
    expect(result.warning).toBeDefined();
  });
});

/** Helper: create a mock ReadableStream reader from a string. */
function mockReader(str) {
  const buf = Buffer.from(str, 'utf-8');
  let sent = false;
  return {
    read: () => {
      if (!sent) {
        sent = true;
        return Promise.resolve({ done: false, value: buf });
      }
      return Promise.resolve({ done: true });
    },
    cancel: jest.fn(),
  };
}
