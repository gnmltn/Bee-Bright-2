/**
 * The second 50% of an enrollment — what a parent still owes after the down payment
 * has been verified. Shared by the admin "Total Unpaid" / "Pending Payments" views and
 * the parent's Payments badge so they can never disagree.
 */
const mongoose = require('mongoose');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');

const EXCLUDED_ENROLLMENT_STATUSES = ['draft', 'rejected', 'cancelled'];

const amountOf = (p) => Number(p?.amountPaid ?? p?.amountDue ?? p?.amount ?? 0) || 0;

/**
 * @param {object} enrollment  needs totalFee + status
 * @param {object[]} payments  this enrollment's Payment docs
 * @returns {{ remaining: number, owed: boolean, underReview: boolean }}
 *   `owed` is true only when the down payment is verified, a balance is left, and the
 *   parent has NOT already submitted the remaining payment (that one is sitting in the
 *   admin verification queue instead — see `underReview`).
 */
function computeRemainingBalance(enrollment, payments) {
  if (!enrollment || EXCLUDED_ENROLLMENT_STATUSES.includes(enrollment.status)) {
    return { remaining: 0, owed: false, underReview: false };
  }
  const list = Array.isArray(payments) ? payments : [];
  const verifiedTotal = list.filter((p) => p.status === 'verified').reduce((sum, p) => sum + amountOf(p), 0);
  const downVerified = list.some((p) => p.status === 'verified' && p.paymentType !== 'remaining');
  const remaining = downVerified ? Math.max(0, Math.round((Number(enrollment.totalFee) || 0) - verifiedTotal)) : 0;
  const underReview = list.some((p) => p.paymentType === 'remaining' && p.status === 'submitted');
  return { remaining, owed: remaining > 0 && !underReview, underReview };
}

/** Every enrollment with an outstanding remaining balance, optionally limited to one parent and one child. */
async function listOutstandingBalances({ parentId, childKey } = {}) {
  const filter = { status: { $nin: EXCLUDED_ENROLLMENT_STATUSES }, totalFee: { $gt: 0 } };
  if (parentId) filter.parent = parentId;
  if (childKey) {
    // One child only: their permanent Student ID (or, for a legacy record, the enrollment _id).
    filter.$or = [{ permanentStudentId: childKey }];
    if (mongoose.Types.ObjectId.isValid(childKey)) filter.$or.push({ _id: childKey });
  }
  const enrollments = await Enrollment.find(filter)
    .populate('parent', 'firstName lastName email')
    .select('enrollmentId parent studentSnapshot totalFee status')
    .lean();
  if (enrollments.length === 0) return [];

  const payments = await Payment.find({ enrollment: { $in: enrollments.map((e) => e._id) } })
    .select('enrollment status paymentType amount amountDue amountPaid')
    .lean();
  const byEnrollment = new Map();
  for (const p of payments) {
    const k = String(p.enrollment);
    if (!byEnrollment.has(k)) byEnrollment.set(k, []);
    byEnrollment.get(k).push(p);
  }

  const out = [];
  for (const e of enrollments) {
    const { remaining, owed } = computeRemainingBalance(e, byEnrollment.get(String(e._id)));
    if (owed) out.push({ enrollment: e, remaining });
  }
  return out;
}

module.exports = { computeRemainingBalance, listOutstandingBalances };
