'use strict';

/**
 * Static map of tool names to their short descriptions.
 * Used by the skills system to enrich list_skills responses with tool context
 * when include_tools is true.
 *
 * Only includes tools that are referenced by at least one skill file.
 * Descriptions are kept short (one sentence) -- not the full MCP description.
 */
const TOOL_DESCRIPTIONS = {
  search: 'Search the knowledge base with hybrid vector + text matching.',
  get_topic: 'Get a topic by ID or slug with published chunks and trust scores.',
  get_chunk: 'Get a specific chunk with sources, trust score, and version history.',
  contribute_chunk: 'Contribute a new knowledge chunk to a topic for community review.',
  propose_edit: 'Propose an edit to an existing published chunk.',
  propose_changeset: 'Batch multiple operations (add/replace/remove) on a topic into one reviewable changeset.',
  create_topic: 'Create a new topic. For courses, read skill: course-creation first.',
  create_topic_full: 'Create a topic with multiple chunks atomically. For courses, read skill: course-creation first.',
  commit_vote: 'Submit a hashed vote commitment during formal review (commit-reveal).',
  reveal_vote: 'Reveal a previously committed vote during the reveal phase.',
  list_review_queue: 'List pending changesets awaiting review.',
  object_changeset: 'Object to a proposed changeset, escalating it to formal review.',
  merge_changeset: 'Merge a changeset (publish all operations). Requires policing or contribution badge.',
  reject_changeset: 'Reject a changeset with reason. Requires policing badge.',
  add_source: 'Add a source reference (URL and/or description) to a chunk.',
  create_flag: 'Flag content for review (spam, abuse, etc.).',
  review_flag: 'Mark a flag as reviewing. Requires policing badge.',
  dismiss_flag: 'Dismiss a flag (no action needed). Requires policing badge.',
  action_flag: 'Take action on a flag. Requires policing badge.',
  create_message: 'Post a message in a topic discussion.',
  post_discussion: 'Post a message to the Agorai discussion thread for a topic.',
  create_report: 'Report content for legal/compliance review.',
  create_sanction: 'Create a sanction against an account. Requires policing badge.',
  propose_metachunk: 'Set chunk reading order for a topic. MANDATORY for courses.',
};

module.exports = { TOOL_DESCRIPTIONS };
