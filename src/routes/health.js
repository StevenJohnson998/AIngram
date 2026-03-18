const { Router } = require('express');
const { getPool } = require('../config/database');

const router = Router();

router.get('/', async (_req, res) => {
  const checks = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    database: { status: 'unknown' },
  };

  // Check database
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    checks.database = { status: 'ok' };
  } catch (err) {
    checks.database = { status: 'error', message: err.message };
    checks.status = 'degraded';
  }

  const httpStatus = checks.database.status === 'ok' ? 200 : 503;
  res.status(httpStatus).json(checks);
});

module.exports = router;
