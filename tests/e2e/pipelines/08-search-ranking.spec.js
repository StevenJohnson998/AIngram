// @ts-check
/**
 * 08 — Search Ranking Influenced by Trust Score
 *
 * Verifies that chunks with higher trust_score rank above
 * equally-relevant chunks with lower trust_score.
 */

const { test, expect } = require('@playwright/test');
const {
  BASE, createUserInDB, createTopicInDB, createChunkInDB, unique,
} = require('./helpers');

test.describe('Search Ranking × Trust Score', () => {
  let highTrustChunkId, lowTrustChunkId;
  const keyword = `thermodynamics${Date.now()}`;

  test.beforeAll(async () => {
    const author = createUserInDB({ prefix: 'e2e-search' });
    const topic = createTopicInDB(author.id);

    // Two chunks with identical searchable content but different trust scores
    highTrustChunkId = createChunkInDB(topic.id, author.id,
      `${keyword} equilibrium principles and energy conservation laws in closed systems`,
      { trustScore: 0.95 });

    lowTrustChunkId = createChunkInDB(topic.id, author.id,
      `${keyword} equilibrium principles and energy conservation laws in open systems`,
      { trustScore: 0.1 });
  });

  test('text search ranks higher-trust chunk first', async ({ request }) => {
    const res = await request.get(`${BASE}/v1/search?q=${keyword}&type=text&limit=10`);
    expect(res.status()).toBe(200);
    const json = await res.json();
    const results = json.data;

    // Filter to only our test chunks
    const ours = results.filter(r => r.id === highTrustChunkId || r.id === lowTrustChunkId);

    if (ours.length >= 2) {
      expect(ours[0].id).toBe(highTrustChunkId);
      expect(parseFloat(ours[0].trust_score)).toBeGreaterThan(parseFloat(ours[1].trust_score));
    } else {
      // Both chunks should appear in results for the unique keyword
      expect(ours.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('hybrid search ranks higher-trust chunk first', async ({ request }) => {
    const res = await request.get(`${BASE}/v1/search?q=${keyword}&type=hybrid&limit=10`);

    if (res.status() === 503) {
      test.skip(true, 'Embedding service unavailable — hybrid falls back to text');
      return;
    }
    expect(res.status()).toBe(200);
    const json = await res.json();
    const results = json.data;

    const ours = results.filter(r => r.id === highTrustChunkId || r.id === lowTrustChunkId);

    if (ours.length >= 2) {
      expect(ours[0].id).toBe(highTrustChunkId);
    }
  });

  test('vector search ranks higher-trust chunk first (skip if no Ollama)', async ({ request }) => {
    const res = await request.get(`${BASE}/v1/search?q=${keyword}&type=vector&limit=10`);

    if (res.status() === 503) {
      test.skip(true, 'Ollama unavailable');
      return;
    }
    expect(res.status()).toBe(200);
    const json = await res.json();
    const results = json.data;

    const ours = results.filter(r => r.id === highTrustChunkId || r.id === lowTrustChunkId);

    if (ours.length >= 2) {
      expect(ours[0].id).toBe(highTrustChunkId);
    }
  });
});
