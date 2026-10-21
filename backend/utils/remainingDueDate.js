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
const Enrollment = require('../models/Enrollment');
const { resolveProgramCode } = require('./schedulingPolicy');
const { resolveCycleId } = require('./attendanceCycles');

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

  // A student can have more than one ENROLLMENT CYCLE of the same program over time (a
  // Renew/Add Program). Schedule rows carry no enrollment reference, so which cycle a
  // given schedule date belongs to is resolved the SAME way attachCycleByStudent already
  // does for the tutor-facing attendance views (backend/utils/attendanceCycles.js) —
  // reused via resolveCycleId, not re-derived — so a brand-new renewal's package can
  // never pick up an older, already-finished cycle's session dates as its own.
  const cycleCandidates = list.filter((e) => e.student && !['rejected', 'cancelled', 'draft'].includes(e.status));
  const byStudentProgram = new Map(); // studentId|CODE -> [{id, enrollmentDate}], ascending
  for (const e of cycleCandidates) {
    const sid = String(e.student);
    for (const pkg of e.packages || []) {
      const code = String(pkg.programCode || '').toUpperCase();
      if (!code) continue;
      const key = `${sid}|${code}`;
      if (!byStudentProgram.has(key)) byStudentProgram.set(key, []);
      byStudentProgram.get(key).push({ id: String(e._id), enrollmentDate: e.enrollmentDate });
    }
  }
  for (const cycles of byStudentProgram.values()) cycles.sort((a, b) => new Date(a.enrollmentDate) - new Date(b.enrollmentDate));

  return list.map((e) => {
    let due = null;
    let invoiceDue = null;
    let packages = e.packages || [];
    if (e.student) {
      const sid = String(e.student);
      const eid = String(e._id);
      const mine = schedules.filter((s) => String(s.student) === sid || (s.students || []).some((x) => String(x) === sid));
      packages = (e.packages || []).map((pkg) => {
        const code = String(pkg.programCode || '').toUpperCase();
        const cycles = byStudentProgram.get(`${sid}|${code}`) || [];
        const forProgram = mine.filter((s) => {
          if (pkg.programCode && resolveProgramCode(s.subject) !== code) return false;
          return resolveCycleId(cycles, s.date) === eid;
        });
        const dates = forProgram.map((s) => s.date);
        const sessionCount = sessionCountFor(pkg);
        const candidate = dueDateFromSessions(sessionCount, dates);
        if (candidate && (!due || candidate > due)) due = candidate;
        const invoiceCandidate = lastSessionDueDate(sessionCount, dates);
        if (invoiceCandidate && (!invoiceDue || invoiceCandidate > invoiceDue)) invoiceDue = invoiceCandidate;

        // Per-package session date range — for the parent-facing "program ends on"
        // display (Request 3). `endDate` mirrors invoiceDueDate's own rule: null until
        // ALL of this package's sessions actually exist in the schedule, so this is
        // never a premature guess — reuses the exact same sortedValidDates/
        // lastSessionDueDate this file already computes `invoiceDueDate` from.
        const sortedDates = sortedValidDates(dates);
        return {
          ...pkg,
          startDate: sortedDates[0] ? sortedDates[0].toISOString() : null,
          endDate: invoiceCandidate ? invoiceCandidate.toISOString() : null,
          sessionsScheduled: sortedDates.length,
          sessionCount: Number.isFinite(Number(sessionCount)) ? Number(sessionCount) : null,
        };
      });
    }
    return {
      ...e,
      packages,
      remainingDueDate: due ? due.toISOString() : null,
      invoiceDueDate: invoiceDue ? invoiceDue.toISOString() : null,
    };
  });
}

/**
 * Adds `startDate`/`endDate`/`status` onto each EXISTING `cycleByStudent` entry a
 * schedule already carries (attached earlier by attachCycleByStudent, which resolves
 * each student to the Enrollment "cycle" that actually owns that session — see
 * backend/utils/attendanceCycles.js). This is the tutor-facing analog of the
 * parent-facing "program ends on" display (Request 3): same `sortedValidDates`/
 * `lastSessionDueDate` pure functions, same "null until the whole package is actually
 * scheduled" rule, and — critically — the date range is computed from ALL of that
 * enrollment's schedule dates for the matching program (every tutor who ever taught it,
 * not just the one requesting this), the exact same scope attachRemainingDueDates
 * already uses. So a parent and any tutor looking at the same child's same program cycle
 * can never see two different dates. Must run AFTER attachCycleByStudent.
 */
