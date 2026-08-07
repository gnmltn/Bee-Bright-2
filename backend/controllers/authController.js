const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const User = require('../models/User');
const AdminEmailVerification = require('../models/AdminEmailVerification');
const jwt = require('jsonwebtoken');
const { validateName, validatePhoneNoLetters } = require('../utils/validation');
const { logAudit } = require('../utils/auditService');
const { normalizeEmailAddress, buildEmailLookupFilter, getEmailLookupCandidates } = require('../utils/email');
const { PASSWORD_EXPIRY_DAYS, getPasswordSecurityState, isPasswordExpired } = require('../utils/passwordPolicy');
const { getMaintenanceEnabled } = require('./settingsController');
const { createCaptchaChallenge, verifyCaptchaAnswer } = require('../utils/captchaService');
const { sendEmail, getEmailErrorMessage, logEmailError } = require('../utils/emailService');
const { setAuthCookie, clearAuthCookie, getAuthTokenFromCookies } = require('../utils/authCookie');
const {
  validateTrustedDevice,
  registerTrustedDevice,
  setTrustedDeviceCookie,
  clearTrustedDeviceCookie,
  revokeTrustedDeviceFromRequest,
  invalidateAllTrustedDevicesForUser,
} = require('../utils/trustedDevice');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads', 'avatars');
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp'
};

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
const LOGIN_OTP_TTL_MINUTES = 10;
const LOGIN_OTP_MAX_VERIFY_ATTEMPTS = 5;
const USER_LOGIN_OTP_PURPOSE = 'user_login';
const ADMIN_LOGIN_OTP_PURPOSE = 'admin_login';

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (buffer.slice(0, 6).toString('ascii') === 'GIF87a' || buffer.slice(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif';
  }

  if (
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

function getProfileImageUrl(req, profileImage) {
  if (!profileImage) return null;
  const base = `${req.protocol}://${req.get('host')}`;
  return `${base}/uploads/${profileImage}`;
}

function normalizeEmail(value = '') {
  return normalizeEmailAddress(value);
}

function maskEmail(email) {
  const [localPart = '', domain = ''] = String(email).split('@');
  if (!localPart || !domain) return email;
  if (localPart.length <= 2) {
    return `${localPart[0] || '*'}*@${domain}`;
  }
  return `${localPart.slice(0, 2)}${'*'.repeat(Math.max(2, localPart.length - 2))}@${domain}`;
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getLoginOtpPurpose(role) {
  return role === 'admin' || role === 'super_admin'
    ? ADMIN_LOGIN_OTP_PURPOSE
    : USER_LOGIN_OTP_PURPOSE;
}

function getNextOtpResendCooldownMs(resendCount = 0) {
  if (resendCount <= 0) return 0;
  if (resendCount === 1) return 3 * 60 * 1000;
  return 5 * 60 * 1000;
}

function getRemainingOtpCooldownMs(record, now = new Date()) {
  if (!record?.lastSentAt) return 0;
  const cooldownMs = getNextOtpResendCooldownMs(record.resendCount || 0);
  if (cooldownMs <= 0) return 0;
  const elapsedMs = now.getTime() - new Date(record.lastSentAt).getTime();
  return Math.max(0, cooldownMs - elapsedMs);
}

function getNextOtpResendAvailableInSeconds(record) {
  return Math.ceil(getNextOtpResendCooldownMs(record?.resendCount || 0) / 1000);
}

function formatDurationFromSeconds(totalSeconds) {
  if (totalSeconds <= 60) {
    return `${Math.max(1, totalSeconds)} second(s)`;
  }

  const minutes = Math.ceil(totalSeconds / 60);
  return `${minutes} minute(s)`;
}

// Generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d'
  });
};

function attachLoginSession(res, token) {
  setAuthCookie(res, token);
}

async function createPostCredentialCaptcha(req, user, flow) {
  const challenge = createCaptchaChallenge({
    userId: String(user._id),
    flow
  });
  return challenge;
}

function buildLoginUserResponse(req, loginUser) {
  const passwordSecurity = getPasswordSecurityState(loginUser);
  return {
    id: loginUser._id,
    firstName: loginUser.firstName,
    middleName: loginUser.middleName || '',
    lastName: loginUser.lastName,
    email: loginUser.email,
    role: loginUser.role,
    isActive: loginUser.isActive,
    gradeLevel: loginUser.gradeLevel || null,
    subjectsTaught: loginUser.subjectsTaught || [],
    employmentType: loginUser.employmentType || 'full-time',
    availability: loginUser.availability || '',
    enrollmentStatus: loginUser.enrollmentStatus || null,
    paymentStatus: loginUser.paymentStatus || null,
    profileImageUrl: getProfileImageUrl(req, loginUser.profileImage),
    passwordChangedAt: passwordSecurity.passwordChangedAt.toISOString(),
    passwordExpiresAt: passwordSecurity.passwordExpiresAt.toISOString(),
    passwordExpired: passwordSecurity.passwordExpired,
    passwordExpiresInDays: passwordSecurity.passwordExpiresInDays,
  };
}

