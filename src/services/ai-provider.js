const crypto = require('crypto');
const { getPool } = require('../config/database');

// Simple encryption for API keys at rest (not secrets-grade, but better than plaintext)
// Lazy evaluation to avoid reading env before dotenv loads
function getEncryptionKey() {
  const key = process.env.AI_PROVIDER_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!key) throw new Error('No encryption key available (set AI_PROVIDER_ENCRYPTION_KEY or JWT_SECRET)');
  return key;
}

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(getEncryptionKey(), 'aingram-provider', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  const [ivHex, encrypted] = encryptedText.split(':');
  if (!ivHex || !encrypted) return null;
  const iv = Buffer.from(ivHex, 'hex');
  const key = crypto.scryptSync(getEncryptionKey(), 'aingram-provider', 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Block internal/metadata URLs in user-supplied endpoints
const BLOCKED_HOSTS = [
  /^169\.254\./,       // AWS/cloud metadata
  /^10\./,             // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,       // RFC 1918
  /^127\./,            // loopback
  /^0\./,              // current network
  /^::1$/,             // IPv6 loopback
  /\.internal$/i,
  /\.local$/i,
];

function validateEndpoint(url) {
  if (!url) return;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    for (const pattern of BLOCKED_HOSTS) {
      if (pattern.test(hostname)) {
        throw new Error(`Blocked endpoint: ${hostname} is a private/internal address`);
      }
    }
  } catch (err) {
    if (err.message.startsWith('Blocked')) throw err;
    throw new Error('Invalid endpoint URL');
  }
}

// Load provider config from external file
const providerConfig = require('../config/ai-providers.json');
const PROVIDER_TYPES = Object.keys(providerConfig.providers);
const DEFAULT_ENDPOINTS = Object.fromEntries(
  PROVIDER_TYPES.map(k => [k, providerConfig.providers[k].endpoint])
);
const PROVIDER_DEFAULTS = providerConfig.defaults;

/**
 * Create an AI provider config.
 */
async function createProvider({ accountId, name, providerType, apiEndpoint, model, apiKey, systemPrompt, maxTokens, temperature, isDefault }) {
  const pool = getPool();

  // Validate custom endpoint against SSRF
  if (apiEndpoint) {
    validateEndpoint(apiEndpoint);
  }

  // If setting as default, unset other defaults first
  if (isDefault) {
    await pool.query(
      'UPDATE ai_providers SET is_default = false WHERE account_id = $1',
      [accountId]
    );
  }

  const result = await pool.query(
    `INSERT INTO ai_providers (account_id, name, provider_type, api_endpoint, model, api_key_encrypted, system_prompt, max_tokens, temperature, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, account_id, name, provider_type, api_endpoint, model, system_prompt, max_tokens, temperature, is_default, created_at`,
    [accountId, name, providerType, apiEndpoint || DEFAULT_ENDPOINTS[providerType], model, encrypt(apiKey), systemPrompt || null, maxTokens || PROVIDER_DEFAULTS.maxTokens, temperature ?? PROVIDER_DEFAULTS.temperature, isDefault || false]
  );

  return result.rows[0];
}

/**
 * List providers for an account.
 */
async function listProviders(accountId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, account_id, name, provider_type, api_endpoint, model, system_prompt, max_tokens, temperature, is_default, created_at
     FROM ai_providers WHERE account_id = $1
     ORDER BY is_default DESC, created_at DESC`,
    [accountId]
  );
  return result.rows;
}

/**
 * Get a provider by ID (with API key for internal use).
 */
async function getProviderById(id) {
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM ai_providers WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Get the default provider for an account, or the first one.
 */
async function getDefaultProvider(accountId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM ai_providers WHERE account_id = $1
     ORDER BY is_default DESC, created_at ASC
     LIMIT 1`,
    [accountId]
  );
  return result.rows[0] || null;
}

/**
 * Update a provider.
 */
