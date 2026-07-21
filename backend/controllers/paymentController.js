const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Payment = require('../models/Payment');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const config = require('../config/payment.config');
const { getGcashPublicDetails } = require('../utils/gcashDetails');
const { logAudit } = require('../utils/auditService');
const { cleanupIncompleteUsers } = require('../utils/incompleteUserCleanup');
const { validateName, validatePhoneNoLetters } = require('../utils/validation');

const generateEnrollmentReference = () =>
  `BRGHT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const VALID_PAYMENT_STATUSES = ['pending', 'submitted', 'verified', 'rejected'];
const PAYMENT_SCREENSHOT_DIR = path.join(__dirname, '..', 'uploads', 'payments');
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

const ensurePaymentScreenshotDir = () => {
  if (!fs.existsSync(PAYMENT_SCREENSHOT_DIR)) {
    fs.mkdirSync(PAYMENT_SCREENSHOT_DIR, { recursive: true });
  }
};

const hasCompleteStudentName = (student) => {
  const first = String(student?.firstName || '').trim();
  const last = String(student?.lastName || '').trim();
  return !!first && !!last;
};

const splitValidAndInvalidPayments = (payments) => {
  const valid = [];
  const invalidIds = [];

  (payments || []).forEach((payment) => {
    if (!payment?.student || !hasCompleteStudentName(payment.student)) {
      invalidIds.push(payment?._id);
      return;
    }
    valid.push(payment);
  });

  return { valid, invalidIds: invalidIds.filter(Boolean) };
};

const persistPaymentScreenshot = (rawScreenshotUrl, paymentId) => {
  if (typeof rawScreenshotUrl !== 'string' || !rawScreenshotUrl.trim()) {
    const error = new Error('Screenshot is required.');
    error.statusCode = 400;
    throw error;
  }

  const screenshotUrl = rawScreenshotUrl.trim();

  if (screenshotUrl.startsWith('/uploads/payments/')) {
    return screenshotUrl;
  }

  const match = screenshotUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
  if (!match) {
    const error = new Error('Screenshot must be a JPG or PNG image data URL.');
    error.statusCode = 400;
    throw error;
  }

  const ext = match[1].toLowerCase() === 'jpg' ? 'jpg' : match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) {
    const error = new Error('Screenshot file is empty.');
    error.statusCode = 400;
    throw error;
  }

  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    const error = new Error('Screenshot must be 5MB or less.');
    error.statusCode = 400;
    throw error;
  }

  ensurePaymentScreenshotDir();
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const filename = `proof-${String(paymentId)}-${Date.now()}-${randomSuffix}.${ext}`;
  const absolutePath = path.join(PAYMENT_SCREENSHOT_DIR, filename);
  fs.writeFileSync(absolutePath, buffer);
  return `/uploads/payments/${filename}`;
};

const buildAdminPaymentFilter = (status) => {
  if (!status || status === 'all') {
    return {};
  }

  if (!VALID_PAYMENT_STATUSES.includes(status)) {
    return null;
  }

  return { status };
};

const findAdminPayments = async (status, limit) => {
  const filter = buildAdminPaymentFilter(status);
  if (!filter) {
    const error = new Error('Invalid payment status filter.');
    error.statusCode = 400;
    throw error;
  }

  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 1000)
    : 500;

  return Payment.find(filter)
    .populate('student', 'firstName lastName email phone')
    .populate('enrollment', 'referenceNumber paymentStatus status totalFee paymentOption')
    .populate('verifiedBy', 'firstName lastName role')
    .sort({ createdAt: -1 })
    .limit(safeLimit);
};

const ensureEnrollmentForPayment = async (payment, studentId) => {
  const existingEnrollmentId = payment.enrollment?._id || payment.enrollment;
  if (existingEnrollmentId) {
    return Enrollment.findById(existingEnrollmentId);
  }

  const draft = payment.pendingEnrollment;
  if (!draft?.selectedSubjects?.length || draft.totalFee == null || !draft.paymentOption) {
    return null;
  }

  const enrollment = await Enrollment.create({
    student: studentId,
    selectedSubjects: draft.selectedSubjects,
    totalFee: Number(draft.totalFee),
    paymentOption: draft.paymentOption,
    paymentStatus: 'pending_verification',
    status: 'pending',
    referenceNumber: generateEnrollmentReference()
  });

  payment.enrollment = enrollment._id;
  payment.pendingEnrollment = undefined;
  await payment.save();

  return enrollment;
};

const validateCheckoutStudent = (student) => {
  if (!student || typeof student !== 'object') {
    return 'Checkout student details are required.';
  }

  const {
    firstName,
    middleName,
    lastName,
    email,
    phone,
    password,
    gradeLevel,
    guardianName,
    guardianPhone
  } = student;

  if (!firstName || !lastName || !email || !phone || !password || !gradeLevel || !guardianName) {
    return 'First name, last name, email, phone, password, grade level, and guardian name are required';
  }

  let nameErr = validateName(firstName, 'First name');
  if (nameErr) return nameErr;
  nameErr = validateName(middleName, 'Middle name');
  if (nameErr) return nameErr;
  nameErr = validateName(lastName, 'Last name');
  if (nameErr) return nameErr;
  nameErr = validateName(guardianName, 'Guardian name');
  if (nameErr) return nameErr;

  const phoneErr = validatePhoneNoLetters(phone);
  if (phoneErr) return phoneErr;
  if ((guardianPhone || '').trim()) {
    const gPhoneErr = validatePhoneNoLetters(guardianPhone);
    if (gPhoneErr) return gPhoneErr;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test((email || '').trim().toLowerCase())) {
    return 'Please enter a valid email address';
  }

  const phPhoneRegex = /^(0?9|639)\d{9}$/;
  const phoneDigits = (phone || '').replace(/\D/g, '');
  if (phoneDigits.length !== 11 && phoneDigits.length !== 12) {
    return 'Phone number must be exactly 11 digits.';
  }
  if (!phPhoneRegex.test(phoneDigits)) {
    return 'Please enter a valid Philippine mobile number (e.g. 09XX XXX XXXX or +63 9XX XXX XXXX)';
  }

  if ((guardianPhone || '').trim()) {
    const guardianDigits = (guardianPhone || '').replace(/\D/g, '');
    if (guardianDigits.length !== 11 && guardianDigits.length !== 12) {
      return 'Guardian phone number must be exactly 11 digits.';
    }
    if (!phPhoneRegex.test(guardianDigits)) {
      return 'Please enter a valid Philippine mobile number for guardian (e.g. 09XX XXX XXXX or +63 9XX XXX XXXX)';
    }
  }

  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
  if (!passwordRegex.test(password)) {
    return 'Password must contain at least 8 characters, one uppercase, one lowercase, one number and one special character (@$!%*?&)';
  }

  return null;
};

const resolveCheckoutStudent = async (student) => {
  const validationMessage = validateCheckoutStudent(student);
  if (validationMessage) {
    const error = new Error(validationMessage);
    error.statusCode = 400;
    throw error;
  }

  const normalizedEmail = student.email.toLowerCase().trim();
  const existingUser = await User.findOne({ email: normalizedEmail }).select('+password');

  if (existingUser) {
    if (existingUser.role !== 'student') {
      const error = new Error('An account with this email already exists. Please log in and enroll from your dashboard.');
      error.statusCode = 400;
      throw error;
    }

    const resumableStatuses = ['not_enrolled', 'pending_payment', 'payment_rejected', 'cancelled'];
    const passwordMatches = await existingUser.comparePassword(student.password);

    if (!passwordMatches) {
      const error = new Error('An account with this email already exists. Please log in and enroll from your dashboard.');
      error.statusCode = 400;
      throw error;
    }

    if (existingUser.isActive || !resumableStatuses.includes(existingUser.enrollmentStatus)) {
      const error = new Error('This account already has an enrollment in progress. Please log in to continue from your dashboard.');
      error.statusCode = 400;
      throw error;
    }

    existingUser.firstName = student.firstName.trim();
    existingUser.middleName = (student.middleName || '').trim();
    existingUser.lastName = student.lastName.trim();
    existingUser.phone = student.phone.trim();
    existingUser.gradeLevel = student.gradeLevel;
    existingUser.guardianName = student.guardianName.trim();
    existingUser.guardianPhone = (student.guardianPhone || '').trim();
    existingUser.enrollmentStatus = 'pending_payment';
    existingUser.paymentStatus = 'pending';
    existingUser.emailVerifiedAt = existingUser.emailVerifiedAt || new Date();
    await existingUser.save();
    return existingUser;
  }

  return User.create({
    firstName: student.firstName.trim(),
    middleName: (student.middleName || '').trim(),
    lastName: student.lastName.trim(),
    email: normalizedEmail,
    phone: student.phone.trim(),
    password: student.password,
    role: 'student',
    gradeLevel: student.gradeLevel,
    guardianName: student.guardianName.trim(),
    guardianPhone: (student.guardianPhone || '').trim(),
    enrollmentStatus: 'pending_payment',
    paymentStatus: 'pending',
    emailVerifiedAt: new Date()
  });
};

// @desc Get GCash account info for payment handler (public - so payers can see where to send)
// @route GET /api/payments/gcash-info
// @access Public
const getGcashInfo = async (req, res) => {
  try {
    const gcash = await getGcashPublicDetails();
    res.status(200).json({
      success: true,
      gcash,
      instructions: config.instructions,
      verification: config.verification,
    });
  } catch (error) {
    console.error('GCash info error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get payment details',
    });
  }
};

// @desc Initiate student payment and generate QR code
// @route POST /api/payments/initiate/student
// @access Private (Student)
const initiateStudentPayment = async (req, res) => {
  try {
    const { enrollmentId } = req.body;
    const requestedMethod = String(req.body?.paymentMethod || 'blockchain').toLowerCase();
    const paymentMethod = requestedMethod === 'gcash' ? 'gcash' : 'blockchain';
    const studentId = req.user.id;

    // Find enrollment
    const enrollment = await Enrollment.findOne({
      _id: enrollmentId,
      student: studentId
    }).populate('selectedSubjects');

    if (!enrollment) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment not found'
      });
    }

    // Check if payment already exists and is not expired
    const existingPayment = await Payment.findOne({
      enrollment: enrollmentId,
      paymentMethod,
      status: { $in: ['pending', 'submitted'] },
      expiresAt: { $gt: new Date() }
    });

    if (existingPayment) {
      const existingResponse = {
        success: true,
        message: 'Active payment already exists',
        payment: {
          id: existingPayment._id,
          _id: existingPayment._id,
          referenceNumber: existingPayment.referenceNumber,
          amount: existingPayment.amount,
          status: existingPayment.status,
          expiresAt: existingPayment.expiresAt,
          paymentMethod,
        },
      };

      if (paymentMethod === 'gcash') {
        existingResponse.gcash = await getGcashPublicDetails();
        return res.status(200).json(existingResponse);
      }

      const existingAmountEth = Number(existingPayment.amount) / (config.blockchain?.phpPerEth || 250000);
      return res.status(200).json({
        ...existingResponse,
        blockchain: {
          amountEth: existingAmountEth,
          contractAddress: config.blockchain?.contractAddress || '',
          recipientAddress: config.blockchain?.recipientAddress || '',
          chainId: config.blockchain?.chainId ?? 1337,
          phpPerEth: config.blockchain?.phpPerEth || 250000,
          referenceNumber: existingPayment.referenceNumber,
        },
      });
    }

    // Calculate amount
    let amount;
    if (enrollment.paymentOption === 'full') {
      amount = enrollment.totalFee;
    } else if (enrollment.paymentOption === 'down') {
      amount = enrollment.totalFee * 0.5; // 50% down payment
    }

    // Create payment record (blockchain)
    const phpPerEth = config.blockchain?.phpPerEth || 250000;
    const amountEth = amount / phpPerEth;

    const payment = await Payment.create({
      student: studentId,
      enrollment: enrollmentId,
      amount: amount,
      paymentType: enrollment.paymentOption,
      status: 'pending',
      paymentMethod,
    });

    const response = {
      success: true,
      message: 'Payment initiated successfully',
      payment: {
        id: payment._id,
        _id: payment._id,
        referenceNumber: payment.referenceNumber,
        amount: payment.amount,
        status: payment.status,
        expiresAt: payment.expiresAt,
        paymentMethod,
      },
    };

    if (paymentMethod === 'gcash') {
      response.gcash = await getGcashPublicDetails();
      return res.status(200).json(response);
    }

    return res.status(200).json({
      ...response,
      blockchain: {
        amountEth,
        contractAddress: config.blockchain?.contractAddress || '',
        recipientAddress: config.blockchain?.recipientAddress || '',
        chainId: config.blockchain?.chainId ?? 1337,
        phpPerEth,
        referenceNumber: payment.referenceNumber
      }
    });

  } catch (error) {
    console.error('Payment initiation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initiate payment',
      error: error.message
    });
  }
};

// @desc Submit payment proof
// @route POST /api/payments/:paymentId/submit-proof
// @access Private (Student)
const submitPaymentProof = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const {
      mobileNumber,
      transactionId,
      screenshotUrl,
      transactionHash,
      fromAddress,
      amountEth,
      checkoutToken,
      checkoutStudent
    } = req.body;
    let studentId = req.user?._id || req.user?.id;

    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: 'Payment ID is required'
      });
    }

    let payment;
    if (studentId) {
      payment = await Payment.findOne({
        _id: paymentId,
        student: studentId
      });
    } else {
      if (!checkoutToken) {
        return res.status(400).json({
          success: false,
          message: 'Checkout token is required'
        });
      }

      payment = await Payment.findOne({
        _id: paymentId,
        checkoutToken
      });
    }

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found. Please close this window and start payment again from the enrollment page.'
      });
    }

    if (payment.expiresAt && new Date() > payment.expiresAt) {
      return res.status(400).json({
        success: false,
        message: 'Payment session has expired. Please start a new payment from the enrollment page.'
      });
    }

    if (payment.status === 'verified') {
      return res.status(400).json({
        success: false,
        message: 'Payment already verified'
      });
    }

    if (payment.status === 'submitted') {
      return res.status(409).json({
        success: false,
        message: 'Payment proof already submitted and pending verification.'
      });
    }

    if (!studentId) {
      const normalizedCheckoutEmail = checkoutStudent?.email?.trim().toLowerCase();
      if (payment.checkoutEmail && normalizedCheckoutEmail !== payment.checkoutEmail) {
        return res.status(400).json({
          success: false,
          message: 'The verified email does not match this checkout session. Please restart enrollment verification.'
        });
      }

      if (payment.student) {
        studentId = payment.student;
      } else {
        const checkoutUser = await resolveCheckoutStudent(checkoutStudent);
        studentId = checkoutUser._id;
        payment.student = studentId;
      }
    }

    const storedScreenshotUrl = persistPaymentScreenshot(screenshotUrl, payment._id);

    if (payment.paymentMethod === 'blockchain') {
      if (!transactionHash || !String(transactionHash).trim()) {
        return res.status(400).json({
          success: false,
          message: 'Transaction hash is required for blockchain payments.'
        });
      }

      payment.blockchainPayment = {
        transactionHash,
        fromAddress: fromAddress || '',
        amountEth: amountEth != null ? Number(amountEth) : undefined,
        network: 'ganache'
      };
      payment.gcashDetails = {
        mobileNumber: '',
        transactionId: transactionHash,
        screenshotUrl: storedScreenshotUrl
      };
    } else {
      payment.gcashDetails = {
        mobileNumber: mobileNumber || '',
        transactionId: transactionId || '',
        screenshotUrl: storedScreenshotUrl
      };
      payment.blockchainPayment = undefined;
    }
    payment.status = 'submitted';
    await payment.save();

    const enrollment = await ensureEnrollmentForPayment(payment, studentId);
    if (!enrollment) {
      return res.status(400).json({
        success: false,
        message: 'Enrollment draft was not found for this payment. Please restart enrollment and submit payment again.'
      });
    }

    if (enrollment.paymentStatus !== 'pending_verification' || enrollment.status !== 'pending') {
      enrollment.paymentStatus = 'pending_verification';
      enrollment.status = 'pending';
      await enrollment.save();
    }

    await User.findByIdAndUpdate(studentId, {
      enrollmentStatus: 'payment_submitted',
      paymentStatus: 'pending_verification'
    });

    logAudit({
      req,
      userId: studentId,
      action: 'Payment Proof Submitted',
      module: 'Payment',
      description: 'Student submitted payment proof',
      status: 'SUCCESS',
      metadata: { paymentId: payment._id, amount: payment.amount }
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Payment proof submitted successfully. We will verify within 1-2 business days.',
      payment
    });

  } catch (error) {
    console.error('Submit proof error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : (error.message || 'Failed to submit payment proof')
    });
  }
};

// @desc Get payment status
// @route GET /api/payments/:paymentId/status
// @access Private
const getPaymentStatus = async (req, res) => {
  try {
    const { paymentId } = req.params;

    const payment = await Payment.findById(paymentId)
      .populate('student', 'firstName lastName email')
      .populate('enrollment');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    res.status(200).json({
      success: true,
      payment
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc Get enrollment payment status
// @route GET /api/payments/student/status/:enrollmentId
// @access Private (Student)
const getEnrollmentPaymentStatus = async (req, res) => {
  try {
    const { enrollmentId } = req.params;
    const studentId = req.user.id;

    const payment = await Payment.findOne({
      enrollment: enrollmentId,
      student: studentId
    }).sort({ createdAt: -1 });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'No payment found for this enrollment'
      });
    }

    res.status(200).json({
      success: true,
      payment
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc Get all student's payments
// @route GET /api/payments/student/my-payments
// @access Private (Student)
const getMyPayments = async (req, res) => {
  try {
    const studentId = req.user.id;

    const payments = await Payment.find({ student: studentId })
      .populate('enrollment')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: payments.length,
      payments
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc Get admin payment history
// @route GET /api/payments/admin/payments
// @access Private (Admin)
const getAdminPayments = async (req, res) => {
  try {
    await cleanupIncompleteUsers();
    const { status = 'all', limit } = req.query;
    const payments = await findAdminPayments(String(status).toLowerCase(), limit);
    const { valid, invalidIds } = splitValidAndInvalidPayments(payments);
    if (invalidIds.length > 0) {
      await Payment.deleteMany({ _id: { $in: invalidIds } });
    }

    res.status(200).json({
      success: true,
      count: valid.length,
      payments: valid
    });

  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to fetch payments'
    });
  }
};

// @desc Get all pending payments (Admin)
// @route GET /api/admin/payments/pending
// @access Private (Admin)
const getPendingPayments = async (req, res) => {
  try {
    await cleanupIncompleteUsers();
    const payments = await findAdminPayments('submitted');
    const { valid, invalidIds } = splitValidAndInvalidPayments(payments);
    if (invalidIds.length > 0) {
      await Payment.deleteMany({ _id: { $in: invalidIds } });
    }

    res.status(200).json({
      success: true,
      count: valid.length,
      payments: valid
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc Verify payment (Admin)
// @route PUT /api/admin/payments/:paymentId/verify
// @access Private (Admin)
const verifyPayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { verified, rejectionReason } = req.body;
    const adminId = req.user.id;

    const payment = await Payment.findById(paymentId).populate('enrollment');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    let enrollment = payment.enrollment;

    if (verified) {
      if (!enrollment) {
        enrollment = await ensureEnrollmentForPayment(payment, payment.student);
      }

      if (!enrollment) {
        return res.status(400).json({
          success: false,
          message: 'Missing enrollment checkout data for this payment.'
        });
      }

      // Verify payment
      payment.status = 'verified';
      payment.verifiedAt = new Date();
      payment.verifiedBy = adminId;

      // Update enrollment
      if (enrollment) {
        enrollment.paymentStatus = 'paid';
        enrollment.status = 'active';
        await enrollment.save();
      }

      await User.findByIdAndUpdate(payment.student, {
        enrollmentStatus: 'active',
        paymentStatus: 'verified',
        isActive: true
      });

      await payment.save();

      logAudit({
        req,
        userId: adminId,
        action: 'Verify Payment',
        module: 'Payment',
        description: 'Admin verified payment',
        status: 'SUCCESS',
        metadata: { paymentId, amount: payment.amount, paymentMethod: payment.paymentMethod }
      }).catch(() => {});

      res.status(200).json({
        success: true,
        message: 'Payment verified successfully',
        payment
      });

    } else {
      // Reject payment
      payment.status = 'rejected';
      payment.rejectionReason = rejectionReason || 'Payment verification failed';

      // Update enrollment
      if (enrollment) {
        enrollment.paymentStatus = 'failed';
        enrollment.status = 'cancelled';
        await enrollment.save();
      }

      await User.findByIdAndUpdate(payment.student, {
        enrollmentStatus: 'payment_rejected',
        paymentStatus: 'rejected',
        isActive: false
      });

      await payment.save();

      logAudit({
        req,
        userId: adminId,
        action: 'Reject Payment',
        module: 'Payment',
        description: 'Admin rejected payment',
        status: 'SUCCESS',
        metadata: { paymentId, amount: payment.amount }
      }).catch(() => {});

      res.status(200).json({
        success: true,
        message: 'Payment rejected',
        payment
      });
    }

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

module.exports = {
  getGcashInfo,
  initiateStudentPayment,
  submitPaymentProof,
  getPaymentStatus,
  getEnrollmentPaymentStatus,
  getMyPayments,
  getAdminPayments,
  getPendingPayments,
  verifyPayment
};
