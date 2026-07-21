const nodemailer = require('nodemailer');

let cachedTransporter = null;
let cachedTransportFingerprint = null;
let verifyPromise = null;

const EMAIL_VERIFY_TIMEOUT_MS = 10000;

function normalizeBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function getEmailConfig() {
  const user =
    process.env.SMTP_USER ||
    process.env.EMAIL_USER ||
    process.env.MAIL_USER ||
    '';
  const pass =
    process.env.SMTP_PASS ||
    process.env.EMAIL_PASS ||
    process.env.EMAIL_PASSWORD ||
    process.env.MAIL_PASS ||
    process.env.GMAIL_APP_PASSWORD ||
    '';
  const host = process.env.SMTP_HOST || process.env.EMAIL_HOST || '';
  const serviceFromEnv = process.env.SMTP_SERVICE || process.env.EMAIL_SERVICE || '';
  const service =
    serviceFromEnv ||
    (host.toLowerCase().includes('gmail') ? 'gmail' : '');
  const port = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || 587);
  const secure = normalizeBoolean(process.env.SMTP_SECURE || process.env.EMAIL_SECURE, port === 465);
  const from = process.env.EMAIL_FROM || process.env.SMTP_FROM || user;

  return {
    user,
    pass,
    service,
    host,
    port,
    secure,
    from,
  };
}

function getTransportFingerprint(config) {
  return JSON.stringify({
    user: config.user,
    service: config.service,
    host: config.host,
    port: config.port,
    secure: config.secure,
  });
}

function getTransporter() {
  const config = getEmailConfig();
  if (!config.user || !config.pass) {
    throw new Error('Email service is not configured. Set SMTP_USER and SMTP_PASS (or EMAIL_USER and EMAIL_PASSWORD).');
  }

  const fingerprint = getTransportFingerprint(config);
  if (cachedTransporter && cachedTransportFingerprint === fingerprint) {
    return { transporter: cachedTransporter, config };
  }

  const transportOptions = config.service
    ? {
        service: config.service,
        auth: { user: config.user, pass: config.pass },
      }
    : {
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.pass },
        connectionTimeout: EMAIL_VERIFY_TIMEOUT_MS,
        greetingTimeout: EMAIL_VERIFY_TIMEOUT_MS,
        socketTimeout: EMAIL_VERIFY_TIMEOUT_MS,
      };

  cachedTransporter = nodemailer.createTransport(transportOptions);
  cachedTransportFingerprint = fingerprint;
  verifyPromise = null;

  return { transporter: cachedTransporter, config };
}

function isSmtpAuthError(error) {
  const msg = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toUpperCase();
  const responseCode = Number(error?.responseCode || 0);

  return (
    code === 'EAUTH' ||
    responseCode === 534 ||
    responseCode === 535 ||
    msg.includes('534-5.7.9') ||
    msg.includes('webloginrequired') ||
    msg.includes('invalid login') ||
    msg.includes('authentication')
  );
}

function getEmailErrorMessage(error) {
  if (isSmtpAuthError(error)) {
    return 'Email service authentication failed. Re-check the mailbox credentials or refresh the provider app password.';
  }

  if (String(error?.code || '').toUpperCase() === 'ETIMEDOUT') {
    return 'Email service timed out while contacting the SMTP server.';
  }

  return 'Unable to send email right now. Please try again later.';
}

function logEmailError(context, error, meta = {}) {
  console.error(`[EMAIL] ${context}`, {
    code: error?.code,
    responseCode: error?.responseCode,
    command: error?.command,
    message: error?.message,
    ...meta,
  });
}

async function verifyEmailTransport() {
  const { transporter, config } = getTransporter();

  if (!verifyPromise) {
    verifyPromise = transporter.verify();
  }

  try {
    await verifyPromise;
    return {
      ok: true,
      service: config.service || config.host,
      user: config.user,
    };
  } catch (error) {
    verifyPromise = null;
    logEmailError('transport verification failed', error, {
      service: config.service || config.host,
      user: config.user,
    });
    throw error;
  }
}

async function sendEmail(message, context = 'email send') {
  const { transporter, config } = getTransporter();

  try {
    if (!verifyPromise) {
      verifyPromise = transporter.verify();
    }
    await verifyPromise;
  } catch (error) {
    verifyPromise = null;
    logEmailError(`${context} transport verification failed`, error, {
      to: message.to,
      service: config.service || config.host,
    });
    throw error;
  }

  try {
    return await transporter.sendMail({
      from: message.from || config.from,
      ...message,
    });
  } catch (error) {
    logEmailError(`${context} send failed`, error, {
      to: message.to,
      subject: message.subject,
      service: config.service || config.host,
    });
    throw error;
  }
}

