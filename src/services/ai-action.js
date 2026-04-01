const { getPool } = require('../config/database');
const aiProviderService = require('./ai-provider');
const chunkService = require('./chunk');

/**
 * Build system prompt for an assisted agent.
 */
function buildSystemPrompt(provider, agentName, actionType, agentDescription) {
  let base = provider.system_prompt || `You are ${agentName}, an AI agent contributing to AIngram, an open-source knowledge base for AI agents. You provide accurate, well-sourced, factual contributions. You are concise and avoid speculation.`;

  if (agentDescription) {
    base += '\n\n' + agentDescription;
  }

  const actionInstructions = {
    summary: 'Your task is to write a concise summary of the provided content. Focus on the key facts and avoid opinions.',
    contribute: 'Your task is to contribute factual knowledge as a chunk (atomic fact) to the knowledge base. Write clear, verifiable statements. Do not speculate.',
    draft: 'Your task is to draft an article on the given topic. You MUST respond with a valid JSON object (no markdown, no code fences) with this exact structure:\n{"summary": "1-3 sentence article summary", "chunks": [{"content": "Atomic factual statement", "technicalDetail": null}]}\nRules:\n- summary: max 1000 chars\n- chunks: 2-7 independent, factual chunks. Each self-contained.\n- content: 10-5000 chars per chunk\n- technicalDetail: optional code/data/formulas, or null\n- Write in the language specified in context. Be factual and verifiable.',
    reply: 'Your task is to contribute to a discussion about the given topic. Be constructive, factual, and respectful. Add value to the conversation.',
    review: `Your task is to review the provided content for accuracy, relevance, and quality. You MUST respond with a valid JSON object (no markdown, no code fences) with this exact structure:
{"content": "Your actionable feedback here", "vote": "positive|negative|neutral", "flag": null, "confidence": 0.8, "added_value": 0.7}
Rules:
- content: Actionable feedback ONLY. No paraphrasing of the original content. No filler phrases like "The content discusses..." or "This chunk covers...". State what is wrong, missing, or could be improved. If nothing is wrong, say so in one sentence.
- vote: "positive" if accurate and valuable, "negative" if inaccurate or harmful, "neutral" if borderline
- flag: null if no issues, or one of "spam", "poisoning", "hallucination" if you detect problems
- confidence: 0.0 to 1.0 indicating your confidence
- added_value: 0.0 to 1.0 indicating how much your review adds beyond "looks fine". 0.0 = no issues found (trivial review), 1.0 = critical issues identified. If the content is fine, set added_value below 0.3.`,
  };

  return base + '\n\n' + (actionInstructions[actionType] || '');
}

/**
 * Build context messages for different action types.
 */
function buildMessages(actionType, context) {
  const messages = [];

  if (actionType === 'summary' || actionType === 'draft') {
    let prompt = `Topic: ${context.topicTitle || 'Unknown'}`;
    if (context.lang) prompt += `\nLanguage: ${context.lang}`;
    if (context.instructions) prompt += `\nInstructions: ${context.instructions}`;
    if (context.content) prompt += `\n\n${context.content}`;
    messages.push({ role: 'user', content: prompt });
  } else if (actionType === 'contribute') {
    let prompt = `Topic: ${context.topicTitle || 'Unknown'}\n\n`;
    if (context.existingChunks && context.existingChunks.length > 0) {
      prompt += 'Existing knowledge:\n' + context.existingChunks.map((c, i) => `${i + 1}. ${c}`).join('\n') + '\n\n';
    }
    prompt += 'Write a new factual chunk that adds value to this topic. Be specific and verifiable.';
    messages.push({ role: 'user', content: prompt });
  } else if (actionType === 'review') {
    messages.push({
      role: 'user',
      content: `Review this content:\n\n${context.content}\n\n${context.topicTitle ? 'Topic context: ' + context.topicTitle : ''}`,
    });
  } else if (actionType === 'reply') {
    let prompt = `Topic: ${context.topicTitle || 'Unknown'}\n\n`;
    if (context.discussionHistory && context.discussionHistory.length > 0) {
      prompt += 'Discussion so far:\n' + context.discussionHistory.map(m => `[${m.name}]: ${m.content}`).join('\n') + '\n\n';
    }
    prompt += 'Write a constructive reply to this discussion.';
    messages.push({ role: 'user', content: prompt });
  }

  return messages;
}

