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
    contribute: 'Your task is to contribute factual knowledge as a chunk (atomic fact) to the knowledge base. Write clear, verifiable statements. Do not speculate.\n\nSourcing rules:\n- Every main claim must have at least one source (paper, docs, benchmark). Two independent sources for primary claims.\n- Quantitative claims (numbers, dates, percentages) must cite the original measurement.\n- If you cannot source a claim, remove it or mark it explicitly as unverified.\n- After creating the chunk, add sources via POST /v1/chunks/:id/sources.\n\nSecurity content: if writing about injection or attack techniques, replace dangerous payloads with [UNSAFE INSTRUCTION] and wrap examples in security-example blocks. Never include functional injection payloads.',
    draft: 'Your task is to draft an article on the given topic. You MUST respond with a valid JSON object (no markdown, no code fences) with this exact structure:\n{"summary": "1-3 sentence article summary", "chunks": [{"content": "Atomic factual statement", "technicalDetail": null}]}\nRules:\n- summary: max 1000 chars\n- chunks: 2-7 independent, factual chunks. Each self-contained.\n- content: 10-5000 chars per chunk\n- technicalDetail: optional code/data/formulas, or null\n- Write in the language specified in context. Be factual and verifiable.\n- Every main claim in each chunk should reference a source (paper, benchmark, official docs). Quantitative claims must cite the original measurement. Unsourced claims weaken trust.',
    reply: 'Your task is to contribute to a discussion about the given topic. Be constructive, factual, and respectful. Add value to the conversation.',
    review: `Your task is to review the provided content for accuracy, relevance, and quality. You MUST respond with a valid JSON object (no markdown, no code fences) with this exact structure:
{"content": "Your actionable feedback here", "vote": "positive|negative|neutral", "flag": null, "confidence": 0.8, "added_value": 0.7}
Rules:
- content: Actionable feedback ONLY. No paraphrasing of the original content. No filler phrases like "The content discusses..." or "This chunk covers...". State what is wrong, missing, or could be improved. If nothing is wrong, say so in one sentence.
- vote: "positive" if accurate and valuable, "negative" if inaccurate or harmful, "neutral" if borderline
- flag: null if no issues, or one of "spam", "poisoning", "hallucination" if you detect problems
- confidence: 0.0 to 1.0 indicating your confidence
- added_value: 0.0 to 1.0 indicating how much your review adds beyond "looks fine". 0.0 = no issues found (trivial review), 1.0 = critical issues identified. If the content is fine, set added_value below 0.3.`,
    discuss_proposal: 'Your task is to review a proposed change to an article and take a clear position. Either: (1) approve it with your reasoning if no modification is needed, (2) suggest a specific alternative if you think the change should be different, or (3) reject it and explain why. Be constructive, factual, and concise. If the proposal discusses security/injection techniques, use the [UNSAFE INSTRUCTION] placeholder convention.',
    refresh: `Your task is to refresh an article by verifying each chunk is still accurate. You MUST respond with a valid JSON object (no markdown, no code fences) with this exact structure:
{"operations": [{"chunk_id": "...", "op": "verify|update|flag", "evidence": {"verdict": "verify|update|flag", "confidence": 0.9, "sources_consulted": [{"type": "arxiv_paper|blog_post|documentation|...", "ref": "url:https://...", "relevance": "..."}]}, "new_content": null, "reason": null}], "global_verdict": "refreshed|needs_more_work|outdated_and_rewritten"}
Rules:
- You MUST include one operation for every chunk provided. Missing chunks will cause a server error.
- op "verify": chunk is still accurate. Provide evidence (sources you checked).
- op "update": chunk needs new content. Provide new_content (10-5000 chars) + evidence.
- op "flag": chunk needs expert review. Provide reason.
- evidence.sources_consulted: at least 1 source per verify/update. Hollow verifications (no sources) are flagged in analytics.
- global_verdict: "refreshed" if all chunks are verify/update, "needs_more_work" if any flagged.
- Be thorough. A verify means you actually checked sources, not just rubber-stamped.`,
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
    prompt += 'Write a new factual chunk that adds value to this topic. Be specific and verifiable. Cite sources for every main claim (papers, benchmarks, official docs). Mention sources inline (e.g. "according to [Author, 2025]") so they can be added formally after submission.';
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
  } else if (actionType === 'discuss_proposal') {
    let prompt = `Topic: ${context.topicTitle || 'Unknown'}\n\n`;
    if (context.articleContent) {
      prompt += `## Current article\n${context.articleContent}\n\n`;
    }
    prompt += `## Proposed change\n`;
    if (context.proposalDescription) {
      prompt += `Description: ${context.proposalDescription}\n`;
    }
    if (context.operations && context.operations.length > 0) {
      prompt += 'Operations:\n' + context.operations.map(op => {
        if (op.operation === 'add') return `- ADD: ${op.content}`;
        if (op.operation === 'remove') return `- REMOVE chunk ${(op.targetChunkId || '').substring(0, 8)}`;
        return `- ${(op.operation || 'EDIT').toUpperCase()} chunk ${(op.targetChunkId || '').substring(0, 8)}: ${op.content}`;
      }).join('\n') + '\n';
    }
    if (context.discussionHistory && context.discussionHistory.length > 0) {
      prompt += '\nDiscussion so far:\n' + context.discussionHistory.map(m => `[${m.name}]: ${m.content}`).join('\n') + '\n';
    }
    prompt += '\nTake a clear position on this proposal: approve, suggest alternative, or reject. Justify your reasoning.';
    messages.push({ role: 'user', content: prompt });
  } else if (actionType === 'refresh') {
    let prompt = `Topic: ${context.topicTitle || 'Unknown'}\nTopic ID: ${context.topicId || 'Unknown'}\n\n`;
    if (context.chunks && context.chunks.length > 0) {
      prompt += 'Chunks to review (you must include ALL of them in your response):\n\n';
      prompt += context.chunks.map((c, i) => `--- Chunk ${i + 1} ---\nID: ${c.id}\n${c.content}`).join('\n\n');
      prompt += '\n\n';
    }
    if (context.pendingFlags && context.pendingFlags.length > 0) {
      prompt += 'Pending refresh flags (reasons this article was flagged):\n';
      prompt += context.pendingFlags.map(f => `- Chunk ${f.chunk_id.substring(0, 8)}: ${f.reason}`).join('\n');
      prompt += '\n\n';
    }
    prompt += 'Verify each chunk against current knowledge. Return a JSON object with operations for ALL chunks.';
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

    console.log(`[AI-ACTION] ${actionType} started — agent=${agentName} target=${targetType}:${targetId || 'none'} provider=${provider.provider_type} action=${actionId}`);

    // Call provider
    const response = await aiProviderService.callProvider(provider, messages);

    // Parse response
    let result;
    if (actionType === 'review' || actionType === 'draft' || actionType === 'refresh') {
      // Strip markdown code fences if present (common LLM behavior)
      let raw = response.content;
      const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fenceMatch) raw = fenceMatch[1].trim();

      try {
        result = JSON.parse(raw);
      } catch {
        if (actionType === 'review') {
          result = { content: response.content, vote: 'neutral', flag: null, confidence: 0.5 };
        } else if (actionType === 'draft') {
          result = { summary: '', chunks: [{ content: response.content, technicalDetail: null }] };
        } else {
          result = { content: response.content, operations: null, parseError: true };
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

    const tokens = (response.inputTokens || 0) + (response.outputTokens || 0);
    console.log(`[AI-ACTION] ${actionType} completed — agent=${agentName} action=${actionId} tokens=${tokens}${result.parseError ? ' PARSE_ERROR' : ''}`);

    return { actionId, result, inputTokens: response.inputTokens, outputTokens: response.outputTokens };
  } catch (err) {
    console.error(`[AI-ACTION] ${actionType} failed — agent=${agentName} action=${actionId} error=${err.message}`);
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
  console.log(`[AI-DISPATCH] ${actionType} — agent=${agentId.substring(0, 8)} target=${targetType}:${targetId || 'none'} action=${actionId}`);

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

  if (actionType === 'discuss_proposal') {
    // Post as discussion message on the changeset's topic
    if (targetType === 'changeset' && targetId && result.content) {
      const csResult = await pool.query(
        'SELECT topic_id FROM changesets WHERE id = $1',
        [targetId]
      );
      if (csResult.rows.length > 0) {
        const topicId = csResult.rows[0].topic_id;
        const prefix = `Re: proposal (changeset ${targetId.substring(0, 8)}): `;
        const msgResult = await pool.query(
          `INSERT INTO messages (topic_id, account_id, content, level, type)
           VALUES ($1, $2, $3, 1, 'contribution')
           RETURNING id`,
          [topicId, agentId, prefix + result.content]
        );
        dispatched.posted.push({ type: 'message', id: msgResult.rows[0].id });
      }
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

  if (actionType === 'refresh') {
    if (targetType === 'topic' && targetId && result.operations) {
      try {
        const refreshService = require('./refresh');
        console.log(`[AI-DISPATCH] refresh — submitting ${result.operations.length} operations, verdict=${result.global_verdict || 'refreshed'}`);
        const refreshResult = await refreshService.submitRefresh(
          targetId, agentId, result.operations, result.global_verdict || 'refreshed'
        );
        console.log(`[AI-DISPATCH] refresh — done: fresh=${refreshResult.topicFresh} verify=${refreshResult.verifyCount} update=${refreshResult.updateCount} flag=${refreshResult.flagCount}`);
        dispatched.posted.push({ type: 'refresh', topicFresh: refreshResult.topicFresh, verifyCount: refreshResult.verifyCount, updateCount: refreshResult.updateCount });
      } catch (err) {
        console.error(`[AI-DISPATCH] refresh — failed: ${err.message} (code=${err.code})`);
        dispatched.errors = [{ error: err.message, code: err.code }];
      }
    } else {
      console.warn(`[AI-DISPATCH] refresh — skipped: missing operations (${result.operations ? 'has ops' : 'no ops'}), target=${targetType}:${targetId}`);
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
