const mongoose = require('mongoose');
const Announcement = require('../models/Announcement');
const User = require('../models/User');
const Schedule = require('../models/Schedule');
const Enrollment = require('../models/Enrollment');
const { sendAnnouncementEmail } = require('../utils/emailService');
const { logAudit } = require('../utils/auditService');
const { parentOwnsStudent } = require('../utils/parentChildAccess');
const { emitToParents, emitToTutors } = require('../utils/realtime');

// A student User's own `.email` is always the internal placeholder
// "child.<enrollmentId>@students.beebright.internal" (see scheduleController.js's
// resolveOrCreateStudentUser) — never a real, deliverable address. Every announcement
// email must go to the actual PARENT's registered email instead ("bug (13).pdf" Group AS —
// every announcement notification was silently bouncing off that placeholder domain).
// Group-aware (a Playgroup tutor's roster includes both `tutor`/`student` and the
// `tutors[]`/`students[]` array fields) — same shape as aiController.js's getTutorStudents.
async function getTutorRosterStudentIds(tutorId) {
  const schedules = await Schedule.find({ $or: [{ tutor: tutorId }, { tutors: tutorId }] })
    .select('student students')
    .lean();
  const ids = new Set();
  for (const s of schedules) {
    if (s.student) ids.add(String(s.student));
    for (const sid of s.students || []) ids.add(String(sid));
  }
  return ids;
}

/** One real parent email per targeted student, deduped (a parent with 2 targeted children in
 * the same announcement only gets one email), never the students' own placeholder emails.
 * Also pushes the same targeted parents a live 'announcement:new' event (realtime pilot
 * expansion, "bug (17).pdf") — same recipient resolution as the email, so the two can never
 * disagree about who this announcement is actually for. */
async function notifyParentsOfStudents(studentIds, { announcementId, title, body, category }) {
  if (!studentIds || studentIds.length === 0) return;
  const enrollments = await Enrollment.find({
    student: { $in: studentIds },
    status: { $nin: ['cancelled', 'rejected', 'draft'] },
  })
    .select('student parent')
    .populate('parent', 'firstName lastName email')
    .lean();
  const parentByEmail = new Map();
  for (const e of enrollments) {
    if (e.parent?.email && !parentByEmail.has(e.parent.email)) parentByEmail.set(e.parent.email, e.parent);
  }
  for (const p of parentByEmail.values()) {
    const name = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Parent';
    sendAnnouncementEmail(p.email, name, title, body, category).catch(() => {});
  }
  emitToParents([...parentByEmail.values()].map((p) => p._id), 'announcement:new', { announcementId, title, category });
}

const TUTOR_CATEGORIES = ['sick_leave', 'exam', 'quiz', 'materials', 'reschedule', 'reminder', 'general'];
const ADMIN_CATEGORIES = ['suspension', 'maintenance', 'holiday', 'general'];
const ALL_CATEGORIES = [...new Set([...TUTOR_CATEGORIES, ...ADMIN_CATEGORIES])];

function parseScheduledDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0));
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// A forward-looking announcement can't happen in the past. The shared Create/Edit
// Announcement date field (Tutor + Admin) already blocks it client-side via the input's
// `min`; this stops a hand-crafted request the same way enrollmentController.js's own
// past-date guard does. One day of grace so a client in a different time zone than the
// server isn't wrongly rejected.
function isScheduledDateInPast(scheduledDateVal) {
  if (!scheduledDateVal) return false;
  const graceStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  graceStart.setHours(0, 0, 0, 0);
  return scheduledDateVal < graceStart;
}

function resetTutorAnnouncementApproval(announcement) {
  announcement.status = 'pending';
  announcement.approvedBy = null;
  announcement.approvedAt = null;
  announcement.rejectedAt = null;
  announcement.rejectionReason = null;
}

function canManageAnnouncement(user, announcement) {
  if (user.role === 'admin' || user.role === 'super_admin') return true;
  return user.role === 'tutor' && announcement.authorRole === 'tutor' && String(announcement.author) === String(user.id);
}

