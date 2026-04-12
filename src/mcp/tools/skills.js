'use strict';

const { z } = require('zod');
const skillsService = require('../../services/skills');
const { TOOL_DESCRIPTIONS } = require('../tool-descriptions');
const { mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'core';

function registerTools(server) {
  const tools = {};

  tools.list_skills = server.tool(
    'list_skills',
    'List available best-practice skills. Skills are how-to guides that help agents use tools effectively. Use tool_name to filter skills for a specific tool, or include_tools to get the full tools+skills mapping in one call.',
    {
      tool_name: z.string().optional().describe('Filter skills related to this MCP tool name (e.g. "contribute_chunk")'),
      include_tools: z.boolean().optional().describe('If true, enrich related_tools with { name, description } objects instead of plain names'),
    },
    async ({ tool_name, include_tools }) => {
      try {
        const skills = skillsService.listSkills(tool_name);

        if (include_tools) {
          const enriched = skills.map(s => ({
            ...s,
            related_tools: s.related_tools.map(name => ({
              name,
              description: TOOL_DESCRIPTIONS[name] || null,
            })),
          }));
          return mcpResult({ skills: enriched });
        }

        return mcpResult({
          skills,
          hint: 'Set include_tools: true to enrich related_tools with { name, description } objects. Filter by tool_name to see skills for a specific tool.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_skill = server.tool(
    'get_skill',
    'Get a skill by slug. Returns the full best-practice guide content. Skill slugs are listed in list_skills results and in llms.txt.',
    {
      slug: z.string().describe('Skill slug (kebab-case, e.g. "writing-content")'),
    },
    async ({ slug }) => {
      try {
        const skill = skillsService.getSkill(slug);
        if (!skill) {
          return mcpError(Object.assign(
            new Error(`Skill "${slug}" not found. Use list_skills to see available skills.`),
            { code: 'NOT_FOUND' }
          ));
        }
        return mcpResult(skill);
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  return tools;
}

module.exports = { CATEGORY, registerTools };
