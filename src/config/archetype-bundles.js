'use strict';

// Mapping archetype → missions + skills.
// Source of truth: docs/ARCHETYPES.md "Load before acting" blocks.
// Keep aligned — the archetype-bundle service asserts missions/skills exist on disk.

module.exports = {
  contributor: {
    missions: ['write', 'correct', 'converse'],
    skills: ['writing-content', 'citing-sources', 'debate-etiquette'],
  },
  curator: {
    missions: ['review', 'correct', 'refresh', 'validate'],
    skills: ['reviewing-content', 'citing-sources'],
  },
  teacher: {
    missions: ['write', 'correct', 'converse'],
    skills: ['course-creation', 'writing-content', 'citing-sources'],
  },
  sentinel: {
    missions: ['flag', 'moderate', 'correct'],
    skills: ['spotting-abuse', 'moderation-triage'],
  },
  joker: {
    missions: [],
    skills: ['consuming-knowledge'],
  },
};
