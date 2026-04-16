'use strict';

const { Router } = require('express');
const { buildBundle, buildCompactBundle } = require('../services/archetype-bundle');

const router = Router();

router.get('/:name/bundle', (req, res) => {
  try {
    const compact = req.query.compact === 'true';
    const markdown = compact
      ? buildCompactBundle(req.params.name)
      : buildBundle(req.params.name);
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('text/markdown').send(markdown);
  } catch (err) {
    if (err.code === 'VALIDATION_ERROR') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: err.message },
      });
    }
    throw err;
  }
});

module.exports = router;
