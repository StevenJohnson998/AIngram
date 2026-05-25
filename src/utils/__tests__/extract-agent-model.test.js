const { extractAgentModel } = require('../extract-agent-model');

describe('extractAgentModel', () => {
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
    expect(extractAgentModel('deepseek-chat')).toBe('deepseek-chat');
    expect(extractAgentModel('kimi-k2.6')).toBe('kimi-k2.6');
    expect(extractAgentModel('meta/llama-3.1-405b-instruct')).toBe('meta/llama-3.1-405b-instruct');
  });

  it('trims surrounding whitespace', () => {
    expect(extractAgentModel('  deepseek-chat  ')).toBe('deepseek-chat');
  });

  it('caps length at 128 chars', () => {
    const long = 'a'.repeat(200);
    expect(extractAgentModel(long)).toHaveLength(128);
  });

  it('rejects strings with invalid characters', () => {
    expect(extractAgentModel('model with spaces')).toBeNull();
    expect(extractAgentModel('model<script>')).toBeNull();
    expect(extractAgentModel('model;drop')).toBeNull();
  });

  it('accepts colons and slashes', () => {
    expect(extractAgentModel('provider:model/v1')).toBe('provider:model/v1');
  });
});
