'use strict';

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '..', 'gui', 'skills');

/**
 * Parse a skill .txt file into structured data.
 *
 * Format: lines before the first blank line are headers (Key: value).
 * Everything after is the content body.
 * The H1 title (# ...) on the first line becomes the title.
 */
function parseSkillFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');

  let title = '';
  const headers = {};
  let headerEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // First line: H1 title
    if (i === 0 && line.startsWith('# ')) {
      title = line.slice(2).trim();
      continue;
    }

    // Blank line ends header section
    if (line.trim() === '') {
      // Skip consecutive blanks right after the title
      if (Object.keys(headers).length === 0 && i <= 2) continue;
      headerEnd = i + 1;
      break;
    }

    // Header line: Key: value
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase().replace(/-/g, '_');
      const value = line.slice(colonIdx + 1).trim();
      headers[key] = value;
    }
  }

  const content = lines.slice(headerEnd).join('\n').trim();
  const slug = headers.slug || path.basename(filePath, '.txt');
  const relatedTools = headers.related_tools
    ? headers.related_tools.split(',').map(t => t.trim()).filter(Boolean)
    : [];
  const relatedRefs = headers.related_refs
    ? headers.related_refs.split(',').map(r => r.trim()).filter(Boolean)
    : [];
  const category = headers.category || null;

  return { slug, title, relatedTools, relatedRefs, category, content, filePath };
}

// In-memory indexes, built once at require time
let skillsBySlug = null;
let toolToSkills = null;

function ensureLoaded() {
  if (skillsBySlug) return;

  skillsBySlug = new Map();
  toolToSkills = new Map();

  if (!fs.existsSync(SKILLS_DIR)) return;

  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.txt'));
  for (const file of files) {
    const skill = parseSkillFile(path.join(SKILLS_DIR, file));
    skillsBySlug.set(skill.slug, skill);

    for (const tool of skill.relatedTools) {
      if (!toolToSkills.has(tool)) toolToSkills.set(tool, []);
      toolToSkills.get(tool).push(skill.slug);
    }
  }
}

/**
 * List all skills, optionally filtered by related tool name.
 * Returns array of { slug, title, relatedTools, category } (no content).
 */
function listSkills(toolFilter) {
  ensureLoaded();
  let skills = Array.from(skillsBySlug.values());

  if (toolFilter) {
    const slugs = toolToSkills.get(toolFilter) || [];
    skills = skills.filter(s => slugs.includes(s.slug));
  }

  return skills.map(s => ({
    slug: s.slug,
    title: s.title,
    related_tools: s.relatedTools,
    category: s.category,
  }));
}

/**
 * Get a single skill by slug, including full content.
 * Returns null if not found.
 */
function getSkill(slug) {
  ensureLoaded();
  const skill = skillsBySlug.get(slug);
  if (!skill) return null;

  return {
    slug: skill.slug,
    title: skill.title,
    related_tools: skill.relatedTools,
    related_refs: skill.relatedRefs,
    category: skill.category,
    content: skill.content,
  };
}

/**
 * Get skill slugs related to a given tool name.
 */
function getSkillsForTool(toolName) {
  ensureLoaded();
  return toolToSkills.get(toolName) || [];
}

/**
 * Reset loaded state (for testing).
 */
function _reset() {
  skillsBySlug = null;
  toolToSkills = null;
}

module.exports = { listSkills, getSkill, getSkillsForTool, parseSkillFile, _reset };
