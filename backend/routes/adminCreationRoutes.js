const express = require('express');
const router = express.Router();
const { createAdmin } = require('../controllers/userController');
const {
  requestAdminCode,
  verifyAdminCode,
  createVerifiedAdmin,
  requestTutorCode,
  verifyTutorCode,
  createVerifiedTutor,
} = require('../controllers/adminInviteController');
const { protect, authorize } = require('../middleware/auth');

// Super admin only: create a new admin account via invite flow (legacy, unverified — kept
// for backward compatibility; the admin UI now uses the email-verified flow below).
router.post('/', protect, authorize('super_admin'), createAdmin);

// Email-verified admin creation ("polish prompt.pdf", Group B item 1).
router.post('/request-code', protect, authorize('super_admin'), requestAdminCode);
router.post('/verify-code', protect, authorize('super_admin'), verifyAdminCode);
router.post('/create-admin', protect, authorize('super_admin'), createVerifiedAdmin);

// Email-verified tutor creation.
router.post('/tutor/request-code', protect, authorize('admin', 'super_admin'), requestTutorCode);
router.post('/tutor/verify-code', protect, authorize('admin', 'super_admin'), verifyTutorCode);
router.post('/tutor/create', protect, authorize('admin', 'super_admin'), createVerifiedTutor);

module.exports = router;
