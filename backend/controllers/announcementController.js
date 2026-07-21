const mongoose = require('mongoose');
const Announcement = require('../models/Announcement');
const User = require('../models/User');
const Schedule = require('../models/Schedule');
const { sendAnnouncementEmail } = require('../utils/emailService');
const { logAudit } = require('../utils/auditService');

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
      // Notify all students by email (get all active students)
      const students = await User.find({ role: 'student', isActive: true, isArchived: { $ne: true } }).select('email firstName lastName').lean();
      for (const s of students) {
        if (s.email) {
          const name = [s.firstName, s.lastName].filter(Boolean).join(' ') || 'Student';
          sendAnnouncementEmail(s.email, name, doc.title, doc.body, doc.category).catch(() => {});
        }
      }
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
    const studentId = req.user.id;
    const studentObjId = mongoose.Types.ObjectId.isValid(studentId) ? new mongoose.Types.ObjectId(studentId) : null;
    if (!studentObjId) {
      return res.status(400).json({ success: false, message: 'Invalid student id' });
    }
    const list = await Announcement.find({
      status: 'approved',
      $or: [
        { targetType: 'all' },
        { targetStudentIds: studentObjId }
      ]
    })
      .sort({ approvedAt: -1, createdAt: -1 })
      .populate('author', 'firstName lastName')
      .lean();
    res.status(200).json({ success: true, announcements: list });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load announcements' });
  }
};

// @desc    Get announcements for current tutor (their own)
// @route   GET /api/announcements/tutor
// @access  Private (tutor)
const getForTutor = async (req, res) => {
  try {
    const list = await Announcement.find({
      $or: [
        { author: req.user.id },
        { authorRole: 'admin', status: 'approved', targetType: 'all' }
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

    const targetIds = [].concat(ann.targetStudentIds || []).filter(Boolean);
    const students = await User.find({ _id: { $in: targetIds } }).select('email firstName lastName').lean();
    for (const s of students) {
      if (s.email) {
        const name = [s.firstName, s.lastName].filter(Boolean).join(' ') || 'Student';
        sendAnnouncementEmail(s.email, name, ann.title, ann.body, ann.category).catch(() => {});
      }
    }

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
    const schedules = await Schedule.find({ tutor: tutorId }).distinct('student');
    const students = await User.find({ _id: { $in: schedules }, role: 'student' })
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
