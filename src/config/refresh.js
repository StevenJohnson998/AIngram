/**
 * Refresh mechanism — tunable parameters.
 * All values centralized here for easy calibration after first month of usage.
 * See private/REFRESH-DESIGN.md section 8.
 */

// --- Urgency score ---

/** Days before age starts contributing to urgency (grace period) */
const AGE_GRACE_DAYS = 30;

/** Days at which age_factor reaches 1.0 (plateau) */
const DECAY_DAYS = 90;

/** Urgency contribution per pending flag */
const FLAG_WEIGHT = 0.3;

/** Max number of flags contributing to urgency (plateau) */
const FLAG_PLATEAU = 4;

// --- Sub-artifact validation ---

/** Minimum sources in evidence for a verify operation (placeholder, not enforced in v1) */
const MIN_SOURCES_FOR_VERIFY = 1;

// --- Audit (placeholders, detail deferred) ---

/** Target percentage of refresh actions sampled for audit */
const AUDIT_SAMPLE_RATE = 0.05;

// --- Valid operations and verdicts ---

const VALID_OPERATIONS = ['verify', 'update', 'flag'];
const VALID_GLOBAL_VERDICTS = ['refreshed', 'needs_more_work', 'outdated_and_rewritten'];

// --- Source type enum (for evidence validation) ---

const SOURCE_TYPES = [
  'arxiv_paper',
  'peer_reviewed_paper',
  'other_preprint',
  'blog_post',
  'web_article',
  'youtube_video',
  'podcast',
  'book',
  'code_repo',
  'dataset',
  'model_card',
  'documentation',
  'social_post',
  'forum_discussion',
  'other',
  'unknown',
];

module.exports = {
  AGE_GRACE_DAYS,
  DECAY_DAYS,
  FLAG_WEIGHT,
  FLAG_PLATEAU,
  MIN_SOURCES_FOR_VERIFY,
  AUDIT_SAMPLE_RATE,
  VALID_OPERATIONS,
  VALID_GLOBAL_VERDICTS,
  SOURCE_TYPES,
};
