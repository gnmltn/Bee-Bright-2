/**
 * Sidebar red count badges (NOT a bell). One endpoint returns the badge counts for the
 * caller's role; a second records that a section was opened.
 *
 * Two kinds of badge:
 *  - "action" badges are state: they stay until the underlying thing is dealt with
 *    (parent Payments = remaining 50% still owed, admin Payments = proofs awaiting
 *    verification, admin Enrollments / Remarks / Announcements = items awaiting review,
 *    tutor Attendance = sessions still unmarked).
 *  - "new" badges are events: the count of things created/published since the user
 *    last opened that section (User.navSeen[section]); opening the section clears it.
 *
 * Requests (admin) already has its own badge and is deliberately not handled here.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Schedule = require('../models/Schedule');
const Remark = require('../models/Remark');
const Announcement = require('../models/Announcement');
const Payment = require('../models/Payment');
const { listOutstandingBalances } = require('../utils/remainingBalance');

// Sections whose badge is "new since last seen" (cleared by opening the section).
const SEEN_SECTIONS = {
  parent: ['schedule', 'progress', 'announcements'],
  student: ['schedule', 'progress', 'announcements'],
  tutor: ['students', 'assessments', 'schedule', 'announcements'],
  admin: ['users'],
  super_admin: ['users'],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const ATTENDANCE_LOOKBACK_DAYS = 14;

const seenAt = (user, section) => {
  const v = user.navSeen?.get ? user.navSeen.get(section) : user.navSeen?.[section];
  return v ? new Date(v) : null;
};

// A schedule counts as "set or updated by admin" when it was created after `since`, or
// changed after `since` by something other than the tutor marking attendance (which
// touches updatedAt too but is not a schedule change).
async function countScheduleChanges(filter, since) {
  const rows = await Schedule.find({ ...filter, updatedAt: { $gt: since } })
    .select('createdAt updatedAt attendanceMarkedAt')
    .lean();
  return rows.filter((r) => {
    if (new Date(r.createdAt) > since) return true;
    const marked = r.attendanceMarkedAt ? new Date(r.attendanceMarkedAt).getTime() : 0;
    return !marked || new Date(r.updatedAt).getTime() - marked > 2000;
  }).length;
}

// A parent's badges are scoped to ONE child (the dashboard's selected child, identified by
// the permanent Student ID; an enrollment _id is accepted for legacy records). Nothing from
// another child may leak into the counts.
const safeChildKey = (raw) => (/^[\w-]{1,64}$/.test(String(raw || '')) ? String(raw) : '');

function childEnrollmentFilter(user, childKey) {
  const filter = { parent: user._id, status: { $nin: ['cancelled', 'rejected', 'draft'] } };
  if (childKey) {
    filter.$or = [{ permanentStudentId: childKey }];
    if (mongoose.Types.ObjectId.isValid(childKey)) filter.$or.push({ _id: childKey });
  }
  return filter;
}

async function childStudentIds(user, childKey) {
  if (user.role === 'student') return [user._id];
  return Enrollment.distinct('student', { ...childEnrollmentFilter(user, childKey), student: { $ne: null } });
}

async function parentBadges(user, since, childKey) {
  const ids = await childStudentIds(user, childKey);
  const forChildren = { $or: [{ student: { $in: ids } }, { students: { $in: ids } }] };
  const [schedule, progress, announcements, owed] = await Promise.all([
    ids.length ? countScheduleChanges(forChildren, since.schedule) : 0,
    ids.length
      ? Remark.countDocuments({ student: { $in: ids }, status: 'published', isCurrentVersion: true, publishedAt: { $gt: since.progress } })
      : 0,
    Announcement.countDocuments({
      status: 'approved',
      approvedAt: { $gt: since.announcements },
      $or: [{ targetType: 'all' }, ...(ids.length ? [{ targetStudentIds: { $in: ids } }] : [])],
    }),
    user.role === 'parent' ? listOutstandingBalances({ parentId: user._id, childKey }) : [],
  ]);
  return { schedule, progress, announcements, payments: owed.length };
}

async function tutorBadges(user, since) {
  const mine = { $or: [{ tutor: user._id }, { tutors: user._id }] };

  const [scheduleChanges, newlyCreated, earlier, assigned, unmarked, announcements] = await Promise.all([
    countScheduleChanges(mine, since.schedule),
    Schedule.find({ ...mine, createdAt: { $gt: since.students } }).select('student students').lean(),
    Schedule.find({ ...mine, createdAt: { $lte: since.students } }).select('student students').lean(),
    Schedule.find(mine).select('student students').lean(),
    Schedule.countDocuments({
      ...mine,
      attendanceStatus: 'unmarked',
      date: { $gte: new Date(Date.now() - ATTENDANCE_LOOKBACK_DAYS * DAY_MS), $lte: new Date() },
    }),
    Announcement.countDocuments({
      $or: [
        { authorRole: 'tutor', author: user._id, $or: [{ approvedAt: { $gt: since.announcements } }, { rejectedAt: { $gt: since.announcements } }] },
        { authorRole: 'admin', targetType: 'all', status: 'approved', approvedAt: { $gt: since.announcements } },
      ],
    }),
  ]);

  const idsOf = (rows) => rows.flatMap((s) => [s.student, ...(s.students || [])]).filter(Boolean).map(String);
  const known = new Set(idsOf(earlier));
  const newStudents = new Set(idsOf(newlyCreated).filter((id) => !known.has(id)));

  const studentIds = [...new Set(idsOf(assigned))];
  const assessments = studentIds.length
    ? await Enrollment.countDocuments({
        student: { $in: studentIds },
        // Skipped ("not applicable") assessments are stamped completed too — only real ones count.
        'preEnrollmentAssessment.applicable': true,
        'preEnrollmentAssessment.completedAt': { $gt: since.assessments },
      })
    : 0;

  return { students: newStudents.size, assessments, schedule: scheduleChanges, attendance: unmarked, announcements };
}

async function adminBadges(user, since) {
  const [users, paymentReview, pendingApproval, payments, remarks, announcements] = await Promise.all([
    User.countDocuments({
      role: { $in: ['parent', 'tutor'] },
      deletedAt: null,
      enrollmentDraft: { $ne: true },
      createdAt: { $gt: since.users },
    }),
    // The Enrollments sidebar badge is the sum; the two tabs inside the Enrollments
    // section each show their own count (paymentReview / pendingApproval).
    Enrollment.countDocuments({ status: 'payment_under_verification' }),
    Enrollment.countDocuments({ status: 'pending_approval' }),
    Payment.countDocuments({ status: 'submitted' }),
    Remark.countDocuments({ status: 'pending_admin_review' }),
    Announcement.countDocuments({ status: 'pending' }),
  ]);
  return { users, enrollments: paymentReview + pendingApproval, paymentReview, pendingApproval, payments, remarks, announcements };
}

// @route   GET /api/notifications/badges
// @access  Private
const getBadges = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('role navSeen');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const role = user.role;
    const sections = SEEN_SECTIONS[role];
    if (!sections) return res.status(200).json({ success: true, badges: {} });

    // "New" badges count things after the last time THIS child's section was opened
    // (`section@childKey`), falling back to the older per-section value; the first time a
    // section is ever counted it is baselined to "now" so old items don't all light up.
    const childKey = user.role === 'parent' ? safeChildKey(req.query?.childKey) : '';
    const now = new Date();
    const baseline = {};
    const since = {};
    for (const s of sections) {
      const scoped = childKey ? `${s}@${childKey}` : s;
      const seen = seenAt(user, scoped) || seenAt(user, s);
      if (seen) since[s] = seen;
      else { since[s] = now; baseline[`navSeen.${scoped}`] = now; }
    }
    if (Object.keys(baseline).length) {
      await User.updateOne({ _id: user._id }, { $set: baseline });
    }
    let badges;
    if (role === 'parent' || role === 'student') badges = await parentBadges(user, since, childKey);
    else if (role === 'tutor') badges = await tutorBadges(user, since);
    else badges = await adminBadges(user, since);

    res.status(200).json({ success: true, badges });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load notification badges' });
  }
};

// @desc    Record that the user opened a badge-carrying section (clears its "new" count)
// @route   POST /api/notifications/seen   body: { section }
// @access  Private
const markSectionSeen = async (req, res) => {
  try {
    const section = String(req.body?.section || '');
    const allowed = SEEN_SECTIONS[req.user.role] || [];
    if (!allowed.includes(section)) {
      return res.status(400).json({ success: false, message: 'This section has no "new" badge to clear.' });
    }
    const childKey = req.user.role === 'parent' ? safeChildKey(req.body?.childKey) : '';
    const key = childKey ? `${section}@${childKey}` : section;
    await User.updateOne({ _id: req.user._id }, { $set: { [`navSeen.${key}`]: new Date() } });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to update badge state' });
  }
};

module.exports = { getBadges, markSectionSeen, SEEN_SECTIONS };
