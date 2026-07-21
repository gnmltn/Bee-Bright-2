const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const Subject = require('../models/Subject');
const Payment = require('../models/Payment');
const EnrollmentVerification = require('../models/EnrollmentVerification');
const paymentConfig = require('../config/payment.config');
const { getGcashPublicDetails } = require('../utils/gcashDetails');
const {
  sendEnrollmentRejectionEmail,
  sendEnrollmentVerificationEmail,
  getEmailErrorMessage,
  logEmailError,
} = require('../utils/emailService');
const { logAudit } = require('../utils/auditService');
const { cleanupIncompleteUsers } = require('../utils/incompleteUserCleanup');
const { validateName, validatePhoneNoLetters } = require('../utils/validation');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// All programs: Monday-Saturday 8:00 AM - 6:00 PM (for scheduling flow)
const DEFAULT_SCHEDULE = 'Mon - Sat 8:00 AM - 6:00 PM';

// Map frontend service ids to Subject codes and full definitions (create if missing)
const SERVICE_CODE_MAP = {
  toddlers: 'TPG101',
  prek: 'PKR105',
  academic: 'ACT102',
  sped: 'SPT103',
  examprep: 'EXP106',
  kinder: 'KRP104'
};

const SUBJECT_CATALOG = {
  TPG101: { name: 'Toddlers Playgroup', schedule: DEFAULT_SCHEDULE, price: 3000, description: 'Socialization, sensory play, early development' },
  PKR105: { name: 'Pre-Kindergarten Readiness Program', schedule: DEFAULT_SCHEDULE, price: 3200, description: 'Foundational academic skills, phonics, basic reading & writing' },
  ACT102: { name: 'Academic Tutorial', schedule: DEFAULT_SCHEDULE, price: 2500, description: 'Subject-based support Grade 1 to Junior High' },
  SPT103: { name: 'SPED Tutorial', schedule: DEFAULT_SCHEDULE, price: 3500, description: 'Individualized learning support, IEP-based' },
  EXP106: { name: 'Examination Preparation', schedule: DEFAULT_SCHEDULE, price: 3500, description: 'Test mastery, mock exams, test-taking strategies' },
  KRP104: { name: 'Kindergarten Readiness Program', schedule: DEFAULT_SCHEDULE, price: 3000, description: 'School-entry preparation, reading & writing readiness' }
};

// Ensure subjects exist in DB (create if missing) and return their IDs in the same order as codes
async function ensureSubjectsByCodes(codes) {
  const subjectIds = [];
  for (const code of codes) {
    let subject = await Subject.findOne({ code });
    if (!subject) {
      const def = SUBJECT_CATALOG[code];
      if (!def) continue;
      subject = await Subject.create({
        code,
        name: def.name,
        schedule: def.schedule,
        price: def.price,
        description: def.description || def.name,
        duration: '2 hours per session',
        capacity: 20
      });
    }
    subjectIds.push(subject._id);
  }
  return subjectIds;
}

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d'
  });
};

const ENROLLMENT_OTP_EXPIRES_MINUTES = 5;
const ENROLLMENT_OTP_RESEND_SECONDS = 120;
const ENROLLMENT_OTP_MAX_ATTEMPTS = 5;
const ENROLLMENT_VERIFIED_WINDOW_MINUTES = 30;

const generateCheckoutToken = () => crypto.randomBytes(24).toString('hex');
const normalizeEmail = (email = '') => email.trim().toLowerCase();
const generateOtpCode = () => String(Math.floor(100000 + Math.random() * 900000));
const hashOtpCode = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');

const isRecentlyVerified = (verification) => {
  if (!verification?.verifiedAt) return false;
  const cutoff = Date.now() - ENROLLMENT_VERIFIED_WINDOW_MINUTES * 60 * 1000;
  return verification.verifiedAt.getTime() >= cutoff;
};

const normalizeIdArray = (values) => {
  const set = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value || '').trim();
    if (id) set.add(id);
  }
  return Array.from(set);
};

