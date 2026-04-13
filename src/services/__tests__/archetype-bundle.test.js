'use strict';

const { buildBundle, KNOWN_ARCHETYPES } = require('../archetype-bundle');
const BUNDLES = require('../../config/archetype-bundles');

describe('archetype-bundle', () => {
  describe('KNOWN_ARCHETYPES', () => {
    test('matches the 5 documented archetypes', () => {
      expect(KNOWN_ARCHETYPES.sort()).toEqual(
        ['contributor', 'curator', 'teacher', 'sentinel', 'joker'].sort()
      );
    });
  });

  describe('buildBundle — happy path', () => {
    test.each(Object.keys(BUNDLES))('%s returns a non-empty markdown bundle', (name) => {
      const md = buildBundle(name);
      expect(typeof md).toBe('string');
      expect(md.length).toBeGreaterThan(100);
      expect(md).toMatch(/^# (Contributor|Curator|Teacher|Sentinel|Joker)\n/);
      expect(md).toContain('# Missions');
      expect(md).toContain('# Skills');
    });

    test('contributor bundle contains its missions and skills as headers', () => {
      const md = buildBundle('contributor');
      expect(md).toContain('## Mission: write');
      expect(md).toContain('## Mission: correct');
      expect(md).toContain('## Mission: converse');
      expect(md).toContain('## Skill: writing-content');
      expect(md).toContain('## Skill: citing-sources');
      expect(md).toContain('## Skill: debate-etiquette');
    });

    test('curator bundle contains its full loadout', () => {
      const md = buildBundle('curator');
      for (const m of ['review', 'correct', 'refresh', 'validate']) {
        expect(md).toContain(`## Mission: ${m}`);
      }
      for (const s of ['reviewing-content', 'citing-sources']) {
        expect(md).toContain(`## Skill: ${s}`);
      }
    });

    test('sentinel bundle has flag/moderate/correct missions', () => {
      const md = buildBundle('sentinel');
      expect(md).toContain('## Mission: flag');
      expect(md).toContain('## Mission: moderate');
      expect(md).toContain('## Skill: spotting-abuse');
      expect(md).toContain('## Skill: moderation-triage');
    });

    test('teacher bundle includes course-creation skill', () => {
      const md = buildBundle('teacher');
      expect(md).toContain('## Skill: course-creation');
    });

    test('joker bundle is valid with empty missions list', () => {
      const md = buildBundle('joker');
      expect(md).toContain('# Joker');
      expect(md).toContain('# Missions');
      expect(md).toMatch(/no fixed missions/i);
      expect(md).not.toContain('## Mission:');
      expect(md).toContain('## Skill: consuming-knowledge');
    });

    test('the archetype section from ARCHETYPES.md is embedded', () => {
      const md = buildBundle('curator');
      expect(md).toContain('## The Curator');
      expect(md).toContain('Load before acting');
      expect(md).not.toContain('## The Contributor');
      expect(md).not.toContain('Machine-readable');
    });

    test('sets no trailing section leakage from next archetype', () => {
      const md = buildBundle('sentinel');
      expect(md).toContain('## The Sentinel');
      expect(md).not.toContain('## The Joker');
    });
  });

  describe('buildBundle — validation', () => {
    test('throws VALIDATION_ERROR on unknown archetype', () => {
      expect(() => buildBundle('wizard')).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' })
      );
    });

    test('throws VALIDATION_ERROR on empty name', () => {
      expect(() => buildBundle('')).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' })
      );
    });

    test('throws VALIDATION_ERROR on non-lowercase name', () => {
      expect(() => buildBundle('Curator')).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' })
      );
    });

    test('throws VALIDATION_ERROR on non-string input', () => {
      expect(() => buildBundle(null)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' })
      );
    });
  });
});
