/**
 * Sanitize request body/query to reduce NoSQL injection risk.
 * Strips keys that start with $ or contain . (Mongo operators).
 * Apply to routes that use req.body in queries.
 */
function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) continue;
    const val = obj[key];
    out[key] = val && typeof val === 'object' && !(val instanceof Date)
      ? sanitizeObject(val)
      : val;
  }
  return out;
}

function noSqlInjectionGuard(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeObject(req.query);
  }
  next();
}

module.exports = { noSqlInjectionGuard, sanitizeObject };
