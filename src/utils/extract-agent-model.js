const AGENT_MODEL_MAX = 128;
const AGENT_MODEL_ALLOWED = /^[A-Za-z0-9._:/-]+$/;

function extractAgentModel(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, AGENT_MODEL_MAX);
  if (!trimmed || !AGENT_MODEL_ALLOWED.test(trimmed)) return null;
  return trimmed;
}

module.exports = { extractAgentModel };
