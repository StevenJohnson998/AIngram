/**
 * Metachunk validation — JSON schema for chunk_type='meta'.
 *
 * A metachunk defines the ordering and structure of chunks within a topic.
 * Its `content` field is a JSON string conforming to the MetachunkContent schema.
 *
 * For topics with topic_type='course', the optional `course` sub-object
 * provides course-specific metadata (level, prerequisites, learning objectives).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CourseMetadata {
  level: 'beginner' | 'intermediate' | 'expert';
  prerequisites: string[];       // topic UUIDs
  learningObjectives: string[];  // free-text objectives
}

export interface MetachunkContent {
  order: string[];               // chunk UUIDs defining display order
  tags?: string[];
  languages?: string[];
  course?: CourseMetadata;
}

export const COURSE_LEVELS = ['beginner', 'intermediate', 'expert'] as const;

export interface ValidationResult {
  valid: boolean;
  error?: string;
  parsed?: MetachunkContent;
}

/**
 * Parse and validate a metachunk content string.
 * Returns the parsed object if valid, or an error message if not.
 */
export function validateMetachunkContent(raw: string, topicType: string = 'knowledge'): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, error: 'Metachunk content must be valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, error: 'Metachunk content must be a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;

  // order: required, non-empty array of UUIDs
  if (!Array.isArray(obj.order) || obj.order.length === 0) {
    return { valid: false, error: 'order must be a non-empty array of chunk UUIDs' };
  }
  for (let i = 0; i < obj.order.length; i++) {
    if (typeof obj.order[i] !== 'string' || !UUID_RE.test(obj.order[i] as string)) {
      return { valid: false, error: `order[${i}] must be a valid UUID` };
    }
  }
  // Check for duplicates
  const seen = new Set<string>();
  for (const id of obj.order as string[]) {
    if (seen.has(id)) {
      return { valid: false, error: `Duplicate UUID in order: ${id}` };
    }
    seen.add(id);
  }

  // tags: optional array of strings
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || !obj.tags.every((t: unknown) => typeof t === 'string')) {
      return { valid: false, error: 'tags must be an array of strings' };
    }
  }

  // languages: optional array of strings
  if (obj.languages !== undefined) {
    if (!Array.isArray(obj.languages) || !obj.languages.every((l: unknown) => typeof l === 'string')) {
      return { valid: false, error: 'languages must be an array of strings' };
    }
  }

  // course: only allowed if topicType === 'course'
  if (obj.course !== undefined) {
    if (topicType !== 'course') {
      return { valid: false, error: 'course sub-object is only allowed for topics with topic_type=course' };
    }

    const course = obj.course as Record<string, unknown>;
    if (typeof course !== 'object' || course === null || Array.isArray(course)) {
      return { valid: false, error: 'course must be an object' };
    }

    // level: required
    if (!COURSE_LEVELS.includes(course.level as typeof COURSE_LEVELS[number])) {
      return { valid: false, error: `course.level must be one of: ${COURSE_LEVELS.join(', ')}` };
    }

    // prerequisites: required, array of UUIDs
    if (!Array.isArray(course.prerequisites)) {
      return { valid: false, error: 'course.prerequisites must be an array' };
    }
    for (let i = 0; i < course.prerequisites.length; i++) {
      if (typeof course.prerequisites[i] !== 'string' || !UUID_RE.test(course.prerequisites[i] as string)) {
        return { valid: false, error: `course.prerequisites[${i}] must be a valid UUID` };
      }
    }

    // learningObjectives: required, non-empty array of strings
    if (!Array.isArray(course.learningObjectives) || course.learningObjectives.length === 0) {
      return { valid: false, error: 'course.learningObjectives must be a non-empty array of strings' };
    }
    for (let i = 0; i < course.learningObjectives.length; i++) {
      if (typeof course.learningObjectives[i] !== 'string' || (course.learningObjectives[i] as string).length === 0) {
        return { valid: false, error: `course.learningObjectives[${i}] must be a non-empty string` };
      }
    }
  } else if (topicType === 'course') {
    return { valid: false, error: 'course sub-object is required for topics with topic_type=course' };
  }

  return {
    valid: true,
    parsed: {
      order: obj.order as string[],
      tags: obj.tags as string[] | undefined,
      languages: obj.languages as string[] | undefined,
      course: obj.course as CourseMetadata | undefined,
    },
  };
}
