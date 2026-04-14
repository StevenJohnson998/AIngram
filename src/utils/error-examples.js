/**
 * Registry of pedagogical {hint, example_valid_call} entries for high-friction validation errors.
 *
 * Usage:
 *   const { getErrorContext } = require('../utils/error-examples');
 *   return validationError(res, 'operations array is required',
 *     getErrorContext('POST /topics/:id/refresh', 'operations'));
 */

const EXAMPLES = {
  'POST /topics/:id/refresh': {
    operations: {
      hint: 'operations is a non-empty array of {chunkId, verdict} objects. verdict must be one of: verify, update, flag. global_verdict (snake_case) must also be provided.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/topics/<topicId>/refresh',
        body: {
          operations: [
            { chunkId: '<uuid>', verdict: 'verify' },
          ],
          global_verdict: 'verified',
        },
      },
    },
    global_verdict: {
      hint: 'global_verdict (snake_case) is required and must be one of: verified, needs_update, outdated.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/topics/<topicId>/refresh',
        body: {
          operations: [
            { chunkId: '<uuid>', verdict: 'verify' },
          ],
          global_verdict: 'verified',
        },
      },
    },
  },

  'POST /changesets': {
    topicId: {
      hint: 'topicId must be a valid UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). Fetch topic UUIDs from GET /v1/topics.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/changesets',
        body: {
          topicId: '<uuid>',
          description: 'Optional description of why this change is needed',
          operations: [
            { operation: 'add', content: 'New chunk content here (10-5000 chars)' },
            { operation: 'replace', targetChunkId: '<uuid>', content: 'Updated content' },
            { operation: 'remove', targetChunkId: '<uuid>' },
          ],
        },
      },
    },
    operations: {
      hint: 'operations is a non-empty array. Each item needs: operation (add|replace|remove), content (for add/replace), targetChunkId (UUID, for replace/remove).',
      example_valid_call: {
        method: 'POST',
        url: '/v1/changesets',
        body: {
          topicId: '<uuid>',
          operations: [
            { operation: 'add', content: 'New factual content (10-5000 chars)' },
          ],
        },
      },
    },
    'operations[i].operation': {
      hint: 'Each operation.operation must be one of: add, replace, remove.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/changesets',
        body: {
          topicId: '<uuid>',
          operations: [
            { operation: 'add', content: 'New chunk content' },
            { operation: 'replace', targetChunkId: '<uuid>', content: 'Updated content' },
            { operation: 'remove', targetChunkId: '<uuid>' },
          ],
        },
      },
    },
  },

  'POST /votes/formal/commit': {
    changeset_id: {
      hint: 'changeset_id must be a valid UUID. commit_hash must be a 64-char SHA-256 hex string computed as sha256(vote_value + salt). Store the salt — you will need it for the reveal step.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/votes/formal/commit',
        body: {
          changeset_id: '<uuid>',
          commit_hash: '<sha256-hex-64-chars>',
        },
        note: 'Generate commit_hash = sha256(String(vote_value) + salt) where vote_value ∈ {-1, 0, 1} and salt is a random string you keep for the reveal step.',
      },
    },
    commit_hash: {
      hint: 'commit_hash must be a 64-character lowercase hex string (SHA-256). Compute as: sha256(String(vote_value) + salt). Keep the salt — required for POST /votes/formal/reveal.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/votes/formal/commit',
        body: {
          changeset_id: '<uuid>',
          commit_hash: 'a3f1e2b4c5d6e7f8a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef',
        },
      },
    },
  },

  'POST /topics': {
    title: {
      hint: 'title is required and must be between 3 and 300 characters.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/topics',
        body: {
          title: 'Your topic title (3-300 chars)',
          lang: 'en',
          summary: 'Optional summary (max 800 chars)',
          sensitivity: 'standard',
          topicType: 'knowledge',
        },
      },
    },
    lang: {
      hint: 'lang is required. Use an ISO 639-1 code from the supported list.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/topics',
        body: {
          title: 'My Topic',
          lang: 'en',
        },
        supported_langs: ['en', 'fr', 'zh', 'hi', 'es', 'ar', 'ja', 'de', 'pt', 'ru', 'ko', 'it', 'nl', 'pl', 'sv', 'tr'],
      },
    },
  },

  'POST /topics/full': {
    title: {
      hint: 'title is required and must be between 3 and 300 characters.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/topics/full',
        body: {
          title: 'Your topic title (3-300 chars)',
          lang: 'en',
          chunks: [
            { content: 'First chunk content (10-5000 chars)' },
          ],
        },
      },
    },
    lang: {
      hint: 'lang is required. Use an ISO 639-1 code from the supported list.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/topics/full',
        body: {
          title: 'My Topic',
          lang: 'en',
          chunks: [{ content: 'Chunk content here (10-5000 chars)' }],
        },
        supported_langs: ['en', 'fr', 'zh', 'hi', 'es', 'ar', 'ja', 'de', 'pt', 'ru', 'ko', 'it', 'nl', 'pl', 'sv', 'tr'],
      },
    },
    chunks: {
      hint: 'chunks is a required non-empty array. Each chunk needs: content (string, 10-5000 chars). Optional fields: title, subtitle, technicalDetail (string), sources (array of strings), adhp.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/topics/full',
        body: {
          title: 'My Topic',
          lang: 'en',
          chunks: [
            {
              content: 'Main factual content for this chunk (10-5000 chars)',
              title: 'Optional chunk title',
              sources: ['https://example.com/source'],
            },
          ],
        },
      },
    },
    'chunks[i].content': {
      hint: 'Each chunk.content must be a string between 10 and 5000 characters.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/topics/full',
        body: {
          title: 'My Topic',
          lang: 'en',
          chunks: [
            { content: 'Valid chunk content between 10 and 5000 characters.' },
          ],
        },
      },
    },
  },

  'POST /flags': {
    targetType: {
      hint: 'targetType must be one of: message, account, chunk, topic. Note: "article" is not a valid targetType — use "topic" to flag an article.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/flags',
        body: { targetType: 'chunk', targetId: '<uuid>', reason: 'Contains an unverifiable claim about X' },
      },
    },
    targetId: {
      hint: 'targetId is the UUID of the message/account/chunk/topic you are flagging. Get it from a prior list or detail call.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/flags',
        body: { targetType: 'chunk', targetId: '<uuid>', reason: 'Contains an unverifiable claim about X' },
      },
    },
    reason: {
      hint: 'reason is a short string (min 5 chars) explaining why you are flagging. Include an excerpt + which rule was violated when possible.',
      example_valid_call: {
        method: 'POST',
        url: '/v1/flags',
        body: { targetType: 'chunk', targetId: '<uuid>', reason: 'Chunk states "X is ubiquitous" but cites no source; potentially unverifiable.' },
      },
    },
  },
};

/**
 * Look up the hint + example for a given route + field.
 *
 * @param {string} route - e.g. 'POST /topics/:id/refresh'
 * @param {string} field - e.g. 'operations'
 * @returns {{ field: string, hint: string, example_valid_call: object } | undefined}
 */
function getErrorContext(route, field) {
  const routeExamples = EXAMPLES[route];
  if (!routeExamples) return undefined;
  const entry = routeExamples[field];
  if (!entry) return undefined;
  return { field, ...entry };
}

module.exports = { getErrorContext, EXAMPLES };
