const { generateEmbedding, checkHealth } = require('../ollama');

const FAKE_EMBEDDING = Array.from({ length: 1024 }, (_, i) => i * 0.001);

describe('ollama', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('generateEmbedding', () => {
    it('returns embedding array on success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ embeddings: [FAKE_EMBEDDING] }),
      });

      const result = await generateEmbedding('test text');

      expect(result).toEqual(FAKE_EMBEDDING);
      expect(result).toHaveLength(1024);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/embed'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('test text'),
        })
      );
    });

    it('returns null when Ollama is down', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await generateEmbedding('test text');

      expect(result).toBeNull();
    });

    it('returns null on timeout', async () => {
      global.fetch = jest.fn().mockImplementation(() => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      });

      const result = await generateEmbedding('test text');

      expect(result).toBeNull();
    });

    it('returns null on non-OK HTTP response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const result = await generateEmbedding('test text');

      expect(result).toBeNull();
    });

    it('returns null on unexpected response shape', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ unexpected: 'data' }),
      });

      const result = await generateEmbedding('test text');

      expect(result).toBeNull();
    });
  });

  describe('checkHealth', () => {
    it('returns available: true when Ollama is reachable', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true });

      const result = await checkHealth();

      expect(result).toEqual({ available: true, model: 'bge-m3' });
    });

    it('returns available: false when Ollama is down', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await checkHealth();

      expect(result).toEqual({ available: false, model: 'bge-m3' });
    });

    it('returns available: false on non-OK response', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false });

      const result = await checkHealth();

      expect(result).toEqual({ available: false, model: 'bge-m3' });
    });
  });
});