async function issueLoginSuccessResponse(req, res, userId, options = {}) {
  const {
    message = 'Login successful',
    mfa = 'email_otp',
    trustedDeviceBypass = false,
    auditDescription,
    metadata = {},
    extraPayload = {},
  } = options;

  const now = new Date();
  await User.findByIdAndUpdate(userId, {
    lastLogin: now,
    lastActivityAt: now,
  });

  const loginUser = await User.findById(userId)
    .select('-password')
    .populate('subjectsTaught', 'name code')
    .lean();

  if (!loginUser) {
    return res.status(401).json({
      success: false,
      message: 'Invalid login session. Please log in again.'
    });
  }

  const token = generateToken(loginUser._id);
  attachLoginSession(res, token);

  const isPrivileged = loginUser.role === 'admin' || loginUser.role === 'super_admin';
  logAudit({
    req,
    userId: loginUser._id,
    action: isPrivileged ? 'Admin Login' : 'Login',
    module: 'Authentication',
    description: auditDescription || `${loginUser.role} logged in with ${mfa === 'trusted_device' ? 'trusted device' : 'email OTP MFA'}`,
    status: 'SUCCESS',
    metadata: { role: loginUser.role, mfa, ...metadata }
  }).catch(() => {});

  return res.status(200).json({
    success: true,
    requiresOtp: false,
    trustedDeviceBypass,
    message,
    token,
    user: buildLoginUserResponse(req, loginUser),
    ...extraPayload,
  });
}

function sendCaptchaFailure(res, captchaVerification) {
  if (captchaVerification.reason === 'max_attempts') {
    return res.status(400).json({
      success: false,
      code: 'CAPTCHA_EXPIRED',
      requireNewCaptcha: true,
      attemptsRemaining: 0,
      message: 'Maximum attempts reached. Please request a new captcha.'
    });
  }

  if (captchaVerification.reason === 'expired') {
    return res.status(400).json({
      success: false,
      code: 'CAPTCHA_EXPIRED',
      requireNewCaptcha: true,
      attemptsRemaining: 0,
      message: 'Captcha expired. Please request a new captcha.'
    });
  }

  return res.status(400).json({
    success: false,
    code: 'CAPTCHA_FAILED',
    requireNewCaptcha: false,
    attemptsRemaining: captchaVerification.attemptsRemaining ?? 0,
    message: `Captcha verification failed. ${captchaVerification.attemptsRemaining ?? 0} attempt(s) remaining.`
  });
}

