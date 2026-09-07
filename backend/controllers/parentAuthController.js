/**
 * Parent/Guardian Authentication Controller
 * Handles registration, OTP send/verify for the enrollment wizard flow.
 *
 * Flow:
 *  1. POST /api/auth/register-parent  → create inactive User(role:parent), send OTP
 *  2. POST /api/auth/parent-otp/send  → resend OTP
 *  3. POST /api/auth/parent-otp/verify → verify OTP, set emailVerifiedAt, return short-lived token
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { sendEmail, getEmailErrorMessage, logEmailError } = require('../utils/emailService');
const { logAudit } = require('../utils/auditService');
const { validateFullName, validatePhMobile, normalizeMobile, checkMobileNumberUnique, toTitleCase } = require('../utils/validation');

// ── Constants ─────────────────────────────────────────────────────────────
const OTP_TTL_MINUTES = 10;
const OTP_RESEND_COOLDOWN_SECONDS = 120;
const OTP_MAX_ATTEMPTS = 5;
const ENROLLMENT_TOKEN_TTL = '2h'; // short-lived token scoped to enrollment wizard
// How long an abandoned Step-2 draft account survives before the TTL index removes it.
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const OTP_SELECT = '+parentOtpHash +parentOtpExpires +parentOtpAttempts +parentOtpLastSentAt';

const draftExpiry = () => new Date(Date.now() + DRAFT_TTL_MS);

const splitName = (cleanName) => {
  const parts = String(cleanName || '').split(' ').filter(Boolean);
  const firstName = parts[0] || '';
  const lastName = parts.length > 1 ? parts[parts.length - 1] : firstName;
  const middleName = parts.length > 2 ? parts.slice(1, -1).join(' ') : '';
  return { firstName, middleName, lastName };
};

// ── Helpers ───────────────────────────────────────────────────────────────
const normalizeEmail = (v = '') => String(v).trim().toLowerCase();

const generateOtp = () =>
  String(Math.floor(100000 + Math.random() * 900000));

const hashValue = (v) =>
  crypto.createHash('sha256').update(String(v)).digest('hex');

const maskEmail = (email) => {
  const [local = '', domain = ''] = String(email).split('@');
  if (local.length <= 2) return `${local[0] || '*'}*@${domain}`;
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
};

const issueEnrollmentToken = (userId) =>
  jwt.sign({ id: userId, scope: 'enrollment' }, process.env.JWT_SECRET, {
    expiresIn: ENROLLMENT_TOKEN_TTL,
  });

const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

// ── Email ─────────────────────────────────────────────────────────────────
async function sendParentOtpEmail(to, otp) {
  return sendEmail(
    {
      to,
      subject: 'Bee Bright — Verify your email to continue enrollment',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#f59e0b,#d97706);padding:28px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:24px;">🐝 Bee Bright</h1>
            <p style="color:#fef3c7;margin:6px 0 0;font-size:14px;">Tutorial Center</p>
          </div>
          <div style="padding:32px;background:#fffbeb;border:1px solid #fde68a;border-top:none;border-radius:0 0 8px 8px;">
            <h2 style="color:#92400e;margin:0 0 12px;">Email Verification</h2>
            <p style="color:#78350f;line-height:1.6;">
              Thank you for registering! Enter the code below to verify your email and continue with the enrollment wizard.
            </p>
            <div style="text-align:center;margin:28px 0;">
              <div style="display:inline-block;background:#fff;border:2px solid #f59e0b;border-radius:12px;padding:16px 40px;">
                <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#92400e;">${otp}</span>
              </div>
            </div>
            <p style="color:#78350f;font-size:14px;text-align:center;">
              This code expires in <strong>${OTP_TTL_MINUTES} minutes</strong>.
            </p>
            <p style="color:#b45309;font-size:13px;text-align:center;margin-top:20px;">
              If you did not request this, you can safely ignore this email.
            </p>
          </div>
        </div>`,
    },
    'parent registration OTP'
  );
}

// ── Controllers ───────────────────────────────────────────────────────────

/**
 * POST /api/auth/register-parent
 * Body: { name, email, mobile, password, draftId? }
 *
 * Creates a DRAFT parent account (enrollmentDraft:true) and sends an OTP. The
 * real, permanent account is only finalized when the parent submits the
 * enrollment (see enrollmentController.submitEnrollment).
 *
 * `draftId` is the id this wizard session is already tracking. When present it
 * lets the parent go Back and fix a mistyped email / mobile without their own
 * earlier draft blocking them — the same record is updated in place.
 *
 * Uniqueness (email + mobile) is enforced against FINALIZED accounts only, so an
 * abandoned draft never permanently reserves a number or address.
 */
