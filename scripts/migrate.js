#!/usr/bin/env node
// Wrapper around node-pg-migrate's programmatic runner that filters the
// noisy "Can't determine timestamp for NNN" message. Our migrations use
// sequential numeric prefixes (001_, 002_, ...) on purpose; node-pg-migrate
// only recognizes 13-digit Unix epoch or 17-digit YYYYMMDDHHMMSSMMM prefixes
// and emits logger.error for any other shape, even though numeric ordering
// still works correctly. Renaming 50+ already-applied migrations would be
// far riskier than swallowing the warning.
//
// Used by docker-entrypoint.sh in place of `npx node-pg-migrate up ...`.

const path = require('node:path');
const { runner } = require('node-pg-migrate');

const TIMESTAMP_NOISE = /^Can't determine timestamp for /;

const filteredLogger = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: (msg, ...rest) => {
    if (typeof msg === 'string' && TIMESTAMP_NOISE.test(msg)) return;
    console.error(msg, ...rest);
  },
};

(async () => {
  await runner({
    databaseUrl: process.env.DATABASE_URL,
    dir: path.resolve(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    logger: filteredLogger,
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
