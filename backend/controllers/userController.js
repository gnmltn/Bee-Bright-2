const User = require('../models/User');
const Subject = require('../models/Subject');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const Schedule = require('../models/Schedule');
const Grade = require('../models/Grade');
const UserArchiveRecord = require('../models/UserArchiveRecord');
const { validateName, validatePhoneNoLetters } = require('../utils/validation');
const { logAudit } = require('../utils/auditService');
const { normalizeEmailAddress, buildEmailLookupFilter } = require('../utils/email');
const { cleanupIncompleteUsers } = require('../utils/incompleteUserCleanup');

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
}) => {
  await UserArchiveRecord.create({
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
  });
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
      subjectsTaught,
      employmentType,
      availability
    } = req.body;

    if (!firstName || !lastName || !email || !password || !phone || !(phone + '').trim()) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, email, password, and phone are required'
      });
    }
    let nameErr = validateName(firstName, 'First name');
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    nameErr = validateName(middleName, 'Middle name');
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    nameErr = validateName(lastName, 'Last name');
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    const phoneErr = validatePhoneNoLetters(phone);
    if (phoneErr) return res.status(400).json({ success: false, message: phoneErr });

    const emailRegex = /^\S+@\S+\.\S+$/;
    if (!emailRegex.test((email || '').trim())) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address'
      });
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password must contain at least 8 characters, one uppercase, one lowercase, one number and one special character (@$!%*?&)'
      });
    }

    const phPhoneRegex = /^(0?9|639)\d{9}$/;
    const phoneDigits = (phone || '').replace(/\D/g, '');
    if (!phPhoneRegex.test(phoneDigits)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid Philippine mobile number (e.g. 09XX XXX XXXX)'
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

    const subjectIds = Array.isArray(subjectsTaught) ? subjectsTaught : [];
    if (subjectIds.length > 0) {
      const found = await Subject.countDocuments({ _id: { $in: subjectIds }, isActive: true });
      if (found !== subjectIds.length) {
        return res.status(400).json({
          success: false,
          message: 'One or more selected subjects are invalid'
        });
      }
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
      availability: (availability || '').trim(),
      subjectsTaught: subjectIds
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
    let nameErr = validateName(firstName, 'First name');
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    nameErr = validateName(middleName, 'Middle name');
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    nameErr = validateName(lastName, 'Last name');
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    const phoneErr = validatePhoneNoLetters(phone);
    if (phoneErr) return res.status(400).json({ success: false, message: phoneErr });

    const emailRegex = /^\S+@\S+\.\S+$/;
    if (!emailRegex.test((email || '').trim())) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address'
      });
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password must contain at least 8 characters, one uppercase, one lowercase, one number and one special character (@$!%*?&)'
      });
    }

    const phPhoneRegex = /^(0?9|639)\d{9}$/;
    const phoneDigits = (phone || '').replace(/\D/g, '');
    if (!phPhoneRegex.test(phoneDigits)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid Philippine mobile number (e.g. 09XX XXX XXXX)'
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

      // If a tutor is removed entirely, remove their schedule records from the system.
      if (userToDelete.role === 'tutor') {
        await Schedule.deleteMany({ tutor: userToDelete._id });
      }

    const deletedAt = new Date();
    userToDelete.deletedAt = deletedAt;
    userToDelete.isActive = false;
    await userToDelete.save();
    await createArchiveRecord({
      user: userToDelete,
      action: 'permanently_deleted',
      performedBy: req.user.id,
      performedByRole: req.user.role,
      archivedAt: userToDelete.archivedAt,
      deletedAt,
    });

    logAudit({
      req,
      userId: req.user.id,
      action: 'Delete Archived User',
      module: 'User Management',
      description: `Deleted archived ${userToDelete.role} account from admin records`,
      status: 'SUCCESS',
      metadata: { deletedUserId: userId, deletedUserRole: userToDelete.role }
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Archived user deleted successfully.',
      userId,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete archived user',
    });
  }
};

module.exports = {
  getAllUsers,
  createTutor,
  createAdmin,
  deleteUser,
  unarchiveUser,
  permanentlyDeleteUser,
};
