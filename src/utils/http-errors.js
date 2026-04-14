/**
 * Shared HTTP error response helpers for route handlers.
 */

/**
 * Returns a 400 VALIDATION_ERROR response.
 *
 * @param {object} res   - Express response object
 * @param {string} message - Human-readable error description
 * @param {object} [opts] - Optional pedagogical fields
 * @param {string} [opts.field]            - Which field failed
 * @param {string} [opts.hint]             - One-sentence correction hint for agents
 * @param {object} [opts.example_valid_call] - Full {method, url, body} example
 */
function validationError(res, message, opts) {
  const error = { code: 'VALIDATION_ERROR', message };
  if (opts) {
    if (opts.field !== undefined) error.field = opts.field;
    if (opts.hint !== undefined) error.hint = opts.hint;
    if (opts.example_valid_call !== undefined) error.example_valid_call = opts.example_valid_call;
  }
  return res.status(400).json({ error });
}

function notFoundError(res, message) {
  return res.status(404).json({
    error: { code: 'NOT_FOUND', message },
  });
}

function forbiddenError(res, message) {
  return res.status(403).json({
    error: { code: 'FORBIDDEN', message },
  });
}

module.exports = { validationError, notFoundError, forbiddenError };
