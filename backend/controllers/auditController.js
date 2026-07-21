const AuditLog = require('../models/AuditLog');
const User = require('../models/User');

const HIDDEN_AUDIT_ACTIONS = ['Payment Initiated', 'Enrollment Checkout Started', 'Student Enrollment'];
const HIDDEN_AUDIT_ACTION_PATTERNS = [/^login$/i, /^admin login(?: mfa)?$/i, /^logout$/i];

const isHiddenAuditAction = (action = '') => {
  const normalized = String(action || '').trim().toLowerCase();
  if (HIDDEN_AUDIT_ACTIONS.some((item) => item.toLowerCase() === normalized)) {
    return true;
  }
  return HIDDEN_AUDIT_ACTION_PATTERNS.some((pattern) => pattern.test(normalized));
};

/**
 * Get all audit logs (admin only). Supports filters.
 */
const getForAdmin = async (req, res) => {
  try {
    const { module, status, userId, startDate, endDate, limit = 100 } = req.query;
    const filter = {};

    if (module) filter.module = module;
    if (status) filter.status = status;
    if (userId) filter.userId = userId;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const logs = await AuditLog.find(filter)
      .populate('userId', 'firstName lastName email role')
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 100, 500))
      .lean();

    const visibleLogs = logs.filter((l) => !isHiddenAuditAction(l.action));

    const formatted = visibleLogs.map((l) => ({
      _id: l._id,
      userId: l.userId?._id,
      userIdentifier: l.userIdentifier,
      userName: l.userId
        ? [l.userId.firstName, l.userId.lastName].filter(Boolean).join(' ')
        : l.userIdentifier || '—',
      userEmail: l.userId?.email || l.userIdentifier || null,
      userRole: l.userId?.role || null,
      action: l.action,
      module: l.module,
      description: l.description,
      ipAddress: l.ipAddress,
      userAgent: l.userAgent,
      status: l.status,
      metadata: l.metadata,
      createdAt: l.createdAt
    }));

    res.status(200).json({ success: true, logs: formatted });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load audit logs' });
  }
};

/**
 * Get current user's own activity logs.
 */
const getMyActivity = async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const logs = await AuditLog.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 200))
      .select('action module description status ipAddress createdAt')
      .lean();

    const visibleLogs = logs.filter((log) => !isHiddenAuditAction(log.action));

    res.status(200).json({ success: true, logs: visibleLogs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load activity' });
  }
};

module.exports = {
  getForAdmin,
  getMyActivity,
  isHiddenAuditAction
};
