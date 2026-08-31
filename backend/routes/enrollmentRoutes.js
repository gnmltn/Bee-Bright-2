const express = require('express');
const router = express.Router();
const {
  sendEnrollmentVerificationCode,
  verifyEnrollmentEmailCode,
  submitEnrollment,
  submitPaymentProof,
  getMyEnrollments,
  trackEnrollment,
  createEnrollment,
  getEnrollmentById,
  getEnrollmentByStudent,
  getAllEnrollments,
  getTutorAssessments,
  adminVerifyPayment,
  adminApproveEnrollment,
  adminRejectEnrollment,
  updateEnrollmentStatus,
  verifyPayment,
  adminAddStudent,
} = require('../controllers/enrollmentController');
const { createDraft, updateDraft, getDraft } = require('../controllers/enrollmentDraftController');
const { getAllPricing, createOrUpdatePricing } = require('../controllers/pricingController');
const { protect, authorize, optionalProtect } = require('../middleware/auth');

// ── Public (no auth required) ────────────────────────────────────────────
router.post('/send-verification-code', sendEnrollmentVerificationCode);
router.post('/verify-email-code', verifyEnrollmentEmailCode);
router.get('/track', trackEnrollment); // GET /enrollments/track?enrollmentId=&email=

// ── Pricing (public read, admin write) ───────────────────────────────────
router.get('/pricing', getAllPricing);
router.post('/pricing', protect, authorize('admin'), createOrUpdatePricing);

// ── Draft autosave (auth required) ───────────────────────────────────────
router.post('/drafts', protect, createDraft);
router.put('/drafts/:id', protect, updateDraft);
router.get('/drafts/:id', protect, getDraft);

// ── Admin bulk/action routes (MUST come before /:id) ─────────────────────
router.get('/admin/all', protect, authorize('admin'), getAllEnrollments);
router.post('/admin/add-student', protect, authorize('admin'), adminAddStudent);

// ── Parent / Student named routes (MUST come before /:id) ────────────────
router.get('/my-enrollments', protect, getMyEnrollments);
router.get('/tutor/assessments', protect, authorize('tutor'), getTutorAssessments);
router.get('/student/:studentId', protect, getEnrollmentByStudent);

// ── Wizard submit ─────────────────────────────────────────────────────────
router.post('/submit', optionalProtect, submitEnrollment);

// ── Legacy student enrollment ─────────────────────────────────────────────
router.post('/', protect, authorize('student'), createEnrollment);

// ── Admin list (root GET — comes after all named GET routes) ──────────────
router.get('/', protect, authorize('admin'), getAllEnrollments);

// ── Parameterized routes LAST (so they never shadow named routes above) ───
router.post('/:enrollmentId/submit-proof', protect, submitPaymentProof);
router.put('/:id/status', protect, authorize('admin'), updateEnrollmentStatus);
router.put('/:id/verify-payment', protect, authorize('admin'), adminVerifyPayment);
router.put('/:id/approve', protect, authorize('admin'), adminApproveEnrollment);
router.put('/:id/reject', protect, authorize('admin'), adminRejectEnrollment);
// /:id GET must be absolute last — catches anything not matched above
router.get('/:id', protect, authorize('admin'), getEnrollmentById);

module.exports = router;
