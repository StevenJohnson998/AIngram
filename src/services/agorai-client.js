'use strict';

const agoraiConfig = require('../config/agorai.json');

// Config file overrides env vars (allows AIngram-specific Agorai config)
const AGORAI_URL = agoraiConfig.url || process.env.AGORAI_URL || 'http://localhost:3200';
const AGORAI_PASS_KEY = agoraiConfig.passKey || process.env.AGORAI_PASS_KEY || '';
const AGORAI_TIMEOUT = agoraiConfig.timeout || 5000;

let sessionId = null;
let projectId = null;
let initialized = false;

/**
 * Low-level MCP JSON-RPC call to Agorai.
 * All tool invocations go through POST /mcp with Bearer auth.
 * @param {string} method - JSON-RPC method (e.g. 'initialize', 'tools/call')
 * @param {object} params
 * @returns {Promise<object|null>} result or null on failure
 */
async function mcpCall(method, params = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${AGORAI_PASS_KEY}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const id = Date.now();
  const body = { jsonrpc: '2.0', id, method, params };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGORAI_TIMEOUT);

  try {
    const res = await fetch(`${AGORAI_URL}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[agorai] MCP ${method} failed: HTTP ${res.status}`);
      return null;
    }

    // Capture session ID from response headers
    const newSession = res.headers.get('mcp-session-id');
    if (newSession) sessionId = newSession;

    // Agorai may respond with SSE (text/event-stream) or plain JSON
    const contentType = res.headers.get('content-type') || '';
    let data;
    if (contentType.includes('text/event-stream')) {
      const text = await res.text();
      // Parse SSE: extract the last "data:" line (skip event lines)
      const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
      if (dataLines.length === 0) {
        console.warn(`[agorai] MCP ${method}: empty SSE response`);
        return null;
      }
      data = JSON.parse(dataLines[dataLines.length - 1].slice(6));
    } else {
      data = await res.json();
    }

    if (data.error) {
      console.warn(`[agorai] MCP ${method} error:`, data.error.message);
      return null;
    }
    return data.result;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[agorai] MCP ${method}: ${err.message}`);
    return null;
  }
}

/**
 * Call an Agorai tool via MCP and parse the JSON text result.
 * Tool results come as { content: [{ type: 'text', text: '...' }] }.
 * @param {string} toolName
 * @param {object} args
 * @returns {Promise<object|string|null>}
 */
async function callTool(toolName, args = {}) {
  const result = await mcpCall('tools/call', { name: toolName, arguments: args });
  if (!result || !result.content || !result.content[0]) return null;
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return result.content[0].text;
  }
}

/**
 * Initialize MCP session and ensure the "aingram" project exists.
 * Lazy-initialized on first tool call; does not block server startup.
 * @returns {Promise<boolean>}
 */
async function ensureInitialized() {
  if (initialized) return true;
  if (!AGORAI_PASS_KEY) {
    console.warn('[agorai] No AGORAI_PASS_KEY configured, Agorai integration disabled');
    return false;
  }

  try {
    // Step 1: Initialize MCP session
    const initResult = await mcpCall('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'aingram', version: '0.1.0' },
    });
    if (!initResult) return false;

    // Step 2: Send initialized notification (fire-and-forget, no response expected)
    const notifHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${AGORAI_PASS_KEY}`,
    };
    if (sessionId) notifHeaders['mcp-session-id'] = sessionId;

    await fetch(`${AGORAI_URL}/mcp`, {
      method: 'POST',
      headers: notifHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }).catch(() => {});

    // Step 3: Find or create project
    const projName = agoraiConfig.projectName || 'aingram';
    const projects = await callTool('list_projects');
    if (Array.isArray(projects)) {
      const existing = projects.find(p => p.name === projName);
      if (existing) {
        projectId = existing.id;
      }
    }
    if (!projectId) {
      const project = await callTool('create_project', {
        name: projName,
        description: 'AIngram Knowledge Base discussions',
      });
      if (project) projectId = project.id;
    }

    if (!projectId) {
      console.warn('[agorai] Failed to create/find aingram project');
      return false;
    }

    initialized = true;
    console.log(`[agorai] Initialized, project: ${projectId}`);
    return true;
  } catch (err) {
    console.warn(`[agorai] Init failed: ${err.message}`);
    return false;
  }
}

