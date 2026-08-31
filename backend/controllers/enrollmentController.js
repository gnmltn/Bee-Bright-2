/**
 * Enrollment Controller — redesigned for Bee Bright v2
 * Supports: parent wizard flow, age-based program selection,
 * GCash/SeaBank/BDO payments, granular status FSM.
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Subject = require('../models/Subject');
const Pricing = require('../models/Pricing');
const EnrollmentVerification = require('../models/EnrollmentVerification');
const { logAudit } = require('../utils/auditService');
const { validateName, validatePhoneNoLetters } = require('../utils/validation');
const { computeAge } = require('../utils/ageEligibility');
const {
  generateEnrollmentId,
  computeAmounts,
  pushStatusHistory,
  sendEnrollmentConfirmationEmail,
  sendEnrollmentApprovedEmail,
  sendEnrollmentRejectedEmail,
  sendPaymentVerifiedEmail,
} = require('../services/enrollmentService');
const { validateAndBuildAssessment } = require('../utils/validateAssessment');
const Schedule = require('../models/Schedule');
const { getEmailErrorMessage, logEmailError } = require('../utils/emailService');

// ── Constants ────────────────────────────────────────────────────────────
const PROOF_DIR = path.join(__dirname, '..', 'uploads', 'payments');
const MAX_PROOF_BYTES = 8 * 1024 * 1024; // 8 MB
const ALLOWED_PROOF_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
const ENROLLMENT_OTP_EXPIRES_MINUTES = 5;
const ENROLLMENT_OTP_RESEND_SECONDS = 120;
const ENROLLMENT_OTP_MAX_ATTEMPTS = 5;
const ENROLLMENT_VERIFIED_WINDOW_MINUTES = 30;

const VALID_PAYMENT_METHODS = ['gcash', 'seabank', 'bdo'];
const VALID_PREFERRED_TIMES = ['morning', 'afternoon', 'no_preference'];

// ── Helpers ──────────────────────────────────────────────────────────────
const normalizeEmail = (v = '') => String(v).trim().toLowerCase();
const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000));
const hashOtp = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

const ensureProofDir = () => {
  if (!fs.existsSync(PROOF_DIR)) fs.mkdirSync(PROOF_DIR, { recursive: true });
};

function saveProofFromDataUrl(dataUrl, enrollmentId) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  if (dataUrl.startsWith('/uploads/payments/')) return dataUrl;
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg)|application\/pdf);base64,(.+)$/i);
  if (!match) throw Object.assign(new Error('Proof must be a JPG, PNG, or PDF.'), { statusCode: 400 });
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length) throw Object.assign(new Error('Proof file is empty.'), { statusCode: 400 });
  if (buf.length > MAX_PROOF_BYTES) throw Object.assign(new Error('Proof file must be 8 MB or less.'), { statusCode: 400 });
  ensureProofDir();
  const ext = match[1].includes('pdf') ? 'pdf' : (match[1].includes('png') ? 'png' : 'jpg');
  const filename = `proof-${String(enrollmentId)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(PROOF_DIR, filename), buf);
  return `/uploads/payments/${filename}`;
}

// ── Legacy subject catalog (kept for backward compat) ────────────────────
const SERVICE_CODE_MAP = {
  toddlers: 'TPG101', prek: 'PKR105', academic: 'ACT102',
  sped: 'SPT103', examprep: 'EXP106', kinder: 'KRP104',
};
const SUBJECT_CATALOG = {
  TPG101: { name: 'Toddlers Playgroup', price: 2800, description: 'Socialization, sensory play, early development' },
  PKR105: { name: 'Pre-Kindergarten Readiness Program', price: 3200, description: 'Foundational academic skills' },
  ACT102: { name: 'Academic Tutorial', price: 2400, description: 'Subject-based support' },
  SPT103: { name: 'SPED Tutorial', price: 3500, description: 'Individualized learning support' },
  EXP106: { name: 'Examination Preparation', price: 1250, description: 'Test mastery, mock exams' },
  KRP104: { name: 'Kindergarten Readiness Program', price: 3000, description: 'School-entry preparation' },
};
async function ensureSubjectsByCodes(codes) {
  const ids = [];
  for (const code of codes) {
    let s = await Subject.findOne({ code });
    if (!s) {
      const def = SUBJECT_CATALOG[code];
      if (!def) continue;
      s = await Subject.create({ code, name: def.name, price: def.price,
        description: def.description, duration: '2 hours per session', capacity: 20,
        schedule: 'Mon - Sat 8:00 AM - 6:00 PM' });
    }
    ids.push(s._id);
  }
  return ids;
}

// ═══════════════════════════════════════════════════════════════════════════
//  LEGACY EMAIL OTP  (used by old 3-step enrollment form still at /enrollment)
// ═══════════════════════════════════════════════════════════════════════════
const sendEnrollmentVerificationCode = async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });

    let v = await EnrollmentVerification.findOne({ email: normalizedEmail })
      .select('+otpHash +otpExpiresAt +otpAttempts +lastSentAt');
    if (!v) v = new EnrollmentVerification({ email: normalizedEmail });

    if (v.lastSentAt && Date.now() - v.lastSentAt.getTime() < ENROLLMENT_OTP_RESEND_SECONDS * 1000)
      return res.status(429).json({ success: false,
        message: `Please wait ${ENROLLMENT_OTP_RESEND_SECONDS} seconds before requesting another code.` });

    const otp = generateOtp();
    v.otpHash = hashOtp(otp);
    v.otpExpiresAt = new Date(Date.now() + ENROLLMENT_OTP_EXPIRES_MINUTES * 60 * 1000);
    v.otpAttempts = 0;
    v.verifiedAt = null;
    await v.save();

    const { sendEnrollmentVerificationEmail } = require('../utils/emailService');
    await sendEnrollmentVerificationEmail(normalizedEmail, otp, ENROLLMENT_OTP_EXPIRES_MINUTES);
    v.lastSentAt = new Date();
    await v.save();

    return res.status(200).json({ success: true, message: 'Verification code sent.' });
  } catch (err) {
    const { logEmailError, getEmailErrorMessage } = require('../utils/emailService');
    logEmailError('enrollment OTP send', err);
    return res.status(502).json({ success: false, message: getEmailErrorMessage(err) });
  }
};

const verifyEnrollmentEmailCode = async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email || '');
    const code = String(req.body?.code || '').trim();
    if (!normalizedEmail || !code)
      return res.status(400).json({ success: false, message: 'Email and code are required.' });

    const v = await EnrollmentVerification.findOne({ email: normalizedEmail })
      .select('+otpHash +otpExpiresAt +otpAttempts +lastSentAt');
    if (!v?.otpHash || !v.otpExpiresAt)
      return res.status(400).json({ success: false, message: 'No verification code found. Request a new one.' });
    if (new Date() > new Date(v.otpExpiresAt))
      return res.status(400).json({ success: false, message: 'Code expired. Request a new one.' });

    v.otpAttempts = (v.otpAttempts || 0) + 1;
    if (v.otpAttempts > ENROLLMENT_OTP_MAX_ATTEMPTS) {
      await v.save();
      return res.status(429).json({ success: false, message: 'Too many attempts. Request a new code.' });
    }
    if (hashOtp(code) !== v.otpHash) {
      await v.save();
      return res.status(400).json({ success: false,
        message: `Incorrect code. ${ENROLLMENT_OTP_MAX_ATTEMPTS - v.otpAttempts} attempt(s) remaining.` });
    }
    v.verifiedAt = new Date();
    v.otpHash = undefined; v.otpAttempts = 0;
    await v.save();
    return res.status(200).json({ success: true, message: 'Email verified.' });
  } catch (err) {
    console.error('verifyEnrollmentEmailCode error:', err);
    return res.status(500).json({ success: false, message: 'Verification failed.' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//  NEW WIZARD SUBMIT  — POST /api/enrollments/submit
//  Accepts the finalized wizard payload, creates Enrollment + Payment records.
// ═══════════════════════════════════════════════════════════════════════════
const submitEnrollment = async (req, res) => {
  try {
    const body = req.body || {};

    // ── Resolve parent identity ──
    let parentId = req.user?._id || null;
    let parentUser = req.user || null;

    // Unauthenticated fallback (legacy path): email + OTP window
    if (!parentId) {
      const email = normalizeEmail(body.email || '');
      if (!email) return res.status(401).json({ success: false, message: 'Authentication required.' });
      const v = await EnrollmentVerification.findOne({ email });
      const windowMs = ENROLLMENT_VERIFIED_WINDOW_MINUTES * 60 * 1000;
      if (!v?.verifiedAt || Date.now() - v.verifiedAt.getTime() > windowMs)
        return res.status(401).json({ success: false, message: 'Email not verified or verification expired.' });
      parentUser = await User.findOne({ email, role: { $in: ['parent', 'student'] } });
      if (!parentUser) return res.status(401).json({ success: false, message: 'Account not found.' });
      parentId = parentUser._id;
    }

    // ── Validate packages ──
    const packages = Array.isArray(body.packages) ? body.packages : [];
    if (packages.length === 0)
      return res.status(400).json({ success: false, message: 'At least one program package must be selected.' });

    // ── Validate payment method ──
    const paymentMethod = String(body.paymentMethod || 'gcash').toLowerCase();
    if (!VALID_PAYMENT_METHODS.includes(paymentMethod))
      return res.status(400).json({ success: false, message: 'Invalid payment method. Choose GCash, SeaBank, or BDO.' });

    // Payment is always 50% down — ignore any 'full' sent by client
    const paymentOption = 'down';

    // ── Student snapshot ──
    const snapshot = {
      firstName: String(body.studentFirstName || body.firstName || '').trim(),
      lastName:  String(body.studentLastName  || body.lastName  || '').trim(),
      middleName: String(body.studentMiddleName || body.middleName || '').trim(),
      birthdate:  body.birthdate ? new Date(body.birthdate) : null,
      computedAge: body.birthdate ? computeAge(body.birthdate) : null,
    };
    if (!snapshot.firstName || !snapshot.lastName)
      return res.status(400).json({ success: false, message: 'Student first and last name are required.' });

    // ── Health info ──
    const healthInfo = {
      allergies:          String(body.allergies || '').trim(),
      medications:        String(body.medications || '').trim(),
      specialNeeds:       body.specialNeeds === true || body.specialNeeds === 'true',
      specialNeedsDetails: String(body.specialNeedsDetails || '').trim(),
      emergencyContact:   String(body.emergencyContact || '').trim(),
    };

    // ── Consent ──
    const consentVersion = String(body.consentVersion || '1.0');
    const consentItems = Array.isArray(body.consentItems) ? body.consentItems : [];
    const allConsented = consentItems.every((c) => c.accepted === true);
    if (!allConsented)
      return res.status(400).json({ success: false, message: 'All participation agreement items must be accepted.' });

    // ── Preferred schedule ──
    const preferredStartDate = body.preferredStartDate ? new Date(body.preferredStartDate) : null;
    const preferredTime = VALID_PREFERRED_TIMES.includes(body.preferredTime) ? body.preferredTime : 'no_preference';

    // ── Pre-enrollment assessment (required only when a matching template exists) ──
    const selectedProgramCodes = packages.map((p) => p.programCode).filter(Boolean);
    const { assessment } = await validateAndBuildAssessment(body, selectedProgramCodes);

    // ── Compute amounts ──
    const { totalFee, amountDue } = computeAmounts(packages, paymentOption);

    // ── Generate enrollment ID ──
    const enrollmentId = await generateEnrollmentId();

    // ── Create Enrollment ──
    const enrollment = new Enrollment({
      enrollmentId,
      parent: parentId,
      studentSnapshot: snapshot,
      packages,
      preferredStartDate,
      preferredTime,
      healthInfo,
      paymentOption,
      totalFee,
      consentVersion,
      consentAcceptedAt: new Date(),
      consentItems,
      status: 'submitted',
      paymentStatus: 'pending',
      preEnrollmentAssessment: assessment || undefined,
    });
    pushStatusHistory(enrollment, 'submitted', parentId, 'parent', 'Enrollment wizard submitted');
    await enrollment.save();

    // ── Create Payment ──
    const payment = new Payment({
      parent: parentId,
      enrollment: enrollment._id,
      amount: amountDue,
      amountDue,
      paymentType: paymentOption,
      paymentMethod,
      status: 'pending',
    });
    await payment.save();

    // ── Update parent enrollmentStatus ──
    if (parentUser) {
      await User.findByIdAndUpdate(parentId, { enrollmentStatus: 'pending_payment' });
    }

    // ── Fetch payment instructions ──
    const instructions = await getPaymentInstructionsForMethod(paymentMethod);

    // ── Send confirmation email ──
    const email = parentUser?.email || body.email || '';
    const parentName = `${parentUser?.firstName || ''} ${parentUser?.lastName || ''}`.trim() || 'Parent';
    if (email) {
      sendEnrollmentConfirmationEmail(email, {
        parentName,
        studentName: `${snapshot.firstName} ${snapshot.lastName}`,
        enrollmentId,
        amountDue,
        paymentMethod,
      }).catch(() => {});
    }

    logAudit({ req, userId: parentId, action: 'Submit Enrollment', module: 'Enrollment',
      description: `Enrollment submitted: ${enrollmentId}`, status: 'SUCCESS',
      metadata: { enrollmentId, paymentMethod, totalFee } }).catch(() => {});

    return res.status(201).json({
      success: true,
      message: 'Enrollment submitted successfully.',
      enrollmentId,
      enrollmentDbId: String(enrollment._id),
      paymentId: String(payment._id),
      amountDue,
      totalFee,
      paymentMethod,
      instructions,
    });
  } catch (err) {
    console.error('submitEnrollment error:', err);
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Enrollment submission failed.' });
  }
};

// ── Payment instruction helper ──────────────────────────────────────────
async function getPaymentInstructionsForMethod(method) {
  const DEFAULTS = {
    gcash:   { accountName: 'Bee Bright Tutorial Center', accountNumber: '09307517208', bankBranch: null },
    seabank: { accountName: 'Bee Bright Tutorial Center', accountNumber: '5678-9012-3456', bankBranch: 'Main Branch' },
    bdo:     { accountName: 'Bee Bright Tutorial Center', accountNumber: '0098-7654-3210', bankBranch: 'Main Branch' },
  };
  const firstPricing = await Pricing.findOne({ active: true, 'meta.accountNumber': { $exists: true, $ne: null } })
    .select('meta').lean().catch(() => null);
  return DEFAULTS[method] || DEFAULTS.gcash;
}

// ── Submit payment proof  POST /api/enrollments/:enrollmentId/submit-proof ──
const submitPaymentProof = async (req, res) => {
  try {
    const { enrollmentId } = req.params;
    const { proofDataUrl, payerReference, paymentMethod } = req.body || {};

    const enrollment = await Enrollment.findOne({ enrollmentId });
    if (!enrollment) return res.status(404).json({ success: false, message: 'Enrollment not found.' });

    const payment = await Payment.findOne({ enrollment: enrollment._id }).sort({ createdAt: -1 });
    if (!payment) return res.status(404).json({ success: false, message: 'Payment record not found.' });

    const proofUrl = saveProofFromDataUrl(proofDataUrl, enrollment._id);
    if (!proofUrl) return res.status(400).json({ success: false, message: 'Payment proof is required.' });

    payment.proofUrl = proofUrl;
    payment.payerReference = String(payerReference || '').trim() || null;
    if (paymentMethod && VALID_PAYMENT_METHODS.includes(paymentMethod)) payment.paymentMethod = paymentMethod;
    payment.status = 'submitted';
    payment.submittedAt = new Date();
    payment.resubmissionCount = (payment.resubmissionCount || 0);
    await payment.save();

    pushStatusHistory(enrollment, 'payment_under_verification', null, 'system', 'Payment proof submitted');
    enrollment.paymentStatus = 'submitted';
    await enrollment.save();

    const parentUser = await User.findById(enrollment.parent).select('email firstName lastName').lean();
    if (parentUser?.email) {
      const { sendEmail } = require('../utils/emailService');
      sendEmail({
        to: parentUser.email,
        subject: `Bee Bright — Payment Proof Received (${enrollment.enrollmentId})`,
        html: `<p>Hi ${parentUser.firstName}, we received your payment proof for enrollment ${enrollment.enrollmentId}. Our team will verify it within 1–2 business days.</p>`,
      }, 'proof received notification').catch(() => {});
    }

    logAudit({ req, action: 'Submit Payment Proof', module: 'Payment',
      description: `Proof submitted for ${enrollmentId}`, status: 'SUCCESS',
      metadata: { enrollmentId, paymentId: payment._id } }).catch(() => {});

    return res.status(200).json({ success: true, message: 'Payment proof submitted. We will verify it shortly.' });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Failed to submit proof.' });
  }
};

// ── Parent: get my enrollments  GET /api/enrollments/my-enrollments ───────
const getMyEnrollments = async (req, res) => {
  try {
    const enrollments = await Enrollment.find({
      $or: [{ parent: req.user._id }, { student: req.user._id }],
    })
      .sort({ createdAt: -1 })
      .populate('approvedBy', 'firstName lastName')
      .lean();

    const withPayments = await Promise.all(
      enrollments.map(async (e) => {
        const payments = await Payment.find({ enrollment: e._id })
          .sort({ createdAt: -1 })
          .select('status paymentMethod amountDue amountPaid proofUrl submittedAt verifiedAt referenceNumber resubmissionCount')
          .lean();
        return { ...e, payments };
      })
    );
    return res.status(200).json({ success: true, enrollments: withPayments });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Failed to fetch enrollments.' });
  }
};

// ── Public tracking  GET /api/enrollments/track?enrollmentId=&email= ──────
const trackEnrollment = async (req, res) => {
  try {
    const enrollmentId = String(req.query.enrollmentId || '').trim().toUpperCase();
    const email = normalizeEmail(req.query.email || '');
    if (!enrollmentId || !email)
      return res.status(400).json({ success: false, message: 'enrollmentId and email are required.' });

    const enrollment = await Enrollment.findOne({ enrollmentId }).lean();
    if (!enrollment)
      return res.status(404).json({ success: false, message: 'Enrollment not found.' });

    // Verify the email belongs to the parent who submitted this enrollment.
    // The student (child) does NOT have a separate login account —
    // only the Parent/Guardian is authenticated.
    const parentUser = enrollment.parent
      ? await User.findById(enrollment.parent).select('email').lean()
      : null;

    const emailMatches = parentUser?.email && normalizeEmail(parentUser.email) === email;

    if (!emailMatches)
      return res.status(403).json({ success: false, message: 'Email does not match the enrollment record. Please use the email you registered with.' });

    const STATUS_LABELS = {
      draft: 'Draft',
      submitted: 'Submitted',
      payment_under_verification: 'Payment Under Verification',
      pending_approval: 'Pending Approval',
      approved: 'Approved',
      active: 'Active',
      rejected: 'Rejected',
      cancelled: 'Cancelled',
    };

    const payment = await Payment.findOne({ enrollment: enrollment._id })
      .sort({ createdAt: -1 })
      .select('status paymentMethod amountDue submittedAt resubmissionCount referenceNumber')
      .lean();

    return res.status(200).json({
      success: true,
      enrollment: {
        enrollmentId: enrollment.enrollmentId,
        status: enrollment.status,
        statusLabel: STATUS_LABELS[enrollment.status] || enrollment.status,
        studentName: `${enrollment.studentSnapshot?.firstName || ''} ${enrollment.studentSnapshot?.lastName || ''}`.trim(),
        submittedAt: enrollment.createdAt,
        rejectionReason: enrollment.rejectionReason || null,
        allowResubmission: enrollment.allowResubmission || false,
        paymentStatus: enrollment.paymentStatus,
        payment: payment || null,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to track enrollment.' });
  }
};

// ── Legacy stubs kept for backward compat ────────────────────────────────
const createEnrollment = async (req, res) =>
  res.status(410).json({ success: false, message: 'Use POST /api/enrollments/submit instead.' });

const getEnrollmentByStudent = async (req, res) => {
  try {
    const { studentId } = req.params;
    const allowed = req.user.role === 'admin' || req.user.role === 'super_admin'
      || String(req.user._id) === studentId;
    if (!allowed) return res.status(403).json({ success: false, message: 'Forbidden.' });
    const enrollments = await Enrollment.find({ $or: [{ student: studentId }, { parent: studentId }] })
      .sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, enrollments });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/admin/enrollments
const getAllEnrollments = async (req, res) => {
  try {
    const { status, q, limit = 100, page = 1 } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (q) {
      const re = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ enrollmentId: re }, { 'studentSnapshot.firstName': re }, { 'studentSnapshot.lastName': re }];
    }
    const skip = (Number(page) - 1) * Number(limit);
    const [enrollments, total] = await Promise.all([
      Enrollment.find(filter)
        .sort({ createdAt: -1 }).skip(skip).limit(Number(limit))
        .populate('parent', 'firstName lastName email phone')
        .populate('approvedBy', 'firstName lastName')
        .lean(),
      Enrollment.countDocuments(filter),
    ]);

    // Attach latest payment per enrollment
    const withPayments = await Promise.all(
      enrollments.map(async (e) => {
        const payment = await Payment.findOne({ enrollment: e._id })
          .sort({ createdAt: -1 }).select('status paymentMethod amountDue proofUrl submittedAt verifiedAt resubmissionCount referenceNumber').lean();
        return { ...e, latestPayment: payment || null };
      })
    );

    return res.status(200).json({ success: true, total, page: Number(page), enrollments: withPayments });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/enrollments/:id
const getEnrollmentById = async (req, res) => {
  try {
    const enrollment = await Enrollment.findById(req.params.id)
      .populate('parent', 'firstName lastName email phone parentProfile')
      .populate('approvedBy', 'firstName lastName')
      .populate('verifiedBy', 'firstName lastName')
      .lean();
    if (!enrollment) return res.status(404).json({ success: false, message: 'Enrollment not found.' });
    const payments = await Payment.find({ enrollment: enrollment._id })
      .sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, enrollment: { ...enrollment, payments } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/enrollments/tutor/assessments
const getTutorAssessments = async (req, res) => {
  try {
    const sessions = await Schedule.find({ tutor: req.user._id }).select('student students').lean();
    const userIds = [];
    for (const session of sessions) {
      if (session.student) userIds.push(session.student);
      if (Array.isArray(session.students)) userIds.push(...session.students);
    }

    const filter = {
      'preEnrollmentAssessment.completedAt': { $ne: null },
    };
    if (userIds.length > 0) {
      filter.$or = [{ parent: { $in: userIds } }, { student: { $in: userIds } }];
    } else {
      // No assigned sessions yet — still allow tutor to see nothing rather than all enrollments
      return res.status(200).json({ success: true, enrollments: [] });
    }

    const enrollments = await Enrollment.find(filter)
      .sort({ createdAt: -1 })
      .populate('parent', 'firstName lastName email phone')
      .select('enrollmentId studentId studentSnapshot packages status preEnrollmentAssessment parent createdAt')
      .lean();

    return res.status(200).json({ success: true, enrollments });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Failed to load assessments.' });
  }
};

// PUT /api/admin/enrollments/:id/verify-payment
const adminVerifyPayment = async (req, res) => {
  try {
    const { verified, note, paymentId } = req.body;
    const enrollment = await Enrollment.findById(req.params.id);
    if (!enrollment) return res.status(404).json({ success: false, message: 'Enrollment not found.' });

    const payment = paymentId
      ? await Payment.findById(paymentId)
      : await Payment.findOne({ enrollment: enrollment._id }).sort({ createdAt: -1 });
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });

    if (verified) {
      payment.status = 'verified';
      payment.verifiedAt = new Date();
      payment.verifiedBy = req.user._id;
      payment.amountPaid = payment.amountDue || payment.amount;
      payment.notes = note || null;
      enrollment.paymentStatus = 'verified';
      enrollment.verifiedBy = req.user._id;
      enrollment.paymentVerifiedAt = new Date();
      pushStatusHistory(enrollment, 'pending_approval', req.user._id, req.user.role, note || 'Payment verified');
    } else {
      payment.status = 'rejected';
      payment.rejectionReason = note || 'Payment rejected by admin';
      enrollment.paymentStatus = 'pending';
      enrollment.allowResubmission = true;
      pushStatusHistory(enrollment, 'submitted', req.user._id, req.user.role, `Payment rejected: ${note || ''}`);
    }

    await Promise.all([payment.save(), enrollment.save()]);

    // Email parent
    const parentUser = await User.findById(enrollment.parent).select('email firstName lastName').lean();
    if (parentUser?.email && verified) {
      sendPaymentVerifiedEmail(parentUser.email, {
        parentName: `${parentUser.firstName} ${parentUser.lastName}`,
        studentName: `${enrollment.studentSnapshot?.firstName || ''} ${enrollment.studentSnapshot?.lastName || ''}`.trim(),
        enrollmentId: enrollment.enrollmentId,
      }).catch(() => {});
    }

    logAudit({ req, userId: req.user._id, action: verified ? 'Verify Payment' : 'Reject Payment',
      module: 'Payment', description: `${verified ? 'Verified' : 'Rejected'} payment for ${enrollment.enrollmentId}`,
      status: 'SUCCESS', metadata: { enrollmentId: enrollment.enrollmentId, paymentId: payment._id } }).catch(() => {});

    return res.status(200).json({ success: true, message: verified ? 'Payment verified.' : 'Payment rejected.', enrollment, payment });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/enrollments/:id/approve
const adminApproveEnrollment = async (req, res) => {
  try {
    const enrollment = await Enrollment.findById(req.params.id);
    if (!enrollment) return res.status(404).json({ success: false, message: 'Enrollment not found.' });

    if (['approved', 'rejected', 'cancelled', 'completed'].includes(enrollment.status)) {
      return res.status(400).json({ success: false, message: `Cannot approve enrollment with status: ${enrollment.status}` });
    }

    // ── Generate Student ID ──────────────────────────────────────────────
    // The student ID is stored on the Enrollment itself.
    // The child is NOT a separate login account — the Parent account is the only user.
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    // Count existing approved enrollments to generate a sequential ID
    const approvedCount = await Enrollment.countDocuments({
      status: { $in: ['approved', 'active'] },
      studentId: { $exists: true, $ne: null }
    });
    const studentId = `S-${y}${mo}${d}-${String(approvedCount + 1).padStart(4, '0')}`;

    // ── Store Student ID on the Enrollment ────────────────────────────────
    enrollment.studentId = studentId;
    enrollment.approvedBy = req.user._id;
    enrollment.approvedAt = now;
    enrollment.paymentStatus = 'paid';
    pushStatusHistory(enrollment, 'approved', req.user._id, req.user.role, 'Enrollment approved');
    await enrollment.save();

    // ── Activate the Parent account ───────────────────────────────────────
    await User.findByIdAndUpdate(enrollment.parent, {
      isActive: true,
      enrollmentStatus: 'active',
    });

    // ── Send approval email to Parent ─────────────────────────────────────
    const parentFull = await User.findById(enrollment.parent).select('email firstName lastName').lean();
    const snap = enrollment.studentSnapshot || {};
    if (parentFull?.email) {
      sendEnrollmentApprovedEmail(parentFull.email, {
        parentName: `${parentFull.firstName} ${parentFull.lastName}`,
        studentName: `${snap.firstName || ''} ${snap.lastName || ''}`.trim(),
        enrollmentId: enrollment.enrollmentId,
        studentId,
      }).catch(() => {});
    }

    logAudit({
      req,
      userId: req.user._id,
      action: 'Approve Enrollment',
      module: 'Enrollment',
      description: `Approved ${enrollment.enrollmentId} — Student ID: ${studentId}`,
      status: 'SUCCESS',
      metadata: { enrollmentId: enrollment.enrollmentId, studentId }
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: 'Enrollment approved. Parent account activated.',
      studentId,
      enrollment
    });
  } catch (err) {
    console.error('adminApproveEnrollment error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/enrollments/:id/reject
const adminRejectEnrollment = async (req, res) => {
  try {
    const { reason, allowResubmission = false } = req.body;
    const enrollment = await Enrollment.findById(req.params.id);
    if (!enrollment) return res.status(404).json({ success: false, message: 'Enrollment not found.' });

    enrollment.rejectionReason = String(reason || '').trim() || 'No reason provided.';
    enrollment.allowResubmission = !!allowResubmission;
    pushStatusHistory(enrollment, 'rejected', req.user._id, req.user.role, enrollment.rejectionReason);
    enrollment.paymentStatus = 'failed';
    await enrollment.save();

    await User.findByIdAndUpdate(enrollment.parent, { enrollmentStatus: 'rejected' });

    const parentUser = await User.findById(enrollment.parent).select('email firstName lastName').lean();
    if (parentUser?.email) {
      sendEnrollmentRejectedEmail(parentUser.email, {
        parentName: `${parentUser.firstName} ${parentUser.lastName}`,
        studentName: `${enrollment.studentSnapshot?.firstName || ''} ${enrollment.studentSnapshot?.lastName || ''}`.trim(),
        enrollmentId: enrollment.enrollmentId,
        reason: enrollment.rejectionReason,
        allowResubmission: !!allowResubmission,
      }).catch(() => {});
    }

    logAudit({ req, userId: req.user._id, action: 'Reject Enrollment', module: 'Enrollment',
      description: `Rejected ${enrollment.enrollmentId}: ${enrollment.rejectionReason}`, status: 'SUCCESS' }).catch(() => {});

    return res.status(200).json({ success: true, message: 'Enrollment rejected.', enrollment });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/enrollments/:id/status  (legacy alias)
const updateEnrollmentStatus = async (req, res) => {
  const { status } = req.body;
  if (status === 'active') return adminApproveEnrollment(req, res);
  if (status === 'cancelled') return adminRejectEnrollment({ ...req, body: { ...req.body, reason: 'Cancelled by admin', allowResubmission: false } }, res);
  return res.status(400).json({ success: false, message: 'Use /approve or /reject endpoints.' });
};

// Legacy verifyPayment alias
const verifyPayment = (req, res) => adminVerifyPayment(req, res);

// Legacy adminAddStudent
const adminAddStudent = async (req, res) => {
  try {
    const body = req.body || {};
    const email = normalizeEmail(body.email || '');
    if (!email || !body.firstName || !body.lastName || !body.password)
      return res.status(400).json({ success: false, message: 'firstName, lastName, email, password are required.' });

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ success: false, message: 'Email already registered.' });

    const student = await User.create({
      firstName: body.firstName, middleName: body.middleName || '',
      lastName: body.lastName, email, phone: body.phone || '09000000000',
      password: body.password, role: 'student',
      guardianName: body.guardianName || body.firstName,
      isActive: true, enrollmentStatus: 'active', paymentStatus: 'verified',
      emailVerifiedAt: new Date(),
    });

    logAudit({ req, userId: req.user._id, action: 'Admin Add Student', module: 'Enrollment',
      description: `Admin created student: ${email}`, status: 'SUCCESS' }).catch(() => {});

    return res.status(201).json({ success: true, message: 'Student added.', student });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/payments/instructions/:method
const getPaymentInstructions = async (req, res) => {
  try {
    const method = String(req.params.method || '').toLowerCase();
    if (!VALID_PAYMENT_METHODS.includes(method))
      return res.status(400).json({ success: false, message: 'Invalid payment method.' });
    const instructions = await getPaymentInstructionsForMethod(method);
    return res.status(200).json({ success: true, method, instructions });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  sendEnrollmentVerificationCode,
  verifyEnrollmentEmailCode,
  submitEnrollment,
  submitPaymentProof,
  getMyEnrollments,
  trackEnrollment,
  createEnrollment,
  getEnrollmentByStudent,
  getAllEnrollments,
  getEnrollmentById,
  getTutorAssessments,
  adminVerifyPayment,
  adminApproveEnrollment,
  adminRejectEnrollment,
  updateEnrollmentStatus,
  verifyPayment,
  adminAddStudent,
  getPaymentInstructions,
};
