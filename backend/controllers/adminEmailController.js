/**
 * Admin email composer — panel-required change: admin shouldn't have to open Gmail by
 * hand to reach a parent/tutor. Sends real email through the SAME SMTP transport + the
 * SAME branded template already used for OTP/verification codes (sendAdminComposedEmail,
 * emailService.js), one individually-addressed email per selected recipient — never one
 * email exposing every recipient's address to each other.
 */
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const { sendAdminComposedEmail } = require('../utils/emailService');
const { logAudit } = require('../utils/auditService');

// GET /api/admin/email/recipients?role=parent|tutor
// Real users matching the filter, INCLUDING an account whose enrollment is still
// rejected/unverified/not yet active — email is exactly how admin would reach them to
// say what's needed, so they must not be filtered out. Each parent carries their most
// relevant enrollment status (if any) so the frontend can show "Jake Soriano - rejected"
// at a glance; tutors have no enrollment-based status concept in this codebase, so they
// never carry one.
const getEmailRecipients = async (req, res) => {
  try {
    const role = String(req.query.role || '').trim();
    if (!['parent', 'tutor'].includes(role)) {
      return res.status(400).json({ success: false, message: 'role must be "parent" or "tutor".' });
    }

    const users = await User.find({ role, deletedAt: null })
      .select('firstName lastName middleName email isArchived')
      .sort({ firstName: 1, lastName: 1 })
      .lean();

    let statusByUserId = new Map();
    if (role === 'parent') {
      // Most-recently-updated enrollment per parent — the single most relevant status to
      // show next to their name. A parent can have several (renewals, multiple children);
      // this deliberately doesn't try to summarize all of them, same scope as the existing
      // Enrollments tab's own per-row status display.
      const enrollments = await Enrollment.find({ parent: { $in: users.map((u) => u._id) } })
        .select('parent status updatedAt')
        .sort({ updatedAt: -1 })
        .lean();
      for (const e of enrollments) {
        const key = String(e.parent);
        if (!statusByUserId.has(key)) statusByUserId.set(key, e.status);
      }
    }

    const recipients = users.map((u) => ({
      _id: String(u._id),
      name: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || 'Unnamed',
      email: u.email || null,
      status: statusByUserId.get(String(u._id)) || null,
      isArchived: Boolean(u.isArchived),
    }));

    return res.status(200).json({ success: true, recipients });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/email/send   Body: { userIds: string[], subject: string, message: string }
const sendAdminEmail = async (req, res) => {
  try {
    const { userIds, subject, message } = req.body || {};
    const ids = Array.isArray(userIds) ? [...new Set(userIds.map(String))].filter(Boolean) : [];
    const trimmedSubject = String(subject || '').trim();
    const trimmedMessage = String(message || '').trim();

    if (!ids.length) return res.status(400).json({ success: false, message: 'Select at least one recipient.' });
    if (!trimmedSubject) return res.status(400).json({ success: false, message: 'Subject is required.' });
    if (!trimmedMessage) return res.status(400).json({ success: false, message: 'Message is required.' });

    const recipients = await User.find({ _id: { $in: ids }, deletedAt: null })
      .select('firstName lastName email role')
      .lean();
    if (!recipients.length) {
      return res.status(404).json({ success: false, message: 'None of the selected recipients could be found.' });
    }

    const results = [];
    for (const recipient of recipients) {
      if (!recipient.email) {
        results.push({ userId: String(recipient._id), sent: false, reason: 'No email on file' });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const sent = await sendAdminComposedEmail(
        recipient.email,
        recipient.firstName || 'there',
        trimmedSubject,
        trimmedMessage,
      );
      results.push({ userId: String(recipient._id), sent, reason: sent ? null : 'Send failed' });
    }

    const sentCount = results.filter((r) => r.sent).length;

    logAudit({
      req,
      userId: req.user._id,
      action: 'Send Admin Email',
      module: 'Communication',
      description: `Sent "${trimmedSubject}" to ${sentCount} of ${ids.length} recipient(s)`,
      status: 'SUCCESS',
      metadata: { subject: trimmedSubject, recipientCount: ids.length, sentCount },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: `Email sent to ${sentCount} of ${ids.length} recipient(s).`,
      sentCount,
      results,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getEmailRecipients, sendAdminEmail };