const findDuplicateActiveEnrollment = async (studentId, subjectIds) => {
  if (!studentId || !subjectIds?.length) return null;
  return Enrollment.findOne({
    student: studentId,
    status: { $in: ['pending', 'active'] },
    selectedSubjects: { $all: subjectIds, $size: subjectIds.length }
  }).sort({ createdAt: -1 });
};


// @desc    Send enrollment email verification code
// @route   POST /api/enrollments/send-verification-code
// @access  Public
const sendEnrollmentVerificationCode = async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email || '');
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address.',
      });
    }

    let verification = await EnrollmentVerification.findOne({ email: normalizedEmail }).select(
      '+otpHash +otpExpiresAt +otpAttempts +lastSentAt'
    );

    if (!verification) {
      verification = new EnrollmentVerification({ email: normalizedEmail });
    }

    if (
      verification.lastSentAt &&
      Date.now() - verification.lastSentAt.getTime() < ENROLLMENT_OTP_RESEND_SECONDS * 1000
    ) {
      return res.status(429).json({
        success: false,
        message: `Please wait ${ENROLLMENT_OTP_RESEND_SECONDS} seconds before requesting another code.`,
      });
    }

    const otp = generateOtpCode();
    verification.otpHash = hashOtpCode(otp);
    verification.otpExpiresAt = new Date(Date.now() + ENROLLMENT_OTP_EXPIRES_MINUTES * 60 * 1000);
    verification.otpAttempts = 0;
    verification.verifiedAt = null;
    await verification.save();

    try {
      await sendEnrollmentVerificationEmail(normalizedEmail, otp, ENROLLMENT_OTP_EXPIRES_MINUTES);
      verification.lastSentAt = new Date();
      await verification.save();

      return res.status(200).json({
        success: true,
        message: 'Verification code sent. Please check your email inbox.',
      });
    } catch (emailError) {
      verification.otpHash = undefined;
      verification.otpExpiresAt = undefined;
      verification.otpAttempts = 0;
      verification.lastSentAt = undefined;
      await verification.save();

      logEmailError('enrollment verification email send failed', emailError, { email: normalizedEmail });

      return res.status(502).json({
        success: false,
        message: getEmailErrorMessage(emailError),
      });
    }
  } catch (error) {
    console.error('sendEnrollmentVerificationCode error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send verification code.',
    });
  }
};

// @desc    Verify enrollment email verification code
// @route   POST /api/enrollments/verify-email-code
// @access  Public
const verifyEnrollmentEmailCode = async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email || '');
    const code = String(req.body?.code || '').trim();

    if (!normalizedEmail || !code) {
      return res.status(400).json({
        success: false,
        message: 'Email and verification code are required.',
      });
    }

    const verification = await EnrollmentVerification.findOne({ email: normalizedEmail }).select(
      '+otpHash +otpExpiresAt +otpAttempts +lastSentAt'
    );

    if (!verification?.otpHash || !verification.otpExpiresAt) {
      return res.status(400).json({
        success: false,
        message: 'No active verification code was found for this email.',
      });
    }

    if (verification.otpAttempts >= ENROLLMENT_OTP_MAX_ATTEMPTS) {
      return res.status(429).json({
        success: false,
        message: 'Too many incorrect attempts. Please request a new verification code.',
      });
    }

    if (verification.otpExpiresAt.getTime() < Date.now()) {
      verification.otpHash = undefined;
      verification.otpExpiresAt = undefined;
      verification.otpAttempts = 0;
      await verification.save();
      return res.status(400).json({
        success: false,
        message: 'Verification code has expired. Please request a new one.',
      });
    }

    if (verification.otpHash !== hashOtpCode(code)) {
      verification.otpAttempts += 1;
      if (verification.otpAttempts >= ENROLLMENT_OTP_MAX_ATTEMPTS) {
        verification.otpHash = undefined;
        verification.otpExpiresAt = undefined;
      }
      await verification.save();
      return res.status(400).json({
        success: false,
        message:
          verification.otpAttempts >= ENROLLMENT_OTP_MAX_ATTEMPTS
            ? 'Too many incorrect attempts. Please request a new verification code.'
            : 'Incorrect verification code.',
      });
    }

    verification.verifiedAt = new Date();
    verification.otpHash = undefined;
    verification.otpExpiresAt = undefined;
    verification.otpAttempts = 0;
    await verification.save();

    res.status(200).json({
      success: true,
      message: 'Email verified successfully.',
      verifiedAt: verification.verifiedAt,
    });
  } catch (error) {
    console.error('verifyEnrollmentEmailCode error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to verify email code.',
    });
  }
};

