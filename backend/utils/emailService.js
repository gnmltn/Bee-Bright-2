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
  // Item E (2nd report) — root cause of "Unable to send email right now": this used to also
  // infer `service: 'gmail'` whenever the host merely CONTAINED "gmail" (e.g. smtp.gmail.com).
  // nodemailer's "gmail" shorthand service dials its own fixed host/port (465, secure) and
  // silently ignores SMTP_PORT/SMTP_SECURE — so an operator who deliberately configured port
  // 587/STARTTLS (the more firewall-friendly option, and what .env actually sets) was overridden
  // into port 465 without realizing it, and every send failed with a connect timeout on 465.
  // The service shorthand is now used ONLY when explicitly requested via SMTP_SERVICE/
  // EMAIL_SERVICE — an explicit host+port+secure always wins.
  const service = process.env.SMTP_SERVICE || process.env.EMAIL_SERVICE || '';
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

/** True for a failed/timed-out TCP connection to the SMTP server — nodemailer wraps the raw
 * connect timeout (whose own error.code is ETIMEDOUT) inside an outer error with code
 * ESOCKET, so ETIMEDOUT alone misses it; this catches both shapes. */
function isSmtpConnectionError(error) {
  const code = String(error?.code || '').toUpperCase();
  const msg = String(error?.message || '').toLowerCase();
  return code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNREFUSED' || msg.includes('etimedout') || msg.includes('econnrefused');
}

