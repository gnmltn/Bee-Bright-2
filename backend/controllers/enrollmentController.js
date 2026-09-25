/**
 * Enrollment Controller — redesigned for Bee Bright v2
 * Supports: parent wizard flow, age-based program selection,
 * GCash/MariBank/BDO payments, granular status FSM.
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Pricing = require('../models/Pricing');
const EnrollmentVerification = require('../models/EnrollmentVerification');
const { logAudit } = require('../utils/auditService');
const { validateName, validatePhoneNoLetters, validateFullName, toTitleCase, checkMobileNumberUnique } = require('../utils/validation');
const { computeAge, checkProgramEligibility, validateEnrollmentAge } = require('../utils/ageEligibility');
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
const { PROGRAM_POLICIES } = require('../utils/schedulingPolicy');
const { canTutorHandleSchedule } = require('./scheduleController');
const { permanentIdOf, findRenewalSource } = require('../utils/studentIdentity');
const { getEmailError } = require('../utils/emailRules');
const PendingParentSignup = require('../models/PendingParentSignup');
const { findPendingFromRequest, assertPendingReady, createUserFromPending, discardPending } = require('../utils/parentSignup');

// ── Constants ────────────────────────────────────────────────────────────
const PROOF_DIR = path.join(__dirname, '..', 'uploads', 'payments');
const REQUIREMENTS_DIR = path.join(__dirname, '..', 'uploads', 'requirements');
const MAX_REQUIREMENT_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_PROOF_BYTES = 8 * 1024 * 1024; // 8 MB
const ALLOWED_PROOF_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
const ENROLLMENT_OTP_EXPIRES_MINUTES = 5;
const ENROLLMENT_OTP_RESEND_SECONDS = 120;
const ENROLLMENT_OTP_MAX_ATTEMPTS = 5;
const ENROLLMENT_VERIFIED_WINDOW_MINUTES = 30;

const VALID_PAYMENT_METHODS = ['gcash', 'maribank', 'bdo'];

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

/** Save one enrollment-requirement document (birth cert / photo / guardian ID) to disk. */
function saveRequirementFromDataUrl(dataUrl, enrollmentId, kind) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  if (dataUrl.startsWith('/uploads/requirements/')) return dataUrl;
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg)|application\/pdf);base64,(.+)$/i);
  if (!match) throw Object.assign(new Error(`${kind} must be a JPG, PNG, or PDF.`), { statusCode: 400 });
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length) throw Object.assign(new Error(`${kind} file is empty.`), { statusCode: 400 });
  if (buf.length > MAX_REQUIREMENT_BYTES) throw Object.assign(new Error(`${kind} file must be 5 MB or less.`), { statusCode: 400 });
  if (!fs.existsSync(REQUIREMENTS_DIR)) fs.mkdirSync(REQUIREMENTS_DIR, { recursive: true });
  const ext = match[1].includes('pdf') ? 'pdf' : (match[1].includes('png') ? 'png' : 'jpg');
  const filename = `${kind}-${String(enrollmentId)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(REQUIREMENTS_DIR, filename), buf);
  return `/uploads/requirements/${filename}`;
}

// Task 25c — the legacy SERVICE_CODE_MAP / SUBJECT_CATALOG / ensureSubjectsByCodes()
// helpers were removed here: they had no call sites, and they still listed the retired
// PKR105 / SPT103 / KRP104 as separately-priced programs. The live enrollment flow
// resolves packages against the Pricing collection (see `pricedPackages` below) and age
// eligibility via utils/ageEligibility.js — both already limited to TPG101/ACT102/EXP106.

// ═══════════════════════════════════════════════════════════════════════════
//  LEGACY EMAIL OTP  (used by old 3-step enrollment form still at /enrollment)
// ═══════════════════════════════════════════════════════════════════════════
const sendEnrollmentVerificationCode = async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email || '');
    const legacyEmailProblem = getEmailError(normalizedEmail);
    if (legacyEmailProblem)
      return res.status(400).json({ success: false, message: legacyEmailProblem });

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
    const body = { ...(req.body || {}) };

    // ── Resolve parent identity ──
    let parentId = req.user?._id || null;
    let parentUser = req.user || null;
    let pendingSignup = null;

    // A verified signup that has NOT become an account yet (nothing is in Users). Its
    // enrollment token carries the pending id; the real User is created below, in this
    // same request, together with the enrollment and its payment proof.
    if (!parentId) {
      pendingSignup = await findPendingFromRequest(req);
      if (pendingSignup) {
        await assertPendingReady(pendingSignup);
        parentId = pendingSignup._id;
      }
    }

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

    // ── Draft account: mobile must still be free among finalized accounts ──
    // (drafts don't reserve numbers, so two people could have drafted the same one).
    if (parentUser?.enrollmentDraft && parentUser.phone) {
      const stillFree = await checkMobileNumberUnique(parentUser.phone, parentUser._id);
      if (!stillFree) {
        return res.status(409).json({
          success: false,
          message: 'That mobile number was just registered to another account. Please go back to the Account step and use a different number.',
        });
      }
    }

    // ── Renew / Add Program for an EXISTING child ──
    // The child keeps their permanent Student ID and identity: the stored snapshot
    // (name + birthdate) overrides whatever the browser sent, and the new enrollment
    // inherits `permanentStudentId` / the student User instead of minting new ones.
    let renewalSource = null;
    if (body.renewalOfEnrollmentId) {
      renewalSource = await findRenewalSource(body.renewalOfEnrollmentId, parentId);
      if (!renewalSource) {
        return res.status(400).json({ success: false, message: 'The child you are adding a program for could not be found on your account.' });
      }
      const snap = renewalSource.studentSnapshot || {};
      body.studentFirstName = snap.firstName || '';
      body.studentMiddleName = snap.middleName || '';
      body.studentLastName = snap.lastName || '';
      body.birthdate = snap.birthdate ? new Date(snap.birthdate).toISOString().slice(0, 10) : body.birthdate;
    }

    // ── Validate packages ──
    const packages = Array.isArray(body.packages) ? body.packages : [];
    if (packages.length === 0)
      return res.status(400).json({ success: false, message: 'At least one program package must be selected.' });

    // Resolve packages and prices from the database; never trust browser-supplied billing values.
    const packageKeys = packages.map((item) => `${item.programCode}:${item.packageSlug}`);
    const pricedPackages = await Pricing.find({
      active: true,
      $expr: { $in: [{ $concat: ['$programCode', ':', '$packageSlug'] }, packageKeys] },
    }).lean();
    const pricedByKey = new Map(pricedPackages.map((item) => [`${item.programCode}:${item.packageSlug}`, item]));
    const canonicalPackages = packages.map((item) => {
      const priced = pricedByKey.get(`${item.programCode}:${item.packageSlug}`);
      if (!priced) throw Object.assign(new Error('One or more selected packages are no longer available.'), { statusCode: 400 });
      return {
        programCode: priced.programCode,
        packageSlug: priced.packageSlug,
        displayName: priced.displayName,
        price: priced.priceFull,
        paymentOption: 'down',
      };
    });

    // ── Age gate (min 2, max 18, real date) — recomputed server-side, never trust the UI ──
    const ageCheck = validateEnrollmentAge(body.birthdate);
    if (!ageCheck.valid) {
      return res.status(400).json({ success: false, message: ageCheck.reason });
    }
    const childAge = ageCheck.ageYears;
    for (const item of canonicalPackages) {
      const eligibility = checkProgramEligibility(item.programCode, childAge);
      if (!eligibility.eligible) {
        throw Object.assign(new Error(eligibility.reason), { statusCode: 400 });
      }
    }

    // ── Validate payment method ──
    const paymentMethod = String(body.paymentMethod || 'gcash').toLowerCase();
    if (!VALID_PAYMENT_METHODS.includes(paymentMethod))
      return res.status(400).json({ success: false, message: 'Invalid payment method. Choose GCash, MariBank, or BDO.' });

    // Payment is always 50% down — ignore any 'full' sent by client
    const paymentOption = 'down';

    // ── Student snapshot (names validated + Title-Cased) ──
    const rawFirst = String(body.studentFirstName || body.firstName || '').trim();
    const rawMiddle = String(body.studentMiddleName || body.middleName || '').trim();
    const rawLast = String(body.studentLastName || body.lastName || '').trim();
    for (const [val, label, required] of [
      [rawFirst, 'Student first name', true],
      [rawMiddle, 'Student middle name', false],
      [rawLast, 'Student last name', true],
    ]) {
      const err = validateFullName(val, label, { minParts: 1, required });
      if (err) return res.status(400).json({ success: false, message: err });
    }
    const snapshot = {
      firstName: toTitleCase(rawFirst),
      lastName:  toTitleCase(rawLast),
      middleName: rawMiddle ? toTitleCase(rawMiddle) : '',
      birthdate:  new Date(body.birthdate),
      computedAge: childAge,
    };

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

    // Available Days, kept per program (Admin_Schedule_and_MultiProgram_Days_Fixes.pdf
    // #4b) — a parent enrolled in more than one program picks a separate day pattern
    // for each. Validate + sanitise: only Mon-Sat values, per program.
    const VALID_PREFERRED_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const preferredDaysByProgram = Array.isArray(body.preferredDaysByProgram)
      ? body.preferredDaysByProgram
          .filter((p) => p && typeof p.programCode === 'string')
          .map((p) => ({
            programCode: p.programCode.toUpperCase(),
            days: Array.isArray(p.days)
              ? p.days
                  .map((d) => String(d || '').trim())
                  .filter((d) => VALID_PREFERRED_DAYS.includes(d))
                  .filter((d, i, arr) => arr.indexOf(d) === i)
              : [],
          }))
      : [];
    // Legacy flat field, kept in sync as the union of every program's days — only for
    // any old consumer that hasn't been updated to read preferredDaysByProgram.
    const preferredDays = [...new Set(preferredDaysByProgram.flatMap((p) => p.days))]
      .sort((a, b) => VALID_PREFERRED_DAYS.indexOf(a) - VALID_PREFERRED_DAYS.indexOf(b));

    // Informational only — Step 7's live-availability slot pick(s), one per
    // enrolled program. Never trusted for auto-assignment.
    const preferredSlots = Array.isArray(body.preferredSlots)
      ? body.preferredSlots
          .filter((s) => s && typeof s.programCode === 'string' && typeof s.startTime === 'string' && typeof s.endTime === 'string')
          .map((s) => ({ programCode: s.programCode.toUpperCase(), startTime: s.startTime, endTime: s.endTime }))
      : [];

    // ── Pre-enrollment assessment (required only when a matching template exists) ──
    const selectedProgramCodes = canonicalPackages.map((p) => p.programCode).filter(Boolean);
    const { assessment } = await validateAndBuildAssessment(body, selectedProgramCodes);

    // ── Compute amounts ──
    const { totalFee, amountDue } = computeAmounts(canonicalPackages, paymentOption);

    // ── Generate enrollment ID ──
    const enrollmentId = await generateEnrollmentId();

    // ── Requirement documents (optional; saved to disk, linked to this enrollment) ──
    const reqDocsInput = body.requirementDocuments || {};
    const requirementDocuments = {};
    for (const [field, kind] of [
      ['birthCertificate', 'birth-certificate'],
      ['studentPhoto', 'student-photo'],
      ['guardianId', 'guardian-id'],
    ]) {
      const doc = reqDocsInput[field];
      if (doc && doc.dataUrl) {
        const savedPath = saveRequirementFromDataUrl(doc.dataUrl, enrollmentId, kind);
        if (savedPath) {
          requirementDocuments[field] = { path: savedPath, fileName: String(doc.fileName || `${kind}`).slice(0, 200), uploadedAt: new Date() };
        }
      }
    }

    // ── Payment proof: arrives WITH the submission, so the account, the enrollment and
    // the payment proof are all written together at this single point. A bad file fails
    // the request here, before anything is created. ──
    const proofUrl = body.proofDataUrl ? saveProofFromDataUrl(body.proofDataUrl, enrollmentId) : null;
    const payerReference = String(body.payerReference || '').trim() || null;

    // ── Create Account (from the verified pending signup) + Enrollment + Payment ──
    let createdParent = null;
    let enrollment = null;
    let payment = null;
    try {
    if (pendingSignup) {
      createdParent = await createUserFromPending(pendingSignup);
      parentUser = createdParent;
    }
    enrollment = new Enrollment({
      enrollmentId,
      parent: parentId,
      student: renewalSource?.student || null,
      permanentStudentId: renewalSource ? permanentIdOf(renewalSource) : enrollmentId,
      renewalOf: renewalSource?._id || null,
      studentSnapshot: snapshot,
      packages: canonicalPackages,
      preferredStartDate,
      preferredDays,
      preferredDaysByProgram,
      preferredSlots,
      healthInfo,
      requirementDocuments,
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
    if (proofUrl) {
      pushStatusHistory(enrollment, 'payment_under_verification', null, 'system', 'Payment proof submitted');
      enrollment.paymentStatus = 'submitted';
    }
    await enrollment.save();

    // ── Create Payment ──
    payment = new Payment({
      parent: parentId,
      enrollment: enrollment._id,
      amount: amountDue,
      amountDue,
      paymentType: paymentOption,
      paymentMethod,
      status: proofUrl ? 'submitted' : 'pending',
      proofUrl,
      payerReference,
      submittedAt: proofUrl ? new Date() : null,
    });
    await payment.save();
    } catch (creationErr) {
      // Nothing may be left half-written: no orphaned enrollment, and no account that
      // was created for this attempt (the pending signup stays so the parent can retry).
      if (enrollment?._id) await Enrollment.deleteOne({ _id: enrollment._id }).catch(() => {});
      if (createdParent) await User.deleteOne({ _id: createdParent._id }).catch(() => {});
      throw creationErr;
    }
    if (pendingSignup) await discardPending(pendingSignup);

    // ── Finalize the parent account ──
    // The Step-2 record has been a draft until now. The parent has completed the
    // wizard and the enrollment is submitted / awaiting payment verification, so
    // the account becomes permanent: uniqueness now applies to it and the TTL
    // that would have auto-deleted an abandoned draft is removed. Login stays
    // gated on admin approval (isActive is unchanged here).
    if (parentUser) {
      await User.findByIdAndUpdate(parentId, {
        $set: { enrollmentStatus: 'pending_payment', enrollmentDraft: false },
        $unset: { draftExpiresAt: 1 },
      });
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
        enrollmentId: permanentIdOf(enrollment),
        amountDue,
        paymentMethod,
      }).catch(() => {});
    }

    if (proofUrl && email) {
      require('../utils/emailService').sendEmail({
        to: email,
        subject: `Bee Bright — Payment Proof Received (${permanentIdOf(enrollment)})`,
        html: `<p>Hi ${parentUser?.firstName || 'there'}, we received your payment proof for student ${permanentIdOf(enrollment)}. Our team will verify it within 1–2 business days.</p>`,
      }, 'proof received notification').catch(() => {});
    }

    logAudit({ req, userId: parentId, action: 'Submit Enrollment', module: 'Enrollment',
      description: `Enrollment submitted: ${enrollmentId}${createdParent ? ' (parent account created with the completed enrollment)' : ''}`, status: 'SUCCESS',
      metadata: { enrollmentId, paymentMethod, totalFee, proofSubmitted: Boolean(proofUrl) } }).catch(() => {});

    return res.status(201).json({
      success: true,
      message: 'Enrollment submitted successfully.',
      enrollmentId,
      permanentStudentId: enrollment.permanentStudentId,
      enrollmentDbId: String(enrollment._id),
      paymentId: String(payment._id),
      proofSubmitted: Boolean(proofUrl),
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

// ── Parent sets a child's profile picture  PUT /api/enrollments/child-photo ─
// Body: { childKey, image } — childKey is the child's permanent Student ID (or, for
// an enrollment not yet backfilled, its _id). Stored on every enrollment of that
// child so it survives Renew / Add Program.
const CHILD_PHOTO_DIR = path.join(__dirname, '..', 'uploads', 'student-avatars');
const CHILD_PHOTO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function detectChildPhotoMime(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

const setChildProfilePhoto = async (req, res) => {
  try {
    if (req.user?.role !== 'parent') {
      return res.status(403).json({ success: false, message: 'Only a parent can set a child\'s profile picture.' });
    }
    const childKey = String(req.body?.childKey || '').trim();
    const image = req.body?.image;
    if (!childKey) return res.status(400).json({ success: false, message: 'childKey is required.' });
    if (typeof image !== 'string') return res.status(400).json({ success: false, message: 'Please provide an image (base64 data URL).' });

    const match = image.match(/^data:image\/(?:png|jpe?g|webp);base64,(.+)$/i);
    if (!match) return res.status(400).json({ success: false, message: 'Please upload a JPG, PNG, or WEBP image.' });
    const buf = Buffer.from(match[1], 'base64');
    if (buf.length > MAX_REQUIREMENT_BYTES) return res.status(400).json({ success: false, message: 'Image size must be under 5MB.' });
    const mime = detectChildPhotoMime(buf);
    if (!mime) return res.status(400).json({ success: false, message: 'Image content is not a valid JPG, PNG, or WEBP file.' });

    const childFilter = { parent: req.user._id, $or: [{ permanentStudentId: childKey }] };
    if (mongoose.Types.ObjectId.isValid(childKey)) childFilter.$or.push({ _id: childKey });
    const enrollments = await Enrollment.find(childFilter).select('_id studentProfileImage').lean();
    if (enrollments.length === 0) return res.status(404).json({ success: false, message: 'Child not found on your account.' });

    if (!fs.existsSync(CHILD_PHOTO_DIR)) fs.mkdirSync(CHILD_PHOTO_DIR, { recursive: true });
    const filename = `${String(childKey).replace(/[^\w-]/g, '')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${CHILD_PHOTO_EXT[mime]}`;
    fs.writeFileSync(path.join(CHILD_PHOTO_DIR, filename), buf);
    const studentProfileImage = `/uploads/student-avatars/${filename}`;

    await Enrollment.updateMany({ _id: { $in: enrollments.map((e) => e._id) } }, { $set: { studentProfileImage } });

    for (const old of new Set(enrollments.map((e) => e.studentProfileImage).filter(Boolean))) {
      if (String(old).startsWith('/uploads/student-avatars/')) {
        fs.unlink(path.join(CHILD_PHOTO_DIR, path.basename(old)), () => {});
      }
    }

    logAudit({ req, userId: req.user._id, action: 'Child Profile Image Update', module: 'Enrollment',
      description: `Parent updated profile picture for child ${childKey}`, status: 'SUCCESS' }).catch(() => {});

    return res.status(200).json({ success: true, message: 'Student profile picture updated.', studentProfileImage });
  } catch (err) {
    console.error('setChildProfilePhoto error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update the profile picture.' });
  }
};

// ── Admin walk-in Add Student  POST /api/enrollments/admin/walk-in ─────────
// Payments_FullyPaid_NewProgramRefinements_AdminWalkIn.pdf Section E. Mirrors
// submitEnrollment's package/age validation, but is admin-authenticated end to
// end (the parent account created in step 1 is only ever referenced by id here,
// never used to authorize the request) and settles the down payment immediately
// as 'verified' — the admin physically collected it, so there is no proof-upload
// or review-queue step, and the enrollment is approved right away.
const adminWalkInEnroll = async (req, res) => {
  try {
    const body = req.body || {};

    const parentId = String(body.parentId || '');
    if (!parentId) return res.status(400).json({ success: false, message: 'parentId is required (create the parent account first).' });
    let parentUser = await User.findOne({ _id: parentId, role: { $in: ['parent', 'student'] } });
    // The parent typed in the Add Student wizard is only a verified PENDING signup until
    // this walk-in is completed; the real account is created together with the enrollment.
    let pendingSignup = null;
    if (!parentUser) {
      pendingSignup = mongoose.Types.ObjectId.isValid(parentId)
        ? await PendingParentSignup.findById(parentId).select('+passwordHash')
        : null;
      if (!pendingSignup) return res.status(404).json({ success: false, message: 'Parent account not found.' });
      await assertPendingReady(pendingSignup);
    }

    // ── Validate packages (same resolution as the parent-facing wizard) ──
    const packages = Array.isArray(body.packages) ? body.packages : [];
    if (packages.length === 0)
      return res.status(400).json({ success: false, message: 'At least one program package must be selected.' });

    const packageKeys = packages.map((item) => `${item.programCode}:${item.packageSlug}`);
    const pricedPackages = await Pricing.find({
      active: true,
      $expr: { $in: [{ $concat: ['$programCode', ':', '$packageSlug'] }, packageKeys] },
    }).lean();
    const pricedByKey = new Map(pricedPackages.map((item) => [`${item.programCode}:${item.packageSlug}`, item]));
    const canonicalPackages = packages.map((item) => {
      const priced = pricedByKey.get(`${item.programCode}:${item.packageSlug}`);
      if (!priced) throw Object.assign(new Error('One or more selected packages are no longer available.'), { statusCode: 400 });
      return {
        programCode: priced.programCode,
        packageSlug: priced.packageSlug,
        displayName: priced.displayName,
        price: priced.priceFull,
        paymentOption: 'down',
      };
    });

    // ── Age gate — recomputed server-side, never trust the UI ──
    const ageCheck = validateEnrollmentAge(body.birthdate);
    if (!ageCheck.valid) return res.status(400).json({ success: false, message: ageCheck.reason });
    const childAge = ageCheck.ageYears;
    for (const item of canonicalPackages) {
      const eligibility = checkProgramEligibility(item.programCode, childAge);
      if (!eligibility.eligible) throw Object.assign(new Error(eligibility.reason), { statusCode: 400 });
    }

    // ── Student snapshot ──
    const rawFirst = String(body.studentFirstName || '').trim();
    const rawMiddle = String(body.studentMiddleName || '').trim();
    const rawLast = String(body.studentLastName || '').trim();
    for (const [val, label, required] of [
      [rawFirst, 'Student first name', true],
      [rawMiddle, 'Student middle name', false],
      [rawLast, 'Student last name', true],
    ]) {
      const err = validateFullName(val, label, { minParts: 1, required });
      if (err) return res.status(400).json({ success: false, message: err });
    }
    const snapshot = {
      firstName: toTitleCase(rawFirst),
      lastName: toTitleCase(rawLast),
      middleName: rawMiddle ? toTitleCase(rawMiddle) : '',
      birthdate: new Date(body.birthdate),
      computedAge: childAge,
    };

    // ── Preferred schedule (optional at a walk-in — admin may not always ask) ──
    const preferredStartDate = body.preferredStartDate ? new Date(body.preferredStartDate) : null;
    const VALID_PREFERRED_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const preferredDaysByProgram = Array.isArray(body.preferredDaysByProgram)
      ? body.preferredDaysByProgram
          .filter((p) => p && typeof p.programCode === 'string')
          .map((p) => ({
            programCode: p.programCode.toUpperCase(),
            days: Array.isArray(p.days)
              ? p.days.map((d) => String(d || '').trim()).filter((d) => VALID_PREFERRED_DAYS.includes(d)).filter((d, i, arr) => arr.indexOf(d) === i)
              : [],
          }))
      : [];
    const preferredDays = [...new Set(preferredDaysByProgram.flatMap((p) => p.days))]
      .sort((a, b) => VALID_PREFERRED_DAYS.indexOf(a) - VALID_PREFERRED_DAYS.indexOf(b));
    const preferredSlots = Array.isArray(body.preferredSlots)
      ? body.preferredSlots
          .filter((s) => s && typeof s.programCode === 'string' && typeof s.startTime === 'string' && typeof s.endTime === 'string')
          .map((s) => ({ programCode: s.programCode.toUpperCase(), startTime: s.startTime, endTime: s.endTime }))
      : [];

    // ── Consent ──
    const consentVersion = String(body.consentVersion || '1.0');
    const consentItems = Array.isArray(body.consentItems) ? body.consentItems : [];
    const allConsented = consentItems.length > 0 && consentItems.every((c) => c.accepted === true);
    if (!allConsented)
      return res.status(400).json({ success: false, message: 'All participation agreement items must be accepted.' });

    // ── Amount actually collected on-site — admin-typed, based on the selected
    // program(s); the standard 50%-down figure is what the UI defaults to, but
    // the admin can adjust it to match what was genuinely handed over. ──
    const { totalFee, amountDue } = computeAmounts(canonicalPackages, 'down');
    const amountPaid = Number(body.amountPaid);
    if (!Number.isFinite(amountPaid) || amountPaid <= 0)
      return res.status(400).json({ success: false, message: 'Enter the amount actually collected.' });

    const enrollmentId = await generateEnrollmentId();
    const now = new Date();

    let createdParent = null;
    let enrollment = null;
    let payment = null;
    try {
    if (pendingSignup) {
      createdParent = await createUserFromPending(pendingSignup);
      parentUser = createdParent;
    }

    enrollment = new Enrollment({
      enrollmentId,
      parent: parentUser._id,
      studentId: enrollmentId,
      permanentStudentId: enrollmentId,
      studentSnapshot: snapshot,
      packages: canonicalPackages,
      preferredStartDate,
      preferredDays,
      preferredDaysByProgram,
      preferredSlots,
      paymentOption: 'down',
      totalFee,
      consentVersion,
      consentAcceptedAt: now,
      consentItems,
      status: 'approved',
      // Fully settled if the admin collected the whole package price on-site;
      // otherwise this is the standard "50% down, remaining still owed" state —
      // never claim 'paid' off less than the full amount.
      paymentStatus: amountPaid >= totalFee ? 'paid' : 'partial',
      approvedBy: req.user._id,
      approvedAt: now,
    });
    pushStatusHistory(enrollment, 'submitted', req.user._id, 'admin', 'Walk-in enrollment (admin-assisted)');
    pushStatusHistory(enrollment, 'approved', req.user._id, 'admin', 'Walk-in enrollment — payment collected on-site');
    await enrollment.save();

    payment = new Payment({
      parent: parentUser._id,
      enrollment: enrollment._id,
      amount: amountPaid,
      amountDue,
      amountPaid,
      paymentType: amountPaid >= totalFee ? 'full' : 'down',
      paymentMethod: 'cash',
      status: 'verified',
      verifiedAt: now,
      verifiedBy: req.user._id,
      notes: 'Walk-in — collected on-site by admin.',
    });
    await payment.save();
    } catch (creationErr) {
      if (enrollment?._id) await Enrollment.deleteOne({ _id: enrollment._id }).catch(() => {});
      if (createdParent) await User.deleteOne({ _id: createdParent._id }).catch(() => {});
      throw creationErr;
    }
    if (pendingSignup) await discardPending(pendingSignup);

    await User.findByIdAndUpdate(parentUser._id, {
      $set: { isActive: true, enrollmentStatus: 'active', enrollmentDraft: false },
      $unset: { draftExpiresAt: 1 },
    });

    const parentFull = await User.findById(parentUser._id).select('email firstName lastName').lean();
    if (parentFull?.email) {
      sendEnrollmentApprovedEmail(parentFull.email, {
        parentName: `${parentFull.firstName} ${parentFull.lastName}`,
        studentName: `${snapshot.firstName} ${snapshot.lastName}`,
        enrollmentId: permanentIdOf(enrollment),
        studentId: enrollment.studentId,
      }).catch(() => {});
    }

    logAudit({
      req, userId: req.user._id, action: 'Admin Walk-In Enrollment', module: 'Enrollment',
      description: `Walk-in enrollment ${enrollmentId} for ${snapshot.firstName} ${snapshot.lastName} — ₱${amountPaid} collected on-site`,
      status: 'SUCCESS', metadata: { enrollmentId, amountPaid, totalFee },
    }).catch(() => {});

    return res.status(201).json({
      success: true,
      message: 'Walk-in enrollment created.',
      enrollmentId,
      enrollmentDbId: String(enrollment._id),
      paymentId: String(payment._id),
      totalFee,
      amountDue,
      amountPaid,
    });
  } catch (err) {
    console.error('adminWalkInEnroll error:', err);
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Walk-in enrollment failed.' });
  }
};

// ── Payment instruction helper ──────────────────────────────────────────
async function getPaymentInstructionsForMethod(method) {
  const DEFAULTS = {
    gcash:   { accountName: 'Bee Bright Tutorial Center', accountNumber: '09307517208', bankBranch: null },
    maribank: { accountName: 'Bee Bright Tutorial Center', accountNumber: '5678-9012-3456', bankBranch: 'Main Branch' },
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

    // Explicitly excludes 'remaining' — this is the DOWN payment's proof-submission
    // path only, kept separate from submitRemainingPaymentProof below even if a
    // 'remaining' Payment already exists and would otherwise be the most recent one.
    let payment = await Payment.findOne({ enrollment: enrollment._id, paymentType: { $ne: 'remaining' } }).sort({ createdAt: -1 });
    if (!payment) {
      // No down-payment record exists for this enrollment at all. Two real cases:
      if (enrollment.paymentStatus === 'paid') {
        // Already fully settled (e.g. an enrollment approved before the Payment
        // model was wired up everywhere) — nothing to attach this proof to, and
        // the generic "Payment record not found" message wrongly implies the
        // parent did something wrong. Say what's actually true instead.
        return res.status(409).json({ success: false, alreadyPaid: true,
          message: 'This enrollment is already fully paid — no payment proof is needed.' });
      }
      // A genuinely missing down-payment record for an otherwise-normal enrollment
      // (e.g. a gap from an older code path) permanently blocks the parent from
      // ever paying. Self-heal by creating the down-payment record now, from the
      // same 50%-down policy every enrollment is charged under.
      const { amountDue } = computeAmounts(enrollment.packages || [], 'down');
      payment = new Payment({
        parent: enrollment.parent,
        enrollment: enrollment._id,
        amount: amountDue,
        amountDue,
        paymentType: 'down',
        paymentMethod: VALID_PAYMENT_METHODS.includes(String(paymentMethod || '').toLowerCase()) ? paymentMethod.toLowerCase() : 'gcash',
        status: 'pending',
      });
      await payment.save();
    }

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
        subject: `Bee Bright — Payment Proof Received (${permanentIdOf(enrollment)})`,
        html: `<p>Hi ${parentUser.firstName}, we received your payment proof for student ${permanentIdOf(enrollment)}. Our team will verify it within 1–2 business days.</p>`,
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

// ── Pay the remaining 50% balance ────────────────────────────────────────
// POST /api/enrollments/:enrollmentId/submit-remaining-proof
// Only reachable once the down payment is actually verified — that's the parent's
// signal the remaining balance is even owed yet. Creates its own Payment document
// (paymentType: 'remaining') rather than reusing the down payment's, so both stay
// independently auditable; a prior rejected remaining-payment attempt is reused
// rather than creating a new one each resubmission.
const submitRemainingPaymentProof = async (req, res) => {
  try {
    const { enrollmentId } = req.params;
    const { proofDataUrl, payerReference, paymentMethod } = req.body || {};

    const enrollment = await Enrollment.findOne({ enrollmentId });
    if (!enrollment) return res.status(404).json({ success: false, message: 'Enrollment not found.' });

    const downPayment = await Payment.findOne({ enrollment: enrollment._id, paymentType: { $ne: 'remaining' } }).sort({ createdAt: -1 });
    if (!downPayment || downPayment.status !== 'verified') {
      return res.status(400).json({ success: false, message: 'The down payment must be verified before the remaining balance can be paid.' });
    }

    const amountPaidSoFar = downPayment.amountPaid ?? downPayment.amountDue ?? downPayment.amount ?? 0;
    const remainingAmount = Math.max(0, Math.round((enrollment.totalFee || 0) - amountPaidSoFar));
    if (remainingAmount <= 0) {
      return res.status(400).json({ success: false, message: 'No remaining balance is due.' });
    }

    let remainingPayment = await Payment.findOne({ enrollment: enrollment._id, paymentType: 'remaining' }).sort({ createdAt: -1 });
    if (!remainingPayment || remainingPayment.status === 'verified') {
      remainingPayment = new Payment({
        parent: enrollment.parent,
        enrollment: enrollment._id,
        amount: remainingAmount,
        amountDue: remainingAmount,
        paymentType: 'remaining',
        paymentMethod: 'gcash',
        status: 'pending',
      });
    }

    const proofUrl = saveProofFromDataUrl(proofDataUrl, enrollment._id);
    if (!proofUrl) return res.status(400).json({ success: false, message: 'Payment proof is required.' });

    remainingPayment.proofUrl = proofUrl;
    remainingPayment.payerReference = String(payerReference || '').trim() || null;
    if (paymentMethod && VALID_PAYMENT_METHODS.includes(paymentMethod)) remainingPayment.paymentMethod = paymentMethod;
    remainingPayment.status = 'submitted';
    remainingPayment.submittedAt = new Date();
    remainingPayment.rejectionReason = null;
    remainingPayment.resubmissionCount = remainingPayment.isNew ? 0 : (remainingPayment.resubmissionCount || 0) + 1;
    await remainingPayment.save();

    // The enrollment itself stays 'active'/'approved' throughout — only the
    // payment-tracking field reflects "remaining balance submitted, awaiting review."
    enrollment.paymentStatus = 'pending_verification';
    await enrollment.save();

    const parentUser = await User.findById(enrollment.parent).select('email firstName lastName').lean();
    if (parentUser?.email) {
      const { sendEmail } = require('../utils/emailService');
      sendEmail({
        to: parentUser.email,
        subject: `Bee Bright — Remaining Balance Proof Received (${permanentIdOf(enrollment)})`,
        html: `<p>Hi ${parentUser.firstName}, we received your proof of payment for the remaining balance for student ${permanentIdOf(enrollment)}. Our team will verify it within 1–2 business days.</p>`,
      }, 'remaining proof received notification').catch(() => {});
    }

    logAudit({ req, action: 'Submit Remaining Payment Proof', module: 'Payment',
      description: `Remaining-balance proof submitted for ${enrollmentId}`, status: 'SUCCESS',
      metadata: { enrollmentId, paymentId: remainingPayment._id, amount: remainingAmount } }).catch(() => {});

    return res.status(200).json({ success: true, message: 'Payment proof submitted. We will verify it shortly.', amount: remainingAmount });
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
          .select('status paymentType amount paymentMethod amountDue amountPaid proofUrl submittedAt verifiedAt rejectionReason referenceNumber resubmissionCount')
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
        .populate('student', 'firstName lastName middleName email phone profileImage')
        .populate('selectedSubjects', 'name code')
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
    // `payments` at the top level (the admin modal reads res.data.payments); also nested
    // on `enrollment` for any older caller that expected it there.
    return res.status(200).json({ success: true, enrollment: { ...enrollment, payments }, payments });
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

    // Payment is always split 50/50 (down payment at enrollment, remaining balance
    // later) — a 'remaining' payment is verified/rejected against an enrollment that's
    // already approved and active, so it must never re-run the down-payment-era status
    // transitions (pending_approval / submitted) or flip the enrollment back to pending.
    const isRemainingBalance = payment.paymentType === 'remaining';

    if (verified) {
      payment.status = 'verified';
      payment.verifiedAt = new Date();
      payment.verifiedBy = req.user._id;
      payment.amountPaid = payment.amountDue || payment.amount;
      payment.notes = note || null;

      if (isRemainingBalance) {
        enrollment.paymentStatus = 'paid';
      } else {
        enrollment.paymentStatus = 'partial';
        enrollment.verifiedBy = req.user._id;
        enrollment.paymentVerifiedAt = new Date();
        pushStatusHistory(enrollment, 'pending_approval', req.user._id, req.user.role, note || 'Payment verified');
      }
    } else {
      payment.status = 'rejected';
      payment.rejectionReason = note || 'Payment rejected by admin';

      if (isRemainingBalance) {
        // The down payment already went through — this only reverts to "still owes
        // the remaining balance," never back to the whole enrollment being unpaid.
        enrollment.paymentStatus = 'partial';
      } else {
        enrollment.paymentStatus = 'pending';
        enrollment.allowResubmission = true;
        pushStatusHistory(enrollment, 'submitted', req.user._id, req.user.role, `Payment rejected: ${note || ''}`);
      }
    }

    await Promise.all([payment.save(), enrollment.save()]);

    // Email parent
    const parentUser = await User.findById(enrollment.parent).select('email firstName lastName').lean();
    if (parentUser?.email && verified) {
      sendPaymentVerifiedEmail(parentUser.email, {
        parentName: `${parentUser.firstName} ${parentUser.lastName}`,
        studentName: `${enrollment.studentSnapshot?.firstName || ''} ${enrollment.studentSnapshot?.lastName || ''}`.trim(),
        enrollmentId: permanentIdOf(enrollment),
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

    // ── Student ID ────────────────────────────────────────────────────────
    // The Student ID is the child's PERMANENT ID (the BB-… enrollmentId of their
    // first enrollment) — never a fresh one per approval, so Renew / Add Program
    // approvals keep the child's original ID. See utils/studentIdentity.js.
    const now = new Date();
    const studentId = permanentIdOf(enrollment);
    enrollment.permanentStudentId = studentId;

    // ── Store Student ID on the Enrollment ────────────────────────────────
    enrollment.studentId = studentId;
    enrollment.approvedBy = req.user._id;
    enrollment.approvedAt = now;
    // Approval only ever happens once the DOWN payment (50%) is verified — the
    // remaining 50% is still owed at this point, so this is not "fully paid" yet.
    // See Parent_Payments_50Percent_Display_and_Payment_Methods.pdf.
    enrollment.paymentStatus = 'partial';
    pushStatusHistory(enrollment, 'approved', req.user._id, req.user.role, 'Enrollment approved');
    await enrollment.save();

    // ── Activate the Parent account ───────────────────────────────────────
    await User.findByIdAndUpdate(enrollment.parent, {
      $set: { isActive: true, enrollmentStatus: 'active', enrollmentDraft: false },
      $unset: { draftExpiresAt: 1 },
    });

    // ── Send approval email to Parent ─────────────────────────────────────
    const parentFull = await User.findById(enrollment.parent).select('email firstName lastName').lean();
    const snap = enrollment.studentSnapshot || {};
    if (parentFull?.email) {
      sendEnrollmentApprovedEmail(parentFull.email, {
        parentName: `${parentFull.firstName} ${parentFull.lastName}`,
        studentName: `${snap.firstName || ''} ${snap.lastName || ''}`.trim(),
        enrollmentId: permanentIdOf(enrollment),
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
        enrollmentId: permanentIdOf(enrollment),
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

// ── Enrollment wizard Step 7: live tutor-capacity availability ─────────────
// Hourly slots for 1-on-1 programs (ACT102/EXP106), 8AM-5PM, lunch skipped.
// Toddlers Playgroup (TPG101) uses its own fixed 2-hour blocks instead — see
// PROGRAM_POLICIES.TPG101.fixedSlots in utils/schedulingPolicy.js.
const HOURLY_PROGRAM_SLOTS = [
  ['08:00', '09:00'], ['09:00', '10:00'], ['10:00', '11:00'], ['11:00', '12:00'],
  ['13:00', '14:00'], ['14:00', '15:00'], ['15:00', '16:00'], ['16:00', '17:00'],
];

// 24-hour "HH:MM" -> a display-only 12-hour label like "8AM" / "1:30PM". The
// underlying startTime/endTime strings stay 24-hour everywhere else — this is
// purely for the label field the frontend renders to the parent.
function to12Hour(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}

// @desc    Live per-hour tutor-capacity availability for the enrollment wizard's
//          Schedule Pref step. Tells the parent "is there enough tutor capacity
//          at this hour" only — the admin still manually assigns the specific
//          tutor after approval; this never auto-assigns anyone.
// @route   GET /api/enrollment/availability?date=YYYY-MM-DD&programCode=ACT102
// @access  Public — matches the rest of the enrollment wizard's routes.
const getEnrollmentAvailability = async (req, res) => {
  try {
    const { date: dateStr, programCode } = req.query;
    if (!dateStr || !programCode) {
      return res.status(400).json({ success: false, message: 'date and programCode are required' });
    }

    const code = String(programCode).toUpperCase();
    const policy = PROGRAM_POLICIES[code];
    if (!policy) {
      return res.status(400).json({ success: false, message: 'Unknown programCode' });
    }

    const date = new Date(`${dateStr}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid date' });
    }

    // Tutors are NOT individually scoped to programs in practice — account
    // creation only sets employmentType (full-time/part-time), nothing ever
    // populates subjectsTaught, and there's no UI that does. Every active tutor
    // is implicitly eligible for every program, so the pool is every active
    // tutor, full stop — no subjectsTaught filter. (2026-09-22 fix: this used
    // to filter by subjectsTaught, which made M always 0 in practice since the
    // field is never populated by any real flow.)
    const tutors = await User.find({
      role: 'tutor',
      isActive: true,
      deletedAt: null,
    }).select('_id').lean();
    const total = tutors.length;

    const slotDefs = policy.fixedSlots
      ? policy.fixedSlots.map((s) => [s.startTime, s.endTime])
      : HOURLY_PROGRAM_SLOTS;

    const slots = {};
    for (const [startTime, endTime] of slotDefs) {
      let available = 0;
      for (const tutor of tutors) {
        const check = await canTutorHandleSchedule({
          tutorId: tutor._id,
          date,
          startTime,
          endTime,
        });
        if (check.ok) available += 1;
      }
      slots[`${startTime}-${endTime}`] = {
        label: `${to12Hour(startTime)}-${to12Hour(endTime)}`,
        available,
        total,
      };
    }

    return res.status(200).json({ success: true, date: dateStr, programCode: code, slots });
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
  submitRemainingPaymentProof,
  getMyEnrollments,
  trackEnrollment,
  getEnrollmentAvailability,
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
  adminWalkInEnroll,
  setChildProfilePhoto,
  getPaymentInstructions,
};
