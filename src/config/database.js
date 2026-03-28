const { Pool } = require('pg');
const { validateEnv } = require('./env');

let pool = null;
let poolOverrides = null;

/**
 * Configure pool overrides. Must be called BEFORE first getPool() call.
 * Used by the worker process to set different pool settings.
 */
function configurePool(overrides) {
  if (pool) {
    throw new Error('configurePool() must be called before first getPool() call');
  }
  poolOverrides = overrides;
}

function getPool() {
  if (pool) return pool;

  const env = validateEnv();

  pool = new Pool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    ...poolOverrides,
  });

  pool.on('error', (err) => {
    console.error('Unexpected pool error:', err.message);
  });

  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, closePool, configurePool };
