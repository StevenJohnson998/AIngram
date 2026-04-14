const {
  parseFields,
  applyFieldset,
  truncateContent,
  stripInternalFields,
} = require('../sparse-fieldset');

describe('parseFields', () => {
  it('returns null for undefined', () => {
    expect(parseFields(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseFields('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseFields('   ')).toBeNull();
  });

  it('returns a Set for valid comma-separated fields', () => {
    const result = parseFields('id,title,status');
    expect(result).toBeInstanceOf(Set);
    expect(result.has('id')).toBe(true);
    expect(result.has('title')).toBe(true);
    expect(result.has('status')).toBe(true);
    expect(result.size).toBe(3);
  });

  it('returns null for invalid characters', () => {
    expect(parseFields('id,title;evil')).toBeNull();
    expect(parseFields('id title')).toBeNull();
    expect(parseFields('id.title')).toBeNull();
  });

  it('returns null if more than 20 fields specified', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `field${i}`).join(',');
    expect(parseFields(tooMany)).toBeNull();
  });

  it('handles exactly 20 fields (boundary)', () => {
    const exact = Array.from({ length: 20 }, (_, i) => `field${i}`).join(',');
    const result = parseFields(exact);
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(20);
  });

  it('handles a single field', () => {
    const result = parseFields('id');
    expect(result).toBeInstanceOf(Set);
    expect(result.has('id')).toBe(true);
  });
});

describe('applyFieldset', () => {
  const row = { id: 'uuid', title: 'Test', slug: 'test', embedding: [1, 2, 3], content: 'hello' };

  it('returns only requested fields when fields Set is provided', () => {
    const result = applyFieldset(row, new Set(['title', 'slug']), { defaults: ['id', 'title'], always: ['id'] });
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('slug');
    expect(result).not.toHaveProperty('embedding');
    expect(result).not.toHaveProperty('content');
  });

  it('returns default fields when fields is null', () => {
    const result = applyFieldset(row, null, { defaults: ['id', 'title'], always: ['id'] });
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('title');
    expect(result).not.toHaveProperty('slug');
    expect(result).not.toHaveProperty('embedding');
  });

  it('always includes "always" fields even if not in defaults or requested', () => {
    const result = applyFieldset(row, new Set(['title']), { defaults: ['title'], always: ['id'] });
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('title');
  });

  it('does not include fields not present in the row', () => {
    const result = applyFieldset(row, null, { defaults: ['id', 'nonexistent'], always: ['id'] });
    expect(result).not.toHaveProperty('nonexistent');
  });

  it('uses id as default always field', () => {
    const result = applyFieldset(row, new Set(['title']), { defaults: ['title'] });
    expect(result).toHaveProperty('id');
  });
});

describe('truncateContent', () => {
  it('returns content unchanged if shorter than maxChars', () => {
    const result = truncateContent('hello', 200);
    expect(result.content).toBe('hello');
    expect(result.content_truncated).toBe(false);
  });

  it('truncates content exactly at maxChars', () => {
    const long = 'a'.repeat(300);
    const result = truncateContent(long, 200);
    expect(result.content).toHaveLength(200);
    expect(result.content_truncated).toBe(true);
  });

  it('does not truncate content exactly equal to maxChars', () => {
    const exact = 'a'.repeat(200);
    const result = truncateContent(exact, 200);
    expect(result.content).toBe(exact);
    expect(result.content_truncated).toBe(false);
  });

  it('handles null content gracefully', () => {
    const result = truncateContent(null, 200);
    expect(result.content).toBe('');
    expect(result.content_truncated).toBe(false);
  });

  it('handles empty string', () => {
    const result = truncateContent('', 200);
    expect(result.content).toBe('');
    expect(result.content_truncated).toBe(false);
  });

  it('uses default maxChars of 200 when not specified', () => {
    const long = 'a'.repeat(201);
    const result = truncateContent(long);
    expect(result.content).toHaveLength(200);
    expect(result.content_truncated).toBe(true);
  });
});

describe('stripInternalFields', () => {
  it('removes embedding from a row', () => {
    const row = { id: 'uuid', title: 'Test', embedding: [1, 2, 3] };
    stripInternalFields(row);
    expect(row).not.toHaveProperty('embedding');
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('title');
  });

  it('removes injection_flags from a row', () => {
    const row = { id: 'uuid', content: 'text', injection_flags: ['flag1'] };
    stripInternalFields(row);
    expect(row).not.toHaveProperty('injection_flags');
    expect(row).toHaveProperty('content');
  });

  it('removes injection_risk_score from a row', () => {
    const row = { id: 'uuid', content: 'text', injection_risk_score: 0.5 };
    stripInternalFields(row);
    expect(row).not.toHaveProperty('injection_risk_score');
  });

  it('mutates and returns the same row', () => {
    const row = { id: 'uuid', embedding: [1] };
    const result = stripInternalFields(row);
    expect(result).toBe(row);
  });

  it('does not throw when fields are not present', () => {
    const row = { id: 'uuid', title: 'Test' };
    expect(() => stripInternalFields(row)).not.toThrow();
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('title');
  });

  it('strips all three internal fields at once', () => {
    const row = {
      id: 'uuid',
      embedding: [1, 2, 3],
      injection_flags: ['x'],
      injection_risk_score: 0.9,
      content: 'ok',
    };
    stripInternalFields(row);
    expect(Object.keys(row)).toEqual(['id', 'content']);
  });
});
