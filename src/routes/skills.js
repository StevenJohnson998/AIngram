'use strict';

const { Router } = require('express');
const skillsService = require('../services/skills');
const { TOOL_DESCRIPTIONS } = require('../mcp/tool-descriptions');

const router = Router();

/**
 * GET /v1/skills
 * List all skills. Optional filters: ?tool=contribute_chunk&include_tools=true
 */
router.get('/', (req, res) => {
  const { tool, include_tools } = req.query;
  const skills = skillsService.listSkills(tool || undefined);

  if (include_tools === 'true') {
    const enriched = skills.map(s => ({
      ...s,
      related_tools: s.related_tools.map(name => ({
        name,
        description: TOOL_DESCRIPTIONS[name] || null,
      })),
    }));
    return res.json({ data: enriched });
  }

  res.json({
    data: skills,
    hint: 'Add ?include_tools=true to enrich related_tools with { name, description } objects. Filter by tool with ?tool=<tool_name>.',
  });
});

/**
 * GET /v1/skills/:slug
 * Get a single skill by slug with full content.
 * Skips .txt requests so express.static can serve the raw files.
 */
router.get('/:slug', (req, res, next) => {
  if (req.params.slug.endsWith('.txt')) return next();
  const skill = skillsService.getSkill(req.params.slug);
  if (!skill) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: `Skill "${req.params.slug}" not found` },
    });
  }
  res.json({ data: skill });
});

module.exports = router;
