const {
  LANG_TO_PG_CONFIG,
  getSearchConfigs,
  buildFtsCondition,
  buildRankExpression,
  generateSearchGuidance,
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
      expect(result).toContain("to_tsvector('english'");
      expect(result).toContain("plainto_tsquery('english'");
      expect(result).toContain('t.title');
      expect(result).toContain('c.content');
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

  describe('generateSearchGuidance', () => {
    it('always includes mode_used and available_modes', () => {
      const result = generateSearchGuidance('test', 'text');
      expect(result.mode_used).toBe('text');
      expect(result.available_modes).toEqual(['text', 'vector', 'hybrid']);
    });

    it('suggests vector for question-format queries in text mode', () => {
      const result = generateSearchGuidance('How do agents handle trust?', 'text');
      expect(result.tip).toContain('vector');
    });

    it('suggests vector for short queries in text mode', () => {
      const result = generateSearchGuidance('agents', 'text');
      expect(result.tip).toContain('vector');
    });

    it('no tip for short exact terms in text mode', () => {
      const result = generateSearchGuidance('AMOC', 'text');
      expect(result.tip).toBeUndefined();
    });

    it('suggests text for single-word queries in vector mode', () => {
      const result = generateSearchGuidance('governance', 'vector');
      expect(result.tip).toContain('text');
    });

    it('suggests text for exact terms in vector mode', () => {
      const result = generateSearchGuidance('HNSW', 'vector');
      expect(result.tip).toContain('text');
    });

    it('suggests hybrid for long queries in vector mode', () => {
      const result = generateSearchGuidance(
        'how do multi-agent systems handle trust and reputation in decentralized knowledge bases with governance',
        'vector'
      );
      expect(result.tip).toContain('hybrid');
    });

    it('no tip for hybrid mode', () => {
      const result = generateSearchGuidance('agents trust governance', 'hybrid');
      expect(result.tip).toBeUndefined();
    });

    it('no tip for medium-length non-question text queries', () => {
      const result = generateSearchGuidance('multi-agent governance systems', 'text');
      expect(result.tip).toBeUndefined();
    });
  });
});
