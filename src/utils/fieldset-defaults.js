/**
 * Per-resource default fieldsets for sparse fieldset support.
 *
 * TOPIC_LIST: fields returned in list endpoints (no embedding, no full content)
 * TOPIC_DETAIL: fields returned in detail endpoints (no embedding)
 * CHUNK_LIST: fields returned when chunks appear inside a topic response
 * CHUNK_DETAIL: fields returned for GET /chunks/:id
 * SEARCH_RESULT: fields returned in search results
 * CHANGESET_LIST: fields returned in review queue lists
 * FLAG_LIST: fields returned in GET /flags
 * DISPUTE_LIST: fields returned in GET /disputes
 */

const DEFAULTS = {
  TOPIC_LIST: [
    'id', 'title', 'slug', 'summary', 'lang', 'topic_type', 'status', 'sensitivity',
    'created_by', 'created_at', 'updated_at',
    'chunk_count', 'proposed_count', 'discussion_message_count',
    'article_summary', 'agorai_conversation_id',
    'to_be_refreshed', 'content_flag',
  ],
  TOPIC_DETAIL: [
    'id', 'title', 'slug', 'summary', 'lang', 'topic_type', 'status', 'sensitivity',
    'created_by', 'created_at', 'updated_at',
    'agorai_conversation_id', 'content_flag', 'content_flag_reason', 'content_flagged_at',
    'to_be_refreshed', 'refresh_requested_at', 'last_refreshed_at', 'refresh_check_count',
  ],
  CHUNK_LIST: [
    'id', 'title', 'subtitle', 'content', 'technical_detail', 'has_technical_detail',
    'trust_score', 'status', 'version', 'sources',
    'created_by', 'proposed_by', 'proposed_by_name', 'created_at', 'updated_at',
    'vote_phase', 'chunk_type', 'article_summary', 'discussion_summary',
    'content_flag', 'quarantine_status', 'hidden',
    'commit_deadline_at', 'reveal_deadline_at', 'vote_score',
  ],
  CHUNK_DETAIL: [
    'id', 'title', 'subtitle', 'content', 'technical_detail', 'has_technical_detail',
    'trust_score', 'status', 'version', 'sources',
    'created_by', 'proposed_by', 'proposed_by_name', 'created_at', 'updated_at',
    'vote_phase', 'chunk_type', 'article_summary', 'discussion_summary',
    'content_flag', 'quarantine_status', 'hidden', 'parent_chunk_id',
    'commit_deadline_at', 'reveal_deadline_at', 'vote_score',
    'retract_reason', 'reject_reason', 'rejection_category', 'rejection_suggestions',
    'confidentiality', 'rationale', 'suggestion_category',
    'valid_as_of', 'merged_at', 'merged_by', 'disputed_at', 'dispute_count',
    'under_review_at', 'adhp',
  ],
  SEARCH_RESULT: [
    'id', 'content_preview', 'content_truncated', 'technical_detail', 'has_technical_detail',
    'trust_score', 'status', 'created_by', 'valid_as_of', 'created_at', 'updated_at',
    'rank', 'topic_id', 'topic_title', 'topic_slug', 'topic_lang', 'topic_type',
  ],
  CHANGESET_LIST: [
    'id', 'topic_id', 'topic_title', 'topic_slug', 'description', 'operation_count',
    'proposed_by', 'proposed_by_name', 'status', 'vote_phase', 'created_at', 'updated_at',
    'merged_at', 'rejected_at', 'rejection_reason',
  ],
  FLAG_LIST: [
    'id', 'target_type', 'target_id', 'reporter_id', 'reason',
    'detection_type', 'status', 'severity', 'created_at', 'updated_at',
    'reviewed_by', 'reviewed_at', 'resolution',
  ],
  DISPUTE_LIST: [
    'id', 'chunk_id', 'created_by', 'reason_tag', 'description',
    'status', 'resolved_verdict', 'resolved_by', 'created_at', 'updated_at',
  ],
};

module.exports = { DEFAULTS };
