/**
 * Distinguishes separate ENROLLMENT CYCLES of the same program for the same student —
 * e.g. a child finishes Academic Tutorial, then renews/re-enrolls in it months later.
 * `Schedule.student`/`students[]` is the permanent User id and never changes between
 * cycles, so grouping attendance by (student, program) alone would blend an old,
 * finished cycle together with a brand new one into one misleading row.
 *
 * There is no `enrollment` reference on Schedule (checked — none of the 4 places a
 * Schedule gets created always has one available: a Playgroup/group session's
 * `students[]` can mix children from entirely different enrollments on one row, and the
 * generic "create an open enrollable slot" admin flow creates the row before anyone is
 * even enrolled into it). So this resolves the cycle at READ time instead, from the
 * student's real Enrollment history — works uniformly for every row, old or new,
 * without needing a schema change or a backfill migration.
 */
const Enrollment = require('../models/Enrollment');
const { resolveProgramCode } = require('./schedulingPolicy');

/**
 * Pure, unit-testable: given one program's enrollments for one student — each
 * `{ id, enrollmentDate }`, sorted ascending by enrollmentDate — and a session date,
 * returns which enrollment "owns" that date: the latest one whose enrollmentDate is on
 * or before the session date (i.e. the active cycle at that point in time). `null` if
 * the session predates every enrollment on record.
 */
function resolveCycleId(sortedEnrollments, sessionDate) {
  const t = new Date(sessionDate).getTime();
  if (!Number.isFinite(t)) return null;
  let match = null;
  for (const e of sortedEnrollments || []) {
    const et = new Date(e.enrollmentDate).getTime();
    if (!Number.isFinite(et) || et > t) break; // sorted ascending — nothing later can match either
    match = e;
  }
  return match ? match.id : null;
}

/**
 * Adds `cycleByStudent: [{ student, enrollmentId }]` to each schedule (lean object) —
 * one entry per enrolled child (mirrors the existing per-child `attendanceByStudent`
 * shape), so a group session's several children can each resolve to their own cycle.
 * `enrollmentId` is the human-readable BB-… code (falling back to the Mongo _id for any
 * legacy enrollment missing it); `null` when no matching enrollment could be found.
 */
async function attachCycleByStudent(schedules) {
  const list = Array.isArray(schedules) ? schedules : [];

  const studentIds = new Set();
  list.forEach((s) => {
    if (s.student) studentIds.add(String(s.student?._id || s.student));
    (s.students || []).forEach((st) => studentIds.add(String(st?._id || st)));
  });

  if (studentIds.size === 0) return list.map((s) => ({ ...s, cycleByStudent: [] }));

  const enrollments = await Enrollment.find({
    student: { $in: [...studentIds] },
    status: { $nin: ['rejected', 'cancelled', 'draft'] },
  })
    .select('student packages enrollmentDate enrollmentId')
    .sort({ enrollmentDate: 1 })
    .lean();

  // studentId|PROGRAMCODE -> [{ id, enrollmentDate }], already ascending since the
  // query above is sorted and insertion order is preserved per key.
  const byStudentProgram = new Map();
  for (const e of enrollments) {
    if (!e.student) continue;
    const sid = String(e.student);
    for (const pkg of e.packages || []) {
      const code = String(pkg.programCode || '').toUpperCase();
      if (!code) continue;
      const key = `${sid}|${code}`;
      if (!byStudentProgram.has(key)) byStudentProgram.set(key, []);
      byStudentProgram.get(key).push({ id: e.enrollmentId || String(e._id), enrollmentDate: e.enrollmentDate });
    }
  }

  return list.map((s) => {
    const programCode = resolveProgramCode(s.subject);
    const roster = s.students && s.students.length > 0 ? s.students : s.student ? [s.student] : [];
    const cycleByStudent = roster.map((student) => {
      const sid = String(student?._id || student);
      const key = `${sid}|${programCode}`;
      return { student: sid, enrollmentId: resolveCycleId(byStudentProgram.get(key), s.date) };
    });
    return { ...s, cycleByStudent };
  });
}

module.exports = { resolveCycleId, attachCycleByStudent };