async function updateProvider(id, accountId, updates) {
  const pool = getPool();

  // Validate endpoint if being updated (need to know provider type)
  if (updates.apiEndpoint) {
    // Look up current provider type if not being changed
    const current = await getProviderById(id);
    const provType = updates.providerType || current?.provider_type;
    validateEndpoint(updates.apiEndpoint);
  }

  const fields = [];
  const values = [];
  let idx = 1;

  if (updates.name !== undefined) { fields.push(`name = $${idx++}`); values.push(updates.name); }
  if (updates.providerType !== undefined) { fields.push(`provider_type = $${idx++}`); values.push(updates.providerType); }
  if (updates.apiEndpoint !== undefined) { fields.push(`api_endpoint = $${idx++}`); values.push(updates.apiEndpoint); }
  if (updates.model !== undefined) { fields.push(`model = $${idx++}`); values.push(updates.model); }
  if (updates.apiKey !== undefined) { fields.push(`api_key_encrypted = $${idx++}`); values.push(encrypt(updates.apiKey)); }
  if (updates.systemPrompt !== undefined) { fields.push(`system_prompt = $${idx++}`); values.push(updates.systemPrompt); }
  if (updates.maxTokens !== undefined) { fields.push(`max_tokens = $${idx++}`); values.push(updates.maxTokens); }
  if (updates.temperature !== undefined) { fields.push(`temperature = $${idx++}`); values.push(updates.temperature); }

  if (updates.isDefault) {
    await pool.query('UPDATE ai_providers SET is_default = false WHERE account_id = $1', [accountId]);
    fields.push(`is_default = $${idx++}`);
    values.push(true);
  }

  if (fields.length === 0) return null;

  fields.push(`updated_at = $${idx++}`);
  values.push(new Date());

  values.push(id);
  values.push(accountId);
  const result = await pool.query(
    `UPDATE ai_providers SET ${fields.join(', ')} WHERE id = $${idx++} AND account_id = $${idx}
     RETURNING id, account_id, name, provider_type, api_endpoint, model, system_prompt, max_tokens, temperature, is_default, created_at, updated_at`,
    values
  );
  return result.rows[0] || null;
}

/**
 * Delete a provider.
 */
async function deleteProvider(id, accountId) {
  const pool = getPool();
  const result = await pool.query(
    'DELETE FROM ai_providers WHERE id = $1 AND account_id = $2 RETURNING id',
    [id, accountId]
  );
  return result.rows.length > 0;
}

/**
 * Call an LLM provider with messages.
 * Returns { content, inputTokens, outputTokens }.
 */
async function callProvider(provider, messages, { maxTokens, temperature, responseFormat } = {}) {
  const apiKey = decrypt(provider.api_key_encrypted);
  if (!apiKey) {
    throw new Error('Provider API key not configured');
  }

  const effectiveMaxTokens = maxTokens || provider.max_tokens || 1024;
  const effectiveTemp = temperature !== undefined ? temperature : provider.temperature;

  const protocol = providerConfig.providers[provider.provider_type]?.protocol || 'openai';

  if (protocol === 'claude') {
    return callClaude(provider, apiKey, messages, effectiveMaxTokens, effectiveTemp);
  }

  // OpenAI-compatible (openai, groq, mistral, custom)
  return callOpenAICompatible(provider, apiKey, messages, effectiveMaxTokens, effectiveTemp);
}

async function callClaude(provider, apiKey, messages, maxTokens, temperature) {
  const systemMsg = messages.find(m => m.role === 'system');
  const userMessages = messages.filter(m => m.role !== 'system');

  const body = {
    model: provider.model,
    max_tokens: maxTokens,
    temperature: temperature,
    messages: userMessages.map(m => ({ role: m.role, content: m.content })),
  };
  if (systemMsg) {
    body.system = systemMsg.content;
  }

  const res = await fetch(provider.api_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return {
    content: data.content?.[0]?.text || '',
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}


async function callOpenAICompatible(provider, apiKey, messages, maxTokens, temperature) {
  const res = await fetch(provider.api_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
      temperature: temperature,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(`Provider API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

module.exports = {
  createProvider,
  listProviders,
  getProviderById,
  getDefaultProvider,
  updateProvider,
  deleteProvider,
  callProvider,
  PROVIDER_TYPES,
};
