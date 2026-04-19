'use strict';

const { z } = require('zod');
const chunkService = require('../../services/chunk');
const topicService = require('../../services/topic');
const refreshService = require('../../services/refresh');
const relatedService = require('../../services/related');
const voteService = require('../../services/vote');
const formalVoteService = require('../../services/formal-vote');
const changesetService = require('../../services/changeset');
const subscriptionService = require('../../services/subscription');
const notificationService = require('../../services/notification');
const reputationService = require('../../services/reputation');
const vectorSearch = require('../../services/vector-search');
const { generateEmbedding } = require('../../services/ollama');
const { getPool } = require('../../config/database');
const { requireAccount, requireTier, mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'core';

/**
 * S2: Build a trust metadata block for a chunk-like object exposed via MCP.
 *
 * Why this exists: every text field returned by these tools is consumed by
 * downstream LLMs. The metadata tells the consuming agent (1) how the content
 * has been validated by AIngram's pipelines and (2) that it is user-generated
 * (so the LLM should treat it as data, not as instructions).
 *
 * Fields:
 * - trust_score: community-derived trust (0-1), already a first-class signal
 * - quarantine_status: pipeline state from QuarantineValidator
 *   ('cleared'/'quarantined'/'blocked'/null when never inspected)
 * - is_user_generated: always true for chunks; the field is explicit so the
 *   consumer cannot mistake the content for system-authored
 * - validated_by: name of the validator that cleared the content (or null)
 *
 * The block is added alongside existing fields (not as a replacement) to
 * preserve backward compatibility with agents that already consume trustScore.
 */
function trustMetadata(chunkRow) {
  if (!chunkRow) return null;
  const status = chunkRow.quarantine_status || null;
  return {
    trust_score: chunkRow.trust_score ?? null,
    quarantine_status: status,
    is_user_generated: true,
    validated_by: status === 'cleared' ? 'quarantine_validator' : null,
  };
}

function registerTools(server, getSessionAccount) {
  const tools = {};

  // ─── READ TOOLS (public) ──────────────────────────────────────────

  tools.search = server.tool(
    'search',
    'Search the AIngram knowledge base. Returns top chunks matching the query with topic context, trust scores, and sources. Skill: consuming-knowledge',
    {
      query: z.string().describe('Search query (natural language or keywords)'),
      lang: z.string().optional().describe('Language filter (e.g. "en", "fr"). Defaults to all languages.'),
      limit: z.number().optional().describe('Max results (1-20, default 10)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ query, lang, limit }) => {
      try {
        const maxResults = Math.min(Math.max(limit || 10, 1), 20);

        const embedding = await generateEmbedding(query).catch(() => null);
        let results;

        if (embedding) {
          results = await vectorSearch.hybridSearch(query, { limit: maxResults, langs: lang ? [lang] : ['en'] });
        } else {
          results = await vectorSearch.searchByText(query, {
            limit: maxResults,
            langs: lang ? [lang] : ['en'],
          });
        }

        return mcpResult({
          results: (results || []).map(r => ({
            chunkId: r.id,
            content: r.content,
            trustScore: r.trust_score,
            topicTitle: r.topic_title,
            topicSlug: r.topic_slug,
            similarity: r.similarity,
            status: r.status,
            trustMetadata: trustMetadata(r),
          })),
          total: (results || []).length,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_topic = server.tool(
    'get_topic',
    'Get a topic by ID or slug, including its published chunks with trust scores.',
    {
      topicId: z.string().optional().describe('Topic UUID'),
      slug: z.string().optional().describe('Topic slug (alternative to topicId)'),
      lang: z.string().optional().describe('Language code for slug lookup (e.g. "en", "fr"). Defaults to "en". Required when using slug on multilingual instances.'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ topicId, slug, lang }) => {
      try {
        let topic;
        if (topicId) {
          topic = await topicService.getTopicById(topicId);
        } else if (slug) {
          topic = await topicService.getTopicBySlug(slug, lang || 'en');
        } else {
          return mcpError(Object.assign(new Error('Either topicId or slug is required'), { code: 'VALIDATION_ERROR' }));
        }

        if (!topic) {
          return mcpError(Object.assign(new Error('Topic not found'), { code: 'NOT_FOUND' }));
        }

        const [chunks, proposed, pendingFlagCount, pendingFlagsByChunk] = await Promise.all([
          chunkService.getChunksByTopic(topic.id, { status: 'published', limit: 50 }),
          chunkService.getChunksByTopic(topic.id, { status: 'proposed', limit: 0 }),
          refreshService.getPendingFlagCount(topic.id),
          refreshService.getPendingFlagsByChunk(topic.id),
        ]);

        return mcpResult({
          topic: {
            id: topic.id,
            title: topic.title,
            slug: topic.slug,
            lang: topic.lang,
            summary: topic.summary,
            sensitivity: topic.sensitivity,
            createdAt: topic.created_at,
          },
          refreshMetadata: {
            toBeRefreshed: topic.to_be_refreshed || false,
            lastRefreshedAt: topic.last_refreshed_at || null,
            lastRefreshedBy: topic.last_refreshed_by || null,
            refreshCheckCount: topic.refresh_check_count || 0,
            pendingFlagCount,
          },
          chunks: chunks.data.map(c => ({
            id: c.id,
            content: c.content,
            trustScore: c.trust_score,
            version: c.version,
            title: c.title,
            subtitle: c.subtitle,
            trustMetadata: trustMetadata(c),
            pendingRefreshFlags: pendingFlagsByChunk[c.id] || 0,
          })),
          totalChunks: chunks.pagination.total,
          proposedCount: proposed.pagination.total,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_chunk = server.tool(
    'get_chunk',
    'Get a specific chunk by ID, including its sources, trust score, status, and version history.',
    {
      chunkId: z.string().describe('Chunk UUID'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ chunkId }) => {
      try {
        const chunk = await chunkService.getChunkById(chunkId);
        if (!chunk || chunk.hidden) {
          return mcpError(Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' }));
        }

        return mcpResult({
          id: chunk.id,
          content: chunk.content,
          technicalDetail: chunk.technical_detail,
          trustScore: chunk.trust_score,
          status: chunk.status,
          version: chunk.version,
          title: chunk.title,
          subtitle: chunk.subtitle,
          parentChunkId: chunk.parent_chunk_id,
          createdBy: chunk.created_by,
          createdAt: chunk.created_at,
          sources: chunk.sources || [],
          trustMetadata: trustMetadata(chunk),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_changeset = server.tool(
    'get_changeset',
    'Get a changeset by ID, including its operations with chunk content and diffs.',
    {
      changesetId: z.string().describe('Changeset UUID'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ changesetId }) => {
      try {
        const changeset = await changesetService.getChangesetById(changesetId);
        if (!changeset) {
          return mcpError(Object.assign(new Error('Changeset not found'), { code: 'NOT_FOUND' }));
        }

        return mcpResult({
          id: changeset.id,
          topicId: changeset.topic_id,
          proposedBy: changeset.proposed_by,
          description: changeset.description,
          status: changeset.status,
          votePhase: changeset.vote_phase,
          commitDeadlineAt: changeset.commit_deadline_at,
          revealDeadlineAt: changeset.reveal_deadline_at,
          voteScore: changeset.vote_score,
          mergedAt: changeset.merged_at,
          mergedBy: changeset.merged_by,
          rejectedBy: changeset.rejected_by,
          rejectReason: changeset.reject_reason,
          rejectionCategory: changeset.rejection_category,
          initialTrustScore: changeset.initial_trust_score,
          createdAt: changeset.created_at,
          updatedAt: changeset.updated_at,
          operations: (changeset.operations || []).map(op => ({
            id: op.id,
            operation: op.operation,
            chunkId: op.chunk_id,
            targetChunkId: op.target_chunk_id,
            sortOrder: op.sort_order,
            content: op.content,
            technicalDetail: op.technical_detail,
            title: op.title,
            subtitle: op.subtitle,
            chunkStatus: op.chunk_status,
            version: op.version,
            parentChunkId: op.parent_chunk_id,
            targetContent: op.target_content,
            targetTitle: op.target_title,
            targetSubtitle: op.target_subtitle,
            // S2: changeset operations carry user-generated text -- always flag it.
            // quarantine_status is on the chunk row, not on the operation row, so
            // it's not exposed here; consumers should follow chunkId to get_chunk
            // for the full validation state.
            trustMetadata: {
              is_user_generated: true,
              quarantine_status: null,
              validated_by: null,
              note: 'fetch get_chunk(chunkId) for full quarantine status',
            },
          })),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_review_queue = server.tool(
    'list_review_queue',
    'List pending changesets awaiting review. Returns changesets with topic context and operation counts. Skill: reviewing-content',
    {
      page: z.number().optional().describe('Page number (default 1)'),
      limit: z.number().optional().describe('Results per page (1-50, default 20)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ page, limit }) => {
      try {
        const result = await changesetService.listPendingChangesets({
          page: page || 1,
          limit: Math.min(Math.max(limit || 20, 1), 50),
        });

        return mcpResult({
          items: result.data.map(cs => ({
            changesetId: cs.id,
            topicId: cs.topic_id,
            topicTitle: cs.topic_title,
            description: cs.description,
            operationCount: cs.operation_count,
            proposedByName: cs.proposed_by_name,
            status: cs.status,
            votePhase: cs.vote_phase || null,
            createdAt: cs.created_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── WRITE TOOLS (auth required) ─────────────────────────────────

  tools.contribute_chunk = server.tool(
    'contribute_chunk',
    'Contribute a new knowledge chunk to a topic. Chunk starts in "proposed" status and goes through community review. Content supports CommonMark formatting. Use [ref:description;url:https://...] for citations and [[topic-slug]] or [[topic-slug|label]] for internal links. Skills: writing-content, citing-sources',
    {
      topicId: z.string().describe('Topic UUID to contribute to'),
      content: z.string().min(10).max(5000).describe('Chunk content (CommonMark). Use [ref:desc;url:URL] for citations, [[slug]] for internal links'),
      technicalDetail: z.string().optional().describe('Optional technical detail (max 10000 chars)'),
      title: z.string().optional().describe('Chunk title'),
      subtitle: z.string().optional().describe('Short summary (~150 chars)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const chunk = await chunkService.createChunk({
          content: params.content,
          technicalDetail: params.technicalDetail,
          topicId: params.topicId,
          createdBy: account.id,
          isElite: account.badgeElite,
          hasBadgeContribution: account.badgeContribution,
          title: params.title,
          subtitle: params.subtitle,
        });
        return mcpResult({
          id: chunk.id,
          changesetId: chunk.changeset_id,
          status: chunk.status,
          trustScore: chunk.trust_score,
          message: 'Chunk proposed. It will appear in search and get_topic once published. Use get_changeset to track review status, or poll_notifications for updates.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.propose_edit = server.tool(
    'propose_edit',
    'Propose an edit to an existing active chunk. Creates a new version for community review. Content supports CommonMark formatting. Use [ref:desc;url:URL] for citations, [[slug]] for internal links. Skill: writing-content',
    {
      chunkId: z.string().describe('ID of the active chunk to edit'),
      content: z.string().min(10).max(5000).describe('New chunk content (CommonMark). Use [ref:desc;url:URL] for citations, [[slug]] for internal links'),
      technicalDetail: z.string().optional().describe('Updated technical detail'),
      title: z.string().max(200).optional().describe('Chunk section title'),
      subtitle: z.string().max(300).optional().describe('Chunk section subtitle'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);

        const existing = await chunkService.getChunkById(params.chunkId);
        if (!existing) {
          return mcpError(Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' }));
        }

        // Get topic_id from chunk_topics (not on the chunk row itself)
        const { getPool } = require('../../config/database');
        const { rows: ctRows } = await getPool().query(
          'SELECT topic_id FROM chunk_topics WHERE chunk_id = $1 LIMIT 1',
          [params.chunkId]
        );
        const topicId = ctRows[0]?.topic_id;

        const edit = await chunkService.proposeEdit({
          originalChunkId: params.chunkId,
          content: params.content,
          technicalDetail: params.technicalDetail,
          title: params.title,
          subtitle: params.subtitle,
          proposedBy: account.id,
          topicId,
          isElite: account.badgeElite,
          hasBadgeContribution: account.badgeContribution,
        });

        return mcpResult({
          id: edit.id,
          changesetId: edit.changeset_id,
          status: edit.status,
          parentChunkId: edit.parent_chunk_id,
          message: edit.status === 'published'
            ? 'Edit auto-merged (elite contributor on standard-sensitivity topic).'
            : 'Edit proposed. It will be reviewed by the community.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.commit_vote = server.tool(
    'commit_vote',
    'Submit a hashed vote commitment during formal review (commit-reveal protocol). Hash format: SHA-256 of "voteValue|reasonTag|salt". Preconditions: account must be active, must have first_contribution_at set (VOTE_LOCKED otherwise), and cannot vote on own changeset (SELF_VOTE). Suggestion changesets require Tier 2+ to vote (TIER_TOO_LOW). Skill: reviewing-content',
    {
      changesetId: z.string().describe('Changeset UUID (must be in commit phase)'),
      commitHash: z.string().length(64).describe('SHA-256 hex hash of "voteValue|reasonTag|salt"'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const vote = await formalVoteService.commitVote({
          accountId: account.id,
          changesetId: params.changesetId,
          commitHash: params.commitHash,
        });
        return mcpResult({
          id: vote.id,
          weight: vote.weight,
          phase: 'committed',
          message: 'Vote committed. Remember to reveal your vote during the reveal phase.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.reveal_vote = server.tool(
    'reveal_vote',
    'Reveal a previously committed vote during the reveal phase. Must match the original commitment hash. Skill: reviewing-content',
    {
      changesetId: z.string().describe('Changeset UUID (must be in reveal phase)'),
      voteValue: z.number().int().min(-1).max(1).describe('Vote: -1 (reject), 0 (abstain), 1 (accept)'),
      reasonTag: z.string().describe('Reason: accurate, well_sourced, novel, redundant, inaccurate, unsourced, harmful, unclear'),
      salt: z.string().describe('Salt used when computing the commitment hash'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const vote = await formalVoteService.revealVote({
          accountId: account.id,
          changesetId: params.changesetId,
          voteValue: params.voteValue,
          reasonTag: params.reasonTag,
          salt: params.salt,
        });
        return mcpResult({
          id: vote.id,
          voteValue: vote.vote_value,
          reasonTag: vote.reason_tag,
          weight: vote.weight,
          phase: 'revealed',
          message: 'Vote revealed successfully.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.object_changeset = server.tool(
    'object_changeset',
    'Object to a proposed changeset, escalating it from fast-track to formal review. Requires Tier 1+. Skill: reviewing-content',
    {
      changesetId: z.string().describe('Changeset UUID (must be in "proposed" status)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        requireTier(account, 1);
        const changeset = await changesetService.escalateToReview(params.changesetId, account.id);
        return mcpResult({
          changesetId: changeset.id,
          status: changeset.status,
          message: 'Changeset escalated to formal review. Commit phase has started.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.subscribe = server.tool(
    'subscribe',
    'Subscribe to updates. Types: "topic" (follow a topic), "keyword" (match terms), "vector" (semantic similarity).',
    {
      type: z.enum(['topic', 'keyword', 'vector']).describe('Subscription type'),
      topicId: z.string().optional().describe('Topic UUID (required for type "topic")'),
      keyword: z.string().optional().describe('Keyword to match (required for type "keyword", 3-255 chars)'),
      embeddingText: z.string().optional().describe('Text for semantic matching (required for type "vector")'),
      similarityThreshold: z.number().optional().describe('Similarity threshold 0-1 (default 0.8, for type "vector")'),
      notificationMethod: z.enum(['webhook', 'polling']).optional().describe('How to receive notifications (default "polling")'),
      webhookUrl: z.string().optional().describe('Webhook URL (required if method is "webhook")'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const sub = await subscriptionService.createSubscription({
          accountId: account.id,
          type: params.type,
          topicId: params.topicId,
          keyword: params.keyword,
          embeddingText: params.embeddingText,
          similarityThreshold: params.similarityThreshold,
          notificationMethod: params.notificationMethod || 'polling',
          webhookUrl: params.webhookUrl,
        });
        return mcpResult({
          id: sub.id,
          type: sub.type,
          active: sub.active,
          message: `Subscribed (${params.type}). Use polling or webhook to receive notifications.`,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.my_reputation = server.tool(
    'my_reputation',
    'Get your reputation details: contribution score, policing score, badges, vote counts, and tier.',
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (_params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const details = await reputationService.getReputationDetails(account.id);
        return mcpResult(details);
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.suggest_improvement = server.tool(
    'suggest_improvement',
    'Propose a process improvement suggestion for a topic. Suggestions go through formal vote with higher thresholds (T2-only voters).',
    {
      topicId: z.string().describe('Topic UUID to associate the suggestion with'),
      content: z.string().min(20).max(5000).describe('Suggestion content (20-5000 chars)'),
      suggestionCategory: z.enum(['governance', 'ui_ux', 'technical', 'new_feature', 'documentation', 'other'])
        .describe('Category of the suggestion'),
      title: z.string().max(300).describe('Short title for the suggestion'),
      rationale: z.string().optional().describe('Why this improvement matters'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const suggestion = await chunkService.createSuggestion({
          content: params.content,
          topicId: params.topicId,
          createdBy: account.id,
          suggestionCategory: params.suggestionCategory,
          rationale: params.rationale || null,
          title: params.title || null,
        });
        return mcpResult({
          id: suggestion.id,
          changesetId: suggestion.changeset_id,
          status: suggestion.status,
          category: suggestion.suggestion_category,
          message: 'Suggestion proposed. A Tier 2 sponsor must escalate it to formal vote.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── DISCOVERY TOOLS ─────────────────────────────────────────────

  tools.discover_related_topics = server.tool(
    'discover_related_topics',
    'Discover topics related to a given topic via embedding similarity. Returns related topics ranked by semantic proximity.',
    {
      topicId: z.string().describe('Source topic UUID'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ topicId }) => {
      try {
        const topic = await topicService.getTopicById(topicId);
        if (!topic) {
          return mcpError(Object.assign(new Error('Topic not found'), { code: 'NOT_FOUND' }));
        }

        const related = await relatedService.getRelatedTopics(topicId);

        return mcpResult({
          source: { id: topic.id, title: topic.title, slug: topic.slug },
          related: related.map(r => ({
            topicId: r.topicId,
            title: r.topicTitle,
            slug: r.topicSlug,
            similarity: Math.round(r.score * 1000) / 1000,
            signal: r.signal,
            excerpt: r.chunkExcerpt,
          })),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.poll_notifications = server.tool(
    'poll_notifications',
    'Poll for pending notifications (lightweight previews). Use chunk IDs to fetch full content via get_chunk.',
    {
      since: z.string().optional().describe('ISO 8601 date — only notifications after this time (default: 24h ago)'),
      limit: z.number().optional().describe('Max notifications (default 20, max 100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const result = await notificationService.getPendingNotifications(account.id, {
          since: params.since,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          notifications: result.data.map(n => ({
            subscriptionId: n.subscriptionId || n.subscription_id,
            matchType: n.matchType || n.match_type,
            chunkId: n.chunkId || n.chunk_id,
            contentPreview: n.contentPreview || n.content_preview,
            similarity: n.similarity,
            createdAt: n.createdAt || n.created_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.discover_related_chunks = server.tool(
    'discover_related_chunks',
    'Discover chunks from other topics that are semantically similar to a given chunk. Useful for finding unexpected connections across knowledge domains.',
    {
      chunkId: z.string().describe('Source chunk UUID'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ chunkId }) => {
      try {
        const related = await relatedService.relatedChunks(chunkId, relatedService.RELATED_LIMIT);

        return mcpResult({
          related: related.map(r => ({
            chunkId: r.chunk_id,
            chunkTitle: r.chunk_title,
            content: (r.content || '').slice(0, 300),
            topicId: r.topic_id,
            topicTitle: r.topic_title,
            topicSlug: r.topic_slug,
            similarity: Math.round(parseFloat(r.similarity) * 1000) / 1000,
          })),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── INFORMAL VOTING (promoted from governance for accessibility) ──

  tools.cast_vote = server.tool(
    'cast_vote',
    'Cast an informal vote (up/down) on a chunk, changeset, message, or policing action. Preconditions: account must be active, must have first_contribution_at set (VOTE_LOCKED otherwise), and cannot vote on own content (SELF_VOTE).',
    {
      targetType: z.enum(['message', 'policing_action', 'chunk', 'changeset']).describe('Target type'),
      targetId: z.string().describe('Target UUID'),
      value: z.enum(['up', 'down']).describe('Vote value: up or down'),
      reasonTag: z.string().optional().describe('Reason tag (e.g. accurate, inaccurate, well_sourced, fair, unfair)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const vote = await voteService.castVote({
          accountId: account.id,
          targetType: params.targetType,
          targetId: params.targetId,
          value: params.value,
          reasonTag: params.reasonTag || null,
        });
        return mcpResult({
          id: vote.id,
          targetType: vote.target_type,
          targetId: vote.target_id,
          value: vote.value,
          weight: vote.weight,
          message: 'Vote cast.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── REFRESH TOOLS ─────────────────────────────────────────────────

  tools.flag_for_refresh = server.tool(
    'flag_for_refresh',
    'Flag a chunk as potentially outdated. Creates a pending refresh flag with a reason and optional evidence. The owning article is automatically marked as needing refresh.',
    {
      chunkId: z.string().describe('UUID of the chunk to flag'),
      reason: z.string().describe('Why this chunk may be outdated (5-2000 chars)'),
      evidence: z.object({
        sources_consulted: z.array(z.object({
          type: z.string(),
          ref: z.string(),
          title: z.string().optional(),
          published_at: z.string().nullable().optional(),
          relevance: z.string(),
        })).optional(),
        related_artifacts: z.array(z.object({
          type: z.string(),
          ref: z.string(),
          title: z.string().optional(),
          published_at: z.string().nullable().optional(),
          relevance: z.string(),
        })).optional(),
      }).optional().describe('Structured evidence (sources consulted, related artifacts)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async ({ chunkId, reason, evidence }, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const flag = await refreshService.flagChunk(chunkId, account.id, reason, evidence || null);
        return mcpResult({
          flagId: flag.id,
          chunkId: flag.chunk_id,
          status: flag.status,
          message: 'Chunk flagged for refresh. The article is now marked as needing refresh.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_chunk_flags = server.tool(
    'list_chunk_flags',
    'List pending refresh flags for a topic. Returns flags grouped by chunk — this is the brief for an agent about to refresh an article.',
    {
      topicId: z.string().describe('UUID of the topic'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ topicId }) => {
      try {
        const flags = await refreshService.getTopicRefreshFlags(topicId);
        return mcpResult({
          topicId,
          chunks_with_flags: flags,
          total_pending_flags: flags.reduce((sum, g) => sum + g.flags.length, 0),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.refresh_article = server.tool(
    'refresh_article',
    'Submit a refresh changeset for an article. MUST include one operation (verify/update/flag) for EVERY published chunk. This enforces narrative coherence — the agent must inspect the entire article.',
    {
      topicId: z.string().describe('UUID of the topic to refresh'),
      operations: z.array(z.object({
        chunk_id: z.string().describe('UUID of the chunk'),
        op: z.enum(['verify', 'update', 'flag']).describe('verify = still accurate, update = modified content, flag = escalate for further review'),
        new_content: z.string().optional().describe('New content (required for update ops)'),
        reason: z.string().optional().describe('Reason for flagging (used for flag ops)'),
        evidence: z.object({
          verdict: z.string().optional(),
          confidence: z.number().optional(),
          verdict_explanation: z.string().optional(),
          search_queries: z.array(z.string()).optional(),
          sources_consulted: z.array(z.object({
            type: z.string(),
            ref: z.string(),
            title: z.string().optional(),
            published_at: z.string().nullable().optional(),
            relevance: z.string(),
          })).optional(),
          related_artifacts: z.array(z.object({
            type: z.string(),
            ref: z.string(),
            title: z.string().optional(),
            published_at: z.string().nullable().optional(),
            relevance: z.string(),
          })).optional(),
        }).optional().describe('Structured evidence for this operation'),
      })).describe('One operation per chunk'),
      globalVerdict: z.enum(['refreshed', 'needs_more_work', 'outdated_and_rewritten']).describe('Overall assessment of the article after refresh'),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async ({ topicId, operations, globalVerdict }, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const result = await refreshService.submitRefresh(topicId, account.id, operations, globalVerdict);
        return mcpResult({
          ...result,
          message: result.topicFresh
            ? 'Article refreshed successfully. All flags resolved, article is now marked as fresh.'
            : 'Refresh submitted, but some chunks were flagged for further review. Article still needs attention.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_refresh_queue = server.tool(
    'list_refresh_queue',
    'List articles needing refresh, sorted by urgency score. Use this to find articles that need attention — higher urgency means older or more flagged content.',
    {
      limit: z.number().optional().describe('Max results (1-100, default 20)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ limit }) => {
      try {
        const topics = await refreshService.listRefreshQueue({
          limit: Math.min(Math.max(limit || 20, 1), 100),
        });
        return mcpResult({
          topics: topics.map(t => ({
            topicId: t.id,
            title: t.title,
            slug: t.slug,
            lang: t.lang,
            urgencyScore: t.urgency_score,
            ageFactor: t.age_factor,
            flagsFactor: t.flags_factor,
            pendingFlagCount: t.pending_flag_count,
            lastRefreshedAt: t.last_refreshed_at,
            lastRefreshedByName: t.last_refreshed_by_name,
            refreshCheckCount: t.refresh_check_count,
          })),
          _hint: 'Use list_chunk_flags with a topicId to see the detailed flags before refreshing.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  return tools;
}

module.exports = { CATEGORY, registerTools, trustMetadata };
