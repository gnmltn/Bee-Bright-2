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

// ── New payment method instructions ──────────────────────────────────────
const { getPaymentInstructions } = require('../controllers/enrollmentController');
router.get('/instructions/:method', getPaymentInstructions);

// ── Resubmit payment proof ────────────────────────────────────────────────
router.put('/:paymentId/resubmit', protect, async (req, res) => {
  try {
    const Payment = require('../models/Payment');
    const Enrollment = require('../models/Enrollment');
    const { pushStatusHistory } = require('../services/enrollmentService');
    const { proofDataUrl, payerReference } = req.body || {};

    const payment = await Payment.findById(req.params.paymentId);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });

    // Only rejected payments can be resubmitted
    if (payment.status !== 'rejected')
      return res.status(400).json({ success: false, message: 'Only rejected payments can be resubmitted.' });

    // Save new proof
    const crypto = require('crypto');
    const path = require('path');
    const fs = require('fs');
    const PROOF_DIR = path.join(__dirname, '..', 'uploads', 'payments');
    if (proofDataUrl) {
      const match = proofDataUrl.match(/^data:(image\/(?:png|jpeg|jpg)|application\/pdf);base64,(.+)$/i);
      if (match) {
        const buf = Buffer.from(match[2], 'base64');
        if (!fs.existsSync(PROOF_DIR)) fs.mkdirSync(PROOF_DIR, { recursive: true });
        const ext = match[1].includes('pdf') ? 'pdf' : (match[1].includes('png') ? 'png' : 'jpg');
        const filename = `proof-resub-${payment._id}-${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(PROOF_DIR, filename), buf);
        payment.proofUrl = `/uploads/payments/${filename}`;
      }
    }

    payment.status = 'submitted';
    payment.submittedAt = new Date();
    payment.resubmissionCount = (payment.resubmissionCount || 0) + 1;
    payment.payerReference = String(payerReference || payment.payerReference || '').trim() || null;
    payment.rejectionReason = null;
    await payment.save();

    // Update enrollment status
    if (payment.enrollment) {
      const enrollment = await Enrollment.findById(payment.enrollment);
      if (enrollment) {
        enrollment.allowResubmission = false;
        enrollment.paymentStatus = 'submitted';
        pushStatusHistory(enrollment, 'payment_under_verification', req.user._id, req.user.role, 'Payment resubmitted');
        await enrollment.save();
      }
    }

    return res.status(200).json({ success: true, message: 'Payment proof resubmitted successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});
