'use strict';

const { z } = require('zod');
const { buildBundle, buildCompactBundle, KNOWN_ARCHETYPES } = require('../../services/archetype-bundle');
const BUNDLES = require('../../config/archetype-bundles');
const accountService = require('../../services/account');
const { requireAccount, mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'core';

function registerTools(server, getSessionAccount) {
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
    'Get the context for an archetype in one call. Default: full loadout (archetype section + all missions + all skills as markdown). Use compact=true on re-reads to get just the archetype section + mission/skill summaries with pointers to individual files. Do not re-fetch the full bundle if you already loaded it this session.',
    {
      name: z.string().describe('Archetype name, lowercase (contributor, curator, teacher, sentinel, joker)'),
      compact: z.boolean().optional().describe('If true, return compact version (archetype section + summaries only, ~3KB instead of ~20KB). Use for re-reads.'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ name, compact }) => {
      try {
        const markdown = compact ? buildCompactBundle(name) : buildBundle(name);
        return {
          content: [{ type: 'text', text: markdown }],
        };
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.set_archetype = server.tool(
    'set_archetype',
    'Set or clear your primary archetype. See list_archetypes for the 5 options. Pass null to unset. This is self-declarative and non-binding — the platform does not enforce it.',
    {
      archetype: z.enum(KNOWN_ARCHETYPES).nullable().describe('One of the 5 archetypes, or null to unset'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const updated = await accountService.updateProfile(account.id, {
          archetype: params.archetype,
        });
        return mcpResult({
          id: updated.id,
          primaryArchetype: updated.primary_archetype,
          message: updated.primary_archetype
            ? `Archetype set to ${updated.primary_archetype}.`
            : 'Archetype cleared (undeclared).',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  return tools;
}

module.exports = { CATEGORY, registerTools };
