'use strict';

/**
 * Autonomous agent test runner.
 * Sends a vague task to an external LLM (DeepSeek/Mistral) and lets it
 * interact with the AIngram API autonomously via function calling.
 *
 * Usage:
 *   PROVIDER=deepseek TASK="Write an article on a subject of your choice" node scripts/test-autonomous-agent.js
 *   PROVIDER=mistral TASK="Search for content and evaluate its reliability" node scripts/test-autonomous-agent.js
 */

const PROVIDERS = {
  deepseek: {
    endpoint: 'https://api.deepseek.com/chat/completions',
    key: process.env.DEEPSEEK_API_KEY || 'sk-5773ebc6449b436ab61912406d57f04f',
    model: 'deepseek-chat',
  },
  mistral: {
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    key: process.env.MISTRAL_API_KEY || 'F2VgtKk7OtJO5iRsNiIkVu6SsgPx6pA7',
    model: 'mistral-small-latest',
  },
};

const AINGRAM_BASE = 'http://localhost:3000';
const MAX_TURNS = 20;
const provider = PROVIDERS[process.env.PROVIDER || 'deepseek'];
if (!provider) { console.error('Unknown PROVIDER. Use deepseek or mistral.'); process.exit(1); }

const task = process.env.TASK || 'Write an article on a subject of your choice related to AI.';

// Tools the LLM can call to interact with AIngram
const tools = [
  {
    type: 'function',
    function: {
      name: 'http_get',
      description: 'Make a GET request to the AIngram API or fetch a .txt documentation file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'URL path (e.g. /llms.txt, /v1/skills, /v1/search?q=trust)' },
          auth_token: { type: 'string', description: 'Optional Bearer token for authenticated requests' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_post',
      description: 'Make a POST request to the AIngram API with a JSON body.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'URL path (e.g. /v1/accounts/register, /v1/topics)' },
          body: { type: 'object', description: 'JSON body to send' },
          auth_token: { type: 'string', description: 'Optional Bearer token for authenticated requests' },
        },
        required: ['path', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'report_done',
      description: 'Call this when you have completed your task. Include a summary of what you did, what skills/docs you read, and whether you followed the best practices.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary of actions taken' },
          skills_read: { type: 'array', items: { type: 'string' }, description: 'List of skill/doc files read' },
          skills_applied: { type: 'array', items: { type: 'string' }, description: 'List of best-practice rules applied' },
          rating: { type: 'number', description: 'Rate the onboarding experience 1-10' },
        },
        required: ['summary', 'skills_read', 'skills_applied', 'rating'],
      },
    },
  },
];

const systemPrompt = `You are an autonomous AI agent. You have access to a knowledge base platform via HTTP.

Your task: ${task}

You need to figure out on your own how this platform works. Start by reading the platform documentation (try /llms.txt). Find out what quality standards exist before acting.

You can make HTTP requests using http_get and http_post tools. The base URL is ${AINGRAM_BASE}.
When done, call report_done with a summary of what you did.

Important:
- Read the documentation BEFORE contributing or reviewing.
- Look for best-practice guidelines or skills.
- Follow whatever quality standards you find.
- Do NOT skip the discovery phase.`;

async function callLLM(messages) {
  const resp = await fetch(provider.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.key}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 4096,
      temperature: 0.3,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function callAIngram(method, path, body, authToken) {
  const url = `${AINGRAM_BASE}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const opts = { method, headers };
  if (body && method === 'POST') opts.body = JSON.stringify(body);

  try {
    const resp = await fetch(url, opts);
    const text = await resp.text();
    // Truncate very long responses to avoid blowing up LLM context
    const truncated = text.length > 4000 ? text.slice(0, 4000) + '\n... [truncated, ' + text.length + ' chars total]' : text;
    return { status: resp.status, body: truncated };
  } catch (err) {
    return { status: 0, body: `Connection error: ${err.message}` };
  }
}

async function run() {
  const providerName = process.env.PROVIDER || 'deepseek';
  console.log(`\n=== Autonomous Agent Test ===`);
  console.log(`Provider: ${providerName} (${provider.model})`);
  console.log(`Task: ${task}`);
  console.log(`Max turns: ${MAX_TURNS}\n`);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Begin. Your task: ${task}` },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    console.log(`--- Turn ${turn} ---`);

    const result = await callLLM(messages);
    const choice = result.choices[0];
    const msg = choice.message;

    // Add assistant message to history
    messages.push(msg);

    if (msg.content) {
      console.log(`[${providerName}] ${msg.content.slice(0, 200)}${msg.content.length > 200 ? '...' : ''}`);
    }

    // Check for tool calls
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log(`[${providerName}] No tool calls, stopping.`);
      break;
    }

    for (const tc of msg.tool_calls) {
      const fn = tc.function;
      let args;
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
      } catch (e) {
        args = {};
      }

      let toolResult;

      if (fn.name === 'http_get') {
        console.log(`  -> GET ${args.path}`);
        const resp = await callAIngram('GET', args.path, null, args.auth_token);
        toolResult = JSON.stringify(resp);
        console.log(`  <- ${resp.status} (${resp.body.length} chars)`);
      } else if (fn.name === 'http_post') {
        console.log(`  -> POST ${args.path}`);
        const resp = await callAIngram('POST', args.path, args.body, args.auth_token);
        toolResult = JSON.stringify(resp);
        console.log(`  <- ${resp.status} (${resp.body.length} chars)`);
      } else if (fn.name === 'report_done') {
        console.log(`\n=== AGENT REPORT ===`);
        console.log(`Skills read: ${(args.skills_read || []).join(', ')}`);
        console.log(`Skills applied: ${(args.skills_applied || []).join(', ')}`);
        console.log(`Rating: ${args.rating}/10`);
        console.log(`Summary: ${args.summary}`);
        console.log(`=== END REPORT ===\n`);
        return args;
      } else {
        toolResult = JSON.stringify({ error: `Unknown tool: ${fn.name}` });
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolResult,
      });
    }
  }

  console.log('Max turns reached without report_done.');
  return null;
}

run().then(report => {
  if (report) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}).catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
