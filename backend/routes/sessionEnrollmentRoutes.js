const express = require('express');
const router = express.Router();
const {
  getAvailableSessionsForStudents,
  enrollStudentInSession,
  unenrollStudentFromSession,
  getStudentSessions
} = require('../controllers/studentEnrollmentController');
const { protect, authorize } = require('../middleware/auth');

// Get available sessions for student to enroll in
// Public route - accessible to authenticated students
router.get('/available', protect, getAvailableSessionsForStudents);

// Enroll student in a session
router.post('/:id/enroll', protect, authorize('student'), enrollStudentInSession);

// Unenroll student from a session
router.post('/:id/unenroll', protect, authorize('student'), unenrollStudentFromSession);

// Get student's enrolled sessions
router.get('/my-sessions', protect, authorize('student'), getStudentSessions);

module.exports = router;