async function sendLoginOtpEmail({ email, code, firstName, role }) {
  const roleLabel =
    role === 'admin' || role === 'super_admin'
      ? 'admin'
      : role === 'tutor'
        ? 'tutor'
        : 'student';

  return sendEmail(
    {
      to: email,
      subject: 'Bee Bright login verification code',
      text: [
        `Hello ${firstName || 'Bee Bright user'},`,
        '',
        `Your Bee Bright ${roleLabel} login verification code is ${code}.`,
        '',
        `This code expires in ${LOGIN_OTP_TTL_MINUTES} minutes.`,
        'If you did not attempt to sign in, you can ignore this email.',
      ].join('\n'),
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 560px; margin: 0 auto;">
          <h2 style="margin-bottom: 12px;">Bee Bright login verification</h2>
          <p>Hello ${firstName || 'Bee Bright user'},</p>
          <p>Use this one-time verification code to finish signing in:</p>
          <div style="font-size: 28px; font-weight: 700; letter-spacing: 6px; padding: 16px 20px; background: #f3f4f6; border-radius: 12px; display: inline-block;">
            ${code}
          </div>
          <p style="margin-top: 16px;">This code expires in ${LOGIN_OTP_TTL_MINUTES} minutes.</p>
          <p style="color: #6b7280;">If you did not attempt to sign in, you can ignore this email.</p>
        </div>
      `,
    },
    `${roleLabel} login OTP`
  );
}

function buildLoginOtpStartResponse(user, message, verificationRecord, devOtp = null) {
  return {
    success: true,
    requiresOtp: true,
    message,
    verificationId: verificationRecord._id,
    maskedEmail: maskEmail(user.email),
    expiresAt: verificationRecord.expiresAt,
    nextResendAvailableInSeconds: getNextOtpResendAvailableInSeconds(verificationRecord),
    ...(devOtp ? { devOtp } : {}),
  };
}

async function createOrRefreshLoginOtp(req, user) {
  const purpose = getLoginOtpPurpose(user.role);
  const now = new Date();
  const existingVerification = await AdminEmailVerification.findOne({
    email: user.email,
    requestedBy: user._id,
    purpose
  });

  if (
    existingVerification &&
    !existingVerification.verifiedAt &&
    existingVerification.expiresAt &&
    new Date(existingVerification.expiresAt).getTime() > now.getTime()
  ) {
    const remainingCooldownMs = getRemainingOtpCooldownMs(existingVerification, now);
    if (remainingCooldownMs > 0) {
      const retryAfterSeconds = Math.ceil(remainingCooldownMs / 1000);
      return {
        blocked: true,
        statusCode: 429,
        payload: {
          success: false,
          code: 'OTP_RESEND_COOLDOWN',
          retryAfterSeconds,
          verificationId: existingVerification._id,
          maskedEmail: maskEmail(user.email),
          expiresAt: existingVerification.expiresAt,
          nextResendAvailableInSeconds: retryAfterSeconds,
          message: `Please wait ${formatDurationFromSeconds(retryAfterSeconds)} before sending another code.`
        }
      };
    }
  }

  const code = generateOtpCode();
  const verificationRecord =
    existingVerification ||
    new AdminEmailVerification({
      email: user.email,
      requestedBy: user._id,
      purpose
    });

  const isResend =
    existingVerification &&
    !existingVerification.verifiedAt &&
    existingVerification.expiresAt &&
    new Date(existingVerification.expiresAt).getTime() > now.getTime();

  verificationRecord.codeHash = hashValue(code);
  verificationRecord.verificationTokenHash = null;
  verificationRecord.attempts = 0;
  verificationRecord.verifiedAt = null;
  verificationRecord.lastSentAt = now;
  verificationRecord.expiresAt = new Date(now.getTime() + LOGIN_OTP_TTL_MINUTES * 60 * 1000);
  verificationRecord.resendCount = isResend ? (verificationRecord.resendCount || 0) + 1 : 0;

  let devOtp = null;
  try {
    await sendLoginOtpEmail({
      email: user.email,
      code,
      firstName: user.firstName,
      role: user.role
    });
  } catch (error) {
    logEmailError('login OTP send failed', error, {
      to: user.email,
      role: user.role
    });

    // Development fallback: still allow OTP flow locally even if SMTP fails.
    if (process.env.NODE_ENV !== 'production') {
      devOtp = code;
    } else {
      return {
        blocked: true,
        statusCode: 503,
        payload: {
          success: false,
          message: getEmailErrorMessage(error)
        }
      };
    }
  }

  await verificationRecord.save();

  return {
    blocked: false,
    statusCode: 200,
    payload: buildLoginOtpStartResponse(
      user,
      devOtp
        ? `Email OTP delivery is unavailable in local mode. Use the development OTP shown in the UI.`
        : `Verification code sent to ${maskEmail(user.email)}.`,
      verificationRecord,
      devOtp
    )
  };
}

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
const register = async (req, res) => {
  try {
    // Handle both naming conventions
    let { 
      firstName, 
      middleName,
      lastName, 
      firstname, 
      lastname,
      email, 
      phone, 
      password, 
      role = 'student', 
      gradeLevel, 
      guardianName,
      guardianPhone 
    } = req.body;

    const normalizedRole = String(role || 'student').toLowerCase().trim();
    if (normalizedRole !== 'student') {
      return res.status(403).json({
        success: false,
        message: 'Public registration is only available for student accounts'
      });
    }

    // Use whichever is provided
    firstName = firstName || firstname || '';
    lastName = lastName || lastname || '';

    // Validate required fields
    if (!firstName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'First name is required'
      });
    }

    if (!lastName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Last name is required'
      });
    }

    let nameErr = validateName(firstName, 'First name');
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    nameErr = validateName(middleName, 'Middle name');
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    nameErr = validateName(lastName, 'Last name');
    if (nameErr) return res.status(400).json({ success: false, message: nameErr });
    const phoneErr = validatePhoneNoLetters(phone);
    if (phoneErr) return res.status(400).json({ success: false, message: phoneErr });

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required'
      });
    }

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required'
      });
    }

    // Validate email format (any valid email)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test((email || '').trim().toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address'
      });
    }

    // Validate Philippine mobile number
    const phPhoneRegex = /^(0?9|639)\d{9}$/;
    const phoneDigits = (phone || '').replace(/\D/g, '');
    if (!phPhoneRegex.test(phoneDigits)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid Philippine mobile number (e.g. 09XX XXX XXXX or +63 9XX XXX XXXX)'
      });
    }

    // Validate password format
    if (!PASSWORD_REGEX.test(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number and one special character (@$!%*?&)'
      });
    }

    // Check if user exists
    const userExists = await User.findOne(buildEmailLookupFilter(email));
    if (userExists) {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    // For non-student roles, set gradeLevel and guardian fields to undefined
    let userData = {
      firstName: firstName.trim(),
      middleName: (middleName || '').trim(),
      lastName: lastName.trim(),
      email: normalizeEmail(email),
      phone: phone.trim(),
      password,
      role: 'student'
    };

    // Only add student-specific fields if role is student
    if (normalizedRole === 'student') {
      if (!gradeLevel) {
        return res.status(400).json({
          success: false,
          message: 'Grade level is required for students'
        });
      }
      
      if (!guardianName) {
        return res.status(400).json({
          success: false,
          message: 'Guardian name is required for students'
        });
      }
      nameErr = validateName(guardianName, 'Guardian name');
      if (nameErr) return res.status(400).json({ success: false, message: nameErr });
      if ((guardianPhone || '').trim()) {
        const gPhoneErr = validatePhoneNoLetters(guardianPhone);
        if (gPhoneErr) return res.status(400).json({ success: false, message: gPhoneErr });
      }

      userData.gradeLevel = gradeLevel;
      userData.guardianName = guardianName;
      userData.guardianPhone = guardianPhone || '';
    }

    // Create user
    const user = await User.create(userData);

    logAudit({
      req,
      userId: user._id,
      action: 'User Registration',
      module: 'User Management',
      description: `${user.role} registered`,
      status: 'SUCCESS',
      metadata: { role: user.role }
    }).catch(() => {});

    // Generate token
    const token = generateToken(user._id);
    attachLoginSession(res, token);

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        gradeLevel: user.gradeLevel || null
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }
    
    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Email already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      message: error.message || 'Registration failed. Please try again.'
    });
  }
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
const login = async (req, res) => {
  return loginStart(req, res);
};

// @desc    Admin login (separate endpoint for rate limiting: 3 attempts / 30 min)
// @route   POST /api/auth/admin-login
// @access  Public
const adminLogin = async (req, res) => {
  return adminLoginStart(req, res);
};

// @desc    Start user login (check credentials first, then send email OTP)
// @route   POST /api/auth/login-start
// @access  Public
const loginStart = async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (role === 'admin') {
      return res.status(400).json({
        success: false,
        message: 'Admin login must use the admin login page at /admin-login'
      });
    }

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password'
      });
    }

    const user = await User.findOne(buildEmailLookupFilter(email)).select('+password');

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    if (!user.password) {
      return res.status(500).json({ success: false, message: 'Authentication error. Please contact support.' });
    }

    if (user.isArchived) {
      return res.status(401).json({ success: false, message: 'Account is archived/suspended. Please contact admin.' });
    }

    if (!user.isActive) {
      // Parent accounts start inactive — they must be allowed to log in to
      // track their enrollment status and manage their application.
      // Only block if the account is truly deactivated (not simply pending approval).
      if (user.role === 'parent') {
        // Allow — parent will see their enrollment tracking dashboard
      } else if (user.role === 'student') {
        return res.status(403).json({
          success: false,
          code: 'ENROLLMENT_PENDING_APPROVAL',
          message: 'Enrollment is pending admin approval. You can log in once your account is approved.'
        });
      } else {
        return res.status(401).json({ success: false, message: 'Account is deactivated. Please contact support.' });
      }
    }

    if (role && user.role !== role.toLowerCase()) {
      // Special case: parent accounts authenticate through the "Parent/Guardian" role.
      // If the client sent 'student' but the account is 'parent', give a clear helpful message.
      if (user.role === 'parent' && role === 'student') {
        return res.status(401).json({
          success: false,
          message: 'You have a Parent/Guardian account. Please select "Parent / Guardian" on the login page.'
        });
      }
      return res.status(401).json({
        success: false,
        message: `Invalid credentials. You are registered as a ${user.role}.`
      });
    }

    if (user.role === 'student' || user.role === 'tutor' || user.role === 'parent') {
      const maintenanceOn = await getMaintenanceEnabled();
      if (maintenanceOn) {
        return res.status(503).json({
          success: false,
          code: 'SYSTEM_MAINTENANCE',
          message: 'Bee Bright is currently undergoing scheduled maintenance. Please try again later. We apologize for any inconvenience.'
        });
      }
    }

    const isPasswordMatch = await user.comparePassword(password);
    if (!isPasswordMatch) {
      logAudit({
        req,
        userIdentifier: user.email,
        action: 'Login',
        module: 'Authentication',
        description: 'Failed - Wrong password',
        status: 'FAILED'
      }).catch(() => {});
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    if (isPasswordExpired(user)) {
      return res.status(403).json({
        success: false,
        code: 'PASSWORD_EXPIRED',
        message: `Your password has expired after ${PASSWORD_EXPIRY_DAYS} days. Reset your password to continue.`,
      });
    }

    const trustedDeviceState = await validateTrustedDevice(req, user);
    if (trustedDeviceState.trusted) {
      return issueLoginSuccessResponse(req, res, user._id, {
        message: 'Login successful. OTP skipped for trusted device.',
        mfa: 'trusted_device',
        trustedDeviceBypass: true,
        metadata: {
          trustedDeviceId: String(trustedDeviceState.record?._id || ''),
        },
      });
    }

    const otpResult = await createOrRefreshLoginOtp(req, user);
    return res.status(otpResult.statusCode).json(otpResult.payload);
  } catch (error) {
    console.error('Login start error:', error);
    return res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
};

// @desc    Start admin login (check credentials first, then send email OTP)
// @route   POST /api/auth/admin-login-start
// @access  Public
const adminLoginStart = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password'
      });
    }

    const normalizedEmail = normalizeEmail(email);
    const user = await User.findOne(buildEmailLookupFilter(normalizedEmail)).select('+password');

    if (!user) {
      logAudit({
        req,
        userIdentifier: normalizedEmail,
        action: 'Admin Login',
        module: 'Authentication',
        description: 'Failed - User not found',
        status: 'FAILED'
      }).catch(() => {});
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    if (user.role !== 'admin' && user.role !== 'super_admin') {
      logAudit({
        req,
        userIdentifier: user.email,
        action: 'Admin Login',
        module: 'Authentication',
        description: 'Failed - Not admin role',
        status: 'FAILED'
      }).catch(() => {});
      return res.status(401).json({ success: false, message: 'Invalid credentials. Admin access only.' });
    }

    if (!user.password) {
      return res.status(500).json({ success: false, message: 'Authentication error. Please contact support.' });
    }

    if (user.isArchived) {
      logAudit({
        req,
        userIdentifier: user.email,
        action: 'Admin Login',
        module: 'Authentication',
        description: 'Failed - Account archived',
        status: 'FAILED'
      }).catch(() => {});
      return res.status(401).json({ success: false, message: 'Account is archived/suspended. Please contact support.' });
    }

    if (!user.isActive) {
      logAudit({
        req,
        userIdentifier: user.email,
        action: 'Admin Login',
        module: 'Authentication',
        description: 'Failed - Account deactivated',
        status: 'FAILED'
      }).catch(() => {});
      return res.status(401).json({ success: false, message: 'Account is deactivated. Please contact support.' });
    }

    const isPasswordMatch = await user.comparePassword(password);
    if (!isPasswordMatch) {
      logAudit({
        req,
        userIdentifier: user.email,
        action: 'Admin Login',
        module: 'Authentication',
        description: 'Failed - Wrong password',
        status: 'FAILED'
      }).catch(() => {});
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    if (isPasswordExpired(user)) {
      return res.status(403).json({
        success: false,
        code: 'PASSWORD_EXPIRED',
        message: `Your password has expired after ${PASSWORD_EXPIRY_DAYS} days. Reset your password to continue.`,
      });
    }

    const trustedDeviceState = await validateTrustedDevice(req, user);
    if (trustedDeviceState.trusted) {
      return issueLoginSuccessResponse(req, res, user._id, {
        message: 'Login successful. OTP skipped for trusted device.',
        mfa: 'trusted_device',
        trustedDeviceBypass: true,
        metadata: {
          trustedDeviceId: String(trustedDeviceState.record?._id || ''),
        },
      });
    }

    const otpResult = await createOrRefreshLoginOtp(req, user);
    return res.status(otpResult.statusCode).json(otpResult.payload);
  } catch (error) {
    console.error('Admin login start error:', error);
    return res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
};

// @desc    Complete login after email OTP verification
// @route   POST /api/auth/login-verify-otp or /api/auth/admin-login-verify-otp
// @access  Public
const verifyLoginOtp = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const verificationId = String(req.body?.verificationId || '').trim();
    const otp = String(req.body?.otp || '').trim();

    if (!email || !verificationId || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Email, verification session, and OTP are required.'
      });
    }

    const verificationRecord = await AdminEmailVerification.findOne({
      _id: verificationId,
      email: { $in: getEmailLookupCandidates(email) },
      purpose: { $in: [ADMIN_LOGIN_OTP_PURPOSE, USER_LOGIN_OTP_PURPOSE] }
    });

    if (!verificationRecord) {
      return res.status(404).json({
        success: false,
        message: 'Verification session not found. Please log in again.'
      });
    }

    if (new Date(verificationRecord.expiresAt).getTime() <= Date.now()) {
      return res.status(400).json({
        success: false,
        message: 'That verification code has expired. Please send a new one.'
      });
    }

    if (verificationRecord.attempts >= LOGIN_OTP_MAX_VERIFY_ATTEMPTS) {
      return res.status(400).json({
        success: false,
        message: 'Too many incorrect attempts. Please send a new verification code.'
      });
    }

    if (verificationRecord.codeHash !== hashValue(otp)) {
      verificationRecord.attempts += 1;
      if (verificationRecord.attempts >= LOGIN_OTP_MAX_VERIFY_ATTEMPTS) {
        verificationRecord.expiresAt = new Date();
      }
      await verificationRecord.save();

      const userForAudit = await User.findById(verificationRecord.requestedBy).select('email');
      logAudit({
        req,
        userId: verificationRecord.requestedBy,
        userIdentifier: userForAudit?.email || email,
        action: 'Admin Login MFA',
        module: 'Authentication',
        description: 'Failed - Incorrect email OTP',
        status: 'FAILED'
      }).catch(() => {});

      return res.status(400).json({
        success: false,
        message:
          verificationRecord.attempts >= LOGIN_OTP_MAX_VERIFY_ATTEMPTS
            ? 'Too many incorrect attempts. Please send a new verification code.'
            : 'Incorrect verification code. Please try again.'
      });
    }

    const user = await User.findById(verificationRecord.requestedBy)
      .select('-password')
      .populate('subjectsTaught', 'name code')
      .lean();

    if (!user || !getEmailLookupCandidates(email).includes(user.email)) {
      await AdminEmailVerification.deleteOne({ _id: verificationRecord._id });
      return res.status(401).json({
        success: false,
        message: 'Invalid login session. Please log in again.'
      });
    }

    if (user.isArchived) {
      await AdminEmailVerification.deleteOne({ _id: verificationRecord._id });
      return res.status(401).json({
        success: false,
        message: 'Account is archived/suspended. Please contact support.'
      });
    }

    if (!user.isActive) {
      await AdminEmailVerification.deleteOne({ _id: verificationRecord._id });

      if (user.role === 'student') {
        return res.status(403).json({
          success: false,
          code: 'ENROLLMENT_PENDING_APPROVAL',
          message: 'Enrollment is pending admin approval. You can log in once your account is approved.'
        });
      }

      // Parent accounts are inactive until enrollment is approved —
      // they must be allowed through so they can track their application.
      if (user.role === 'parent') {
        // Do NOT block — continue to issue the login token below.
      } else {
        return res.status(401).json({
          success: false,
          message: 'Account is deactivated. Please contact support.'
        });
      }
    }

    if (
      verificationRecord.purpose === ADMIN_LOGIN_OTP_PURPOSE &&
      user.role !== 'admin' &&
      user.role !== 'super_admin'
    ) {
      await AdminEmailVerification.deleteOne({ _id: verificationRecord._id });
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials. Admin access only.'
      });
    }

    if (
      verificationRecord.purpose === USER_LOGIN_OTP_PURPOSE &&
      user.role !== 'student' &&
      user.role !== 'tutor' &&
      user.role !== 'parent'
    ) {
      await AdminEmailVerification.deleteOne({ _id: verificationRecord._id });
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials for the selected login page.'
      });
    }

    if (user.role === 'student' || user.role === 'tutor' || user.role === 'parent') {
      const maintenanceOn = await getMaintenanceEnabled();
      if (maintenanceOn) {
        return res.status(503).json({
          success: false,
          code: 'SYSTEM_MAINTENANCE',
          message: 'Bee Bright is currently undergoing scheduled maintenance. Please try again later. We apologize for any inconvenience.'
        });
      }
    }

    if (isPasswordExpired(user)) {
      await AdminEmailVerification.deleteOne({ _id: verificationRecord._id });
      return res.status(403).json({
        success: false,
        code: 'PASSWORD_EXPIRED',
        message: `Your password has expired after ${PASSWORD_EXPIRY_DAYS} days. Reset your password to continue.`,
      });
    }

    const trustDeviceRequested = req.body?.trustDevice !== false;

    let trustedDevicePayload = {
      trustedDeviceRegistered: false,
      trustedDeviceExpiresAt: null,
    };

    if (trustDeviceRequested) {
      try {
        const trustedDeviceRegistration = await registerTrustedDevice(req, user);
        setTrustedDeviceCookie(res, trustedDeviceRegistration.token, trustedDeviceRegistration.trustedExpiryDate);
        trustedDevicePayload = {
          trustedDeviceRegistered: true,
          trustedDeviceExpiresAt: trustedDeviceRegistration.trustedExpiryDate,
        };

        logAudit({
          req,
          userId: user._id,
          action: 'Trusted Device Registration',
          module: 'Security',
          description: 'Trusted device registered after OTP login',
          status: 'SUCCESS',
          metadata: { role: user.role }
        }).catch(() => {});
      } catch (trustedDeviceError) {
        console.error('Trusted device registration error:', trustedDeviceError);
      }
    }

    await AdminEmailVerification.deleteOne({ _id: verificationRecord._id });

    return issueLoginSuccessResponse(req, res, user._id, {
      message: 'Login successful',
      mfa: 'email_otp',
      trustedDeviceBypass: false,
      metadata: {
        trustedDeviceRegistered: trustedDevicePayload.trustedDeviceRegistered,
      },
      extraPayload: trustedDevicePayload,
    });
  } catch (error) {
    console.error('Verify login OTP error:', error);
    return res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.'
    });
  }
};

// @desc    Complete login after captcha verification
// @route   POST /api/auth/login-complete
// @access  Public
const completeLogin = async (req, res) => {
  return res.status(410).json({
    success: false,
    code: 'LOGIN_METHOD_UPDATED',
    message: 'Captcha login has been replaced with email OTP verification. Please request a new login code.'
  });
};

// @desc    Logout current user
// @route   POST /api/auth/logout
// @access  Public
const logout = async (req, res) => {
  try {
    await revokeTrustedDeviceFromRequest(req, 'manual_logout');
  } catch (error) {
    console.error('Trusted device revoke on logout error:', error);
  }

  clearAuthCookie(res);
  clearTrustedDeviceCookie(res);

  try {
    let userId = null;
    const authHeader = String(req.headers.authorization || '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const token = bearerToken || getAuthTokenFromCookies(req);
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded?.id || null;
    }

    if (userId) {
      logAudit({
        req,
        userId,
        action: 'Logout',
        module: 'Authentication',
        description: 'Manual logout from current device',
        status: 'SUCCESS'
      }).catch(() => {});
    }
  } catch (error) {
    // Ignore token decode errors on logout.
  }

  return res.status(200).json({
    success: true,
    message: 'Logged out successfully'
  });
};

// @desc    Get captcha challenge for login
// @route   GET /api/auth/captcha-challenge
// @access  Public
const getCaptchaChallenge = async (req, res) => {
  try {
    const challenge = createCaptchaChallenge();
    res.status(200).json({
      success: true,
      challenge
    });
  } catch (error) {
    console.error('Get captcha challenge error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate captcha challenge'
    });
  }
};

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate('subjectsTaught', 'name code');
   
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
   
    // Return user in frontend-friendly format
    const fullName = [user.firstName, user.middleName, user.lastName].filter(Boolean).join(' ');
    const userResponse = {
      id: user._id,
      firstName: user.firstName,
      middleName: user.middleName || '',
      lastName: user.lastName,
      name: fullName || `${user.firstName} ${user.lastName}`,
      email: user.email,
      role: user.role,
      phone: user.phone,
      isActive: user.isActive,
      gradeLevel: user.gradeLevel,
      guardianName: user.guardianName,
      guardianPhone: user.guardianPhone,
      enrolledSubjects: user.enrolledSubjects,
      subjectsTaught: user.subjectsTaught || [],
      employmentType: user.employmentType || 'full-time',
      availability: user.availability || '',
      enrollmentStatus: user.enrollmentStatus,
      paymentStatus: user.paymentStatus,
      profileImageUrl: getProfileImageUrl(req, user.profileImage),
      lastLogin: user.lastLogin,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      ...(() => {
        const passwordSecurity = getPasswordSecurityState(user);
        return {
          passwordChangedAt: passwordSecurity.passwordChangedAt.toISOString(),
          passwordExpiresAt: passwordSecurity.passwordExpiresAt.toISOString(),
          passwordExpired: passwordSecurity.passwordExpired,
          passwordExpiresInDays: passwordSecurity.passwordExpiresInDays,
        };
      })()
    };
   
    res.status(200).json({
      success: true,
      user: userResponse
    });
  } catch (error) {
    console.error('GetMe error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get user'
    });
  }
};

// @desc    Update user profile
// @route   PUT /api/auth/update-profile
// @access  Private
const updateProfile = async (req, res) => {
  try {
    const { firstName, middleName, lastName, phone, gradeLevel, guardianName, guardianPhone, subjectsTaught, employmentType, availability } = req.body;
   
    const user = await User.findById(req.user.id);
   
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
   
    // Update fields
    if (firstName !== undefined) {
      const nameErr = validateName(firstName, 'First name');
      if (nameErr) return res.status(400).json({ success: false, message: nameErr });
      user.firstName = firstName;
    }
    if (middleName !== undefined) {
      const nameErr = validateName(middleName, 'Middle name');
      if (nameErr) return res.status(400).json({ success: false, message: nameErr });
      user.middleName = middleName;
    }
    if (lastName !== undefined) {
      const nameErr = validateName(lastName, 'Last name');
      if (nameErr) return res.status(400).json({ success: false, message: nameErr });
      user.lastName = lastName;
    }
    if (phone !== undefined) {
      const phoneErr = validatePhoneNoLetters(phone);
      if (phoneErr) return res.status(400).json({ success: false, message: phoneErr });
      const phPhoneRegex = /^(0?9|639)\d{9}$/;
      const phoneDigits = (phone || '').replace(/\D/g, '');
      if (phoneDigits && !phPhoneRegex.test(phoneDigits)) {
        return res.status(400).json({
          success: false,
          message: 'Please enter a valid Philippine mobile number (e.g. 09XX XXX XXXX)'
        });
      }
      user.phone = phone;
    }
    if (gradeLevel && user.role === 'student') user.gradeLevel = gradeLevel;
    if (guardianName !== undefined && user.role === 'student') {
      const nameErr = validateName(guardianName, 'Guardian name');
      if (nameErr) return res.status(400).json({ success: false, message: nameErr });
      user.guardianName = guardianName;
    }
    if (guardianPhone !== undefined && user.role === 'student') {
      const gPhoneErr = validatePhoneNoLetters(guardianPhone);
      if (gPhoneErr) return res.status(400).json({ success: false, message: gPhoneErr });
      user.guardianPhone = guardianPhone;
    }
    // Tutor-only
    if (user.role === 'tutor') {
      if (Array.isArray(subjectsTaught)) user.subjectsTaught = subjectsTaught;
      if (employmentType !== undefined && ['full-time', 'part-time'].includes(employmentType)) user.employmentType = employmentType;
      if (availability !== undefined) user.availability = String(availability || '').trim();
    }
   
    await user.save();
    const updated = await User.findById(user._id).select('-password').populate('subjectsTaught', 'name code').lean();
    const fullName = [updated.firstName, updated.middleName, updated.lastName].filter(Boolean).join(' ');
    logAudit({
      req,
      userId: req.user.id,
      action: 'Profile Update',
      module: 'User Management',
      description: 'User updated profile information',
      status: 'SUCCESS'
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: updated._id,
        firstName: updated.firstName,
        middleName: updated.middleName || '',
        lastName: updated.lastName,
        name: fullName || `${updated.firstName} ${updated.lastName}`,
        email: updated.email,
        role: updated.role,
        phone: updated.phone,
        isActive: updated.isActive,
        gradeLevel: updated.gradeLevel,
        guardianName: updated.guardianName,
        guardianPhone: updated.guardianPhone,
        enrolledSubjects: updated.enrolledSubjects,
        subjectsTaught: updated.subjectsTaught || [],
        employmentType: updated.employmentType || 'full-time',
        availability: updated.availability || '',
        enrollmentStatus: updated.enrollmentStatus,
        paymentStatus: updated.paymentStatus,
        profileImageUrl: getProfileImageUrl(req, updated.profileImage)
      }
    });
  } catch (error) {
    console.error('UpdateProfile error:', error);
    logAudit({
      req,
      userId: req.user?.id,
      action: 'Profile Update',
      module: 'User Management',
      description: 'User profile update failed',
      status: 'FAILED',
      metadata: { error: error.message }
    }).catch(() => {});
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update profile'
    });
  }
};

// @desc    Upload profile image (accepts base64 data URL; any image type)
// @route   PUT /api/auth/profile-image
// @access  Private
const uploadProfileImage = async (req, res) => {
  try {
    const { image } = req.body;
    if (!image || typeof image !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Please provide an image (base64 data URL)'
      });
    }
    const match = image.match(/^data:image\/([\w+-]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({
        success: false,
        message: 'Invalid image format. Use a data URL (e.g. data:image/jpeg;base64,...)'
      });
    }
    const mime = `image/${match[1].toLowerCase()}`;
    if (!Object.prototype.hasOwnProperty.call(MIME_TO_EXT, mime)) {
      return res.status(400).json({
        success: false,
        message: 'Unsupported image type. Please upload a JPG, PNG, GIF, or WEBP image.'
      });
    }
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        message: 'Image size must be under 5MB'
      });
    }
    const detectedMime = detectImageMime(buffer);
    if (!detectedMime || detectedMime !== mime) {
      return res.status(400).json({
        success: false,
        message: 'Image content does not match the uploaded file type'
      });
    }
    const ext = MIME_TO_EXT[detectedMime];
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
    const filename = `${req.user.id}-${Date.now()}${ext}`;
    const relPath = path.join('avatars', filename);
    const absPath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(absPath, buffer);
    const user = await User.findById(req.user.id);
    if (!user) {
      fs.unlinkSync(absPath);
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (user.profileImage) {
      const oldPath = path.join(__dirname, '..', 'uploads', user.profileImage);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    user.profileImage = relPath;
    await user.save();
    const profileImageUrl = getProfileImageUrl(req, relPath);
    logAudit({
      req,
      userId: req.user.id,
      action: 'Profile Image Update',
      module: 'User Management',
      description: 'User updated profile picture',
      status: 'SUCCESS'
    }).catch(() => {});
    res.status(200).json({
      success: true,
      message: 'Profile picture updated',
      profileImageUrl
    });
  } catch (error) {
    console.error('UploadProfileImage error:', error);
    logAudit({
      req,
      userId: req.user?.id,
      action: 'Profile Image Update',
      module: 'User Management',
      description: 'Profile picture upload failed',
      status: 'FAILED',
      metadata: { error: error.message }
    }).catch(() => {});
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload profile picture'
    });
  }
};

// @desc    Change password
// @route   PUT /api/auth/change-password
// @access  Private
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide current and new password'
      });
    }
   
    const user = await User.findById(req.user.id).select('+password');
   
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
   
    // Check current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      logAudit({
        req,
        userId: user._id,
        action: 'Password Change',
        module: 'User Management',
        description: 'Failed - Current password incorrect',
        status: 'FAILED'
      }).catch(() => {});
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }
   
    // Validate new password
    if (!PASSWORD_REGEX.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: 'New password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number and one special character (@$!%*?&)'
      });
    }
   
    // Update password
    user.password = newPassword;
    await user.save();
    await invalidateAllTrustedDevicesForUser(user._id, 'password_changed');

    logAudit({
      req,
      userId: user._id,
      action: 'Password Change',
      module: 'User Management',
      description: 'Password changed successfully',
      status: 'SUCCESS'
    }).catch(() => {});
   
    res.status(200).json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    console.error('ChangePassword error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to change password'
    });
  }
};

module.exports = {
  register,
  login,
  adminLogin,
  loginStart,
  adminLoginStart,
  verifyLoginOtp,
  completeLogin,
  logout,
  getCaptchaChallenge,
  getMe,
  updateProfile,
  uploadProfileImage,
  changePassword
};