function getEmailErrorMessage(error) {
  if (isSmtpAuthError(error)) {
    return 'Email service authentication failed. Re-check the mailbox credentials or refresh the provider app password.';
  }

  if (isSmtpConnectionError(error)) {
    return 'Could not reach the email server right now. Please try again in a moment.';
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

// ── Shared branded template ("polishing prompt (1).pdf", Group H) ──────────────────────────
// Every outgoing email is wrapped in this SAME visual frame (logo header banner, styled
// content box) — only the accent color (semantic: orange=default/info, green=success,
// red=rejection/warning) and the body content vary per email. Previously each
// email-sending function in this file, services/enrollmentService.js, and
// controllers/{authController,parentAuthController,adminInviteController,scheduleController,
// enrollmentController}.js built its own ad-hoc inline HTML (or, for most of
// scheduleController.js's notifications, no HTML at all — text-only), so the same product
// sent visually inconsistent emails depending on which code path triggered it.
const EMAIL_BRAND_ACCENTS = {
  orange: { from: '#f59e0b', to: '#d97706', bg: '#fffbeb', border: '#fde68a', heading: '#92400e', text: '#78350f', subtle: '#b45309' },
  green: { from: '#10b981', to: '#059669', bg: '#ecfdf5', border: '#a7f3d0', heading: '#065f46', text: '#064e3b', subtle: '#047857' },
  red: { from: '#374151', to: '#374151', bg: '#fef9f9', border: '#fca5a5', heading: '#991b1b', text: '#7f1d1d', subtle: '#b91c1c' },
};

/**
 * Wraps `bodyHtml` in the standard Bee Bright header banner + styled content box.
 * @param {{ title?: string, bodyHtml: string, accent?: 'orange'|'green'|'red', ctaLabel?: string, ctaUrl?: string }} opts
 */
function buildBrandedEmailHtml({ title, bodyHtml, accent = 'orange', ctaLabel, ctaUrl }) {
  const c = EMAIL_BRAND_ACCENTS[accent] || EMAIL_BRAND_ACCENTS.orange;
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:linear-gradient(135deg,${c.from},${c.to});padding:28px;text-align:center;border-radius:8px 8px 0 0;">
        <h1 style="color:#fff;margin:0;font-size:24px;">🐝 Bee Bright</h1>
        <p style="color:#fef3c7;margin:6px 0 0;font-size:14px;">Tutorial Center</p>
      </div>
      <div style="padding:32px;background:${c.bg};border:1px solid ${c.border};border-top:none;border-radius:0 0 8px 8px;">
        ${title ? `<h2 style="color:${c.heading};margin:0 0 12px;">${title}</h2>` : ''}
        <div style="color:${c.text};line-height:1.6;">${bodyHtml}</div>
        ${ctaLabel && ctaUrl ? `
        <div style="text-align:center;margin:28px 0;">
          <a href="${ctaUrl}" style="background:linear-gradient(135deg,${c.from},${c.to});color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;">${ctaLabel}</a>
        </div>` : ''}
      </div>
    </div>`;
}

/** Same branded frame, plus the large bordered OTP code box every verification-code email uses. */
function buildOtpEmailHtml({ title, introHtml, otp, expiresMinutes, accent = 'orange' }) {
  const c = EMAIL_BRAND_ACCENTS[accent] || EMAIL_BRAND_ACCENTS.orange;
  const bodyHtml = `
    ${introHtml || ''}
    <div style="text-align:center;margin:28px 0;">
      <div style="display:inline-block;background:#fff;border:2px solid ${c.from};border-radius:12px;padding:16px 40px;">
        <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:${c.heading};">${otp}</span>
      </div>
    </div>
    <p style="color:${c.text};font-size:14px;text-align:center;">This code expires in <strong>${expiresMinutes} minutes</strong>.</p>
    <p style="color:${c.subtle};font-size:13px;text-align:center;margin-top:20px;">If you did not request this, you can safely ignore this email.</p>
  `;
  return buildBrandedEmailHtml({ title, bodyHtml, accent });
}

async function sendOtpEmail(to, otp, expiresMinutes = 5) {
  return sendEmail(
    {
      to,
      subject: `Bee Bright Password Reset OTP (valid for ${expiresMinutes} minutes)`,
      text: `Your Bee Bright password reset OTP is ${otp}. It expires in ${expiresMinutes} minutes.`,
      html: buildOtpEmailHtml({
        title: 'Password Reset',
        introHtml: '<p>Use the code below to reset your Bee Bright account password.</p>',
        otp,
        expiresMinutes,
      }),
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
      html: buildOtpEmailHtml({
        title: 'Enrollment Verification',
        introHtml: '<p>Enter the code below to verify your email and continue with enrollment.</p>',
        otp,
        expiresMinutes,
      }),
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
        html: buildBrandedEmailHtml({
          title: `Welcome to Bee Bright, ${studentName}!`,
          accent: 'green',
          bodyHtml: `
            <p>We're excited to inform you that your payment has been verified and your enrollment is now active.</p>
            <div style="background:#fff;border-radius:10px;padding:20px;margin:20px 0;border-left:4px solid #10b981;">
              <h3 style="color:#065f46;margin-top:0;">Account Details:</h3>
              <ul>
                <li><strong>Status:</strong> Active Enrollment</li>
                <li><strong>Access:</strong> Full access to tutorials</li>
                <li><strong>Start Learning:</strong> Login now to begin</li>
              </ul>
            </div>
          `,
          ctaLabel: 'Login to Your Dashboard',
          ctaUrl: `${process.env.FRONTEND_URL}/login`,
        }),
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
        html: buildBrandedEmailHtml({
          title: 'Enrollment Not Approved',
          accent: 'red',
          bodyHtml: `
            <p>Hello ${studentName},</p>
            <p>We regret to inform you that your enrollment has not been approved.</p>
            <div style="background:#fff;border-left:4px solid #ef4444;padding:16px;margin:20px 0;border-radius:4px;">
              <p style="margin:0;">${reasonText}</p>
            </div>
          `,
        }),
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
        html: buildBrandedEmailHtml({
          bodyHtml: `
            <p>Hello ${recipientName},</p>
            <p>You have a new ${label.toLowerCase()}:</p>
            <div style="background:#fff;border-radius:8px;padding:20px;margin:16px 0;border-left:4px solid #f59e0b;">
              <span style="font-size:12px;color:#b45309;">${label}</span>
              <h2 style="color:#92400e;margin:8px 0;">${(title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h2>
              <div style="color:#78350f;line-height:1.6;">${safeBody}</div>
            </div>
            <p style="font-size:14px;">Log in to your dashboard to view all announcements.</p>
          `,
        }),
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
  buildBrandedEmailHtml,
  buildOtpEmailHtml,
  isSmtpAuthError,
  isSmtpConnectionError,
  getEmailErrorMessage,
  logEmailError,
  getEmailConfig,
};