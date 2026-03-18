const {
  LANG_TO_PG_CONFIG,
  getSearchConfigs,
  buildFtsCondition,
  buildRankExpression,
} = require('../search');

describe('search route helpers', () => {
  describe('LANG_TO_PG_CONFIG', () => {
    it('maps supported languages to PG text search configs', () => {
      expect(LANG_TO_PG_CONFIG.en).toBe('english');
      expect(LANG_TO_PG_CONFIG.fr).toBe('french');
      expect(LANG_TO_PG_CONFIG.de).toBe('german');
      expect(LANG_TO_PG_CONFIG.es).toBe('spanish');
      expect(LANG_TO_PG_CONFIG.it).toBe('italian');
      expect(LANG_TO_PG_CONFIG.pt).toBe('portuguese');
      expect(LANG_TO_PG_CONFIG.ru).toBe('russian');
      expect(LANG_TO_PG_CONFIG.nl).toBe('dutch');
      expect(LANG_TO_PG_CONFIG.sv).toBe('swedish');
      expect(LANG_TO_PG_CONFIG.tr).toBe('turkish');
    });

    it('maps unsupported languages to simple', () => {
      expect(LANG_TO_PG_CONFIG.zh).toBe('simple');
      expect(LANG_TO_PG_CONFIG.hi).toBe('simple');
      expect(LANG_TO_PG_CONFIG.ar).toBe('simple');
      expect(LANG_TO_PG_CONFIG.ja).toBe('simple');
      expect(LANG_TO_PG_CONFIG.ko).toBe('simple');
      expect(LANG_TO_PG_CONFIG.pl).toBe('simple');
    });
  });

  describe('getSearchConfigs', () => {
    it('returns only english for en users', () => {
      expect(getSearchConfigs('en')).toEqual(['english']);
    });

    it('returns user lang + english for non-en users', () => {
      expect(getSearchConfigs('fr')).toEqual(['french', 'english']);
    });

    it('returns simple + english for unsupported langs', () => {
      expect(getSearchConfigs('zh')).toEqual(['simple', 'english']);
    });

    it('avoids duplicate when user lang maps to same as english', () => {
      // 'en' maps to 'english', so should only return one
      const configs = getSearchConfigs('en');
      expect(configs).toHaveLength(1);
    });
  });

  describe('buildFtsCondition', () => {
    it('builds single config condition', () => {
      const result = buildFtsCondition(['english'], '$1');
      expect(result).toBe(
        "(to_tsvector('english', c.content) @@ plainto_tsquery('english', $1))"
      );
    });

    it('builds bilingual OR condition', () => {
      const result = buildFtsCondition(['french', 'english'], '$1');
      expect(result).toContain('OR');
      expect(result).toContain("'french'");
      expect(result).toContain("'english'");
    });
  });

  describe('buildRankExpression', () => {
    it('builds single config rank', () => {
      const result = buildRankExpression(['english'], '$1');
      expect(result).toContain("ts_rank(to_tsvector('english'");
      expect(result).not.toContain('GREATEST');
    });

    it('builds GREATEST for multiple configs', () => {
      const result = buildRankExpression(['french', 'english'], '$1');
      expect(result).toContain('GREATEST');
      expect(result).toContain("'french'");
      expect(result).toContain("'english'");
    });
  });
});