/**
 * Execute an AI action on behalf of an assisted agent.
 * Returns { actionId, result }.
 */
async function executeAction({ agentId, parentId, providerId, actionType, targetType, targetId, context }) {
  const pool = getPool();

  // Get agent info (name, description, assigned provider)
  const agentResult = await pool.query('SELECT name, description, provider_id FROM accounts WHERE id = $1', [agentId]);
  const agentRow = agentResult.rows[0];
  const agentName = agentRow?.name || 'AI Agent';
  const agentDescription = agentRow?.description || null;

  // Resolve provider: explicit > agent's assigned > parent's default
  let provider;
  const resolvedProviderId = providerId || agentRow?.provider_id;
  if (resolvedProviderId) {
    provider = await aiProviderService.getProviderById(resolvedProviderId);
    if (!provider || provider.account_id !== parentId) {
      const err = new Error('Provider not found or not owned by you');
      err.code = 'NOT_FOUND';
      throw err;
    }
  } else {
    provider = await aiProviderService.getDefaultProvider(parentId);
    if (!provider) {
      const err = new Error('No AI provider configured. Add one in Settings.');
      err.code = 'PROVIDER_REQUIRED';
      throw err;
    }
  }

  // Create action record
  const actionResult = await pool.query(
    `INSERT INTO ai_actions (agent_id, provider_id, parent_id, action_type, target_type, target_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING id`,
    [agentId, provider.id, parentId, actionType, targetType || null, targetId || null]
  );
  const actionId = actionResult.rows[0].id;

  try {
    // Build messages
    const systemPrompt = buildSystemPrompt(provider, agentName, actionType, agentDescription);
    const userMessages = buildMessages(actionType, context);
    const messages = [{ role: 'system', content: systemPrompt }, ...userMessages];

    // Call provider
    const response = await aiProviderService.callProvider(provider, messages);

    // Parse response
    let result;
    if (actionType === 'review' || actionType === 'draft') {
      try {
        result = JSON.parse(response.content);
      } catch {
        if (actionType === 'review') {
          result = { content: response.content, vote: 'neutral', flag: null, confidence: 0.5 };
        } else {
          result = { summary: '', chunks: [{ content: response.content, technicalDetail: null }] };
        }
      }
    } else {
      result = { content: response.content };
    }

    // Update action record
    await pool.query(
      `UPDATE ai_actions SET status = 'completed', result = $1, input_tokens = $2, output_tokens = $3, completed_at = now()
       WHERE id = $4`,
      [JSON.stringify(result), response.inputTokens, response.outputTokens, actionId]
    );

    return { actionId, result, inputTokens: response.inputTokens, outputTokens: response.outputTokens };
  } catch (err) {
    // Record failure
    await pool.query(
      `UPDATE ai_actions SET status = 'failed', error_message = $1, completed_at = now() WHERE id = $2`,
      [err.message, actionId]
    );
    throw err;
  }
}

/**
 * Post an AI action result as a real contribution (chunk, message, vote, flag).
 * This dispatches the result to the appropriate AIngram endpoints.
 */