async function attachProgramDateRangeToCycles(schedulesWithCycles) {
  const list = Array.isArray(schedulesWithCycles) ? schedulesWithCycles : [];
  const emptyRange = { startDate: null, endDate: null, status: null };

  const enrollmentIds = new Set();
  list.forEach((s) => (s.cycleByStudent || []).forEach((c) => { if (c.enrollmentId) enrollmentIds.add(String(c.enrollmentId)); }));
  if (enrollmentIds.size === 0) {
    return list.map((s) => ({ ...s, cycleByStudent: (s.cycleByStudent || []).map((c) => ({ ...c, ...emptyRange })) }));
  }

  // enrollmentId on cycleByStudent is the human-readable BB-… code, falling back to the
  // Mongo _id for any legacy enrollment missing it (same resolveCycleId rule) — match on
  // both so either form resolves.
  const validObjectIds = [...enrollmentIds].filter((id) => /^[a-f0-9]{24}$/i.test(id));
  const enrollments = await Enrollment.find({
    $or: [{ enrollmentId: { $in: [...enrollmentIds] } }, ...(validObjectIds.length ? [{ _id: { $in: validObjectIds } }] : [])],
  })
    .select('student packages enrollmentId status')
    .lean();
  const enrollmentById = new Map(enrollments.map((e) => [e.enrollmentId || String(e._id), e]));

  const studentIds = [...new Set(enrollments.map((e) => e.student && String(e.student)).filter(Boolean))];

  // Every cycle (enrollment, any status except rejected/cancelled/draft) these students
  // have EVER had for each program — needed to correctly bound each specific cycle's own
  // schedule dates, the exact same way attachCycleByStudent resolves cycles on the
  // schedule side (reused here via resolveCycleId, not re-derived), so a renewed
  // program's range can never pick up an older, already-finished cycle's dates.
  const allCycleEnrollments = studentIds.length
    ? await Enrollment.find({ student: { $in: studentIds }, status: { $nin: ['rejected', 'cancelled', 'draft'] } })
        .select('student packages enrollmentDate')
        .lean()
    : [];
  const byStudentProgram = new Map(); // studentId|CODE -> [{id, enrollmentDate}], ascending
  for (const e of allCycleEnrollments) {
    const sid = String(e.student);
    for (const pkg of e.packages || []) {
      const code = String(pkg.programCode || '').toUpperCase();
      if (!code) continue;
      const key = `${sid}|${code}`;
      if (!byStudentProgram.has(key)) byStudentProgram.set(key, []);
      byStudentProgram.get(key).push({ id: String(e._id), enrollmentDate: e.enrollmentDate });
    }
  }
  for (const cycles of byStudentProgram.values()) cycles.sort((a, b) => new Date(a.enrollmentDate) - new Date(b.enrollmentDate));

  const allSchedules = studentIds.length
    ? await Schedule.find({ $or: [{ student: { $in: studentIds } }, { students: { $in: studentIds } }] })
        .select('student students subject date')
        .populate('subject', 'code name')
        .lean()
    : [];

  const pricing = await Pricing.find({}).select('programCode packageSlug sessionCount').lean();
  const sessionCountFor = (pkg) =>
    pricing.find((p) => p.programCode === pkg.programCode && p.packageSlug === pkg.packageSlug)?.sessionCount ?? null;

  const rangeCache = new Map();
  const computeRange = (enrollmentId, programCode) => {
    const cacheKey = `${enrollmentId}|${programCode}`;
    if (rangeCache.has(cacheKey)) return rangeCache.get(cacheKey);
    const enrollment = enrollmentById.get(enrollmentId);
    const pkg = (enrollment?.packages || []).find((p) => String(p.programCode || '').toUpperCase() === programCode);
    let result = { ...emptyRange, status: enrollment?.status || null };
    if (enrollment && pkg) {
      const sid = String(enrollment.student);
      const eid = String(enrollment._id);
      const cycles = byStudentProgram.get(`${sid}|${programCode}`) || [];
      const dates = allSchedules
        .filter((s) =>
          (String(s.student) === sid || (s.students || []).some((x) => String(x) === sid))
          && resolveProgramCode(s.subject) === programCode
          && resolveCycleId(cycles, s.date) === eid
        )
        .map((s) => s.date);
      const sessionCount = sessionCountFor(pkg);
      const sorted = sortedValidDates(dates);
      const endDate = lastSessionDueDate(sessionCount, dates);
      result = {
        startDate: sorted[0] ? sorted[0].toISOString() : null,
        endDate: endDate ? endDate.toISOString() : null,
        status: enrollment.status || null,
      };
    }
    rangeCache.set(cacheKey, result);
    return result;
  };

  return list.map((s) => {
    const programCode = resolveProgramCode(s.subject);
    const cycleByStudent = (s.cycleByStudent || []).map((c) => ({
      ...c,
      ...(c.enrollmentId ? computeRange(String(c.enrollmentId), programCode) : emptyRange),
    }));
    return { ...s, cycleByStudent };
  });
}

module.exports = { attachRemainingDueDates, attachProgramDateRangeToCycles, dueDateFromSessions, lastSessionDueDate, halfwaySession, sortedValidDates };
