'use strict';

const fs = require('fs');
const path = require('path');
const BUNDLES = require('../config/archetype-bundles');

const ARCHETYPES_MD = path.join(__dirname, '..', '..', 'docs', 'ARCHETYPES.md');
const MISSIONS_DIR = path.join(__dirname, '..', 'gui');
const SKILLS_DIR = path.join(__dirname, '..', 'gui', 'skills');

const DISPLAY_NAME = {
  contributor: 'Contributor',
  curator: 'Curator',
  teacher: 'Teacher',
  sentinel: 'Sentinel',
  joker: 'Joker',
};

function validationError(message) {
  return Object.assign(new Error(message), { code: 'VALIDATION_ERROR' });
}

function extractSection(markdown, displayName) {
  const startRe = new RegExp(`^## The ${displayName}\\s*$`, 'm');
  const start = markdown.search(startRe);
  if (start === -1) {
    throw new Error(`Section "## The ${displayName}" not found in ARCHETYPES.md`);
  }
  const rest = markdown.slice(start);
  const nextRe = /\n## (The |Machine-readable)/;
  const nextMatch = rest.slice(1).search(nextRe);
  const end = nextMatch === -1 ? rest.length : nextMatch + 1;
  return rest.slice(0, end).replace(/\n+---\s*\n*$/, '').trimEnd();
}

function readMission(slug) {
  const file = path.join(MISSIONS_DIR, `llms-${slug}.txt`);
  return fs.readFileSync(file, 'utf8').trimEnd();
}

function readSkill(slug) {
  const file = path.join(SKILLS_DIR, `${slug}.txt`);
  return fs.readFileSync(file, 'utf8').trimEnd();
}

// One-line purpose for each mission/skill (used in compact mode).
const MISSION_SUMMARY = {
  write: 'Write articles and chunks with sourced, factual content.',
  correct: 'Fix errors, improve clarity, add missing sources.',
  converse: 'Participate in discussions constructively.',
  review: 'Review content for accuracy, vote, flag issues.',
  refresh: 'Verify chunks against current knowledge, update stale content.',
  validate: 'Validate pending contributions for publication.',
  flag: 'Report harmful, inaccurate, or policy-violating content.',
  moderate: 'Triage flagged content and recommend actions.',
};

const SKILL_SUMMARY = {
  'writing-content': 'Structure and style for knowledge-base articles.',
  'citing-sources': 'How to find, format, and attach sources.',
  'debate-etiquette': 'Rules and norms for constructive discussions.',
  'reviewing-content': 'Evaluation criteria and review workflow.',
  'course-creation': 'How to create and structure courses.',
  'spotting-abuse': 'Patterns for detecting bad actors and harmful content.',
  'moderation-triage': 'Prioritization and escalation for flagged content.',
  'consuming-knowledge': 'How to navigate and use the knowledge base.',
};

function validateArchetype(rawName) {
  if (typeof rawName !== 'string' || !rawName) {
    throw validationError('archetype name is required');
  }
  const name = rawName.toLowerCase();
  if (!/^[a-z]+$/.test(rawName)) {
    throw validationError(`archetype name must be lowercase ascii (got "${rawName}")`);
  }
  const loadout = BUNDLES[name];
  if (!loadout) {
    const known = Object.keys(BUNDLES).join(', ');
    throw validationError(`unknown archetype "${name}" (known: ${known})`);
  }
  return { name, loadout };
}

function buildBundle(rawName) {
  const { name, loadout } = validateArchetype(rawName);

  const markdown = fs.readFileSync(ARCHETYPES_MD, 'utf8');
  const section = extractSection(markdown, DISPLAY_NAME[name]);

  const parts = [
    `# ${DISPLAY_NAME[name]}`,
    '',
    '> This bundle is complete and static. Do not re-fetch it during this session.',
    '> If you need to re-read a specific mission, use `GET /llms-{slug}.txt` directly.',
    '',
    section,
    '', '---', '', '# Missions',
  ];
  if (loadout.missions.length === 0) {
    parts.push('', '_(no fixed missions — pick per action; see other archetypes for mapping)_');
  } else {
    for (const slug of loadout.missions) {
      parts.push('', `## Mission: ${slug}`, '', readMission(slug));
    }
  }
  parts.push('', '---', '', '# Skills');
  for (const slug of loadout.skills) {
    parts.push('', `## Skill: ${slug}`, '', readSkill(slug));
  }
  return parts.join('\n') + '\n';
}

function buildCompactBundle(rawName) {
  const { name, loadout } = validateArchetype(rawName);

  const markdown = fs.readFileSync(ARCHETYPES_MD, 'utf8');
  const section = extractSection(markdown, DISPLAY_NAME[name]);

  const parts = [
    `# ${DISPLAY_NAME[name]} (compact)`,
    '',
    '> Compact view. For full mission/skill details, use `GET /v1/archetypes/' + name + '/bundle` or individual files below.',
    '',
    section,
    '', '---', '', '## Missions',
  ];
  if (loadout.missions.length === 0) {
    parts.push('', '_(no fixed missions)_');
  } else {
    for (const slug of loadout.missions) {
      const summary = MISSION_SUMMARY[slug] || '';
      parts.push(`- **${slug}**: ${summary} Details: \`GET /llms-${slug}.txt\``);
    }
  }
  parts.push('', '## Skills');
  for (const slug of loadout.skills) {
    const summary = SKILL_SUMMARY[slug] || '';
    parts.push(`- **${slug}**: ${summary} Details: \`GET /skills/${slug}.txt\``);
  }
  return parts.join('\n') + '\n';
}

module.exports = {
  buildBundle,
  buildCompactBundle,
  KNOWN_ARCHETYPES: Object.keys(BUNDLES),
};
