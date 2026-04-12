'use strict';

const path = require('path');
const { listSkills, getSkill, getSkillsForTool, parseSkillFile, _reset } = require('../skills');

beforeEach(() => {
  _reset();
});

describe('parseSkillFile', () => {
  const skillsDir = path.join(__dirname, '..', '..', 'gui', 'skills');

  test('parses writing-content.txt with all header fields', () => {
    const skill = parseSkillFile(path.join(skillsDir, 'writing-content.txt'));
    expect(skill.slug).toBe('writing-content');
    expect(skill.title).toBe('Writing Content');
    expect(skill.relatedTools).toContain('contribute_chunk');
    expect(skill.relatedTools).toContain('propose_edit');
    expect(skill.relatedRefs).toContain('llms-contribute');
    expect(skill.category).toBe('contributing');
    expect(skill.content).toContain('Writing Good Summaries');
    expect(skill.content.length).toBeGreaterThan(100);
  });

  test('parses citing-sources.txt', () => {
    const skill = parseSkillFile(path.join(skillsDir, 'citing-sources.txt'));
    expect(skill.slug).toBe('citing-sources');
    expect(skill.relatedTools).toContain('contribute_chunk');
    expect(skill.content).toContain('Source Citations');
  });

  test('parses reviewing-content.txt', () => {
    const skill = parseSkillFile(path.join(skillsDir, 'reviewing-content.txt'));
    expect(skill.slug).toBe('reviewing-content');
    expect(skill.relatedTools).toContain('commit_vote');
    expect(skill.relatedTools).toContain('reveal_vote');
    expect(skill.relatedTools).toContain('list_review_queue');
    expect(skill.category).toBe('reviewing');
  });

  test('parses consuming-knowledge.txt', () => {
    const skill = parseSkillFile(path.join(skillsDir, 'consuming-knowledge.txt'));
    expect(skill.slug).toBe('consuming-knowledge');
    expect(skill.relatedTools).toContain('search');
    expect(skill.relatedTools).toContain('get_topic');
    expect(skill.relatedTools).toContain('get_chunk');
    expect(skill.category).toBe('consuming');
  });
});

describe('listSkills', () => {
  test('returns all skills without filter', () => {
    const skills = listSkills();
    expect(skills).toHaveLength(4);
    const slugs = skills.map(s => s.slug).sort();
    expect(slugs).toEqual(['citing-sources', 'consuming-knowledge', 'reviewing-content', 'writing-content']);
  });

  test('returns skills filtered by tool name', () => {
    const skills = listSkills('contribute_chunk');
    expect(skills.length).toBeGreaterThanOrEqual(2);
    const slugs = skills.map(s => s.slug);
    expect(slugs).toContain('writing-content');
    expect(slugs).toContain('citing-sources');
  });

  test('returns empty array for unknown tool', () => {
    const skills = listSkills('nonexistent_tool');
    expect(skills).toEqual([]);
  });

  test('does not include content in list results', () => {
    const skills = listSkills();
    for (const skill of skills) {
      expect(skill.content).toBeUndefined();
    }
  });

  test('each skill has slug, title, related_tools, category', () => {
    const skills = listSkills();
    for (const skill of skills) {
      expect(skill).toHaveProperty('slug');
      expect(skill).toHaveProperty('title');
      expect(skill).toHaveProperty('related_tools');
      expect(skill).toHaveProperty('category');
    }
  });
});

describe('getSkill', () => {
  test('returns full skill with content', () => {
    const skill = getSkill('writing-content');
    expect(skill).not.toBeNull();
    expect(skill.slug).toBe('writing-content');
    expect(skill.title).toBe('Writing Content');
    expect(skill.related_tools).toContain('contribute_chunk');
    expect(skill.related_refs).toContain('llms-contribute');
    expect(skill.content).toContain('Writing Good Summaries');
  });

  test('returns null for nonexistent slug', () => {
    const skill = getSkill('nonexistent');
    expect(skill).toBeNull();
  });
});

describe('getSkillsForTool', () => {
  test('returns skill slugs for contribute_chunk', () => {
    const slugs = getSkillsForTool('contribute_chunk');
    expect(slugs).toContain('writing-content');
    expect(slugs).toContain('citing-sources');
  });

  test('returns skill slugs for search', () => {
    const slugs = getSkillsForTool('search');
    expect(slugs).toContain('consuming-knowledge');
  });

  test('returns skill slugs for commit_vote', () => {
    const slugs = getSkillsForTool('commit_vote');
    expect(slugs).toContain('reviewing-content');
  });

  test('returns empty array for unknown tool', () => {
    const slugs = getSkillsForTool('unknown');
    expect(slugs).toEqual([]);
  });
});
