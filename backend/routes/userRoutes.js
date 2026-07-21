const express = require('express');
const router = express.Router();
const { getAllUsers, createTutor, createAdmin, deleteUser, unarchiveUser, permanentlyDeleteUser } = require('../controllers/userController');
const { protect, authorize } = require('../middleware/auth');

// Admin: list all users
router.get('/', protect, authorize('admin'), getAllUsers);
// Admin: create tutor
router.post('/tutors', protect, authorize('admin'), createTutor);
// Super admin only: create admin
router.post('/admins', protect, authorize('super_admin'), createAdmin);
// Admin: permanently delete an archived user from admin records
router.delete('/:id/permanent', protect, authorize('admin'), permanentlyDeleteUser);
// Admin: delete user (cascades to enrollments, payments, schedules, grades)
router.delete('/:id', protect, authorize('admin'), deleteUser);
// Admin: unarchive user
router.patch('/:id/unarchive', protect, authorize('admin'), unarchiveUser);

module.exports = router;