/**
 * Create an Agorai conversation via MCP.
 * @param {string} title
 * @returns {Promise<string|null>} conversationId or null on failure
 */
async function createConversation(title) {
  if (!await ensureInitialized()) return null;
  const convDefaults = agoraiConfig.conversationDefaults || {};
  const conv = await callTool('create_conversation', {
    project_id: projectId,
    title,
    public_read: convDefaults.publicRead !== false,
    default_visibility: 'public',
  });
  return conv?.id || null;
}

/**
 * Fetch messages from an Agorai conversation (public REST endpoint, no auth).
 * @param {string} conversationId
 * @param {{ limit?: number, offset?: number }} options
 * @returns {Promise<{ messages: Array, total: number }>}
 */
async function getMessages(conversationId, { limit = 50, offset = 0 } = {}) {
  try {
    const url = `${AGORAI_URL}/api/conversations/${conversationId}/public?limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return { messages: [], total: 0 };
    const data = await res.json();
    return {
      messages: data.messages || data || [],
      total: data.total || (data.messages || data || []).length,
    };
  } catch (err) {
    console.warn(`[agorai] getMessages error: ${err.message}`);
    return { messages: [], total: 0 };
  }
}

/**
 * Send a message to an Agorai conversation via MCP.
 * Auto-subscribes to the conversation before sending.
 * @param {string} conversationId
 * @param {{ content: string, accountId: string, accountName: string, level?: number }} params
 * @returns {Promise<object|null>} message object or null on failure
 */
async function sendMessage(conversationId, { content, accountId, accountName, level = 1 }) {
  if (!await ensureInitialized()) return null;

  // Subscribe to conversation (idempotent, ignore failures)
  await callTool('subscribe', { conversation_id: conversationId });

  const msg = await callTool('send_message', {
    conversation_id: conversationId,
    content,
    visibility: 'public',
    metadata: { source: 'aingram', accountId, accountName, level },
  });
  return msg || null;
}

/**
 * Fetch active conversations from an Agorai project (public REST endpoint).
 * @param {{ days?: number, limit?: number }} options
 * @returns {Promise<Array<{ id: string, title: string, messageCount: number, participantCount: number, lastMessageAt: string }>>}
 */
async function getActiveConversations({ days = 7, limit = 10 } = {}) {
  if (!await ensureInitialized()) return [];
  try {
    const url = `${AGORAI_URL}/api/projects/${projectId}/conversations/active?days=${days}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.warn(`[agorai] getActiveConversations error: ${err.message}`);
    return [];
  }
}

/**
 * Fetch stats for a specific Agorai conversation (public REST endpoint).
 * Only works if conversation has publicRead=true.
 * @param {string} conversationId
 * @returns {Promise<object|null>}
 */
async function getConversationStats(conversationId) {
  try {
    const url = `${AGORAI_URL}/api/conversations/${conversationId}/stats`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`[agorai] getConversationStats error: ${err.message}`);
    return null;
  }
}

/**
 * Check Agorai health via REST endpoint (no MCP, no auth).
 * @returns {Promise<{ available: boolean }>}
 */
async function checkHealth() {
  try {
    const res = await fetch(`${AGORAI_URL}/health`);
    if (!res.ok) return { available: false };
    return { available: true };
  } catch {
    return { available: false };
  }
}

/**
 * Reset internal state (for testing only).
 */
function _resetForTests() {
  sessionId = null;
  projectId = null;
  initialized = false;
}

module.exports = { createConversation, getMessages, sendMessage, getActiveConversations, getConversationStats, checkHealth, ensureInitialized, _resetForTests };
