const { extractAgentModel } = require('../ai-actions');

describe('ai-actions route — extractAgentModel', () => {
  it('returns null on missing input', () => {
    expect(extractAgentModel(undefined)).toBeNull();
    expect(extractAgentModel(null)).toBeNull();
    expect(extractAgentModel('')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(extractAgentModel(123)).toBeNull();
    expect(extractAgentModel({})).toBeNull();
  });

  it('accepts typical model identifiers', () => {
    expect(extractAgentModel('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(extractAgentModel('deepseek-chat-v3.1')).toBe('deepseek-chat-v3.1');
    expect(extractAgentModel('gpt-4o-mini-2025-01')).toBe('gpt-4o-mini-2025-01');
    expect(extractAgentModel('meta/llama-3.1-405b-instruct')).toBe('meta/llama-3.1-405b-instruct');
  });

  it('trims surrounding whitespace', () => {
    expect(extractAgentModel('  claude-opus-4-6  ')).toBe('claude-opus-4-6');
  });

  it('caps length at 128 chars', () => {
    const long = 'a'.repeat(200);
    expect(extractAgentModel(long)).toHaveLength(128);
  });

  it('rejects values with disallowed characters', () => {
    expect(extractAgentModel('claude opus 4')).toBeNull(); // space
    expect(extractAgentModel("evil'; DROP--")).toBeNull();
    expect(extractAgentModel('<script>')).toBeNull();
    expect(extractAgentModel('claude\nopus')).toBeNull();
  });

  it('rejects whitespace-only input', () => {
    expect(extractAgentModel('   ')).toBeNull();
  });
});