const registerParent = async (req, res) => {
  try {
    const { name, email, mobile, password, draftId } = req.body;

    // ── Validation ──
    const nameErr = validateFullName(name, 'Full name', { minParts: 2 });
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    const cleanName = toTitleCase(name);

    const normalizedEmail = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });

    const mobileErr = validatePhMobile(mobile, 'Mobile number');
    if (mobileErr) return res.status(400).json({ success: false, message: mobileErr });
    const phoneDigits = normalizeMobile(mobile);

    if (!PASSWORD_RE.test(password))
      return res.status(400).json({
        success: false,
        message:
          'Password must be at least 8 characters and include uppercase, lowercase, number, and special character (@$!%*?&).',
      });

    // ── Resolve which record to write ──────────────────────────────────────
    // 1. The draft this wizard session already owns (if the id still points at a draft).
    let sessionDraft = null;
    if (draftId && mongoose.Types.ObjectId.isValid(draftId)) {
      sessionDraft = await User.findOne({ _id: draftId, role: 'parent', enrollmentDraft: true }).select(OTP_SELECT);
    }

    // 2. Whatever account currently holds the requested email (email is unique).
    const byEmail = await User.findOne({ email: normalizedEmail }).select(OTP_SELECT);

    // A finalized (non-draft) account already owns this email → cannot reuse it.
    if (byEmail && !byEmail.enrollmentDraft) {
      if (byEmail.role !== 'parent')
        return res.status(409).json({
          success: false,
          message: 'An account with this email already exists. Please log in instead.',
        });
      if (byEmail.emailVerifiedAt && byEmail.isActive)
        return res.status(409).json({
          success: false,
          message: 'This email is already registered and verified. Please log in.',
        });
      // else: a legacy unverified/inactive non-draft parent — fall through and reuse it.
    }

    // Mobile number must be free among FINALIZED accounts only (drafts don't reserve).
    const mobileIsFree = await checkMobileNumberUnique(phoneDigits, byEmail?._id || sessionDraft?._id || null);
    if (!mobileIsFree) {
      return res.status(409).json({
        success: false,
        message: 'Mobile number is already registered to another account.',
      });
    }

    // Prefer the record that owns the email; otherwise reuse the session draft.
    let parent = byEmail || sessionDraft;

    // If the email moved to a *different* draft, retire the now-orphaned session draft.
    if (parent && sessionDraft && String(parent._id) !== String(sessionDraft._id)) {
      await User.deleteOne({ _id: sessionDraft._id, enrollmentDraft: true }).catch(() => {});
    }

    const { firstName, middleName, lastName } = splitName(cleanName);
    const emailChanged = !!parent && parent.email !== normalizedEmail;

    if (parent) {
      // Reuse the draft / legacy record — update its details in place.
      parent.firstName = firstName;
      parent.middleName = middleName;
      parent.lastName = lastName;
      parent.email = normalizedEmail;
      parent.phone = phoneDigits;
      parent.password = password; // re-hashed by the pre-save hook when modified
      parent.role = 'parent';
      parent.isActive = false;
      if (emailChanged) parent.emailVerifiedAt = null; // new address → must verify again
      if (parent.enrollmentDraft) parent.draftExpiresAt = draftExpiry();

      // Cooldown only matters when we'd resend to the SAME address.
      if (!emailChanged && parent.parentOtpLastSentAt) {
        const elapsed = Date.now() - new Date(parent.parentOtpLastSentAt).getTime();
        if (elapsed < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
          const wait = Math.ceil((OTP_RESEND_COOLDOWN_SECONDS * 1000 - elapsed) / 1000);
          return res.status(429).json({
            success: false,
            message: `Please wait ${wait} seconds before requesting a new code.`,
          });
        }
      }
    } else {
      // Brand-new draft account.
      parent = new User({
        firstName,
        middleName,
        lastName,
        email: normalizedEmail,
        phone: phoneDigits,
        password,
        role: 'parent',
        isActive: false,
        emailVerifiedAt: null,
        enrollmentDraft: true,
        draftExpiresAt: draftExpiry(),
      });
    }

    // ── Generate & store OTP ──
    const otp = generateOtp();
    parent.parentOtpHash = hashValue(otp);
    parent.parentOtpExpires = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    parent.parentOtpAttempts = 0;
    parent.parentOtpLastSentAt = new Date();

    await parent.save();

    // ── Send email ──
    try {
      await sendParentOtpEmail(normalizedEmail, otp);
    } catch (emailErr) {
      logEmailError('parent OTP email failed', emailErr, { email: normalizedEmail });
      return res.status(502).json({
        success: false,
        message: getEmailErrorMessage(emailErr),
      });
    }

    logAudit({
      req,
      action: 'Parent Register',
      module: 'Authentication',
      description: `Parent account created for ${normalizedEmail}`,
      status: 'SUCCESS',
      metadata: { email: normalizedEmail },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: 'Verification code sent to your email.',
      verificationSentTo: maskEmail(normalizedEmail),
      parentId: String(parent._id),
    });
  } catch (err) {
    console.error('registerParent error:', err);
    return res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
};

