import { validateMetachunkContent } from '../metachunk';

describe('validateMetachunkContent', () => {
  const validUUID1 = '550e8400-e29b-41d4-a716-446655440000';
  const validUUID2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const validUUID3 = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

  describe('order field', () => {
    it('accepts valid order array', () => {
      const result = validateMetachunkContent(JSON.stringify({
        order: [validUUID1, validUUID2],
      }));
      expect(result.valid).toBe(true);
      expect(result.parsed!.order).toEqual([validUUID1, validUUID2]);
    });

    it('rejects empty order', () => {
      const result = validateMetachunkContent(JSON.stringify({ order: [] }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('non-empty');
    });

    it('rejects missing order', () => {
      const result = validateMetachunkContent(JSON.stringify({ tags: ['a'] }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('order');
    });

    it('rejects invalid UUIDs in order', () => {
      const result = validateMetachunkContent(JSON.stringify({
        order: [validUUID1, 'not-a-uuid'],
      }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('order[1]');
    });

    it('rejects duplicate UUIDs', () => {
      const result = validateMetachunkContent(JSON.stringify({
        order: [validUUID1, validUUID1],
      }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Duplicate');
    });
  });

  describe('optional fields', () => {
    it('accepts tags and languages', () => {
      const result = validateMetachunkContent(JSON.stringify({
        order: [validUUID1],
        tags: ['ai', 'safety'],
        languages: ['en', 'fr'],
      }));
      expect(result.valid).toBe(true);
      expect(result.parsed!.tags).toEqual(['ai', 'safety']);
      expect(result.parsed!.languages).toEqual(['en', 'fr']);
    });

    it('rejects non-string tags', () => {
      const result = validateMetachunkContent(JSON.stringify({
        order: [validUUID1],
        tags: [123],
      }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('tags');
    });
  });

  describe('JSON parsing', () => {
    it('rejects invalid JSON', () => {
      const result = validateMetachunkContent('not json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('valid JSON');
    });

    it('rejects arrays', () => {
      const result = validateMetachunkContent(JSON.stringify([validUUID1]));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('JSON object');
    });
  });

  describe('course sub-object', () => {
    const validCourse = {
      order: [validUUID1, validUUID2],
      course: {
        level: 'beginner',
        prerequisites: [validUUID3],
        learningObjectives: ['Understand AI basics'],
      },
    };

    it('accepts valid course metadata for course topics', () => {
      const result = validateMetachunkContent(JSON.stringify(validCourse), 'course');
      expect(result.valid).toBe(true);
      expect(result.parsed!.course!.level).toBe('beginner');
    });

    it('rejects course sub-object for knowledge topics', () => {
      const result = validateMetachunkContent(JSON.stringify(validCourse), 'knowledge');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('only allowed for topics with topic_type=course');
    });

    it('requires course sub-object for course topics', () => {
      const result = validateMetachunkContent(JSON.stringify({
        order: [validUUID1],
      }), 'course');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required for topics with topic_type=course');
    });

    it('rejects invalid level', () => {
      const result = validateMetachunkContent(JSON.stringify({
        order: [validUUID1],
        course: { level: 'master', prerequisites: [], learningObjectives: ['x'] },
      }), 'course');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('level');
    });

    it('rejects empty learningObjectives', () => {
      const result = validateMetachunkContent(JSON.stringify({
        order: [validUUID1],
        course: { level: 'expert', prerequisites: [], learningObjectives: [] },
      }), 'course');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('learningObjectives');
    });

    it('accepts empty prerequisites', () => {
      const result = validateMetachunkContent(JSON.stringify({
        order: [validUUID1],
        course: { level: 'intermediate', prerequisites: [], learningObjectives: ['Learn X'] },
      }), 'course');
      expect(result.valid).toBe(true);
      expect(result.parsed!.course!.prerequisites).toEqual([]);
    });
  });
});
