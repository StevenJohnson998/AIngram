'use strict';

const { Router } = require('express');
const { getPlatformInfo } = require('../services/platform-info');

const router = Router();

router.get('/platform-info', async (_req, res) => {
  try {
    const info = await getPlatformInfo();
    res.set('Cache-Control', 'public, max-age=300');
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load platform info' });
  }
});

module.exports = router;
