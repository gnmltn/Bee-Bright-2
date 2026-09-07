/**
 * Enrollment Service
 * Centralizes business logic for enrollment: ID generation, amount computation,
 * status transitions, and email notifications.
 */
const mongoose = require('mongoose');
const EnrollmentCounter = require('../models/EnrollmentCounter');
const { sendEmail, logEmailError } = require('../utils/emailService');

// ── Enrollment ID ──────────────────────────────────────────────────────────

/**
 * Generate a unique enrollment ID in the format BB-YYYYMMDD-XXXX
 * Uses an atomic MongoDB counter to guarantee uniqueness even under concurrent requests.
 * @param {Date} [date]
 * @returns {Promise<string>}
 */
async function generateEnrollmentId(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const key = `${y}${m}${d}`;

  const counter = await EnrollmentCounter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const seq = String(counter.seq).padStart(4, '0');
  return `BB-${y}${m}${d}-${seq}`;
}

// ── Payment amount ─────────────────────────────────────────────────────────

/**
 * Compute the amount due based on packages and payment option.
 * @param {Array<{price: number}>} packages
 * @param {'full'|'down'} paymentOption
 * @returns {{ totalFee: number, amountDue: number }}
 */
function computeAmounts(packages, paymentOption) {
  const totalFee = (packages || []).reduce((sum, p) => sum + Number(p.price || 0), 0);
  const amountDue = paymentOption === 'down' ? Math.ceil(totalFee * 0.5) : totalFee;
  return { totalFee, amountDue };
}

// ── Status helpers ─────────────────────────────────────────────────────────

/**
 * Push a status history entry onto an enrollment document.
 * Call enrollment.save() after this.
 */
function pushStatusHistory(enrollment, status, actorId = null, actorRole = null, note = '') {
  enrollment.status = status;
  if (!Array.isArray(enrollment.statusHistory)) enrollment.statusHistory = [];
  enrollment.statusHistory.push({
    status,
    at: new Date(),
    by: actorId || null,
    byRole: actorRole || null,
    note: note || '',
  });
}

// ── Email notifications ────────────────────────────────────────────────────

