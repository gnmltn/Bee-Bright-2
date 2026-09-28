/**
 * Two independent, schedule-derived dates for an enrollment — both null until the child's
 * actual Schedule records reach the relevant session, deliberately never a fixed day offset:
 *
 * 1. `remainingDueDate` — when the remaining 50% falls due: "after half of the sessions are
 *    completed", i.e. the date of the halfway session. Until the admin has scheduled at
 *    least that many sessions there is no due date yet (null) — a payment reminder must not
 *    appear straight after enrolling. (Payments_RemainingBalanceReminder, "Group 23".)
 * 2. `invoiceDueDate` — the invoice's own Due Date: the date of the LAST (final) scheduled
 *    session of the package/enrollment period, not a fixed "+7 days from issue" offset. Also
 *    null until the full package is scheduled, so it can never show a stale/wrong date early
 *    ("what to do (6).pdf"). This is a genuinely separate trigger point from #1 — a package
 *    is still only half-scheduled long before its due date, and the reminder is deliberately
 *    meant to land earlier than the final bill, so #1's timing is intentionally NOT changed
 *    or reconsidered here.
 */
const Schedule = require('../models/Schedule');
const Pricing = require('../models/Pricing');
const { resolveProgramCode } = require('./schedulingPolicy');

/** Session number (1-based) at which the second half of a package becomes payable. */
const halfwaySession = (sessionCount) => Math.ceil(Number(sessionCount) / 2);

/** Sorted, validated Date objects from a mixed-order list of date-likes. */
function sortedValidDates(sessionDates) {
  return (sessionDates || [])
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b);
}

/**
 * Pure part, unit-testable: given a package's total sessions and the child's session dates
 * for that program (any order), the due date or null when the schedule doesn't reach halfway.
 */
function dueDateFromSessions(sessionCount, sessionDates) {
  const total = Number(sessionCount);
  if (!Number.isFinite(total) || total <= 0) return null;
  const idx = halfwaySession(total) - 1;
  return sortedValidDates(sessionDates)[idx] || null;
}

/**
 * Pure part, unit-testable: the invoice Due Date — the LAST scheduled session's date, or
 * null until all `sessionCount` sessions for this package actually exist in the schedule
 * (a partially-scheduled package has no real "last session" yet to be due against).
 */
function lastSessionDueDate(sessionCount, sessionDates) {
  const total = Number(sessionCount);
  if (!Number.isFinite(total) || total <= 0) return null;
  const dates = sortedValidDates(sessionDates);
  if (dates.length < total) return null;
  return dates[total - 1] || null;
}

/** Adds `remainingDueDate` and `invoiceDueDate` (each ISO string | null) to each enrollment object (plain/lean). */
async function attachRemainingDueDates(enrollments) {
  const list = Array.isArray(enrollments) ? enrollments : [];
  const studentIds = [...new Set(list.map((e) => e.student && String(e.student)).filter(Boolean))];
  const schedules = studentIds.length
    ? await Schedule.find({ $or: [{ student: { $in: studentIds } }, { students: { $in: studentIds } }] })
        .select('student students subject date')
        .populate('subject', 'code name')
        .lean()
    : [];

  const pricing = await Pricing.find({}).select('programCode packageSlug sessionCount').lean();
  const sessionCountFor = (pkg) =>
    pricing.find((p) => p.programCode === pkg.programCode && p.packageSlug === pkg.packageSlug)?.sessionCount ?? null;

  return list.map((e) => {
    let due = null;
    let invoiceDue = null;
    if (e.student) {
      const sid = String(e.student);
      const mine = schedules.filter((s) => String(s.student) === sid || (s.students || []).some((x) => String(x) === sid));
      for (const pkg of e.packages || []) {
        const forProgram = mine.filter((s) => !pkg.programCode || resolveProgramCode(s.subject) === String(pkg.programCode).toUpperCase());
        const dates = forProgram.map((s) => s.date);
        const candidate = dueDateFromSessions(sessionCountFor(pkg), dates);
        if (candidate && (!due || candidate > due)) due = candidate;
        const invoiceCandidate = lastSessionDueDate(sessionCountFor(pkg), dates);
        if (invoiceCandidate && (!invoiceDue || invoiceCandidate > invoiceDue)) invoiceDue = invoiceCandidate;
      }
    }
    return {
      ...e,
      remainingDueDate: due ? due.toISOString() : null,
      invoiceDueDate: invoiceDue ? invoiceDue.toISOString() : null,
    };
  });
}

module.exports = { attachRemainingDueDates, dueDateFromSessions, lastSessionDueDate, halfwaySession };
