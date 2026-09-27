/**
 * When the remaining 50% of an enrollment falls due: "after half of the sessions are
 * completed", i.e. on the date of the halfway session of the child's schedule for that
 * program. Until the admin has scheduled at least that many sessions there is no due date
 * yet (null) — which is why a payment reminder must not appear straight after enrolling.
 */
const Schedule = require('../models/Schedule');
const Pricing = require('../models/Pricing');
const { resolveProgramCode } = require('./schedulingPolicy');

/** Session number (1-based) at which the second half of a package becomes payable. */
const halfwaySession = (sessionCount) => Math.ceil(Number(sessionCount) / 2);

/**
 * Pure part, unit-testable: given a package's total sessions and the child's session dates
 * for that program (any order), the due date or null when the schedule doesn't reach halfway.
 */
function dueDateFromSessions(sessionCount, sessionDates) {
  const total = Number(sessionCount);
  if (!Number.isFinite(total) || total <= 0) return null;
  const dates = (sessionDates || [])
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b);
  const idx = halfwaySession(total) - 1;
  return dates[idx] || null;
}

/** Adds `remainingDueDate` (ISO string | null) to each enrollment object (plain/lean). */
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
    if (e.student) {
      const sid = String(e.student);
      const mine = schedules.filter((s) => String(s.student) === sid || (s.students || []).some((x) => String(x) === sid));
      for (const pkg of e.packages || []) {
        const forProgram = mine.filter((s) => !pkg.programCode || resolveProgramCode(s.subject) === String(pkg.programCode).toUpperCase());
        const candidate = dueDateFromSessions(sessionCountFor(pkg), forProgram.map((s) => s.date));
        if (candidate && (!due || candidate > due)) due = candidate;
      }
    }
    return { ...e, remainingDueDate: due ? due.toISOString() : null };
  });
}

module.exports = { attachRemainingDueDates, dueDateFromSessions, halfwaySession };