async function sendOtpEmail(to, otp, expiresMinutes = 5) {
  return sendEmail(
    {
      to,
      subject: `Bee Bright Password Reset OTP (valid for ${expiresMinutes} minutes)`,
      text: `Your Bee Bright password reset OTP is ${otp}. It expires in ${expiresMinutes} minutes.`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2>Bee Bright Password Reset</h2>
          <p>Your OTP code is:</p>
          <div style="font-size:28px;font-weight:bold;letter-spacing:4px;padding:12px 16px;background:#f3f3f3;border-radius:8px;display:inline-block;">
            ${otp}
          </div>
          <p style="margin-top:16px;">This code will expire in <b>${expiresMinutes} minutes</b>.</p>
          <p>If you did not request this, ignore this email.</p>
        </div>
      `,
    },
    'password reset OTP'
  );
}

async function sendEnrollmentVerificationEmail(to, otp, expiresMinutes = 5) {
  return sendEmail(
    {
      to,
      subject: 'Bee Bright enrollment verification code',
      text: `Your Bee Bright enrollment verification code is ${otp}. It expires in ${expiresMinutes} minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 600px; margin: 0 auto;">
          <h2 style="margin-bottom: 8px;">Bee Bright enrollment verification</h2>
          <p>Your verification code is:</p>
          <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px; margin: 16px 0;">${otp}</p>
          <p>This code expires in ${expiresMinutes} minutes.</p>
        </div>
      `,
    },
    'enrollment verification OTP'
  );
}

const sendPaymentApprovalEmail = async (to, studentName) => {
  try {
    await sendEmail(
      {
        to,
        subject: 'Your Bee Bright Enrollment is Approved!',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
              <h1 style="color: white; margin: 0;">Bee Bright</h1>
            </div>
            <div style="padding: 30px; background: #f9f9f9;">
              <h2 style="color: #333;">Welcome to Bee Bright, ${studentName}!</h2>
              <p style="color: #666; line-height: 1.6;">
                We're excited to inform you that your payment has been verified and your enrollment is now active.
              </p>
              <div style="background: white; border-radius: 10px; padding: 20px; margin: 20px 0; border-left: 4px solid #4CAF50;">
                <h3 style="color: #333; margin-top: 0;">Account Details:</h3>
                <ul style="color: #666;">
                  <li><strong>Status:</strong> Active Enrollment</li>
                  <li><strong>Access:</strong> Full access to tutorials</li>
                  <li><strong>Start Learning:</strong> Login now to begin</li>
                </ul>
              </div>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${process.env.FRONTEND_URL}/login"
                   style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
                  Login to Your Dashboard
                </a>
              </div>
            </div>
          </div>
        `,
      },
      'payment approval email'
    );
    return true;
  } catch (error) {
    return false;
  }
};

const sendEnrollmentRejectionEmail = async (to, studentName, reason) => {
  try {
    const defaultReason = 'Your enrollment does not meet our standards or payment could not be verified.';
    const reasonText = reason || defaultReason;

    await sendEmail(
      {
        to,
        subject: 'Bee Bright - Enrollment Not Approved',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #333; padding: 24px; text-align: center;">
              <h1 style="color: white; margin: 0;">Bee Bright</h1>
            </div>
            <div style="padding: 30px; background: #f9f9f9;">
              <h2 style="color: #333;">Enrollment Not Approved</h2>
              <p style="color: #666; line-height: 1.6;">Hello ${studentName},</p>
              <p style="color: #666; line-height: 1.6;">We regret to inform you that your enrollment has not been approved.</p>
              <div style="background: #fff3cd; border-left: 4px solid #856404; padding: 16px; margin: 20px 0; border-radius: 4px;">
                <p style="color: #856404; margin: 0; line-height: 1.6;">${reasonText}</p>
              </div>
            </div>
          </div>
        `,
      },
      'enrollment rejection email'
    );
    return true;
  } catch (error) {
    return false;
  }
};

const sendAnnouncementEmail = async (to, recipientName, title, body, category = 'general') => {
  try {
    const categoryLabels = {
      sick_leave: 'Sick Leave',
      exam: 'Exam',
      quiz: 'Quiz',
      materials: 'Materials to Bring',
      reschedule: 'Class Reschedule',
      reminder: 'Reminder',
      suspension: 'Class Suspension',
      maintenance: 'System Maintenance',
      holiday: 'Holiday',
      general: 'Announcement',
    };
    const label = categoryLabels[category] || 'Announcement';
    const safeBody = (body || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');

    await sendEmail(
      {
        to,
        subject: `[Bee Bright] ${title}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #333; padding: 24px; text-align: center;">
              <h1 style="color: white; margin: 0;">Bee Bright</h1>
            </div>
            <div style="padding: 30px; background: #f9f9f9;">
              <p style="color: #666;">Hello ${recipientName},</p>
              <p style="color: #666;">You have a new ${label.toLowerCase()}:</p>
              <div style="background: white; border-radius: 8px; padding: 20px; margin: 16px 0; border-left: 4px solid #667eea;">
                <span style="font-size: 12px; color: #888;">${label}</span>
                <h2 style="color: #333; margin: 8px 0;">${(title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h2>
                <div style="color: #555; line-height: 1.6;">${safeBody}</div>
              </div>
              <p style="color: #666; font-size: 14px;">
                Log in to your dashboard to view all announcements.
              </p>
            </div>
          </div>
        `,
      },
      'announcement email'
    );
    return true;
  } catch (error) {
    return false;
  }
};

module.exports = {
  getTransporter,
  verifyEmailTransport,
  sendEmail,
  sendOtpEmail,
  sendEnrollmentVerificationEmail,
  sendPaymentApprovalEmail,
  sendEnrollmentRejectionEmail,
  sendAnnouncementEmail,
  isSmtpAuthError,
  getEmailErrorMessage,
  logEmailError,
};