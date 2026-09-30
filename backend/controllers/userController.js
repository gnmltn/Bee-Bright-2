const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const UserArchiveRecord = require('../models/UserArchiveRecord');
const { validateFullName, validatePhMobile } = require('../utils/validation');
const { logAudit } = require('../utils/auditService');
const { normalizeEmailAddress, buildEmailLookupFilter } = require('../utils/email');
const { cleanupIncompleteUsers } = require('../utils/incompleteUserCleanup');
const { getEmailError } = require('../utils/emailRules');
const { hardDeleteUser } = require('../utils/hardDeleteUser');
const { runTransactionSafe } = require('../utils/runTransactionSafe');
const { emitToAdmins } = require('../utils/realtime');

const loadAdminUser = async (userId) => (
  User.findById(userId)
    .select('-password')
    .populate('subjectsTaught', 'name code')
    .lean()
);

const MANAGEABLE_ROLES_BY_ACTOR = {
  admin: ['student', 'tutor', 'parent'],
  super_admin: ['admin', 'student', 'tutor', 'parent'],
};

const getManageableRolesForActor = (actorRole) => MANAGEABLE_ROLES_BY_ACTOR[actorRole] || [];

const canManageTargetRole = (actorRole, targetRole) => getManageableRolesForActor(actorRole).includes(targetRole);

const createArchiveRecord = async ({
  user,
  action,
  performedBy,
  performedByRole,
  archivedAt = null,
  unarchivedAt = null,
  deletedAt = null,
  session = null,
}) => {
  // A snapshot record — it never depends on the User row still existing afterwards, which is
  // exactly why permanentlyDeleteUser can create it in the same transaction as the hard delete.
  await UserArchiveRecord.create([{
    user: user._id,
    action,
    performedBy: performedBy || null,
    performedByRole: performedByRole === 'super_admin' ? 'super_admin' : 'admin',
    email: user.email,
    role: user.role,
    firstName: user.firstName,
    middleName: user.middleName || '',
    lastName: user.lastName,
    phone: user.phone || '',
    archivedAt,
    unarchivedAt,
    deletedAt,
  }], session ? { session } : undefined);
};

// @desc    Get all users (admin only)
// @route   GET /api/users
// @access  Private (Admin)
const getAllUsers = async (req, res) => {
  try {
    await cleanupIncompleteUsers();

    const manageableRoles = getManageableRolesForActor(req.user.role);
    if (manageableRoles.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to manage user accounts'
      });
    }

    // List all users for management (active + archived), excluding permanently removed records.
    const users = await User.find({
      deletedAt: null,
      role: { $in: manageableRoles }
    })
      .select('-password')
      .populate('subjectsTaught', 'name code')
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: users.length,
      users
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch users'
    });
  }
};

// @desc    Create tutor (admin only)
// @route   POST /api/users/tutors
// @access  Private (Admin)
const createTutor = async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins or super admins can create tutor accounts'
      });
    }

    const {
      firstName,
      middleName,
      lastName,
      email,
      password,
      phone,
      employmentType,
      availability
    } = req.body;

    if (!firstName || !lastName || !email || !password || !phone || !(phone + '').trim()) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, email, password, and phone are required'
      });
    }
    let nameErr = validateFullName(firstName, 'First name', { minParts: 1, required: true });
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    nameErr = validateFullName(middleName, 'Middle name', { minParts: 1, required: false });
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    nameErr = validateFullName(lastName, 'Last name', { minParts: 1, required: true });
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    const phoneErr = validatePhMobile(phone, 'Phone number');
    if (phoneErr) return res.status(400).json({ success: false, message: phoneErr });

    const emailProblem = getEmailError(email);
    if (emailProblem) {
      return res.status(400).json({
        success: false,
        message: emailProblem
      });
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password must contain at least 8 characters, one uppercase, one lowercase, one number and one special character (@$!%*?&)'
      });
    }

    const normalizedEmail = normalizeEmailAddress(email);
    const existing = await User.findOne(buildEmailLookupFilter(normalizedEmail));
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'A user with this email already exists'
      });
    }

    const employment = employmentType === 'part-time' ? 'part-time' : 'full-time';
    const user = await User.create({
      firstName: firstName.trim(),
      middleName: (middleName || '').trim(),
      lastName: lastName.trim(),
      email: normalizedEmail,
      password,
      phone: (phone || '').trim(),
      role: 'tutor',
      employmentType: employment,
      availability: (availability || '').trim()
    });

    const created = await User.findById(user._id).select('-password').populate('subjectsTaught', 'name code').lean();

    logAudit({
      req,
      userId: req.user.id,
      action: 'Add Tutor',
      module: 'User Management',
      description: 'Admin added new tutor',
      status: 'SUCCESS',
      metadata: { tutorId: user._id }
    }).catch(() => {});

    emitToAdmins('user:changed', { action: 'created', userId: String(user._id), role: 'tutor' });

    res.status(201).json({
      success: true,
      message: 'Tutor created successfully',
      user: created
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ success: false, message: messages.join(', ') });
    }
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Email already exists' });
    }
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create tutor'
    });
  }
};

