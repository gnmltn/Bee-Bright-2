const express = require('express');
const router = express.Router();
const {
  sendEnrollmentVerificationCode,
  verifyEnrollmentEmailCode,
  submitEnrollment,
  createEnrollment,
  getMyEnrollments,
  getAllEnrollments,
  getEnrollmentById,
  updateEnrollmentStatus,
  verifyPayment,
  adminAddStudent,
  getEnrollmentByStudent
} = require('../controllers/enrollmentController');
const { protect, authorize, optionalProtect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { enrollmentSubmitRules } = require('../middleware/inputValidation');

router.post('/send-verification-code', sendEnrollmentVerificationCode);
router.post('/verify-email-code', verifyEnrollmentEmailCode);

// Public or optional-auth: register + enroll in one step (or enroll only if logged in)
router.post('/submit', optionalProtect, validate(enrollmentSubmitRules), submitEnrollment);

// Student routes
router.post('/', protect, authorize('student'), createEnrollment);
router.get('/my-enrollments', protect, authorize('student'), getMyEnrollments);
router.get('/student/:studentId', protect, getEnrollmentByStudent);

// Admin routes: list all enrollments and update status
router.get('/', protect, authorize('admin'), getAllEnrollments);
router.get('/:id', protect, authorize('admin'), getEnrollmentById);
router.post('/admin/add-student', protect, authorize('admin'), adminAddStudent);
router.put('/:id/status', protect, authorize('admin'), updateEnrollmentStatus);
router.put('/:id/verify-payment', protect, authorize('admin'), verifyPayment);

module.exports = router;
