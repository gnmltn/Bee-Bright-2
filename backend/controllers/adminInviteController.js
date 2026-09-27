/**
 * Email-verified admin/tutor account creation ("polish prompt.pdf", Group B item 1).
 *
 * Flow: request-code (sends a 6-digit OTP to the new account's email) -> verify-code
 * (checks the OTP, issues a single-use verificationToken) -> create (only accepted with a
 * valid, unexpired, unconsumed verificationId + verificationToken pair) -> the verification
 * record is deleted on successful creation so the token can never be reused.
 *
 * The AdminEmailVerification model and this frontend contract (services/adminEmailVerification.ts)
 * already existed — only these routes/controller were missing, which is why "Create" was never
 * actually gated on verification.
 */
const crypto = require('crypto');
const User = require('../models/User');
const AdminEmailVerification = require('../models/AdminEmailVerification');
const { validateFullName, validatePhMobile } = require('../utils/validation');
const { getEmailError } = require('../utils/emailRules');
const { normalizeEmailAddress, buildEmailLookupFilter } = require('../utils/email');
const { sendEmail, logEmailError, getEmailErrorMessage, buildOtpEmailHtml } = require('../utils/emailService');
const { logAudit } = require('../utils/auditService');

const OTP_TTL_MINUTES = 10;
const TOKEN_TTL_MINUTES = 20; // window to fill in the rest of the form after verifying
const MAX_VERIFY_ATTEMPTS = 5;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}
function maskEmail(email) {
  const [localPart = '', domain = ''] = String(email).split('@');
  if (!localPart || !domain) return email;
  if (localPart.length <= 2) return `${localPart[0] || '*'}*@${domain}`;
  return `${localPart.slice(0, 2)}${'*'.repeat(Math.max(2, localPart.length - 2))}@${domain}`;
}

async function sendInviteOtpEmail({ email, code, roleLabel }) {
  await sendEmail({
    to: email,
    subject: `Bee Bright ${roleLabel} account verification code`,
    text: [
      `An admin is creating a Bee Bright ${roleLabel} account using this email address.`,
      `Verification code: ${code}`,
      `This code expires in ${OTP_TTL_MINUTES} minutes.`,
      'If you did not expect this, you can ignore this email.',
    ].join('\n'),
    html: buildOtpEmailHtml({
      title: `${roleLabel[0].toUpperCase()}${roleLabel.slice(1)} Account Verification`,
      introHtml: `<p>An admin is creating a ${roleLabel} account using this email address. Use this one-time code to confirm it:</p>`,
      otp: code,
      expiresMinutes: OTP_TTL_MINUTES,
    }),
  }, `${roleLabel} account invite OTP`);
}

async function requestCode(purpose, roleLabel, req, res) {
  try {
    const email = normalizeEmailAddress(req.body?.email);
    const emailProblem = getEmailError(email);
    if (emailProblem) return res.status(400).json({ success: false, message: emailProblem });

    const existingUser = await User.findOne(buildEmailLookupFilter(email));
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'A user with this email already exists.' });
    }

    const now = new Date();
    const code = generateOtpCode();
    let record = await AdminEmailVerification.findOne({ email, requestedBy: req.user.id, purpose });
    if (!record) record = new AdminEmailVerification({ email, requestedBy: req.user.id, purpose });
    record.codeHash = hashValue(code);
    record.verificationTokenHash = null;
    record.attempts = 0;
    record.verifiedAt = null;
    record.lastSentAt = now;
    record.resendCount = (record.resendCount || 0) + 1;
    record.expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000);

    // Development fallback: still allow the flow to be tested locally even if SMTP fails
    // or the target address can't actually receive mail (e.g. a throwaway test domain) —
    // mirrors the same fallback already used by the login-OTP flow (authController.js).
    let devOtp = null;
    try {
      await sendInviteOtpEmail({ email, code, roleLabel });
    } catch (error) {
      logEmailError(`${roleLabel} invite OTP send failed`, error, { to: email });
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ success: false, message: getEmailErrorMessage(error) });
      }
      devOtp = code;
    }

    await record.save();
    res.status(200).json({
      success: true,
      message: `Verification code sent to ${maskEmail(email)}.`,
      verificationId: record._id,
      expiresAt: record.expiresAt,
      ...(devOtp ? { devOtp } : {}),
      maskedEmail: maskEmail(email),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to send verification code.' });
  }
}