// @desc    Create announcement (tutor: pending + target students; admin: approved + all)
// @route   POST /api/announcements
// @access  Private (tutor or admin)
const createAnnouncement = async (req, res) => {
  try {
    const { title, body, category, targetType, targetStudentIds, scheduledDate } = req.body;
    if (!title || !body || typeof title !== 'string' || typeof body !== 'string') {
      return res.status(400).json({ success: false, message: 'Title and body are required' });
    }
    const cat = (req.user.role === 'admin' || req.user.role === 'super_admin')
      ? (ADMIN_CATEGORIES.includes(category) ? category : 'general')
      : (TUTOR_CATEGORIES.includes(category) ? category : 'general');

    const scheduledDateVal = parseScheduledDate(scheduledDate);
    if (scheduledDate && !scheduledDateVal) {
      return res.status(400).json({ success: false, message: 'Invalid scheduled date' });
    }
    if (isScheduledDateInPast(scheduledDateVal)) {
      return res.status(400).json({ success: false, message: 'The announcement date cannot be in the past.' });
    }

    if (req.user.role === 'admin' || req.user.role === 'super_admin') {
      const doc = await Announcement.create({
        title: title.trim(),
        body: body.trim(),
        category: cat,
        scheduledDate: scheduledDateVal,
        authorRole: 'admin',
        author: req.user.id,
        status: 'approved',
        targetType: 'all',
        targetStudentIds: [],
        approvedBy: req.user.id,
        approvedAt: new Date()
      });
      const populated = await Announcement.findById(doc._id).populate('author', 'firstName lastName email');
      // Admin announcement = broadcast-wide: EVERY parent and EVERY tutor, notified at
      // their own real registered email (never a student account's placeholder address).
      const [parents, tutors] = await Promise.all([
        User.find({ role: 'parent', isActive: true, isArchived: { $ne: true } }).select('email firstName lastName').lean(),
        User.find({ role: 'tutor', isActive: true, isArchived: { $ne: true } }).select('email firstName lastName').lean(),
      ]);
      for (const recipient of [...parents, ...tutors]) {
        if (recipient.email) {
          const name = [recipient.firstName, recipient.lastName].filter(Boolean).join(' ') || 'there';
          sendAnnouncementEmail(recipient.email, name, doc.title, doc.body, doc.category).catch(() => {});
        }
      }
      emitToParents(parents.map((p) => p._id), 'announcement:new', { announcementId: String(doc._id), title: doc.title, category: doc.category });
      emitToTutors(tutors.map((t) => t._id), 'announcement:new', { announcementId: String(doc._id), title: doc.title, category: doc.category });
      logAudit({
        req,
        userId: req.user.id,
        action: 'Post Announcement',
        module: 'Announcement',
        description: 'Admin posted center-wide announcement',
        status: 'SUCCESS',
        metadata: { announcementId: doc._id, category: doc.category }
      }).catch(() => {});
      return res.status(201).json({ success: true, announcement: populated });
    }

    if (req.user.role === 'tutor') {
      if (targetType !== 'specific_students' || !Array.isArray(targetStudentIds) || targetStudentIds.length === 0) {
        return res.status(400).json({ success: false, message: 'Select at least one student to notify' });
      }
      // Never trust the picker alone — the frontend already scopes it to getMyStudents,
      // but a tutor-authored announcement must never be able to target (and eventually
      // email the parent of) a student this tutor doesn't actually handle.
      const roster = await getTutorRosterStudentIds(req.user.id);
      const notHandled = targetStudentIds.filter((id) => !roster.has(String(id)));
      if (notHandled.length > 0) {
        return res.status(403).json({ success: false, message: 'You can only target students you currently handle.' });
      }
      const doc = await Announcement.create({
        title: title.trim(),
        body: body.trim(),
        category: cat,
        scheduledDate: scheduledDateVal,
        authorRole: 'tutor',
        author: req.user.id,
        status: 'pending',
        targetType: 'specific_students',
        targetStudentIds
      });
      const populated = await Announcement.findById(doc._id)
        .populate('author', 'firstName lastName email')
        .populate('targetStudentIds', 'firstName lastName email');
      logAudit({
        req,
        userId: req.user.id,
        action: 'Post Announcement',
        module: 'Announcement',
        description: 'Tutor posted announcement for students (pending approval)',
        status: 'SUCCESS',
        metadata: { announcementId: doc._id, category: doc.category, targetCount: targetStudentIds?.length || 0 }
      }).catch(() => {});
      return res.status(201).json({ success: true, announcement: populated });
    }

    return res.status(403).json({ success: false, message: 'Not authorized' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to create announcement' });
  }
};

// @desc    Get announcements for current student (approved, targeting them or all)
// @route   GET /api/announcements/student
// @access  Private (student)
const getForStudent = async (req, res) => {
  try {
    // A parent account's own id never matches Announcement.targetStudentIds (those
    // are keyed by the CHILD's own studentUserId) — a parent must pass ?studentId=
    // for the currently-selected child so student-specific announcements resolve
    // correctly (ChildSelector_AddChildModal_TutorRemarksView.pdf A). No studentId
    // yet (e.g. that child has no linked User until their first class) still shows
    // targetType:'all' announcements, same "nothing else yet" pattern used elsewhere.
    let studentObjId = null;
    if (req.user.role === 'parent') {
      const queryStudentId = String(req.query.studentId || '');
      if (queryStudentId) {
        if (!mongoose.Types.ObjectId.isValid(queryStudentId) || !(await parentOwnsStudent(req.user._id, queryStudentId))) {
          return res.status(403).json({ success: false, message: 'Select one of your own children.' });
        }
        studentObjId = new mongoose.Types.ObjectId(queryStudentId);
      }
    } else {
      studentObjId = mongoose.Types.ObjectId.isValid(req.user.id) ? new mongoose.Types.ObjectId(req.user.id) : null;
      if (!studentObjId) {
        return res.status(400).json({ success: false, message: 'Invalid student id' });
      }
    }
    const orConditions = [{ targetType: 'all' }];
    if (studentObjId) orConditions.push({ targetStudentIds: studentObjId });
    // A new account has no connection to anything posted before it existed — never return
    // (not just "don't flag as new") an announcement approved before THIS account's own
    // createdAt. Applied here at the query level, not filtered client-side, so there is no
    // view/tab/direct-link that can still reach it. See "bug (6).pdf".
    const list = await Announcement.find({
      status: 'approved',
      approvedAt: { $gte: req.user.createdAt },
      $or: orConditions
    })
      .sort({ approvedAt: -1, createdAt: -1 })
      .populate('author', 'firstName lastName')
      .lean();
    // Parents/students always see "Bee Bright Admin" for center announcements — never
    // the individual Admin / Super Admin account that posted it. Tutor-authored ones
    // keep the tutor's own name.
    const announcements = list.map((a) => (
      a.authorRole === 'admin' ? { ...a, author: { firstName: 'Bee Bright', lastName: 'Admin' } } : a
    ));
    res.status(200).json({ success: true, announcements });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load announcements' });
  }
};

// @desc    Get announcements for current tutor (their own)
// @route   GET /api/announcements/tutor
// @access  Private (tutor)
const getForTutor = async (req, res) => {
  try {
    // Same per-account creation-date filter as getForStudent — only applies to the admin
    // broadcast branch; a tutor's OWN authored announcements (any status) are always
    // theirs to see regardless of date, since they could never have authored one before
    // their own account existed.
    const list = await Announcement.find({
      $or: [
        { author: req.user.id },
        { authorRole: 'admin', status: 'approved', targetType: 'all', approvedAt: { $gte: req.user.createdAt } }
      ]
    })
      .sort({ approvedAt: -1, createdAt: -1 })
      .populate('targetStudentIds', 'firstName lastName')
      .lean();
    res.status(200).json({ success: true, announcements: list });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load announcements' });
  }
};

// @desc    Get all announcements for admin (all + pending for approve/reject)
// @route   GET /api/announcements/admin
// @access  Private (admin)
const getForAdmin = async (req, res) => {
  try {
    const list = await Announcement.find({})
      .sort({ createdAt: -1 })
      .populate('author', 'firstName lastName email')
      .populate('targetStudentIds', 'firstName lastName email')
      .populate('approvedBy', 'firstName lastName')
      .lean();
    res.status(200).json({ success: true, announcements: list });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load announcements' });
  }
};

// @desc    Approve tutor announcement; notify target students by email
// @route   PATCH /api/announcements/:id/approve
// @access  Private (admin)
const approveAnnouncement = async (req, res) => {
  try {
    const id = req.params.id;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid announcement id' });
    }
    const ann = await Announcement.findById(id);
    if (!ann) return res.status(404).json({ success: false, message: 'Announcement not found' });
    if (ann.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Announcement is not pending' });
    }
    ann.status = 'approved';
    ann.approvedBy = req.user.id;
    ann.approvedAt = new Date();
    ann.rejectedAt = null;
    ann.rejectionReason = null;
    await ann.save();

    // Tutor-authored = scoped to specific students -> only THEIR parents, never the
    // students' own placeholder emails, and never every parent/tutor.
    const targetIds = [].concat(ann.targetStudentIds || []).filter(Boolean);
    await notifyParentsOfStudents(targetIds, { announcementId: String(ann._id), title: ann.title, body: ann.body, category: ann.category });

    const populated = await Announcement.findById(ann._id)
      .populate('author', 'firstName lastName email')
      .populate('targetStudentIds', 'firstName lastName email')
      .populate('approvedBy', 'firstName lastName')
      .lean();

    logAudit({
      req,
      userId: req.user.id,
      action: 'Approve Announcement',
      module: 'Announcement',
      description: 'Admin approved tutor announcement',
      status: 'SUCCESS',
      metadata: { announcementId: ann._id }
    }).catch(() => {});

    res.status(200).json({ success: true, announcement: populated });
  } catch (error) {
    console.error('approveAnnouncement error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to approve' });
  }
};

