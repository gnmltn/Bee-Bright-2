const express = require('express');
const router = express.Router();
const {
  forgotPassword,
  resetPassword,
  requestPasswordChangeCode,
  changePassword,
} = require("../controllers/passwordController");
const {
  registerParent,
  sendParentOtp,
  verifyParentOtp,
  checkMobileAvailability,
} = require('../controllers/parentAuthController');
const {
  register,
  login,
  adminLogin,
  loginStart,
  adminLoginStart,
  verifyLoginOtp,
  completeLogin,
  logout,
  getCaptchaChallenge,
  getMe,
  updateProfile,
  uploadProfileImage,
} = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const {
  userLoginLimiter,
  adminLoginLimiter,
  passwordOtpRequestLimiter,
  passwordOtpVerifyLimiter,
} = require('../middleware/rateLimit');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { assertValidEmail } = require('../utils/emailRules');

const preserveEmailAddress = (value) => String(value || '').trim().toLowerCase();
// Every email field on every auth form goes through the same character rules.
const emailField = () => body('email').customSanitizer(preserveEmailAddress).custom(assertValidEmail);

// Middleware to normalize field names
const normalizeFields = (req, res, next) => {
  if (req.body.firstname && !req.body.firstName) {
    req.body.firstName = req.body.firstname;
  }

  if (req.body.lastname && !req.body.lastName) {
    req.body.lastName = req.body.lastname;
  }

  next();
};

// Public routes
router.get('/captcha-challenge', getCaptchaChallenge);

// ── Parent/Guardian enrollment registration ──────────────────────────────
router.post(
  '/check-mobile',
  validate([body('mobile').notEmpty().withMessage('Mobile number is required')]),
  checkMobileAvailability,
);
router.post(
  '/register-parent',
  validate([
    // The wizard sends split firstName/middleName/lastName (registerParent's own preferred
    // shape); a single combined `name` is still accepted for older callers. Item E of
    // "Redundant_Switchers_Settings_Rules_EnrollmentBugs.pdf" — this rule still required the
    // old `name` field even after the wizard stopped sending it, so every registration was
    // rejected here before the controller (which already supported both) ever ran.
    body().custom((_, { req }) => {
      const hasSplit = String(req.body?.firstName || '').trim() && String(req.body?.lastName || '').trim();
      const hasName = String(req.body?.name || '').trim();
      if (!hasSplit && !hasName) {
        throw new Error('First name and last name are required');
      }
      return true;
    }),
    emailField(),
    body('mobile').notEmpty().withMessage('Mobile number is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('draftId').optional({ nullable: true }).isMongoId().withMessage('Invalid draft reference'),
  ]),
  registerParent
);
router.post(
  '/parent-otp/send',
  validate([
    emailField(),
  ]),
  sendParentOtp
);
router.post(
  '/parent-otp/verify',
  validate([
    emailField(),
    body('code').isLength({ min: 6, max: 6 }).isNumeric().withMessage('6-digit code required'),
  ]),
  verifyParentOtp
);

router.post(
  '/login-start',
  userLoginLimiter,
  validate([
    emailField(),
    body('password').notEmpty().withMessage('Password is required'),
    body('role').isIn(['student', 'tutor', 'parent']).withMessage('Role must be student, tutor, or parent'),
  ]),
  loginStart
);

router.post(
  '/admin-login-start',
  adminLoginLimiter,
  validate([
    emailField(),
    body('password').notEmpty().withMessage('Password is required'),
  ]),
  adminLoginStart
);

router.post(
  '/login-verify-otp',
  validate([
    emailField(),
    body('verificationId').notEmpty().withMessage('Verification session is required'),
    body('otp')
      .isLength({ min: 6, max: 6 })
      .withMessage('Verification code must be 6 digits')
      .isNumeric()
      .withMessage('Verification code must be numeric'),
  ]),
  verifyLoginOtp
);

router.post(
  '/admin-login-verify-otp',
  validate([
    emailField(),
    body('verificationId').notEmpty().withMessage('Verification session is required'),
    body('otp')
      .isLength({ min: 6, max: 6 })
      .withMessage('Verification code must be 6 digits')
      .isNumeric()
      .withMessage('Verification code must be numeric'),
  ]),
  verifyLoginOtp
);

router.post('/login-complete', completeLogin);
router.post('/logout', logout);

router.post(
  '/register',
  normalizeFields,
  validate([
    body('firstName').notEmpty().withMessage('First name is required').trim(),
    body('lastName').notEmpty().withMessage('Last name is required').trim(),
    emailField(),
    body('phone').notEmpty().withMessage('Phone number is required').trim(),
    body('role').optional().equals('student').withMessage('Public registration is only available for student accounts'),
    body('password')
      .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/)
      .withMessage('Password must contain uppercase, lowercase, number and special character'),
  ]),
  register
);

router.post(
  '/login',
  userLoginLimiter,
  validate([
    emailField(),
    body('password').notEmpty().withMessage('Password is required'),
    body('role').isIn(['student', 'tutor']).withMessage('Role must be student or tutor'),
  ]),
  login
);

router.post(
  '/admin-login',
  adminLoginLimiter,
  validate([
    emailField(),
    body('password').notEmpty().withMessage('Password is required'),
  ]),
  adminLogin
);

router.post(
  '/forgot_password',
  passwordOtpRequestLimiter,
  validate([
    emailField(),
  ]),
  forgotPassword
);

router.post(
  '/reset_password',
  passwordOtpVerifyLimiter,
  validate([
    emailField(),
    body('otp')
      .isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
      .isNumeric().withMessage('OTP must be numeric'),
    body('newPassword')
      .isLength({ min: 8 }).withMessage('New password must be at least 8 characters')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/)
      .withMessage('New password must contain uppercase, lowercase, number and special character'),
  ]),
  resetPassword
);

// Protected routes
router.get('/me', protect, getMe);
router.put('/update-profile', protect, updateProfile);
router.put('/profile-image', protect, uploadProfileImage);

router.post(
  '/change-password/request-code',
  protect,
  passwordOtpRequestLimiter,
  validate([
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword')
      .isLength({ min: 8 }).withMessage('New password must be at least 8 characters')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/)
      .withMessage('New password must contain uppercase, lowercase, number and special character'),
  ]),
  requestPasswordChangeCode
);

router.put(
  '/change-password',
  protect,
  passwordOtpVerifyLimiter,
  validate([
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword')
      .isLength({ min: 8 }).withMessage('New password must be at least 8 characters')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/)
      .withMessage('New password must contain uppercase, lowercase, number and special character'),
    body('otp')
      .isLength({ min: 6, max: 6 }).withMessage('Verification code must be 6 digits')
      .isNumeric().withMessage('Verification code must be numeric'),
  ]),
  changePassword
);

module.exports = router;