// @desc    Create admin (admin only)
// @route   POST /api/users/admins
// @access  Private (Admin)
const createAdmin = async (req, res) => {
  try {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Only super admins can create admin accounts'
      });
    }

    const { firstName, middleName, lastName, email, password, phone } = req.body;

    if (!firstName || !lastName || !email || !password || !phone || !(phone + '').trim()) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, email, password, and phone are required'
      });
    }
    let nameErr = validateFullName(firstName, 'First name', { minParts: 1, required: true });
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    nameErr = validateFullName(middleName, 'Middle name', { minParts: 1, required: false });
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    nameErr = validateFullName(lastName, 'Last name', { minParts: 1, required: true });
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    const phoneErr = validatePhMobile(phone, 'Phone number');
    if (phoneErr) return res.status(400).json({ success: false, message: phoneErr });

    const emailProblem = getEmailError(email);
    if (emailProblem) {
      return res.status(400).json({
        success: false,
        message: emailProblem
      });
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password must contain at least 8 characters, one uppercase, one lowercase, one number and one special character (@$!%*?&)'
      });
    }

    const normalizedEmail = normalizeEmailAddress(email);
    const existing = await User.findOne(buildEmailLookupFilter(normalizedEmail));
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'A user with this email already exists'
      });
    }

    const user = await User.create({
      firstName: firstName.trim(),
      middleName: (middleName || '').trim(),
      lastName: lastName.trim(),
      email: normalizedEmail,
      password,
      phone: (phone || '').trim(),
      role: 'admin',
      isActive: true
    });

    const created = await User.findById(user._id).select('-password').lean();

    logAudit({
      req,
      userId: req.user.id,
      action: 'Add Admin',
      module: 'User Management',
      description: 'Super admin added new admin',
      status: 'SUCCESS',
      metadata: { adminId: user._id }
    }).catch(() => {});

    emitToAdmins('user:changed', { action: 'created', userId: String(user._id), role: 'admin' });

    res.status(201).json({
      success: true,
      message: 'Admin created successfully',
      user: created
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ success: false, message: messages.join(', ') });
    }
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Email already exists' });
    }
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create admin'
    });
  }
};

// @desc    Archive user (admin only) - soft delete, suspend access; keeps enrollments, payments, schedules, grades
// @route   DELETE /api/users/:id   (kept as DELETE for backward compatibility, but behavior is archive)
// @access  Private (Admin)
const deleteUser = async (req, res) => {
  try {
    const userId = req.params.id;

    const userToDelete = await User.findById(userId);
    if (!userToDelete) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!canManageTargetRole(req.user.role, userToDelete.role)) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to archive this account',
      });
    }

    if (userToDelete._id.toString() === req.user.id) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own account',
      });
    }

    if (userToDelete.role === 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin', isActive: true, isArchived: { $ne: true } });
      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          message: 'Cannot archive the last active admin. At least one admin must remain.',
        });
      }
    }

    // Soft delete: mark as archived and inactive; keep related records for history.
    userToDelete.isArchived = true;
    userToDelete.isActive = false;

    // For students, also mark enrollment status as cancelled to avoid confusion
    if (userToDelete.role === 'student') {
      userToDelete.enrollmentStatus = 'cancelled';
    }
    const archivedAt = new Date();
    userToDelete.archivedAt = archivedAt;
    await userToDelete.save();
    await createArchiveRecord({
      user: userToDelete,
      action: 'archived',
      performedBy: req.user.id,
      performedByRole: req.user.role,
      archivedAt,
    });
    const archivedUser = await loadAdminUser(userId);

    logAudit({
      req,
      userId: req.user.id,
      action: 'Archive User',
      module: 'User Management',
      description: `Archived ${userToDelete.role} account`,
      status: 'SUCCESS',
      metadata: { archivedUserId: userId, archivedUserRole: userToDelete.role }
    }).catch(() => {});

    emitToAdmins('user:changed', { action: 'archived', userId: String(userId), role: userToDelete.role });

    res.status(200).json({
      success: true,
      message: 'User archived successfully. Account access has been suspended.',
      user: archivedUser,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete user',
    });
  }
};

