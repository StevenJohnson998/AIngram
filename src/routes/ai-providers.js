const { Router } = require('express');
const aiProviderService = require('../services/ai-provider');
const { authenticateRequired } = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');

const router = Router();

const VALID_PROVIDER_TYPES = aiProviderService.PROVIDER_TYPES;

/**
 * GET /ai/providers/types — list available provider types (public, for GUI dropdown)
 */
router.get('/types', (_req, res) => {
  const config = require('../config/ai-providers.json');
  const types = Object.entries(config.providers).map(([key, val]) => ({
    id: key, name: val.name, needsEndpoint: val.endpoint === null, models: val.models || [],
  }));
  return res.status(200).json({ types });
});

/**
 * POST /ai/providers — create a new AI provider config
 */
router.post('/', authenticateRequired, authenticatedLimiter, async (req, res) => {
  try {
    if (req.account.type !== 'human' || req.account.parentId) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Only root human accounts can manage AI providers' },
      });
    }

    const { name, providerType, apiEndpoint, model, apiKey, systemPrompt, maxTokens, temperature, isDefault } = req.body;

    if (!name || !providerType || !model) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Missing required fields: name, providerType, model' },
      });
    }

    if (!VALID_PROVIDER_TYPES.includes(providerType)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `providerType must be one of: ${VALID_PROVIDER_TYPES.join(', ')}` },
      });
    }

    if (!apiKey && providerType !== 'ollama') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'apiKey is required for non-Ollama providers' },
      });
    }

    const provider = await aiProviderService.createProvider({
      accountId: req.account.id,
      name,
      providerType,
      apiEndpoint,
      model,
      apiKey,
      systemPrompt,
      maxTokens,
      temperature,
      isDefault,
    });

    return res.status(201).json({ provider });
  } catch (err) {
    console.error('Create provider error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * GET /ai/providers — list my AI providers
 */
router.get('/', authenticateRequired, async (req, res) => {
  try {
    const providers = await aiProviderService.listProviders(req.account.id);
    return res.status(200).json({ providers });
  } catch (err) {
    console.error('List providers error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * PUT /ai/providers/:id — update a provider
 */
router.put('/:id', authenticateRequired, authenticatedLimiter, async (req, res) => {
  try {
    if (req.body.providerType && !VALID_PROVIDER_TYPES.includes(req.body.providerType)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `providerType must be one of: ${VALID_PROVIDER_TYPES.join(', ')}` },
      });
    }
    if (req.body.maxTokens !== undefined && (typeof req.body.maxTokens !== 'number' || req.body.maxTokens < 1 || req.body.maxTokens > 100000)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'maxTokens must be a number between 1 and 100000' },
      });
    }
    if (req.body.temperature !== undefined && (typeof req.body.temperature !== 'number' || req.body.temperature < 0 || req.body.temperature > 2)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'temperature must be a number between 0 and 2' },
      });
    }

    const updated = await aiProviderService.updateProvider(req.params.id, req.account.id, req.body);
    if (!updated) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Provider not found or no fields to update' },
      });
    }
    return res.status(200).json({ provider: updated });
  } catch (err) {
    console.error('Update provider error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * POST /ai/providers/:id/test — test provider connectivity
 */
router.post('/:id/test', authenticateRequired, authenticatedLimiter, async (req, res) => {
  try {
    const provider = await aiProviderService.getProviderById(req.params.id);
    if (!provider || provider.account_id !== req.account.id) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Provider not found' },
      });
    }

    const start = Date.now();
    try {
      const result = await aiProviderService.callProvider(provider, [
        { role: 'user', content: 'Reply with exactly: OK' },
      ], { maxTokens: 10, temperature: 0 });

      return res.status(200).json({
        ok: true,
        model: provider.model,
        responseTimeMs: Date.now() - start,
        reply: (result.content || '').substring(0, 50),
      });
    } catch (callErr) {
      return res.status(200).json({
        ok: false,
        model: provider.model,
        responseTimeMs: Date.now() - start,
        error: callErr.message.substring(0, 200),
      });
    }
  } catch (err) {
    console.error('Test provider error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

/**
 * DELETE /ai/providers/:id — delete a provider
 */
router.delete('/:id', authenticateRequired, authenticatedLimiter, async (req, res) => {
  try {
    const deleted = await aiProviderService.deleteProvider(req.params.id, req.account.id);
    if (!deleted) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Provider not found' },
      });
    }
    return res.status(204).send();
  } catch (err) {
    console.error('Delete provider error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

module.exports = router;
