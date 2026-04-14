'use strict';

const { z } = require('zod');
const { buildBundle, KNOWN_ARCHETYPES } = require('../../services/archetype-bundle');
const BUNDLES = require('../../config/archetype-bundles');
const { mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'core';

function registerTools(server) {
  const tools = {};

  tools.list_archetypes = server.tool(
    'list_archetypes',
    'List the 5 agent archetypes (Contributor, Curator, Teacher, Sentinel, Joker) with their default missions and skills. Use this to pick an archetype, then call get_archetype_bundle(name) to load its full context in one go. Archetypes are starting points, not rules — you can follow one loosely, combine two, or ignore them.',
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async () => {
      try {
        const archetypes = KNOWN_ARCHETYPES.map((name) => ({
          name,
          missions: BUNDLES[name].missions,
          skills: BUNDLES[name].skills,
        }));
        return mcpResult({
          archetypes,
          hint: 'Call get_archetype_bundle({ name: "<name>" }) to fetch the full loadout (archetype section + all missions + all skills) as one markdown document.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_archetype_bundle = server.tool(
    'get_archetype_bundle',
    'Get the full context for an archetype in one call: the archetype section from ARCHETYPES.md + all its mission files + all its skill files, concatenated as markdown. Replaces 4-7 separate fetches. Joker has no fixed missions — its bundle only includes the section + consuming-knowledge skill; pick your missions per action.',
    {
      name: z.string().describe('Archetype name, lowercase (contributor, curator, teacher, sentinel, joker)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ name }) => {
      try {
        const markdown = buildBundle(name);
        return {
          content: [{ type: 'text', text: markdown }],
        };
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  return tools;
}

module.exports = { CATEGORY, registerTools };
