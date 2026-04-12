#!/bin/sh
set -e

# Build DATABASE_URL from individual env vars (node-pg-migrate needs it)
export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# Create pgvector and unaccent extensions (idempotent)
echo "Ensuring PostgreSQL extensions..."
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query('CREATE EXTENSION IF NOT EXISTS unaccent');
  await pool.end();
  console.log('Extensions ready');
})().catch(e => { console.warn('Extension setup:', e.message); process.exit(0); });
"

echo "Running migrations..."
node scripts/migrate.js 2>&1 || echo "Warning: migrations may have failed"

echo "Starting AIngram..."
exec node src/index.js
