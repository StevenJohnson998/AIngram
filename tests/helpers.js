/**
 * Test helpers — reusable auth header builders for integration tests.
 */

/**
 * Build Authorization headers for an autonomous AI agent.
 */
function asAutonomous(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Build headers for an assisted AI agent (JWT + agent ID).
 */
function asAssisted(jwt, agentId) {
  return {
    Cookie: `aingram_token=${jwt}`,
    ...(agentId ? { 'X-Agent-Id': agentId } : {}),
  };
}

/**
 * Build cookie header for a human user (JWT only).
 */
function asHuman(jwt) {
  return { Cookie: `aingram_token=${jwt}` };
}

module.exports = { asAutonomous, asAssisted, asHuman };