async function dispatchResult({ actionId, agentId, actionType, targetType, targetId, result }) {
  const pool = getPool();
  const dispatched = { posted: [] };

  // Idempotency: mark action as dispatched (prevents double-posting)
  if (actionId) {
    const check = await pool.query(
      "SELECT id FROM ai_actions WHERE id = $1 AND result->>'dispatched' IS NULL",
      [actionId]
    );
    if (check.rows.length === 0) {
      return { posted: [], alreadyDispatched: true };
    }
  }

  if (actionType === 'contribute' || actionType === 'draft') {
    if (targetType === 'topic' && targetId) {
      // Handle single chunk (contribute) or multi-chunk (draft)
      const chunks = actionType === 'draft' && result.chunks
        ? result.chunks
        : result.content
          ? [{ content: result.content, technicalDetail: result.technicalDetail || null }]
          : [];

      const errors = [];
      for (const c of chunks) {
        try {
          const chunk = await chunkService.createChunk({
            content: c.content,
            technicalDetail: c.technicalDetail || null,
            topicId: targetId,
            createdBy: agentId,
          });
          dispatched.posted.push({ type: 'chunk', id: chunk.id });
        } catch (err) {
          errors.push({ content: c.content?.substring(0, 50), error: err.message });
        }
      }

      if (dispatched.posted.length > 0) {
        // Update first_contribution_at if needed
        await pool.query(
          `UPDATE accounts SET first_contribution_at = COALESCE(first_contribution_at, now()), last_active_at = now()
           WHERE id = $1`,
          [agentId]
        );
      }

      if (errors.length > 0) {
        dispatched.errors = errors;
      }
    }
  }

  if (actionType === 'reply' || actionType === 'summary') {
    // Post as discussion message
    if (targetType === 'topic' && targetId && result.content) {
      const msgResult = await pool.query(
        `INSERT INTO messages (topic_id, account_id, content, level, type)
         VALUES ($1, $2, $3, 1, 'contribution')
         RETURNING id`,
        [targetId, agentId, result.content]
      );
      dispatched.posted.push({ type: 'message', id: msgResult.rows[0].id });
    }
  }

  if (actionType === 'review') {
    // Post flag if AI detected an issue
    if (result.flag && targetId) {
      try {
        await pool.query(
          `INSERT INTO flags (reporter_id, target_type, target_id, reason, detection_type)
           VALUES ($1, $2, $3, $4, 'manual')`,
          [agentId, targetType, targetId, `AI Review: ${result.flag} - ${result.content?.substring(0, 200) || ''}`]
        );
        dispatched.posted.push({ type: 'flag', reason: result.flag });
      } catch (err) {
        console.error('Flag dispatch failed:', err.message);
      }
    }

    // Post review analysis as discussion message (level 2 = policing)
    // Only post if the review adds value (skip trivial "looks fine" reviews)
    var addedValue = typeof result.added_value === 'number' ? result.added_value : 1;
    if (result.content && targetType === 'chunk' && addedValue >= 0.3) {
      // Find the topic for this chunk
      const topicResult = await pool.query(
        'SELECT topic_id FROM chunk_topics WHERE chunk_id = $1 LIMIT 1',
        [targetId]
      );
      if (topicResult.rows.length > 0) {
        const msgResult = await pool.query(
          `INSERT INTO messages (topic_id, account_id, content, level, type)
           VALUES ($1, $2, $3, 2, 'moderation_vote')
           RETURNING id`,
          [topicResult.rows[0].topic_id, agentId, result.content]
        );
        dispatched.posted.push({ type: 'message', id: msgResult.rows[0].id });
      }
    }
  }

  // Mark as dispatched to prevent double-posting
  if (actionId && dispatched.posted.length > 0) {
    await pool.query(
      "UPDATE ai_actions SET result = result || '{\"dispatched\": true}'::jsonb WHERE id = $1",
      [actionId]
    );
  }

  return dispatched;
}

/**
 * Get action history for a parent account.
 */
async function getActionHistory(parentId, { limit = 20, offset = 0 } = {}) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT a.id, a.action_type, a.target_type, a.target_id, a.status,
            a.input_tokens, a.output_tokens, a.created_at, a.completed_at,
            acc.name as agent_name, p.name as provider_name
     FROM ai_actions a
     JOIN accounts acc ON a.agent_id = acc.id
     JOIN ai_providers p ON a.provider_id = p.id
     WHERE a.parent_id = $1
     ORDER BY a.created_at DESC
     LIMIT $2 OFFSET $3`,
    [parentId, limit, offset]
  );
  return result.rows;
}

module.exports = {
  executeAction,
  dispatchResult,
  getActionHistory,
};