const buildPaymentSessionResponse = async (payment) => {
  const phpPerEth = paymentConfig.blockchain?.phpPerEth || 250000;
  const amountEth = Number(payment.amount) / phpPerEth;
  const method = payment.paymentMethod === 'gcash' ? 'gcash' : 'blockchain';

  const response = {
    payment: {
      id: payment._id,
      _id: payment._id,
      referenceNumber: payment.referenceNumber,
      amount: payment.amount,
      status: payment.status,
      expiresAt: payment.expiresAt,
      checkoutToken: payment.checkoutToken || null,
      paymentMethod: method,
    },
  };

  if (method === 'gcash') {
    return {
      ...response,
      gcash: await getGcashPublicDetails(),
    };
  }

  return {
    ...response,
    blockchain: {
      amountEth,
      contractAddress: paymentConfig.blockchain?.contractAddress || '',
      recipientAddress: paymentConfig.blockchain?.recipientAddress || '',
      chainId: paymentConfig.blockchain?.chainId ?? 1337,
      phpPerEth,
      referenceNumber: payment.referenceNumber
    }
  };
};

const mapPaymentToEnrollmentState = (paymentStatus) => {
  if (paymentStatus === 'verified') {
    return { paymentStatus: 'paid', status: 'active' };
  }
  if (paymentStatus === 'rejected') {
    return { paymentStatus: 'failed', status: 'cancelled' };
  }
  if (paymentStatus === 'submitted') {
    return { paymentStatus: 'pending_verification', status: 'pending' };
  }
  return { paymentStatus: 'pending', status: 'pending' };
};

