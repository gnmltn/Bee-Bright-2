/**
 * Centralized input validation rules (express-validator) for security.
 * Use with validate() middleware from ./validate.js
 */
const { body } = require('express-validator');

const enrollmentSubmitRules = [
  body('selectedSubjectCodes').isArray({ min: 1 }).withMessage('Select at least one subject'),
  body('totalFee').isFloat({ min: 0 }).withMessage('Invalid total fee'),
  body('paymentOption').isIn(['full', 'down']).withMessage('Invalid payment option'),
  body('paymentMethod').optional().isIn(['gcash', 'blockchain']).withMessage('Invalid payment method'),
  body('firstName').optional().trim().isLength({ max: 100 }),
  body('lastName').optional().trim().isLength({ max: 100 }),
  body('email').optional().trim().isEmail().toLowerCase(),
  body('phone').optional().trim().isLength({ max: 11 }),
  body('guardianName').optional().trim().isLength({ max: 50 }),
  body('guardianPhone').optional().trim().isLength({ max: 20 }),
  body('password').optional().isLength({ min: 8, max: 20 }),
  body('gradeLevel').optional().trim().isLength({ max: 50 }),
];

const paymentProofRules = [
  body('mobileNumber').trim().notEmpty().withMessage('Mobile number is required').isLength({ max: 11 }),
  body('transactionId').trim().notEmpty().withMessage('Transaction ID is required').isLength({ max: 12 }),
  body('screenshotUrl').notEmpty().withMessage('Screenshot is required').isString().isLength({ max: 10 * 1024 * 1024 }),
];

module.exports = {
  enrollmentSubmitRules,
  paymentProofRules,
};
