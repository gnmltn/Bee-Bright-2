/**
 * Enrollment Service
 * Centralizes business logic for enrollment: ID generation, amount computation,
 * status transitions, and email notifications.
 */
const mongoose = require('mongoose');
const EnrollmentCounter = require('../models/EnrollmentCounter');
const { sendEmail, logEmailError, buildBrandedEmailHtml } = require('../utils/emailService');

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
  const methodLabel = { gcash: 'GCash', maribank: 'MariBank', bdo: 'BDO' }[paymentMethod] || paymentMethod;
  return sendEmail(
    {
      to,
      subject: `Bee Bright — Enrollment Received (${enrollmentId})`,
      html: buildBrandedEmailHtml({
        title: 'Enrollment Received!',
        bodyHtml: `
          <p>Hi <strong>${parentName}</strong>,</p>
          <p>We've received the enrollment application for <strong>${studentName}</strong>.</p>
          <div style="background:#fff;border:1px solid #fde68a;border-radius:8px;padding:20px;margin:20px 0;">
            <p style="margin:0 0 8px;"><strong>Student ID:</strong> ${enrollmentId}</p>
            <p style="margin:0 0 8px;"><strong>Amount Due:</strong> ₱${Number(amountDue).toLocaleString()}</p>
            <p style="margin:0;"><strong>Payment Method:</strong> ${methodLabel}</p>
          </div>
          <p>Our team will review your enrollment and payment proof within <strong>1–2 business days</strong>.
             You will receive an email once your enrollment is approved.</p>
          <p style="color:#b45309;font-size:14px;margin-top:24px;">
            You can track your enrollment status at any time using your Enrollment ID and registered email.
          </p>
        `,
      }),
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
      html: buildBrandedEmailHtml({
        title: 'Enrollment Approved!',
        accent: 'green',
        bodyHtml: `
          <p>Hi <strong>${parentName}</strong>,</p>
          <p>Great news! The enrollment for <strong>${studentName}</strong> has been <strong>approved</strong>.</p>
          <div style="background:#fff;border:1px solid #a7f3d0;border-radius:8px;padding:20px;margin:20px 0;">
            <p style="margin:0 0 8px;"><strong>Enrollment ID:</strong> ${enrollmentId}</p>
            <p style="margin:0;"><strong>Student ID:</strong> ${studentId}</p>
          </div>
          <p>Our scheduling team will reach out to arrange your child's class schedule based on your preferred start date and time.</p>
        `,
        ctaLabel: 'Log In to Your Dashboard',
        ctaUrl: loginUrl,
      }),
    },
    'enrollment approved'
  ).catch((err) => logEmailError('enrollment approved email', err, { to, enrollmentId }));
}

// The account this enrollment belonged to is permanently deleted right after this email is
// sent (see enrollmentController.js's adminRejectEnrollment) — there is no dashboard left to
// log into, so this never offers a "resubmit"/"log in" path, only a fresh application.
async function sendEnrollmentRejectedEmail(to, { parentName, studentName, enrollmentId, reason }) {
  const enrollUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/enrollment`;
  return sendEmail(
    {
      to,
      subject: `Bee Bright — Enrollment Update (${enrollmentId})`,
      html: buildBrandedEmailHtml({
        title: 'Enrollment Not Approved',
        accent: 'red',
        bodyHtml: `
          <p>Hi <strong>${parentName}</strong>,</p>
          <p>We were unable to verify your payment for <strong>${studentName}</strong>'s enrollment (${enrollmentId}), so we could not approve it.</p>
          ${reason ? `
          <div style="background:#fff;border-left:4px solid #ef4444;border-radius:4px;padding:16px;margin:16px 0;">
            <p style="margin:0;"><strong>Reason:</strong> ${reason}</p>
          </div>` : ''}
          <p>Please submit a new enrollment application if you'd like to try again.</p>
          <p style="color:#b91c1c;font-size:14px;margin-top:20px;">
            If you have questions, please contact us at beebrightph@gmail.com
          </p>
        `,
        ctaLabel: 'Start a New Enrollment',
        ctaUrl: enrollUrl,
      }),
    },
    'enrollment rejected'
  ).catch((err) => logEmailError('enrollment rejected email', err, { to, enrollmentId }));
}

async function sendPaymentVerifiedEmail(to, { parentName, studentName, enrollmentId }) {
  return sendEmail(
    {
      to,
      subject: `Bee Bright — Payment Verified (${enrollmentId})`,
      html: buildBrandedEmailHtml({
        title: 'Payment Verified',
        bodyHtml: `
          <p>Hi <strong>${parentName}</strong>,</p>
          <p>Your payment for <strong>${studentName}</strong>'s enrollment (${enrollmentId}) has been verified.
             The enrollment is now pending final approval — we'll notify you once it's confirmed.</p>
        `,
      }),
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
