'use strict';

/**
 * Aggregates all MCP tool category modules.
 * Each module exports { CATEGORY, registerTools(server, getSessionAccount) }.
 */

const toolModules = [
  require('./core'),
  require('./account'),
  require('./knowledge-curation'),
  require('./governance'),
  require('./review-moderation'),
  require('./discussion'),
  require('./subscriptions'),
  require('./ai-integration'),
  require('./reports-sanctions'),
  require('./analytics'),
  require('./skills'),
  require('./archetypes'),
];

/**
 * Register all tools from all category modules.
 * @param {McpServer} server
 * @param {function} getSessionAccount
 * @returns {Object<string, Object<string, RegisteredTool>>} category -> { toolName -> registeredTool }
 */
function registerAllTools(server, getSessionAccount) {
  const allTools = {};
  for (const mod of toolModules) {
    allTools[mod.CATEGORY] = { ...allTools[mod.CATEGORY], ...mod.registerTools(server, getSessionAccount) };
  }
  return allTools;
}

module.exports = { registerAllTools };