async function verifyCode(purpose, req, res) {
  try {
    const email = normalizeEmailAddress(req.body?.email);
    const verificationId = String(req.body?.verificationId || '').trim();
    const code = String(req.body?.code || '').trim();
    if (!email || !verificationId || !code) {
      return res.status(400).json({ success: false, message: 'Email, verification session, and code are required.' });
    }

    const record = await AdminEmailVerification.findOne({ _id: verificationId, email, purpose, requestedBy: req.user.id });
    if (!record) {
      return res.status(404).json({ success: false, message: 'Verification session not found. Please send a new code.' });
    }
    if (new Date(record.expiresAt).getTime() <= Date.now()) {
      return res.status(400).json({ success: false, message: 'That verification code has expired. Please send a new one.' });
    }
    if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
      return res.status(400).json({ success: false, message: 'Too many incorrect attempts. Please send a new verification code.' });
    }
    if (record.codeHash !== hashValue(code)) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ success: false, message: 'Incorrect verification code. Please try again.' });
    }

    const token = generateVerificationToken();
    record.verificationTokenHash = hashValue(token);
    record.verifiedAt = new Date();
    record.attempts = 0;
    record.expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);
    await record.save();

    res.status(200).json({
      success: true,
      message: 'Email verified.',
      verificationId: record._id,
      verificationToken: token,
      expiresAt: record.expiresAt,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to verify the email code.' });
  }
}

/** Confirms a verified, unexpired, unconsumed token and deletes it (single-use). */
async function consumeVerification(purpose, { email, verificationId, verificationToken }, req) {
  if (!email || !verificationId || !verificationToken) {
    return { ok: false, message: 'Email verification is required before creating this account.' };
  }
  const record = await AdminEmailVerification.findOne({ _id: verificationId, email, purpose, requestedBy: req.user.id });
  if (!record || !record.verifiedAt) {
    return { ok: false, message: 'Email verification is required before creating this account.' };
  }
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    return { ok: false, message: 'Your email verification has expired. Please verify the email again.' };
  }
  if (!record.verificationTokenHash || record.verificationTokenHash !== hashValue(verificationToken)) {
    return { ok: false, message: 'Invalid verification token. Please verify the email again.' };
  }
  await AdminEmailVerification.deleteOne({ _id: record._id });
  return { ok: true };
}

function validateNameAndPasswordFields({ firstName, middleName, lastName, password }) {
  let err = validateFullName(firstName, 'First name', { minParts: 1, required: true });
  if (err) return err;
  err = validateFullName(middleName, 'Middle name', { minParts: 1, required: false });
  if (err) return err;
  err = validateFullName(lastName, 'Last name', { minParts: 1, required: true });
  if (err) return err;
  if (!password || !PASSWORD_REGEX.test(password)) {
    return 'Password must contain at least 8 characters, one uppercase, one lowercase, one number and one special character (@$!%*?&)';
  }
  return null;
}

// @desc  Request an email verification code before creating an admin
// @route POST /api/admin-invites/request-code
// @access Private (super_admin)
const requestAdminCode = (req, res) => requestCode('create_admin', 'admin', req, res);

// @desc  Verify the code sent for admin account creation
// @route POST /api/admin-invites/verify-code
// @access Private (super_admin)
const verifyAdminCode = (req, res) => verifyCode('create_admin', req, res);