// @desc    Unarchive user (admin only) - restore account access for archived user
// @route   PATCH /api/users/:id/unarchive
// @access  Private (Admin)
const unarchiveUser = async (req, res) => {
  try {
    const userId = req.params.id;

    const userToRestore = await User.findById(userId);
    if (!userToRestore) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!canManageTargetRole(req.user.role, userToRestore.role)) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to unarchive this account',
      });
    }

    if (!userToRestore.isArchived) {
      return res.status(400).json({
        success: false,
        message: 'User is not archived',
      });
    }

    const unarchivedAt = new Date();
    userToRestore.isArchived = false;
    userToRestore.archivedAt = null;
    userToRestore.isActive = true;

    if (userToRestore.role === 'student' && userToRestore.enrollmentStatus === 'cancelled') {
      userToRestore.enrollmentStatus = 'payment_rejected';
    }

    await userToRestore.save();
    await createArchiveRecord({
      user: userToRestore,
      action: 'unarchived',
      performedBy: req.user.id,
      performedByRole: req.user.role,
      unarchivedAt,
    });
    const restoredUser = await loadAdminUser(userId);

    logAudit({
      req,
      userId: req.user.id,
      action: 'Unarchive User',
      module: 'User Management',
      description: `Unarchived ${userToRestore.role} account`,
      status: 'SUCCESS',
      metadata: { restoredUserId: userId, restoredUserRole: userToRestore.role }
    }).catch(() => {});

    emitToAdmins('user:changed', { action: 'unarchived', userId: String(userId), role: userToRestore.role });

    res.status(200).json({
      success: true,
      message: 'User unarchived successfully. Account access has been restored.',
      user: restoredUser,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to unarchive user',
    });
  }
};

// @desc    Remove archived user from admin records while keeping historical references intact
// @route   DELETE /api/users/:id/permanent
// @access  Private (Admin)
const permanentlyDeleteUser = async (req, res) => {
  try {
    const userId = req.params.id;

    const userToDelete = await User.findById(userId);
    if (!userToDelete || userToDelete.deletedAt) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!canManageTargetRole(req.user.role, userToDelete.role)) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to delete this archived account',
      });
    }

    if (userToDelete._id.toString() === req.user.id) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own account',
      });
    }

    if (!userToDelete.isArchived) {
      return res.status(400).json({
        success: false,
        message: 'Only archived users can be permanently deleted.',
      });
    }

    // A real hard delete — the account and every record that only exists because of it
    // (enrollments, payments, sessions, remarks, and for a parent, their children's own
    // student accounts) are removed together. The archive-record snapshot is written in the
    // SAME transaction, before the row it snapshots is gone, so a mid-way failure rolls back
    // everything: no half-deleted data, and no account left soft-deleted-but-still-in-the-DB.
    const deletedAt = new Date();
    await runTransactionSafe(async (session) => {
      await createArchiveRecord({
        user: userToDelete,
        action: 'deleted',
        performedBy: req.user.id,
        performedByRole: req.user.role,
        archivedAt: userToDelete.archivedAt,
        deletedAt,
        session,
      });
      await hardDeleteUser(userToDelete, session);
    });

    logAudit({
      req,
      userId: req.user.id,
      action: 'Delete Archived User',
      module: 'User Management',
      description: `Permanently deleted archived ${userToDelete.role} account and its linked records`,
      status: 'SUCCESS',
      metadata: { deletedUserId: userId, deletedUserRole: userToDelete.role }
    }).catch(() => {});

    emitToAdmins('user:changed', { action: 'deleted', userId: String(userId), role: userToDelete.role });

    // The transaction only resolves once every deletion has committed, so by the time this
    // response goes out the account is actually gone — the frontend removes the row on this
    // response alone, no page refresh needed.
    res.status(200).json({
      success: true,
      message: 'Archived user permanently deleted.',
      userId,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete archived user',
    });
  }
};

// @desc    Every parent's children (name + permanent Student ID), keyed by parent id
// @route   GET /api/users/parent-children
// @access  Private (Admin)
const getParentChildren = async (req, res) => {
  try {
    const enrollments = await Enrollment.find({
      parent: { $ne: null },
      status: { $nin: ['cancelled', 'rejected', 'draft'] },
    })
      .select('parent student enrollmentId permanentStudentId studentId studentSnapshot packages createdAt')
      .sort({ createdAt: -1 })
      .lean();

    // parentId -> childKey -> { name, studentId, programs }: one entry per CHILD, so Renew / Add
    // Program enrollments (same permanent Student ID) never list a child twice — their programs
    // are merged onto the one entry instead.
    const byParent = {};
    for (const e of enrollments) {
      const parentId = String(e.parent);
      const studentId = e.permanentStudentId || e.studentId || e.enrollmentId || '';
      const key = studentId || String(e._id);
      byParent[parentId] = byParent[parentId] || new Map();
      const programs = (e.packages || []).map((p) => p.displayName || p.programCode).filter(Boolean);
      const existing = byParent[parentId].get(key);
      if (existing) {
        for (const program of programs) if (!existing.programs.includes(program)) existing.programs.push(program);
        if (!existing.studentUserId && e.student) existing.studentUserId = String(e.student);
        continue;
      }
      const name = [e.studentSnapshot?.firstName, e.studentSnapshot?.lastName].filter(Boolean).join(' ') || 'Child';
      byParent[parentId].set(key, { name, studentId, programs: [...new Set(programs)], studentUserId: e.student ? String(e.student) : null });
    }

    const children = {};
    for (const [parentId, map] of Object.entries(byParent)) {
      children[parentId] = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    res.status(200).json({ success: true, children });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load children' });
  }
};

module.exports = {
  getAllUsers,
  createTutor,
  createAdmin,
  deleteUser,
  unarchiveUser,
  permanentlyDeleteUser,
  getParentChildren,
};
