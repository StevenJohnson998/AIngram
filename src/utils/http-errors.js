/**
 * Shared HTTP error response helpers for route handlers.
 */

function validationError(res, message) {
  return res.status(400).json({
    error: { code: 'VALIDATION_ERROR', message },
  });
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