/**
 * POST /api/auth/parent-otp/send
 * Body: { email }   – resend OTP for an existing unverified parent
 */
const sendParentOtp = async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email || '');
    if (!normalizedEmail)
      return res.status(400).json({ success: false, message: 'Email is required.' });

    const parent = await User.findOne({ email: normalizedEmail, role: 'parent' }).select(
      '+parentOtpHash +parentOtpExpires +parentOtpAttempts +parentOtpLastSentAt'
    );

    if (!parent)
      return res.status(404).json({
        success: false,
        message: 'No pending parent account found for this email. Please register first.',
      });

    if (parent.emailVerifiedAt)
      return res.status(400).json({
        success: false,
        message: 'Email already verified. Please proceed to the enrollment wizard.',
      });

    const lastSent = parent.parentOtpLastSentAt;
    if (lastSent) {
      const elapsed = Date.now() - new Date(lastSent).getTime();
      if (elapsed < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
        const wait = Math.ceil((OTP_RESEND_COOLDOWN_SECONDS * 1000 - elapsed) / 1000);
        return res.status(429).json({
          success: false,
          message: `Please wait ${wait} seconds before requesting a new code.`,
          retryAfterSeconds: wait,
        });
      }
    }

    const otp = generateOtp();
    parent.parentOtpHash = hashValue(otp);
    parent.parentOtpExpires = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    parent.parentOtpAttempts = 0;
    parent.parentOtpLastSentAt = new Date();
    if (parent.enrollmentDraft) parent.draftExpiresAt = new Date(Date.now() + DRAFT_TTL_MS);
    await parent.save();

    try {
      await sendParentOtpEmail(normalizedEmail, otp);
    } catch (emailErr) {
      logEmailError('parent OTP resend failed', emailErr, { email: normalizedEmail });
      return res.status(502).json({ success: false, message: getEmailErrorMessage(emailErr) });
    }

    return res.status(200).json({
      success: true,
      message: 'Verification code resent.',
      verificationSentTo: maskEmail(normalizedEmail),
    });
  } catch (err) {
    console.error('sendParentOtp error:', err);
    return res.status(500).json({ success: false, message: 'Failed to resend code.' });
  }
};

/**
 * POST /api/auth/parent-otp/verify
 * Body: { email, code }
 *
 * Returns a short-lived JWT (scope: enrollment) so the wizard can auto-save drafts.
 */
