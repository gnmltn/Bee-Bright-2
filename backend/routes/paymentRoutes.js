const express = require('express');
const router = express.Router();
const {
  getGcashInfo,
  initiateStudentPayment,
  submitPaymentProof,
  getPaymentStatus,
  getEnrollmentPaymentStatus,
  getMyPayments,
  getAdminPayments,
  getPendingPayments,
  verifyPayment
} = require('../controllers/paymentController');
const { protect, authorize, optionalProtect } = require('../middleware/auth');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');

const submitProofValidation = [
  body('transactionHash').optional().isString().trim(),
  body('fromAddress').optional().isString().trim(),
  body('amountEth').optional().isNumeric(),
  body('mobileNumber').optional().isString().trim(),
  body('transactionId').optional().isString().trim(),
  body('screenshotUrl').notEmpty().withMessage('Screenshot is required').isString(),
  body('checkoutToken').optional().isString().trim(),
  body('checkoutStudent').optional().isObject(),
  body().custom((value, { req }) => {
    const hasAuth = !!req.user;
    if (!hasAuth) {
      if (!req.body?.checkoutToken?.trim()) {
        throw new Error('Checkout token is required.');
      }
      if (!req.body?.checkoutStudent || typeof req.body.checkoutStudent !== 'object') {
        throw new Error('Checkout student details are required.');
      }
    }
    return true;
  }),
];

// Public: GCash payment handler details (so payers see where to send money)
router.get('/gcash-info', getGcashInfo);

// Student routes
router.post(
  '/initiate/student',
  protect,
  authorize('student'),
  validate([
    body('enrollmentId').notEmpty().withMessage('Enrollment ID is required'),
    body('paymentMethod').optional().isIn(['gcash', 'blockchain']).withMessage('Invalid payment method')
  ]),
  initiateStudentPayment
);

router.post(
  '/:paymentId/submit-proof',
  optionalProtect,
  validate(submitProofValidation),
  submitPaymentProof
);

router.get(
  '/student/my-payments',
  protect,
  authorize('student'),
  getMyPayments
);

router.get(
  '/student/status/:enrollmentId',
  protect,
  authorize('student'),
  getEnrollmentPaymentStatus
);

router.get(
  '/:paymentId/status',
  protect,
  getPaymentStatus
);

// Admin routes
router.get(
  '/admin/payments',
  protect,
  authorize('admin'),
  getAdminPayments
);

router.get(
  '/admin/payments/pending',
  protect,
  authorize('admin'),
  getPendingPayments
);

router.put(
  '/admin/payments/:paymentId/verify',
  protect,
  authorize('admin'),
  validate([
    body('verified').isBoolean().withMessage('Verified must be boolean')
  ]),
  verifyPayment
);

module.exports = router;
