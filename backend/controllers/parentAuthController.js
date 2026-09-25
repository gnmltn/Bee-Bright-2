/**
 * Parent/Guardian Authentication Controller
 * Handles registration, OTP send/verify for the enrollment wizard flow.
 *
 * Flow (nothing here writes to the Users collection — see models/PendingParentSignup.js):
 *  1. POST /api/auth/register-parent  → store a PENDING signup, send OTP
 *  2. POST /api/auth/parent-otp/send  → resend OTP
 *  3. POST /api/auth/parent-otp/verify → verify OTP, mark the pending signup verified, return short-lived token
 *  The real User is created when the completed enrollment + payment proof is submitted.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const PendingParentSignup = require('../models/PendingParentSignup');
const { getEmailError } = require('../utils/emailRules');
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
const OTP_SELECT = '+passwordHash +otpHash +otpExpires +otpAttempts +otpLastSentAt';

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
 * Stores the signup in PendingParentSignup (NOT in Users) and sends an OTP. The real
 * parent account is only created when the completed enrollment — payment proof included
 * — is submitted (enrollmentController.submitEnrollment / adminWalkInEnroll, via
 * utils/parentSignup.js). Abandoning the wizard at any step therefore leaves nothing in
 * the Users collection, and the pending record expires by itself.
 *
 * `draftId` is the pending id this wizard session already owns; when present the same
 * record is updated in place so the parent can go Back and fix a mistyped email/mobile.
 *
 * Uniqueness (email + mobile) is enforced against real accounts only, so an abandoned
 * signup never reserves an address or number.
 */
const registerParent = async (req, res) => {
  try {
    const { name, email, mobile, password, draftId } = req.body;

    // ── Validation ──
    const nameErr = validateFullName(name, 'Full name', { minParts: 2 });
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    const cleanName = toTitleCase(name);

    const normalizedEmail = normalizeEmail(email);
    const emailErr = getEmailError(normalizedEmail);
    if (emailErr) return res.status(400).json({ success: false, message: emailErr });

    const mobileErr = validatePhMobile(mobile, 'Mobile number');
    if (mobileErr) return res.status(400).json({ success: false, message: mobileErr });
    const phoneDigits = normalizeMobile(mobile);

    if (!PASSWORD_RE.test(password))
      return res.status(400).json({
        success: false,
        message:
          'Password must be at least 8 characters and include uppercase, lowercase, number, and special character (@$!%*?&).',
      });

    // ── An existing REAL account owns this email → cannot sign up again ──
    const existingUser = await User.findOne({ email: normalizedEmail }).select('role enrollmentDraft emailVerifiedAt isActive');
    if (existingUser && existingUser.enrollmentDraft) {
      // Left over from before signups moved to PendingParentSignup: an abandoned draft. Retire it.
      await User.deleteOne({ _id: existingUser._id, enrollmentDraft: true }).catch(() => {});
    } else if (existingUser) {
      if (existingUser.role !== 'parent')
        return res.status(409).json({
          success: false,
          message: 'An account with this email already exists. Please log in instead.',
        });
      return res.status(409).json({
        success: false,
        message: 'This email is already registered. Please log in.',
      });
    }

    // ── Resolve which pending record to write: this session's, else one already on the email ──
    let sessionPending = null;
    if (draftId && mongoose.Types.ObjectId.isValid(draftId)) {
      sessionPending = await PendingParentSignup.findById(draftId).select(OTP_SELECT);
    }
    const byEmail = await PendingParentSignup.findOne({ email: normalizedEmail }).select(OTP_SELECT);

    // Mobile number must be free among real accounts (pending signups don't reserve).
    const mobileIsFree = await checkMobileNumberUnique(phoneDigits, null);
    if (!mobileIsFree) {
      return res.status(409).json({
        success: false,
        message: 'Mobile number is already registered to another account.',
      });
    }

    let pending = byEmail || sessionPending;
    // The email moved onto a different pending record → retire this session's now-orphaned one.
    if (pending && sessionPending && String(pending._id) !== String(sessionPending._id)) {
      await PendingParentSignup.deleteOne({ _id: sessionPending._id }).catch(() => {});
    }

    const { firstName, middleName, lastName } = splitName(cleanName);
    const emailChanged = !!pending && pending.email !== normalizedEmail;
    const passwordHash = await bcrypt.hash(password, 10);

    if (pending) {
      // Cooldown only matters when we'd resend to the SAME address.
      if (!emailChanged && pending.otpLastSentAt) {
        const elapsed = Date.now() - new Date(pending.otpLastSentAt).getTime();
        if (elapsed < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
          const wait = Math.ceil((OTP_RESEND_COOLDOWN_SECONDS * 1000 - elapsed) / 1000);
          return res.status(429).json({
            success: false,
            message: `Please wait ${wait} seconds before requesting a new code.`,
          });
        }
      }
      pending.firstName = firstName;
      pending.middleName = middleName;
      pending.lastName = lastName;
      pending.email = normalizedEmail;
      pending.phone = phoneDigits;
      pending.passwordHash = passwordHash;
      if (emailChanged) pending.emailVerifiedAt = null; // new address → must verify again
      pending.expiresAt = draftExpiry();
    } else {
      pending = new PendingParentSignup({
        firstName,
        middleName,
        lastName,
        email: normalizedEmail,
        phone: phoneDigits,
        passwordHash,
        emailVerifiedAt: null,
        expiresAt: draftExpiry(),
      });
    }

    // ── Generate & store OTP ──
    const otp = generateOtp();
    pending.otpHash = hashValue(otp);
    pending.otpExpires = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    pending.otpAttempts = 0;
    pending.otpLastSentAt = new Date();

    await pending.save();

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
      description: `Parent signup started (pending, no account yet) for ${normalizedEmail}`,
      status: 'SUCCESS',
      metadata: { email: normalizedEmail },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: 'Verification code sent to your email.',
      verificationSentTo: maskEmail(normalizedEmail),
      parentId: String(pending._id),
    });
  } catch (err) {
    console.error('registerParent error:', err);
    return res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
};

