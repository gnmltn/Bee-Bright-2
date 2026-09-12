const Escalation = require('../models/Escalation');
const { logAudit } = require('../utils/auditService');

const STATUS_VALUES = ['open', 'acknowledged', 'resolved'];
// Filter alias for the default admin view: everything that still needs attention.
const UNRESOLVED_STATUSES = ['open', 'acknowledged'];

/**
 * GET /api/escalations  (admin / super_admin)
 * Filters: status ('unresolved' = open + acknowledged; or an exact status), source,
 * severity, category. Open + urgent float to the top.
 */
const listEscalations = async (req, res) => {
  try {
    const { status, source, severity, category, limit = 100 } = req.query;
    const filter = {};
    if (status === 'unresolved') filter.status = { $in: UNRESOLVED_STATUSES };
    else if (status) filter.status = status;
    if (source) filter.source = source;
    if (severity) filter.severity = severity;
    if (category) filter.category = category;

    const rows = await Escalation.find(filter)
      .populate('user', 'firstName lastName email role')
      .populate('handledBy', 'firstName lastName email')
      .sort({ status: 1, severity: 1, createdAt: -1 }) // 'acknowledged' < 'open' < 'resolved' alphabetically; re-sort below
      .limit(Math.min(Number(limit) || 100, 500))
      .lean();

    // Deterministic priority ordering: open first, then urgent before normal, newest first.
    const statusRank = { open: 0, acknowledged: 1, resolved: 2 };
    const severityRank = { urgent: 0, normal: 1 };
    rows.sort((a, b) => {
      const s = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
      if (s !== 0) return s;
      const v = (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
      if (v !== 0) return v;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.status(200).json({ success: true, count: rows.length, escalations: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load escalations.' });
  }
};

/**
 * GET /api/escalations/mine  (any authenticated user)
 * The caller's OWN handoff tickets only — read-only status visibility (Tasks 16/18).
 * Child-safety escalations are never returned here; those are admin-only.
 */
const listMyEscalations = async (req, res) => {
  try {
    const rows = await Escalation.find({ user: req.user._id, source: 'handoff' })
      .select('category trigger status severity createdAt updatedAt handledAt')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.status(200).json({ success: true, count: rows.length, escalations: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load your requests.' });
  }
};

/**
 * GET /api/escalations/stats  (admin / super_admin)
 * Open-item counts for a dashboard badge.
 */
const getEscalationStats = async (req, res) => {
  try {
    const [openUrgent, openTotal, unresolvedSafety] = await Promise.all([
      Escalation.countDocuments({ status: 'open', severity: 'urgent' }),
      Escalation.countDocuments({ status: { $in: ['open', 'acknowledged'] } }),
      Escalation.countDocuments({ status: { $in: ['open', 'acknowledged'] }, source: 'child_safety' }),
    ]);
    res.status(200).json({
      success: true,
      stats: { openUrgent, openOrAcknowledged: openTotal, unresolvedChildSafety: unresolvedSafety },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load escalation stats.' });
  }
};

/**
 * GET /api/escalations/:id  (admin / super_admin)
 */
const getEscalation = async (req, res) => {
  try {
    const row = await Escalation.findById(req.params.id)
      .populate('user', 'firstName lastName email role phone')
      .populate('handledBy', 'firstName lastName email')
      .lean();
    if (!row) return res.status(404).json({ success: false, message: 'Escalation not found.' });
    res.status(200).json({ success: true, escalation: row });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load escalation.' });
  }
};

/**
 * PATCH /api/escalations/:id  (admin / super_admin)
 * Body: { status?, resolutionNote? }
 */
const updateEscalation = async (req, res) => {
  try {
    const { status, resolutionNote } = req.body || {};
    const row = await Escalation.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Escalation not found.' });

    if (status !== undefined) {
      if (!STATUS_VALUES.includes(status)) {
        return res.status(400).json({ success: false, message: `status must be one of: ${STATUS_VALUES.join(', ')}` });
      }
      row.status = status;
      if (status === 'acknowledged' || status === 'resolved') {
        row.handledBy = req.user._id;
        row.handledAt = new Date();
      }
    }
    if (typeof resolutionNote === 'string') {
      row.resolutionNote = resolutionNote.slice(0, 2000);
    }

    await row.save();

    logAudit({
      req,
      action: 'Update Escalation',
      module: 'Security',
      status: 'SUCCESS',
      userId: req.user._id,
      description: `Escalation ${row._id} → ${row.status}`,
      metadata: { escalationId: String(row._id), status: row.status, source: row.source, category: row.category },
    }).catch(() => {});

    // Return the re-populated row so the client keeps the requester's name/email
    // (a bare save() strips the populated `user` back to an id).
    const fresh = await Escalation.findById(row._id)
      .populate('user', 'firstName lastName email role phone')
      .populate('handledBy', 'firstName lastName email')
      .lean();

    res.status(200).json({ success: true, escalation: fresh || row });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to update escalation.' });
  }
};

module.exports = {
  listEscalations,
  listMyEscalations,
  getEscalationStats,
  getEscalation,
  updateEscalation,
  STATUS_VALUES,
};
