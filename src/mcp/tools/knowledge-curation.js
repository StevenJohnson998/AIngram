'use strict';

const { z } = require('zod');
const topicService = require('../../services/topic');
const chunkService = require('../../services/chunk');
const { requireAccount, mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'knowledge_curation';

const VALID_LANGS = ['en', 'fr', 'zh', 'hi', 'es', 'ar', 'ja', 'de', 'pt', 'ru', 'ko', 'it', 'nl', 'pl', 'sv', 'tr'];
const langEnum = z.enum(VALID_LANGS);

function registerTools(server, getSessionAccount) {
  const tools = {};

  // ─── TOPIC MANAGEMENT ─────────────────────────────────────────────

  tools.create_topic = server.tool(
    'create_topic',
    'Create a new topic in the knowledge base.',
    {
      title: z.string().min(3).max(300).describe('Topic title (3-300 chars)'),
      lang: langEnum.describe('Language code'),
      summary: z.string().max(1000).optional().describe('Topic summary (max 1000 chars)'),
      sensitivity: z.enum(['standard', 'sensitive']).optional().describe('Sensitivity level (default: standard)'),
      topicType: z.enum(['knowledge', 'course']).optional().describe('Topic type (default: knowledge)'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const topic = await topicService.createTopic({
          title: params.title,
          lang: params.lang,
          summary: params.summary,
          sensitivity: params.sensitivity,
          topicType: params.topicType,
          createdBy: account.id,
        });
        return mcpResult({
          id: topic.id,
          title: topic.title,
          slug: topic.slug,
          lang: topic.lang,
          sensitivity: topic.sensitivity,
          topicType: topic.topic_type,
          status: topic.status,
          createdAt: topic.created_at,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.create_topic_full = server.tool(
    'create_topic_full',
    'Create a topic with multiple chunks atomically. All chunks start in "proposed" status.',
    {
      title: z.string().min(3).max(300).describe('Topic title'),
      lang: langEnum.describe('Language code'),
      summary: z.string().max(1000).optional().describe('Topic summary'),
      sensitivity: z.enum(['standard', 'sensitive']).optional().describe('Sensitivity level'),
      topicType: z.enum(['knowledge', 'course']).optional().describe('Topic type (default: knowledge)'),
      chunks: z.array(z.object({
        content: z.string().min(10).max(5000).describe('Chunk content'),
        technicalDetail: z.string().max(10000).optional().describe('Technical detail'),
        title: z.string().optional().describe('Chunk title'),
        subtitle: z.string().optional().describe('Chunk subtitle'),
      })).min(1).max(20).describe('Array of chunks (1-20)'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const result = await topicService.createTopicFull({
          title: params.title,
          lang: params.lang,
          summary: params.summary,
          sensitivity: params.sensitivity,
          topicType: params.topicType,
          chunks: params.chunks,
          createdBy: account.id,
          isElite: account.badgeElite,
          hasBadgeContribution: account.badgeContribution,
        });
        return mcpResult({
          topic: {
            id: result.topic.id,
            title: result.topic.title,
            slug: result.topic.slug,
          },
          chunks: result.chunks.map(c => ({ id: c.id, status: c.status })),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_topics = server.tool(
    'list_topics',
    'List topics with optional filters for language, status, sensitivity, and topic type.',
    {
      lang: langEnum.optional().describe('Filter by language'),
      status: z.enum(['active', 'locked', 'archived']).optional().describe('Filter by status'),
      sensitivity: z.enum(['standard', 'sensitive']).optional().describe('Filter by sensitivity'),
      topicType: z.enum(['knowledge', 'course']).optional().describe('Filter by topic type'),
      page: z.number().optional().describe('Page number (default 1)'),
      limit: z.number().optional().describe('Results per page (default 20)'),
    },
    async (params) => {
      try {
        const result = await topicService.listTopics({
          lang: params.lang,
          status: params.status,
          sensitivity: params.sensitivity,
          topicType: params.topicType,
          page: params.page || 1,
          limit: params.limit || 20,
        });
        return mcpResult({
          topics: result.data.map(t => ({
            id: t.id,
            title: t.title,
            slug: t.slug,
            lang: t.lang,
            sensitivity: t.sensitivity,
            topicType: t.topic_type,
            status: t.status,
            chunkCount: t.chunk_count,
            createdAt: t.created_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_topic_by_slug = server.tool(
    'get_topic_by_slug',
    'Get a topic by its slug and language, including chunks.',
    {
      slug: z.string().describe('Topic slug'),
      lang: langEnum.describe('Language code'),
      page: z.number().optional().describe('Chunk page (default 1)'),
      limit: z.number().optional().describe('Chunks per page (default 20, max 50)'),
    },
    async (params) => {
      try {
        const topic = await topicService.getTopicBySlug(params.slug, params.lang);
        if (!topic) {
          return mcpError(Object.assign(new Error('Topic not found'), { code: 'NOT_FOUND' }));
        }
        const chunks = await chunkService.getChunksWithSourcesByTopic(topic.id, {
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 50),
        });
        return mcpResult({
          topic: {
            id: topic.id,
            title: topic.title,
            slug: topic.slug,
            lang: topic.lang,
            sensitivity: topic.sensitivity,
            status: topic.status,
          },
          chunks: chunks.data,
          pagination: chunks.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.update_topic = server.tool(
    'update_topic',
    'Update a topic you created. Only the creator can update.',
    {
      topicId: z.string().describe('Topic UUID'),
      title: z.string().min(3).max(300).optional().describe('New title'),
      summary: z.string().max(1000).optional().describe('New summary'),
      sensitivity: z.enum(['standard', 'sensitive']).optional().describe('New sensitivity'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const existing = await topicService.getTopicById(params.topicId);
        if (!existing) {
          return mcpError(Object.assign(new Error('Topic not found'), { code: 'NOT_FOUND' }));
        }
        if (existing.created_by !== account.id) {
          return mcpError(Object.assign(new Error('Only the creator can update this topic'), { code: 'FORBIDDEN' }));
        }
        const updated = await topicService.updateTopic(params.topicId, {
          title: params.title,
          summary: params.summary,
          sensitivity: params.sensitivity,
        });
        return mcpResult({
          id: updated.id,
          title: updated.title,
          slug: updated.slug,
          sensitivity: updated.sensitivity,
          updatedAt: updated.updated_at,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.flag_topic = server.tool(
    'flag_topic',
    'Flag a topic for content issues (spam, poisoning, hallucination, review needed).',
    {
      topicId: z.string().describe('Topic UUID'),
      contentFlag: z.enum(['spam', 'poisoning', 'hallucination', 'review_needed']).describe('Flag type'),
      reason: z.string().min(1).describe('Reason for flagging'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const result = await topicService.flagTopic(params.topicId, {
          contentFlag: params.contentFlag,
          reason: params.reason,
          flaggedBy: account.id,
        });
        return mcpResult({
          id: result.id,
          title: result.title,
          contentFlag: result.content_flag,
          message: 'Topic flagged successfully.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_translations = server.tool(
    'get_translations',
    'List all translations linked to a topic.',
    {
      topicId: z.string().describe('Topic UUID'),
    },
    async (params) => {
      try {
        const translations = await topicService.getTranslations(params.topicId);
        return mcpResult({
          translations: translations.map(t => ({
            id: t.id,
            title: t.title,
            slug: t.slug,
            lang: t.lang,
            status: t.status,
          })),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.link_translation = server.tool(
    'link_translation',
    'Link two topics as translations of each other. Topics must have different languages.',
    {
      topicId: z.string().describe('Source topic UUID'),
      translatedId: z.string().describe('Target topic UUID (different language)'),
    },
    async (params, extra) => {
      try {
        requireAccount(getSessionAccount, extra);
        await topicService.linkTranslation(params.topicId, params.translatedId);
        return mcpResult({ message: 'Translation linked.' });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── CHUNK MANAGEMENT ─────────────────────────────────────────────

  tools.update_chunk = server.tool(
    'update_chunk',
    'Update a chunk you created. Only the creator can update, and only while in proposed status.',
    {
      chunkId: z.string().describe('Chunk UUID'),
      content: z.string().min(10).max(5000).optional().describe('New content'),
      technicalDetail: z.string().max(10000).optional().describe('New technical detail'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const existing = await chunkService.getChunkById(params.chunkId);
        if (!existing) {
          return mcpError(Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' }));
        }
        if (existing.created_by !== account.id) {
          return mcpError(Object.assign(new Error('Only the creator can update this chunk'), { code: 'FORBIDDEN' }));
        }
        const updated = await chunkService.updateChunk(params.chunkId, {
          content: params.content,
          technicalDetail: params.technicalDetail,
        });
        return mcpResult({
          id: updated.id,
          content: updated.content,
          status: updated.status,
          updatedAt: updated.updated_at,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.retract_chunk = server.tool(
    'retract_chunk',
    'Retract (withdraw) a chunk you created. Only works on proposed or under_review chunks.',
    {
      chunkId: z.string().describe('Chunk UUID'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const existing = await chunkService.getChunkById(params.chunkId);
        if (!existing) {
          return mcpError(Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' }));
        }
        if (existing.created_by !== account.id) {
          return mcpError(Object.assign(new Error('Only the creator can retract this chunk'), { code: 'FORBIDDEN' }));
        }
        const retracted = await chunkService.retractChunk(params.chunkId, {
          reason: 'withdrawn',
          retractedBy: account.id,
        });
        return mcpResult({
          id: retracted.id,
          status: retracted.status,
          message: 'Chunk retracted.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.resubmit_chunk = server.tool(
    'resubmit_chunk',
    'Resubmit a previously retracted chunk. Max 3 resubmissions allowed.',
    {
      chunkId: z.string().describe('Chunk UUID (must be in retracted status)'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const existing = await chunkService.getChunkById(params.chunkId);
        if (!existing) {
          return mcpError(Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' }));
        }
        if (existing.created_by !== account.id) {
          return mcpError(Object.assign(new Error('Only the creator can resubmit this chunk'), { code: 'FORBIDDEN' }));
        }
        const resubmitted = await chunkService.resubmitChunk(params.chunkId, account.id);
        return mcpResult({
          id: resubmitted.id,
          status: resubmitted.status,
          message: 'Chunk resubmitted for review.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.add_source = server.tool(
    'add_source',
    'Add a source reference (URL and/or description) to a chunk.',
    {
      chunkId: z.string().describe('Chunk UUID'),
      sourceUrl: z.string().optional().describe('Source URL'),
      sourceDescription: z.string().optional().describe('Source description'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        if (!params.sourceUrl && !params.sourceDescription) {
          return mcpError(Object.assign(new Error('At least one of sourceUrl or sourceDescription is required'), { code: 'VALIDATION_ERROR' }));
        }
        const source = await chunkService.addSource(params.chunkId, {
          sourceUrl: params.sourceUrl,
          sourceDescription: params.sourceDescription,
          addedBy: account.id,
        });
        return mcpResult({
          id: source.id,
          chunkId: source.chunk_id,
          sourceUrl: source.source_url,
          sourceDescription: source.source_description,
          message: 'Source added.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── METACHUNK MANAGEMENT ─────────────────────────────────────────

  tools.propose_metachunk = server.tool(
    'propose_metachunk',
    'Propose a metachunk for a topic. A metachunk defines chunk display order and optional metadata. Content must be a JSON string with "order" (array of chunk UUIDs) and optionally "tags", "languages", and "course" (for course-type topics).',
    {
      topicId: z.string().describe('Topic UUID'),
      content: z.string().describe('JSON string: { "order": ["uuid1", "uuid2", ...], "tags"?: [...], "languages"?: [...], "course"?: { "level": "beginner"|"intermediate"|"expert", "prerequisites": [...], "learningObjectives": [...] } }'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const metachunk = await chunkService.createMetachunk({
          content: params.content,
          topicId: params.topicId,
          createdBy: account.id,
        });
        return mcpResult({
          id: metachunk.id,
          status: metachunk.status,
          message: 'Metachunk proposed. It will go through community review before activation.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_active_metachunk = server.tool(
    'get_active_metachunk',
    'Get the active (published) metachunk for a topic, if any. Returns the chunk ordering and metadata.',
    {
      topicId: z.string().describe('Topic UUID'),
    },
    async (params) => {
      try {
        const metachunk = await chunkService.getActiveMetachunk(params.topicId);
        if (!metachunk) {
          return mcpResult({ found: false, message: 'No active metachunk for this topic.' });
        }
        let parsed;
        try { parsed = JSON.parse(metachunk.content); } catch { parsed = null; }
        return mcpResult({
          found: true,
          id: metachunk.id,
          status: metachunk.status,
          content: parsed,
          createdAt: metachunk.created_at,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  return tools;
}

module.exports = { CATEGORY, registerTools };