/**
 * POST /api/auth/parent-otp/send
 * Body: { email }   – resend OTP for a pending (not yet enrolled) signup
 */
const sendParentOtp = async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email || '');
    if (!normalizedEmail)
      return res.status(400).json({ success: false, message: 'Email is required.' });

    const pending = await PendingParentSignup.findOne({ email: normalizedEmail }).select(OTP_SELECT);

    if (!pending)
      return res.status(404).json({
        success: false,
        message: 'No pending parent account found for this email. Please register first.',
      });

    if (pending.emailVerifiedAt)
      return res.status(400).json({
        success: false,
        message: 'Email already verified. Please proceed to the enrollment wizard.',
      });

    const lastSent = pending.otpLastSentAt;
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
    pending.otpHash = hashValue(otp);
    pending.otpExpires = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    pending.otpAttempts = 0;
    pending.otpLastSentAt = new Date();
    pending.expiresAt = draftExpiry();
    await pending.save();

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
 * Marks the pending signup's email verified and returns a short-lived enrollment-scoped
 * JWT whose `id` is the pending record's id. That id becomes the User `_id` when the
 * enrollment is submitted, so the same token then works as a normal session token.
 */
const verifyParentOtp = async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email || '');
    const code = String(req.body?.code || '').trim();

    if (!normalizedEmail || !code)
      return res.status(400).json({ success: false, message: 'Email and verification code are required.' });

    const pending = await PendingParentSignup.findOne({ email: normalizedEmail }).select(OTP_SELECT);

    if (!pending)
      return res.status(404).json({
        success: false,
        message: 'No pending account found. Please register first.',
      });

    if (pending.emailVerifiedAt) {
      // Already verified – just return a new token
      const token = issueEnrollmentToken(pending._id);
      return res.status(200).json({
        success: true,
        message: 'Email already verified.',
        token,
        emailVerifiedAt: pending.emailVerifiedAt,
        parentId: String(pending._id),
      });
    }

    if (!pending.otpHash || !pending.otpExpires)
      return res.status(400).json({ success: false, message: 'No verification code found. Please request a new one.' });

    if (new Date() > new Date(pending.otpExpires))
      return res.status(400).json({ success: false, message: 'Verification code has expired. Please request a new one.' });

    // Increment attempts before checking to prevent timing attacks
    pending.otpAttempts = (pending.otpAttempts || 0) + 1;

    if (pending.otpAttempts > OTP_MAX_ATTEMPTS) {
      await pending.save();
      return res.status(429).json({
        success: false,
        message: 'Too many incorrect attempts. Please request a new verification code.',
        code: 'MAX_ATTEMPTS',
      });
    }

    if (hashValue(code) !== pending.otpHash) {
      const remaining = OTP_MAX_ATTEMPTS - pending.otpAttempts;
      await pending.save();
      return res.status(400).json({
        success: false,
        message: `Incorrect verification code. ${remaining} attempt(s) remaining.`,
        attemptsRemaining: remaining,
      });
    }

    // ── Success ──
    pending.emailVerifiedAt = new Date();
    pending.otpHash = undefined;
    pending.otpExpires = undefined;
    pending.otpAttempts = 0;
    // Verifying the email buys the signup a fresh survival window.
    pending.expiresAt = draftExpiry();
    await pending.save();

    const token = issueEnrollmentToken(pending._id);

    logAudit({
      req,
      action: 'Parent OTP Verified',
      module: 'Authentication',
      description: `Parent email verified (pending signup): ${normalizedEmail}`,
      status: 'SUCCESS',
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: 'Email verified successfully. You may now continue with enrollment.',
      token,
      emailVerifiedAt: pending.emailVerifiedAt,
      parentId: String(pending._id),
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