async function sendEnrollmentConfirmationEmail(to, { parentName, studentName, enrollmentId, amountDue, paymentMethod }) {
  const methodLabel = { gcash: 'GCash', seabank: 'SeaBank', bdo: 'BDO' }[paymentMethod] || paymentMethod;
  return sendEmail(
    {
      to,
      subject: `Bee Bright — Enrollment Received (${enrollmentId})`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#f59e0b,#d97706);padding:28px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:24px;">🐝 Bee Bright Tutorial Center</h1>
          </div>
          <div style="padding:32px;background:#fffbeb;border:1px solid #fde68a;border-top:none;border-radius:0 0 8px 8px;">
            <h2 style="color:#92400e;">Enrollment Received!</h2>
            <p style="color:#78350f;line-height:1.6;">Hi <strong>${parentName}</strong>,</p>
            <p style="color:#78350f;line-height:1.6;">
              We've received the enrollment application for <strong>${studentName}</strong>.
            </p>
            <div style="background:#fff;border:1px solid #fde68a;border-radius:8px;padding:20px;margin:20px 0;">
              <p style="margin:0 0 8px;"><strong>Enrollment ID:</strong> ${enrollmentId}</p>
              <p style="margin:0 0 8px;"><strong>Amount Due:</strong> ₱${Number(amountDue).toLocaleString()}</p>
              <p style="margin:0;"><strong>Payment Method:</strong> ${methodLabel}</p>
            </div>
            <p style="color:#78350f;line-height:1.6;">
              Our team will review your enrollment and payment proof within <strong>1–2 business days</strong>.
              You will receive an email once your enrollment is approved.
            </p>
            <p style="color:#b45309;font-size:14px;margin-top:24px;">
              You can track your enrollment status at any time using your Enrollment ID and registered email.
            </p>
          </div>
        </div>`,
    },
    'enrollment confirmation'
  ).catch((err) => logEmailError('enrollment confirmation email', err, { to, enrollmentId }));
}

async function sendEnrollmentApprovedEmail(to, { parentName, studentName, enrollmentId, studentId }) {
  const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login`;
  return sendEmail(
    {
      to,
      subject: `Bee Bright — Enrollment Approved! Welcome, ${studentName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#10b981,#059669);padding:28px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:24px;">🐝 Bee Bright Tutorial Center</h1>
          </div>
          <div style="padding:32px;background:#ecfdf5;border:1px solid #a7f3d0;border-top:none;border-radius:0 0 8px 8px;">
            <h2 style="color:#065f46;">Enrollment Approved!</h2>
            <p style="color:#064e3b;line-height:1.6;">Hi <strong>${parentName}</strong>,</p>
            <p style="color:#064e3b;line-height:1.6;">
              Great news! The enrollment for <strong>${studentName}</strong> has been <strong>approved</strong>.
            </p>
            <div style="background:#fff;border:1px solid #a7f3d0;border-radius:8px;padding:20px;margin:20px 0;">
              <p style="margin:0 0 8px;"><strong>Enrollment ID:</strong> ${enrollmentId}</p>
              <p style="margin:0;"><strong>Student ID:</strong> ${studentId}</p>
            </div>
            <p style="color:#064e3b;line-height:1.6;">
              Our scheduling team will reach out to arrange your child's class schedule based on your preferred start date and time.
            </p>
            <div style="text-align:center;margin:28px 0;">
              <a href="${loginUrl}" style="background:linear-gradient(135deg,#10b981,#059669);color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;">
                Log In to Your Dashboard
              </a>
            </div>
          </div>
        </div>`,
    },
    'enrollment approved'
  ).catch((err) => logEmailError('enrollment approved email', err, { to, enrollmentId }));
}

async function sendEnrollmentRejectedEmail(to, { parentName, studentName, enrollmentId, reason, allowResubmission }) {
  return sendEmail(
    {
      to,
      subject: `Bee Bright — Enrollment Update (${enrollmentId})`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#374151;padding:28px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:24px;">🐝 Bee Bright Tutorial Center</h1>
          </div>
          <div style="padding:32px;background:#fef9f9;border:1px solid #fca5a5;border-top:none;border-radius:0 0 8px 8px;">
            <h2 style="color:#991b1b;">Enrollment Not Approved</h2>
            <p style="color:#7f1d1d;line-height:1.6;">Hi <strong>${parentName}</strong>,</p>
            <p style="color:#7f1d1d;line-height:1.6;">
              Unfortunately, the enrollment for <strong>${studentName}</strong> (${enrollmentId}) was not approved.
            </p>
            ${reason ? `
            <div style="background:#fff;border-left:4px solid #ef4444;border-radius:4px;padding:16px;margin:16px 0;">
              <p style="color:#7f1d1d;margin:0;"><strong>Reason:</strong> ${reason}</p>
            </div>` : ''}
            ${allowResubmission ? `
            <p style="color:#7f1d1d;line-height:1.6;">
              You may upload new payment proof and resubmit your application. Log in to your parent dashboard to do so.
            </p>` : ''}
            <p style="color:#b91c1c;font-size:14px;margin-top:20px;">
              If you have questions, please contact us at beebrightph@gmail.com
            </p>
          </div>
        </div>`,
    },
    'enrollment rejected'
  ).catch((err) => logEmailError('enrollment rejected email', err, { to, enrollmentId }));
}

async function sendPaymentVerifiedEmail(to, { parentName, studentName, enrollmentId }) {
  return sendEmail(
    {
      to,
      subject: `Bee Bright — Payment Verified (${enrollmentId})`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#f59e0b,#d97706);padding:28px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="color:#fff;margin:0;">🐝 Bee Bright</h1>
          </div>
          <div style="padding:32px;background:#fffbeb;border:1px solid #fde68a;border-top:none;border-radius:0 0 8px 8px;">
            <h2 style="color:#92400e;">Payment Verified</h2>
            <p style="color:#78350f;">Hi <strong>${parentName}</strong>,</p>
            <p style="color:#78350f;line-height:1.6;">
              Your payment for <strong>${studentName}</strong>'s enrollment (${enrollmentId}) has been verified.
              The enrollment is now pending final approval — we'll notify you once it's confirmed.
            </p>
          </div>
        </div>`,
    },
    'payment verified'
  ).catch((err) => logEmailError('payment verified email', err, { to, enrollmentId }));
}

module.exports = {
  generateEnrollmentId,
  computeAmounts,
  pushStatusHistory,
  sendEnrollmentConfirmationEmail,
  sendEnrollmentApprovedEmail,
  sendEnrollmentRejectedEmail,
  sendPaymentVerifiedEmail,
};