// @desc  Create an admin account — only accepted with a verified email
// @route POST /api/admin-invites/create-admin
// @access Private (super_admin)
const createVerifiedAdmin = async (req, res) => {
  try {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only super admins can create admin accounts' });
    }
    const { firstName, middleName, lastName, email, password, phone, verificationId, verificationToken } = req.body;

    if (!firstName || !lastName || !email || !password || !phone || !String(phone).trim()) {
      return res.status(400).json({ success: false, message: 'First name, last name, email, password, and phone are required' });
    }
    const fieldErr = validateNameAndPasswordFields({ firstName, middleName, lastName, password });
    if (fieldErr) return res.status(400).json({ success: false, message: fieldErr });
    const phoneErr = validatePhMobile(phone, 'Phone number');
    if (phoneErr) return res.status(400).json({ success: false, message: phoneErr });
    const emailProblem = getEmailError(email);
    if (emailProblem) return res.status(400).json({ success: false, message: emailProblem });

    const normalizedEmail = normalizeEmailAddress(email);
    const verification = await consumeVerification('create_admin', { email: normalizedEmail, verificationId, verificationToken }, req);
    if (!verification.ok) return res.status(400).json({ success: false, message: verification.message });

    const existing = await User.findOne(buildEmailLookupFilter(normalizedEmail));
    if (existing) return res.status(400).json({ success: false, message: 'A user with this email already exists' });

    const user = await User.create({
      firstName: firstName.trim(),
      middleName: (middleName || '').trim(),
      lastName: lastName.trim(),
      email: normalizedEmail,
      password,
      phone: String(phone).trim(),
      role: 'admin',
      isActive: true,
    });

    const created = await User.findById(user._id).select('-password').lean();

    logAudit({
      req,
      userId: req.user.id,
      action: 'Add Admin',
      module: 'User Management',
      description: 'Super admin added new admin (email verified)',
      status: 'SUCCESS',
      metadata: { adminId: user._id },
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Admin created successfully', user: created });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ success: false, message: messages.join(', ') });
    }
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Email already exists' });
    res.status(500).json({ success: false, message: error.message || 'Failed to create admin' });
  }
};

// @desc  Request an email verification code before creating a tutor
// @route POST /api/admin-invites/tutor/request-code
// @access Private (admin, super_admin)
const requestTutorCode = (req, res) => requestCode('create_tutor', 'tutor', req, res);

// @desc  Verify the code sent for tutor account creation
// @route POST /api/admin-invites/tutor/verify-code
// @access Private (admin, super_admin)
const verifyTutorCode = (req, res) => verifyCode('create_tutor', req, res);

// @desc  Create a tutor account — only accepted with a verified email
// @route POST /api/admin-invites/tutor/create
// @access Private (admin, super_admin)
const createVerifiedTutor = async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only admins or super admins can create tutor accounts' });
    }
    const {
      firstName, middleName, lastName, email, password, phone,
      employmentType, availability, verificationId, verificationToken,
    } = req.body;

    if (!firstName || !lastName || !email || !password || !phone || !String(phone).trim()) {
      return res.status(400).json({ success: false, message: 'First name, last name, email, password, and phone are required' });
    }
    const fieldErr = validateNameAndPasswordFields({ firstName, middleName, lastName, password });
    if (fieldErr) return res.status(400).json({ success: false, message: fieldErr });
    const phoneErr = validatePhMobile(phone, 'Phone number');
    if (phoneErr) return res.status(400).json({ success: false, message: phoneErr });
    const emailProblem = getEmailError(email);
    if (emailProblem) return res.status(400).json({ success: false, message: emailProblem });

    const employment = employmentType === 'part-time' ? 'part-time' : 'full-time';
    if (employment === 'part-time' && !String(availability || '').trim()) {
      return res.status(400).json({ success: false, message: 'Select at least one day and a start/end time for this part-time tutor\'s availability.' });
    }

    const normalizedEmail = normalizeEmailAddress(email);
    const verification = await consumeVerification('create_tutor', { email: normalizedEmail, verificationId, verificationToken }, req);
    if (!verification.ok) return res.status(400).json({ success: false, message: verification.message });

    const existing = await User.findOne(buildEmailLookupFilter(normalizedEmail));
    if (existing) return res.status(400).json({ success: false, message: 'A user with this email already exists' });

    const user = await User.create({
      firstName: firstName.trim(),
      middleName: (middleName || '').trim(),
      lastName: lastName.trim(),
      email: normalizedEmail,
      password,
      phone: String(phone).trim(),
      role: 'tutor',
      employmentType: employment,
      availability: (availability || '').trim(),
    });

    const created = await User.findById(user._id).select('-password').populate('subjectsTaught', 'name code').lean();

    logAudit({
      req,
      userId: req.user.id,
      action: 'Add Tutor',
      module: 'User Management',
      description: 'Admin added new tutor (email verified)',
      status: 'SUCCESS',
      metadata: { tutorId: user._id },
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Tutor created successfully', user: created });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ success: false, message: messages.join(', ') });
    }
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Email already exists' });
    res.status(500).json({ success: false, message: error.message || 'Failed to create tutor' });
  }
};

module.exports = {
  requestAdminCode,
  verifyAdminCode,
  createVerifiedAdmin,
  requestTutorCode,
  verifyTutorCode,
  createVerifiedTutor,
};
