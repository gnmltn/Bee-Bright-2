const AuditLog = require('../models/AuditLog');

/**
 * Get client IP from request
 */
function getClientIp(req) {
  if (!req) return null;
  return req.ip ||
    req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers?.['x-real-ip'] ||
    req.connection?.remoteAddress ||
    null;
}

/**
 * Get user agent from request
 */
function getUserAgent(req) {
  return req?.headers?.['user-agent'] || null;
}

/**
 * Log an audit entry. Does not throw - fails silently to avoid breaking app flow.
 * @param {Object} options
 * @param {Object} [options.req] - Express request (for IP, user agent, user)
 * @param {string} options.action - e.g. "Login", "Approve Enrollment"
 * @param {string} options.module - Authentication | User Management | Enrollment | Payment | Administrative | Academic | Security | Announcement
 * @param {string} [options.description] - Human-readable description
 * @param {string} [options.status] - SUCCESS | FAILED
 * @param {string} [options.userIdentifier] - Email/username when no userId (e.g. failed login)
 * @param {Object} [options.metadata] - Extra data (no passwords, no full card numbers)
 */
async function logAudit(options) {
  try {
    const {
      req,
      action,
      module,
      description = '',
      status = 'SUCCESS',
      userId,
      userIdentifier,
      metadata = null
    } = options;

    const entry = {
      action,
      module,
      description,
      status,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      metadata
    };

    if (userId) {
      entry.userId = userId;
    }
    if (userIdentifier) {
      entry.userIdentifier = userIdentifier;
    }
    if (req?.user?.id && !userId) {
      entry.userId = req.user.id;
    }

    await AuditLog.create(entry);
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

module.exports = {
  logAudit,
  getClientIp,
  getUserAgent
};