const verifyParentOtp = async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email || '');
    const code = String(req.body?.code || '').trim();

    if (!normalizedEmail || !code)
      return res.status(400).json({ success: false, message: 'Email and verification code are required.' });

    const parent = await User.findOne({ email: normalizedEmail, role: 'parent' }).select(
      '+parentOtpHash +parentOtpExpires +parentOtpAttempts +parentOtpLastSentAt password'
    );

    if (!parent)
      return res.status(404).json({
        success: false,
        message: 'No pending account found. Please register first.',
      });

    if (parent.emailVerifiedAt) {
      // Already verified – just return a new token
      const token = issueEnrollmentToken(parent._id);
      return res.status(200).json({
        success: true,
        message: 'Email already verified.',
        token,
        emailVerifiedAt: parent.emailVerifiedAt,
        parentId: String(parent._id),
      });
    }

    if (!parent.parentOtpHash || !parent.parentOtpExpires)
      return res.status(400).json({ success: false, message: 'No verification code found. Please request a new one.' });

    if (new Date() > new Date(parent.parentOtpExpires))
      return res.status(400).json({ success: false, message: 'Verification code has expired. Please request a new one.' });

    // Increment attempts before checking to prevent timing attacks
    parent.parentOtpAttempts = (parent.parentOtpAttempts || 0) + 1;

    if (parent.parentOtpAttempts > OTP_MAX_ATTEMPTS) {
      await parent.save();
      return res.status(429).json({
        success: false,
        message: 'Too many incorrect attempts. Please request a new verification code.',
        code: 'MAX_ATTEMPTS',
      });
    }

    if (hashValue(code) !== parent.parentOtpHash) {
      const remaining = OTP_MAX_ATTEMPTS - parent.parentOtpAttempts;
      await parent.save();
      return res.status(400).json({
        success: false,
        message: `Incorrect verification code. ${remaining} attempt(s) remaining.`,
        attemptsRemaining: remaining,
      });
    }

    // ── Success ──
    parent.emailVerifiedAt = new Date();
    parent.parentOtpHash = undefined;
    parent.parentOtpExpires = undefined;
    parent.parentOtpAttempts = 0;
    // Verifying the email buys the draft a fresh survival window.
    if (parent.enrollmentDraft) parent.draftExpiresAt = new Date(Date.now() + DRAFT_TTL_MS);
    await parent.save();

    const token = issueEnrollmentToken(parent._id);

    logAudit({
      req,
      userId: parent._id,
      action: 'Parent OTP Verified',
      module: 'Authentication',
      description: `Parent email verified: ${normalizedEmail}`,
      status: 'SUCCESS',
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: 'Email verified successfully. You may now continue with enrollment.',
      token,
      emailVerifiedAt: parent.emailVerifiedAt,
      parentId: String(parent._id),
    });
  } catch (err) {
    console.error('verifyParentOtp error:', err);
    return res.status(500).json({ success: false, message: 'Verification failed. Please try again.' });
  }
};

/**
 * POST /api/auth/check-mobile   { mobile }
 * Public. Real-time uniqueness feedback for the enrollment wizard (parent mobile,
 * alternate guardian / emergency contact). Format errors are reported too.
 */
const checkMobileAvailability = async (req, res) => {
  try {
    const { mobile } = req.body || {};
    const formatErr = validatePhMobile(mobile, 'Mobile number');
    if (formatErr) {
      return res.status(200).json({ success: true, available: false, valid: false, message: formatErr });
    }
    const available = await checkMobileNumberUnique(mobile, null);
    return res.status(200).json({
      success: true,
      valid: true,
      available,
      message: available ? null : 'This number is already registered/used by another account.',
    });
  } catch (err) {
    console.error('checkMobileAvailability error:', err);
    return res.status(500).json({ success: false, message: 'Could not check the mobile number.' });
  }
};

module.exports = { registerParent, sendParentOtp, verifyParentOtp, checkMobileAvailability };
