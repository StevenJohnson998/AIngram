const { generateSlug, ensureUniqueSlug } = require('../slug');

describe('generateSlug', () => {
  it('converts a normal title to a slug', () => {
    expect(generateSlug('Hello World')).toBe('hello-world');
  });

  it('handles multiple spaces', () => {
    expect(generateSlug('hello   world')).toBe('hello-world');
  });

  it('removes special characters', () => {
    expect(generateSlug('Hello, World! How are you?')).toBe('hello-world-how-are-you');
  });

  it('handles leading/trailing spaces and hyphens', () => {
    expect(generateSlug('  --Hello World--  ')).toBe('hello-world');
  });

  it('handles accented characters (diacritics)', () => {
    expect(generateSlug('Resume de la lecon')).toBe('resume-de-la-lecon');
    expect(generateSlug('Resumi de la lecon')).toBe('resumi-de-la-lecon');
  });

  it('strips French diacritics', () => {
    expect(generateSlug('Les experiences de Rene')).toBe('les-experiences-de-rene');
  });

  it('handles unicode by stripping non-alphanumeric', () => {
    // CJK characters get stripped since they are non-alphanumeric in latin range
    expect(generateSlug('test title')).toBe('test-title');
  });

  it('collapses multiple hyphens', () => {
    expect(generateSlug('hello---world')).toBe('hello-world');
  });

  it('handles empty string', () => {
    expect(generateSlug('')).toBe('');
  });

  it('handles null/undefined', () => {
    expect(generateSlug(null)).toBe('');
    expect(generateSlug(undefined)).toBe('');
  });

  it('handles numbers in title', () => {
    expect(generateSlug('Top 10 AI Models in 2026')).toBe('top-10-ai-models-in-2026');
  });
});

describe('ensureUniqueSlug', () => {
  function createMockPool(existingSlugs) {
    return {
      query: jest.fn((sql, params) => {
        const slug = params[0];
        const found = existingSlugs.includes(slug);
        return Promise.resolve({ rows: found ? [{ slug }] : [] });
      }),
    };
  }

  it('returns the slug as-is if no collision', async () => {
    const pool = createMockPool([]);
    const result = await ensureUniqueSlug('hello-world', 'en', pool);
    expect(result).toBe('hello-world');
  });

  it('appends -1 on first collision', async () => {
    const pool = createMockPool(['hello-world']);
    const result = await ensureUniqueSlug('hello-world', 'en', pool);
    expect(result).toBe('hello-world-1');
  });

  it('appends -2 when -1 also collides', async () => {
    const pool = createMockPool(['hello-world', 'hello-world-1']);
    const result = await ensureUniqueSlug('hello-world', 'en', pool);
    expect(result).toBe('hello-world-2');
  });

  it('passes lang to the query', async () => {
    const pool = createMockPool([]);
    await ensureUniqueSlug('test', 'fr', pool);
    expect(pool.query).toHaveBeenCalledWith(
      expect.any(String),
      ['test', 'fr']
    );
  });
});