const backfillMissingEnrollmentsFromPayments = async () => {
  const orphanPayments = await Payment.find({
    enrollment: { $exists: false },
    student: { $exists: true, $ne: null },
    'pendingEnrollment.selectedSubjects.0': { $exists: true },
    'pendingEnrollment.totalFee': { $exists: true },
    'pendingEnrollment.paymentOption': { $in: ['full', 'down'] }
  }).sort({ createdAt: 1 });

  for (const payment of orphanPayments) {
    const draft = payment.pendingEnrollment;
    if (!draft?.selectedSubjects?.length || draft.totalFee == null || !draft.paymentOption) {
      continue;
    }

    const state = mapPaymentToEnrollmentState(payment.status);

    const existing = await Enrollment.findOne({
      student: payment.student,
      totalFee: Number(draft.totalFee),
      paymentOption: draft.paymentOption,
      selectedSubjects: { $all: draft.selectedSubjects, $size: draft.selectedSubjects.length }
    }).sort({ createdAt: -1 });

    const enrollment = existing || await Enrollment.create({
      student: payment.student,
      selectedSubjects: draft.selectedSubjects,
      totalFee: Number(draft.totalFee),
      paymentOption: draft.paymentOption,
      paymentStatus: state.paymentStatus,
      status: state.status,
      referenceNumber: `BRGHT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    });

    if (existing) {
      existing.paymentStatus = state.paymentStatus;
      existing.status = state.status;
      await existing.save();
    }

    payment.enrollment = enrollment._id;
    payment.pendingEnrollment = undefined;
    await payment.save();
  }
};

// @desc    Submit enrollment (public: register + enroll, or authenticated: enroll only)
// @route   POST /api/enrollments/submit
// @access  Public (optional auth)
const submitEnrollment = async (req, res) => {
  try {
    const {
      firstName,
      middleName,
      lastName,
      email,
      phone,
      password,
      gradeLevel,
      guardianName,
      guardianPhone,
      selectedSubjectCodes,
      totalFee,
      paymentOption,
      paymentMethod: requestedPaymentMethod
    } = req.body;
    const paymentMethod = String(requestedPaymentMethod || 'blockchain').toLowerCase() === 'gcash'
      ? 'gcash'
      : 'blockchain';

    if (!selectedSubjectCodes || !Array.isArray(selectedSubjectCodes) || selectedSubjectCodes.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please select at least one subject'
      });
    }
    if (totalFee == null || totalFee < 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid total fee'
      });
    }
    if (!['full', 'down'].includes(paymentOption)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment option'
      });
    }

    const codes = selectedSubjectCodes.map(id => SERVICE_CODE_MAP[id] || id).filter(Boolean);
    if (codes.length !== selectedSubjectCodes.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more selected subjects are invalid'
      });
    }
    const subjectIds = normalizeIdArray(await ensureSubjectsByCodes(codes));
    if (subjectIds.length !== codes.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more selected subjects are invalid'
      });
    }

    let studentId = null;
    let normalizedPublicEmail = null;

    if (req.user && req.user.role === 'student') {
      studentId = req.user._id;
    } else {
      if (!firstName || !lastName || !email || !phone || !password || !gradeLevel || !guardianName) {
        return res.status(400).json({
          success: false,
          message: 'First name, last name, email, phone, password, grade level, and guardian name are required'
        });
      }
      let nameErr = validateName(firstName, 'First name');
      if (nameErr) return res.status(400).json({ success: false, message: nameErr });
      nameErr = validateName(middleName, 'Middle name');
      if (nameErr) return res.status(400).json({ success: false, message: nameErr });
      nameErr = validateName(lastName, 'Last name');
      if (nameErr) return res.status(400).json({ success: false, message: nameErr });
      nameErr = validateName(guardianName, 'Guardian name');
      if (nameErr) return res.status(400).json({ success: false, message: nameErr });
      const phoneErr = validatePhoneNoLetters(phone);
      if (phoneErr) return res.status(400).json({ success: false, message: phoneErr });
      if ((guardianPhone || '').trim()) {
        const gPhoneErr = validatePhoneNoLetters(guardianPhone);
        if (gPhoneErr) return res.status(400).json({ success: false, message: gPhoneErr });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test((email || '').trim().toLowerCase())) {
        return res.status(400).json({
          success: false,
          message: 'Please enter a valid email address'
        });
      }
      const phPhoneRegex = /^(0?9|639)\d{9}$/;
      const phoneDigits = (phone || '').replace(/\D/g, '');
      if (phoneDigits.length !== 11 && phoneDigits.length !== 12) {
        return res.status(400).json({
          success: false,
          message: 'Phone number must be exactly 11 digits.'
        });
      }
      if (!phPhoneRegex.test(phoneDigits)) {
        return res.status(400).json({
          success: false,
          message: 'Please enter a valid Philippine mobile number (e.g. 09XX XXX XXXX or +63 9XX XXX XXXX)'
        });
      }
      if ((guardianPhone || '').trim()) {
        const guardianDigits = (guardianPhone || '').replace(/\D/g, '');
        if (guardianDigits.length !== 11 && guardianDigits.length !== 12) {
          return res.status(400).json({
            success: false,
            message: 'Guardian phone number must be exactly 11 digits.'
          });
        }
        if (!phPhoneRegex.test(guardianDigits)) {
          return res.status(400).json({
            success: false,
            message: 'Please enter a valid Philippine mobile number for guardian (e.g. 09XX XXX XXXX or +63 9XX XXX XXXX)'
          });
        }
      }
      const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
      if (!passwordRegex.test(password)) {
        return res.status(400).json({
          success: false,
          message: 'Password must contain at least 8 characters, one uppercase, one lowercase, one number and one special character (@$!%*?&)'
        });
      }
      const normalizedEmail = normalizeEmail(email);
      normalizedPublicEmail = normalizedEmail;
      const verification = await EnrollmentVerification.findOne({ email: normalizedEmail });
      if (!isRecentlyVerified(verification)) {
        return res.status(400).json({
          success: false,
          message: 'Please verify your email address before continuing to Select Services.',
        });
      }
      const userExists = await User.findOne({ email: normalizedEmail }).select('+password');
      if (userExists) {
        if (userExists.role !== 'student') {
          return res.status(400).json({
            success: false,
            message: 'An account with this email already exists. Please log in and enroll from your dashboard.'
          });
        }

        const resumableStatuses = ['not_enrolled', 'pending_payment', 'payment_rejected', 'cancelled'];
        const passwordMatches = await userExists.comparePassword(password);

        if (!passwordMatches) {
          return res.status(400).json({
            success: false,
            message: 'An account with this email already exists. Please log in and enroll from your dashboard.'
          });
        }

        if (userExists.isActive || !resumableStatuses.includes(userExists.enrollmentStatus)) {
          return res.status(400).json({
            success: false,
            message: 'This account already has an enrollment in progress. Please log in to continue from your dashboard.'
          });
        }

        userExists.firstName = firstName.trim();
        userExists.middleName = (middleName || '').trim();
        userExists.lastName = lastName.trim();
        userExists.phone = phone.trim();
        userExists.gradeLevel = gradeLevel;
        userExists.guardianName = guardianName.trim();
        userExists.guardianPhone = (guardianPhone || '').trim();
        await userExists.save();

        studentId = userExists._id;
      }
    }

    const totalFeeNumber = Number(totalFee);
    const amountToPay = paymentOption === 'full'
      ? totalFeeNumber
      : Math.ceil(totalFeeNumber * 0.5);

    let payment = null;
    if (studentId) {
      const duplicateEnrollment = await findDuplicateActiveEnrollment(studentId, subjectIds);
      if (duplicateEnrollment) {
        return res.status(400).json({
          success: false,
          message: 'Duplicate enrollment detected for the selected subjects. Please continue using the existing enrollment record.'
        });
      }

      payment = await Payment.findOne({
        student: studentId,
        enrollment: { $exists: false },
        status: 'pending',
        paymentMethod,
        paymentType: paymentOption,
        expiresAt: { $gt: new Date() },
        'pendingEnrollment.totalFee': totalFeeNumber,
        'pendingEnrollment.paymentOption': paymentOption,
        'pendingEnrollment.selectedSubjects': { $all: subjectIds, $size: subjectIds.length }
      }).sort({ createdAt: -1 });
    }

    if (!payment) {
      payment = await Payment.create({
        ...(studentId ? { student: studentId } : {}),
        ...(normalizedPublicEmail ? { checkoutEmail: normalizedPublicEmail } : {}),
        amount: amountToPay,
        paymentType: paymentOption,
        status: 'pending',
        paymentMethod,
        checkoutToken: generateCheckoutToken(),
        pendingEnrollment: {
          selectedSubjects: subjectIds,
          totalFee: totalFeeNumber,
          paymentOption
        }
      });
    }

    if (studentId) {
      await User.findByIdAndUpdate(studentId, {
        enrollmentStatus: 'pending_payment',
        paymentStatus: 'pending'
      });
    }

    const paymentSession = await buildPaymentSessionResponse(payment);
    const response = {
      success: true,
      message: 'Payment session created. Complete the payment and submit proof to finish enrollment.',
      ...paymentSession
    };
    res.status(201).json(response);
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({ success: false, message: messages.join(', ') });
    }
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Email already exists' });
    }
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to submit enrollment'
    });
  }
};

// @desc    Create enrollment
// @route   POST /api/enrollments
// @access  Private
const createEnrollment = async (req, res) => {
  try {
    const { studentId, selectedSubjects, totalFee, paymentOption } = req.body;
    const normalizedSubjects = normalizeIdArray(selectedSubjects);

    if (!studentId || normalizedSubjects.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'studentId and at least one selected subject are required'
      });
    }

    const duplicateEnrollment = await findDuplicateActiveEnrollment(studentId, normalizedSubjects);
    if (duplicateEnrollment) {
      return res.status(400).json({
        success: false,
        message: 'Duplicate enrollment detected for this student and subject set'
      });
    }

    // Create enrollment record
    const enrollment = await Enrollment.create({
      student: studentId,
      selectedSubjects: normalizedSubjects,
      totalFee,
      paymentOption,
      paymentStatus: 'pending',
      status: 'pending',
      referenceNumber: `BRGHT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    });

    // Update user's enrollment status
    await User.findByIdAndUpdate(studentId, {
      enrollmentStatus: 'pending_payment'
    });

    res.status(201).json({
      success: true,
      enrollment
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

const getMyEnrollments = async (req, res) => {
  try {
    const studentId = req.user.id;
    
    const enrollments = await Enrollment.find({ student: studentId })
      .populate('selectedSubjects')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: enrollments.length,
      enrollments
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

const getAllEnrollments = async (req, res) => {
  try {
    await cleanupIncompleteUsers();
    await backfillMissingEnrollmentsFromPayments();

    const enrollments = await Enrollment.find()
      .populate('student', 'firstName lastName email phone gradeLevel profileImage')
      .populate('selectedSubjects')
      .sort({ createdAt: -1 });

    // Exclude orphaned enrollments where the referenced student no longer exists.
    const validEnrollments = enrollments.filter((enrollment) => enrollment?.student?._id);

    res.status(200).json({
      success: true,
      count: validEnrollments.length,
      enrollments: validEnrollments
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get single enrollment by ID (admin) with payments for proof-of-payment view
// @route   GET /api/enrollments/:id
// @access  Private (Admin only)
const getEnrollmentById = async (req, res) => {
  try {
    const { id } = req.params;
    const enrollment = await Enrollment.findById(id)
      .populate('student', 'firstName lastName email phone gradeLevel profileImage guardianName guardianPhone')
      .populate('selectedSubjects');

    if (!enrollment) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment not found'
      });
    }

    const Payment = require('../models/Payment');
    const payments = await Payment.find({ enrollment: id })
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      enrollment,
      payments
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch enrollment'
    });
  }
};

const updateEnrollmentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const enrollment = await Enrollment.findById(id);
    
    if (!enrollment) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment not found'
      });
    }

    enrollment.status = status;
    await enrollment.save();

    // Update user's enrollment status if needed
    if (status === 'active') {
      await User.findByIdAndUpdate(enrollment.student, {
        enrollmentStatus: 'active',
        isActive: true
      });
    }

    res.status(200).json({
      success: true,
      enrollment
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Accept or reject enrollment (admin). When accepted, student is officially enrolled.
// @route   PUT /api/enrollments/:id/verify-payment
// @access  Private (Admin only)
const verifyPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { verified } = req.body;

    if (typeof verified !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'verified must be true (accept) or false (reject)'
      });
    }

    const enrollment = await Enrollment.findById(id).populate('student');
    
    if (!enrollment) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment not found'
      });
    }

    const studentId = enrollment.student?._id || enrollment.student;

    if (verified) {
      // Accept: mark enrollment and payment as settled, student officially enrolled
      enrollment.paymentStatus = 'paid';
      enrollment.status = 'active';
      enrollment.paymentVerifiedAt = new Date();
      enrollment.verifiedBy = req.user.id;
      await enrollment.save();

      // Mark any payment records for this enrollment as verified
      await Payment.updateMany(
        { enrollment: id },
        { $set: { status: 'verified', verifiedAt: new Date(), verifiedBy: req.user.id } }
      );

      // Student is officially enrolled
      if (studentId) {
        await User.findByIdAndUpdate(studentId, {
          enrollmentStatus: 'active',
          isActive: true
        });
      }

      logAudit({
        req,
        userId: req.user.id,
        action: 'Approve Enrollment',
        module: 'Enrollment',
        description: `Approved enrollment for student`,
        status: 'SUCCESS',
        metadata: { enrollmentId: id, studentId }
      }).catch(() => {});

      res.status(200).json({
        success: true,
        message: 'Enrollment accepted. Student is officially enrolled.',
        enrollment
      });
    } else {
      // Reject: mark enrollment and payment as failed, student not enrolled
      enrollment.paymentStatus = 'failed';
      enrollment.status = 'cancelled';
      await enrollment.save();

      await Payment.updateMany(
        { enrollment: id },
        { $set: { status: 'rejected', rejectionReason: 'Enrollment rejected by admin' } }
      );

      if (studentId) {
        await User.findByIdAndUpdate(studentId, {
          enrollmentStatus: 'payment_rejected',
          isActive: false
        });
      }

      // Send rejection email to student's Gmail
      const student = enrollment.student;
      const studentEmail = student?.email || (student && typeof student === 'object' ? student.email : null);
      const studentName = student
        ? [student.firstName, student.middleName, student.lastName].filter(Boolean).join(' ') || 'Student'
        : 'Student';
      if (studentEmail) {
        await sendEnrollmentRejectionEmail(
          studentEmail,
          studentName,
          'Your enrollment does not meet our standards or payment was not verified. You will not be able to sign in until an admin accepts your enrollment.'
        );
      }

      logAudit({
        req,
        userId: req.user.id,
        action: 'Reject Enrollment',
        module: 'Enrollment',
        description: `Rejected enrollment for student`,
        status: 'SUCCESS',
        metadata: { enrollmentId: id, studentId }
      }).catch(() => {});

      res.status(200).json({
        success: true,
        message: 'Enrollment rejected. Student has been notified by email and cannot sign in until enrollment is accepted.',
        enrollment
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Admin: Add new student (walk-in enrollment) – create User + Enrollment in one step
// @route   POST /api/enrollments/admin/add-student
// @access  Private (Admin only)
const adminAddStudent = async (req, res) => {
  try {
    const {
      firstName,
      middleName,
      lastName,
      email,
      phone,
      password,
      gradeLevel,
      guardianName,
      guardianPhone,
      selectedSubjectIds,
      paymentOption,
      totalFee,
      paymentStatus,
      status,
      enrollmentDate
    } = req.body;

    if (!firstName || !lastName || !email || !phone || !password || !gradeLevel || !guardianName) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, email, phone, password, grade level, and guardian name are required'
      });
    }

    let nameErr = validateName(firstName, 'First name');
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    nameErr = validateName(middleName, 'Middle name');
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    nameErr = validateName(lastName, 'Last name');
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    nameErr = validateName(guardianName, 'Guardian name');
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    const phoneErr = validatePhoneNoLetters(phone);
    if (phoneErr) return res.status(400).json({ success: false, message: phoneErr });
    if ((guardianPhone || '').trim()) {
      const gPhoneErr = validatePhoneNoLetters(guardianPhone);
      if (gPhoneErr) return res.status(400).json({ success: false, message: gPhoneErr });
    }

    const validGradeLevels = ['Toddler', 'Pre-Kindergarten', 'Kindergarten', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10'];
    if (!validGradeLevels.includes(gradeLevel)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid grade level'
      });
    }

    const normalizedSelectedSubjectIds = normalizeIdArray(selectedSubjectIds);

    if (!normalizedSelectedSubjectIds.length) {
      return res.status(400).json({
        success: false,
        message: 'Select at least one program'
      });
    }

    const totalFeeNum = Number(totalFee);
    if (isNaN(totalFeeNum) || totalFeeNum < 0) {
      return res.status(400).json({
        success: false,
        message: 'Total fee must be a valid number ≥ 0'
      });
    }

    if (!['full', 'down'].includes(paymentOption)) {
      return res.status(400).json({
        success: false,
        message: 'Payment option must be "full" or "down"'
      });
    }

    const validPaymentStatuses = ['pending', 'pending_verification', 'paid', 'failed', 'partial'];
    const enrollmentPaymentStatus = validPaymentStatuses.includes(paymentStatus) ? paymentStatus : 'pending';

    const validStatuses = ['pending', 'active'];
    const enrollmentStatus = validStatuses.includes(status) ? status : 'pending';

    const emailTrim = (email || '').toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailTrim)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address'
      });
    }

    const phPhoneRegex = /^(0?9|639)\d{9}$/;
    const phoneDigits = (phone || '').replace(/\D/g, '');
    if (!phPhoneRegex.test(phoneDigits)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid Philippine mobile number (09XX or +63 9XX)'
      });
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters with one uppercase, one lowercase, one number and one special character (@$!%*?&)'
      });
    }

    const existingUser = await User.findOne({ email: emailTrim });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'An account with this email already exists'
      });
    }

    const subjectCount = await Subject.countDocuments({ _id: { $in: normalizedSelectedSubjectIds }, isActive: true });
    if (subjectCount !== normalizedSelectedSubjectIds.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more selected programs are invalid'
      });
    }

    const isActiveEnrollment = enrollmentStatus === 'active' && enrollmentPaymentStatus === 'paid';

    const user = await User.create({
      firstName: firstName.trim(),
      middleName: (middleName || '').trim(),
      lastName: lastName.trim(),
      email: emailTrim,
      phone: phone.trim(),
      password,
      role: 'student',
      gradeLevel: gradeLevel.trim(),
      guardianName: (guardianName || '').trim(),
      guardianPhone: (guardianPhone || '').trim(),
      enrollmentStatus: isActiveEnrollment ? 'active' : (enrollmentPaymentStatus === 'paid' ? 'active' : 'pending_payment'),
      isActive: isActiveEnrollment,
      paymentStatus: enrollmentPaymentStatus === 'paid' ? 'verified' : 'pending'
    });

    const refNum = 'WB-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const enrollmentData = {
      student: user._id,
      selectedSubjects: normalizedSelectedSubjectIds,
      referenceNumber: refNum,
      paymentOption,
      totalFee: totalFeeNum,
      paymentStatus: enrollmentPaymentStatus,
      status: enrollmentStatus,
      enrollmentDate: enrollmentDate ? new Date(enrollmentDate) : new Date()
    };
    if (isActiveEnrollment) {
      enrollmentData.paymentVerifiedAt = new Date();
      enrollmentData.verifiedBy = req.user._id;
    }
    const enrollment = await Enrollment.create(enrollmentData);

    const populated = await Enrollment.findById(enrollment._id)
      .populate('student', 'firstName lastName email phone gradeLevel profileImage')
      .populate('selectedSubjects', 'name code')
      .lean();

    logAudit({
      req,
      userId: req.user.id,
      action: 'Add Student',
      module: 'User Management',
      description: 'Admin added new student',
      status: 'SUCCESS',
      metadata: { studentId: user._id, enrollmentId: enrollment._id }
    }).catch(() => {});

    res.status(201).json({
      success: true,
      message: 'Student and enrollment created successfully.',
      user: { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email, gradeLevel: user.gradeLevel },
      enrollment: populated
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Email already exists' });
    }
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to add student'
    });
  }
};

// @desc    Get enrollment by student
// @route   GET /api/enrollments/student/:studentId
// @access  Private
const getEnrollmentByStudent = async (req, res) => {
  try {
    const { studentId } = req.params;
    
    const enrollment = await Enrollment.findOne({ student: studentId })
      .populate('student', 'firstName lastName email phone gradeLevel profileImage')
      .populate('selectedSubjects');

    if (!enrollment) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment not found'
      });
    }

    res.status(200).json({
      success: true,
      enrollment
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

module.exports = {
  sendEnrollmentVerificationCode,
  verifyEnrollmentEmailCode,
  submitEnrollment,
  createEnrollment,
  verifyPayment,
  adminAddStudent,
  getEnrollmentByStudent,
  getEnrollmentById,
  getMyEnrollments,
  getAllEnrollments,
  updateEnrollmentStatus
};
