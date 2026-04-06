'use strict';

const { z } = require('zod');
const { CATEGORIES } = require('./categories');
const { mcpResult, mcpError } = require('./helpers');

/**
 * Register the two progressive-disclosure meta-tools.
 *
 * - list_capabilities: returns all categories with descriptions and tool counts
 * - enable_tools: enables or disables a category's tools for this session
 *
 * @param {McpServer} server
 * @param {Object<string, Object<string, RegisteredTool>>} allTools - category -> { toolName -> registeredTool }
 * @param {Object<string, boolean>} enabledState - category -> enabled (mutable, per-session)
 */
function registerMetaTools(server, allTools, enabledState) {

  server.tool(
    'list_capabilities',
    'List all available tool categories. Each category groups related tools. Use enable_tools to activate a category and make its tools available.',
    {},
    async () => {
      try {
        const categories = Object.entries(CATEGORIES).map(([name, cat]) => ({
          category: name,
          description: cat.description,
          toolCount: allTools[name] ? Object.keys(allTools[name]).length : 0,
          enabled: cat.alwaysEnabled || !!enabledState[name],
          alwaysEnabled: cat.alwaysEnabled,
        }));

        return mcpResult({
          categories,
          totalTools: categories.reduce((sum, c) => sum + c.toolCount, 0),
          hint: 'Call enable_tools({ category: "<name>", enabled: true }) to activate a category.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  server.tool(
    'enable_tools',
    'Enable or disable a tool category for this session. Enabling makes the category\'s tools available in tools/list. Core tools are always available.',
    {
      category: z.string().describe(`Category name: ${Object.keys(CATEGORIES).filter(k => !CATEGORIES[k].alwaysEnabled).join(', ')}`),
      enabled: z.boolean().describe('true to enable, false to disable'),
    },
    async ({ category, enabled }) => {
      try {
        const cat = CATEGORIES[category];
        if (!cat) {
          return mcpError(Object.assign(
            new Error(`Unknown category "${category}". Valid: ${Object.keys(CATEGORIES).join(', ')}`),
            { code: 'VALIDATION_ERROR' }
          ));
        }

        if (cat.alwaysEnabled) {
          return mcpResult({
            category,
            enabled: true,
            message: `Category "${category}" is always enabled and cannot be disabled.`,
          });
        }

        const categoryTools = allTools[category];
        if (!categoryTools || Object.keys(categoryTools).length === 0) {
          return mcpResult({
            category,
            enabled: false,
            message: `Category "${category}" has no tools registered yet.`,
          });
        }

        enabledState[category] = enabled;
        for (const tool of Object.values(categoryTools)) {
          if (enabled) {
            tool.enable();
          } else {
            tool.disable();
          }
        }

        const toolNames = Object.keys(categoryTools);
        return mcpResult({
          category,
          enabled,
          toolCount: toolNames.length,
          tools: toolNames,
          message: enabled
            ? `Enabled ${toolNames.length} tools in "${category}". They are now visible in tools/list.`
            : `Disabled ${toolNames.length} tools in "${category}". They are no longer visible.`,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );
}

module.exports = { registerMetaTools };