// @desc    Reject tutor announcement
// @route   PATCH /api/announcements/:id/reject
// @access  Private (admin)
const rejectAnnouncement = async (req, res) => {
  try {
    const { reason } = req.body || {};
    const ann = await Announcement.findById(req.params.id);
    if (!ann) return res.status(404).json({ success: false, message: 'Announcement not found' });
    if (ann.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Announcement is not pending' });
    }
    ann.status = 'rejected';
    ann.rejectedAt = new Date();
    ann.rejectionReason = (reason && typeof reason === 'string') ? reason.trim() : null;
    ann.approvedBy = null;
    ann.approvedAt = null;
    await ann.save();

    const populated = await Announcement.findById(ann._id)
      .populate('author', 'firstName lastName email')
      .populate('targetStudentIds', 'firstName lastName email');

    logAudit({
      req,
      userId: req.user.id,
      action: 'Reject Announcement',
      module: 'Announcement',
      description: 'Admin rejected tutor announcement',
      status: 'SUCCESS',
      metadata: { announcementId: ann._id }
    }).catch(() => {});

    res.status(200).json({ success: true, announcement: populated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to reject' });
  }
};

// @desc    Get list of students the tutor handles (for announcement target picker)
// @route   GET /api/announcements/my-students
// @access  Private (tutor)
const getMyStudents = async (req, res) => {
  try {
    const tutorId = req.user.id;
    // Group-aware (was `Schedule.find({ tutor: tutorId }).distinct('student')` — the
    // singular field only, so a Toddlers Playgroup tutor's own roster from `tutors[]`/
    // `students[]` never showed up here at all).
    const roster = await getTutorRosterStudentIds(tutorId);
    const students = await User.find({ _id: { $in: [...roster] }, role: 'student' })
      .select('firstName lastName email')
      .sort({ firstName: 1, lastName: 1 })
      .lean();
    const list = students.map(s => ({
      _id: s._id,
      name: [s.firstName, s.lastName].filter(Boolean).join(' '),
      email: s.email
    }));
    res.status(200).json({ success: true, students: list });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load students' });
  }
};

// @desc    Update announcement
// @route   PUT /api/announcements/:id
// @access  Private (admin or tutor owner)
const updateAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid announcement id' });
    }

    const ann = await Announcement.findById(id);
    if (!ann) {
      return res.status(404).json({ success: false, message: 'Announcement not found' });
    }
    if (!canManageAnnouncement(req.user, ann)) {
      return res.status(403).json({ success: false, message: 'Not authorized to edit this announcement' });
    }

    const { title, body, category, targetStudentIds, scheduledDate } = req.body || {};
    if (!title || !body || typeof title !== 'string' || typeof body !== 'string') {
      return res.status(400).json({ success: false, message: 'Title and body are required' });
    }

    const allowedCategories = ann.authorRole === 'admin' ? ADMIN_CATEGORIES : TUTOR_CATEGORIES;
    const nextCategory = allowedCategories.includes(category) ? category : 'general';
    const scheduledDateVal = parseScheduledDate(scheduledDate);
    if (scheduledDate && !scheduledDateVal) {
      return res.status(400).json({ success: false, message: 'Invalid scheduled date' });
    }
    if (isScheduledDateInPast(scheduledDateVal)) {
      return res.status(400).json({ success: false, message: 'The announcement date cannot be in the past.' });
    }

    ann.title = title.trim();
    ann.body = body.trim();
    ann.category = nextCategory;
    ann.scheduledDate = scheduledDateVal;

    if (ann.authorRole === 'admin') {
      ann.targetType = 'all';
      ann.targetStudentIds = [];
      ann.status = 'approved';
      ann.approvedBy = req.user.id;
      ann.approvedAt = ann.approvedAt || new Date();
      ann.rejectedAt = null;
      ann.rejectionReason = null;
    } else {
      if (!Array.isArray(targetStudentIds) || targetStudentIds.length === 0) {
        return res.status(400).json({ success: false, message: 'Select at least one student to notify' });
      }
      ann.targetType = 'specific_students';
      ann.targetStudentIds = targetStudentIds;
      resetTutorAnnouncementApproval(ann);
    }

    await ann.save();

    const populated = await Announcement.findById(ann._id)
      .populate('author', 'firstName lastName email')
      .populate('targetStudentIds', 'firstName lastName email')
      .populate('approvedBy', 'firstName lastName')
      .lean();

    logAudit({
      req,
      userId: req.user.id,
      action: 'Edit Announcement',
      module: 'Announcement',
      description: req.user.role === 'admin' || req.user.role === 'super_admin' ? 'Admin edited announcement' : 'Tutor edited announcement',
      status: 'SUCCESS',
      metadata: { announcementId: ann._id, category: ann.category }
    }).catch(() => {});

    return res.status(200).json({ success: true, announcement: populated });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to update announcement' });
  }
};

// @desc    Delete announcement
// @route   DELETE /api/announcements/:id
// @access  Private (admin or tutor owner)
const deleteAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid announcement id' });
    }

    const ann = await Announcement.findById(id);
    if (!ann) {
      return res.status(404).json({ success: false, message: 'Announcement not found' });
    }
    if (!canManageAnnouncement(req.user, ann)) {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this announcement' });
    }

    await ann.deleteOne();

    logAudit({
      req,
      userId: req.user.id,
      action: 'Delete Announcement',
      module: 'Announcement',
      description: req.user.role === 'admin' || req.user.role === 'super_admin' ? 'Admin deleted announcement' : 'Tutor deleted announcement',
      status: 'SUCCESS',
      metadata: { announcementId: ann._id, category: ann.category, authorRole: ann.authorRole }
    }).catch(() => {});

    return res.status(200).json({ success: true, message: 'Announcement deleted successfully' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete announcement' });
  }
};

module.exports = {
  createAnnouncement,
  getForStudent,
  getForTutor,
  getForAdmin,
  approveAnnouncement,
  rejectAnnouncement,
  getMyStudents,
  updateAnnouncement,
  deleteAnnouncement
};
