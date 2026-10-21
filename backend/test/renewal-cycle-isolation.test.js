/**
 * Bug report: a Renew/Add Program invoice already showed a real due date right after
 * admin approved payment, even though the NEW/renewed program had never actually been
 * scheduled (confirmed: the child also didn't appear in the Scheduling Tab). Per the Due
 * Date logic (Request: remainingDueDate.js), a package's due date must come from its OWN
 * actual last scheduled session and read "Pending — awaiting full session schedule"
 * (i.e. null) until a full schedule exists for THAT program.
 *
 * Root cause: attachRemainingDueDates matched a package's session dates by
 * (student, programCode) ALONE. A Renew/Add Program enrollment links to the student's
 * REAL, already-existing User id immediately on creation (unlike a brand-new enrollment,
 * whose `student` stays null until first scheduled) — so for a RETURNING child renewing
 * a program they'd already completed before, the renewal's package wrongly picked up the
 * OLD, already-finished cycle's session dates as if they were its own, producing a real
 * due date before anything had actually been scheduled for the new cycle.
 *
 * Fix: attachRemainingDueDates now resolves which enrollment CYCLE each schedule date
 * actually belongs to (resolveCycleId, reused from backend/utils/attendanceCycles.js —
 * the same mechanism already used for the tutor-facing attendance views), and only
 * counts a date toward a package's due date when it resolves to THAT SAME enrollment.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Schedule = require('../models/Schedule');
const Pricing = require('../models/Pricing');
const { attachRemainingDueDates } = require('../utils/remainingDueDate');

const mockQuery = (result) => {
  const q = { select: () => q, sort: () => q, populate: () => q, lean: () => Promise.resolve(result) };
  return q;
};

test('a brand-new Renew/Add Program cycle shows Pending (null due date) even though an OLDER, already-finished cycle of the SAME program has real schedule rows on file', async () => {
  const studentId = new mongoose.Types.ObjectId().toString();
  const subjectId = new mongoose.Types.ObjectId().toString();
  const oldEnrollmentId = new mongoose.Types.ObjectId().toString();
  const newEnrollmentId = new mongoose.Types.ObjectId().toString();

  // The OLD, already-completed cycle: fully scheduled months ago.
  const oldDates = ['2026-01-05', '2026-01-07', '2026-01-09', '2026-01-12'];
  const scheduleDocs = oldDates.map((date) => ({ student: studentId, students: [], subject: { _id: subjectId, code: 'ACT102' }, date }));

  const origScheduleFind = Schedule.find;
  const origPricingFind = Pricing.find;
  Schedule.find = () => mockQuery(scheduleDocs);
  Pricing.find = () => mockQuery([{ programCode: 'ACT102', packageSlug: 'pkg-4', sessionCount: 4 }]);

  try {
    const enrollments = [
      { _id: oldEnrollmentId, student: studentId, status: 'completed', enrollmentDate: '2026-01-01', packages: [{ programCode: 'ACT102', packageSlug: 'pkg-4', displayName: 'Academic Tutorial' }] },
      // The renewal — admin just approved payment, nothing has been scheduled for it yet.
      { _id: newEnrollmentId, student: studentId, status: 'approved', enrollmentDate: '2026-10-01', renewalOf: oldEnrollmentId, packages: [{ programCode: 'ACT102', packageSlug: 'pkg-4', displayName: 'Academic Tutorial' }] },
    ];
    const [oldResult, newResult] = await attachRemainingDueDates(enrollments);

    // The OLD cycle still correctly resolves its OWN (finished) dates — unaffected.
    assert.equal(new Date(oldResult.packages[0].endDate).toISOString().slice(0, 10), '2026-01-12');
    assert.equal(new Date(oldResult.invoiceDueDate).toISOString().slice(0, 10), '2026-01-12');

    // The renewal must NOT inherit the old cycle's dates — Pending, not a real date.
    assert.equal(newResult.invoiceDueDate, null, 'the renewal invoice must show Pending, not the old cycle\'s due date');
    assert.equal(newResult.remainingDueDate, null);
    assert.equal(newResult.packages[0].startDate, null);
    assert.equal(newResult.packages[0].endDate, null);
    assert.equal(newResult.packages[0].sessionsScheduled, 0);
  } finally {
    Schedule.find = origScheduleFind;
    Pricing.find = origPricingFind;
  }
});

test('once the renewed cycle actually gets its own schedule, its dates resolve from ITS OWN sessions only — never blended with the old cycle\'s', async () => {
  const studentId = new mongoose.Types.ObjectId().toString();
  const subjectId = new mongoose.Types.ObjectId().toString();
  const oldEnrollmentId = new mongoose.Types.ObjectId().toString();
  const newEnrollmentId = new mongoose.Types.ObjectId().toString();

  const scheduleDocs = [
    // OLD cycle's sessions (before the renewal's own enrollmentDate).
    { student: studentId, students: [], subject: { _id: subjectId, code: 'ACT102' }, date: '2026-01-05' },
    { student: studentId, students: [], subject: { _id: subjectId, code: 'ACT102' }, date: '2026-01-07' },
    // NEW cycle's own sessions (on/after the renewal's enrollmentDate).
    { student: studentId, students: [], subject: { _id: subjectId, code: 'ACT102' }, date: '2026-10-05' },
    { student: studentId, students: [], subject: { _id: subjectId, code: 'ACT102' }, date: '2026-10-19' },
  ];

  const origScheduleFind = Schedule.find;
  const origPricingFind = Pricing.find;
  Schedule.find = () => mockQuery(scheduleDocs);
  Pricing.find = () => mockQuery([{ programCode: 'ACT102', packageSlug: 'pkg-2', sessionCount: 2 }]);

  try {
    const enrollments = [
      { _id: oldEnrollmentId, student: studentId, status: 'completed', enrollmentDate: '2026-01-01', packages: [{ programCode: 'ACT102', packageSlug: 'pkg-2', displayName: 'Academic Tutorial' }] },
      { _id: newEnrollmentId, student: studentId, status: 'approved', enrollmentDate: '2026-10-01', renewalOf: oldEnrollmentId, packages: [{ programCode: 'ACT102', packageSlug: 'pkg-2', displayName: 'Academic Tutorial' }] },
    ];
    const [oldResult, newResult] = await attachRemainingDueDates(enrollments);

    assert.equal(new Date(oldResult.packages[0].startDate).toISOString().slice(0, 10), '2026-01-05');
    assert.equal(new Date(oldResult.packages[0].endDate).toISOString().slice(0, 10), '2026-01-07');
    assert.equal(oldResult.packages[0].sessionsScheduled, 2, 'the old cycle only counts its OWN 2 sessions, not the new cycle\'s');

    assert.equal(new Date(newResult.packages[0].startDate).toISOString().slice(0, 10), '2026-10-05');
    assert.equal(new Date(newResult.packages[0].endDate).toISOString().slice(0, 10), '2026-10-19');
    assert.equal(newResult.packages[0].sessionsScheduled, 2, 'the new cycle only counts its OWN 2 sessions, not the old cycle\'s');
  } finally {
    Schedule.find = origScheduleFind;
    Pricing.find = origPricingFind;
  }
});

test('a single, never-renewed enrollment is completely unaffected by the cycle-awareness fix (the common case)', async () => {
  const studentId = new mongoose.Types.ObjectId().toString();
  const subjectId = new mongoose.Types.ObjectId().toString();
  const enrollmentId = new mongoose.Types.ObjectId().toString();
  const dates = ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12'];
  const scheduleDocs = dates.map((date) => ({ student: studentId, students: [], subject: { _id: subjectId, code: 'TPG101' }, date }));

  const origScheduleFind = Schedule.find;
  const origPricingFind = Pricing.find;
  Schedule.find = () => mockQuery(scheduleDocs);
  Pricing.find = () => mockQuery([{ programCode: 'TPG101', packageSlug: 'pkg-4', sessionCount: 4 }]);

  try {
    const [result] = await attachRemainingDueDates([
      { _id: enrollmentId, student: studentId, status: 'approved', enrollmentDate: '2026-09-01', packages: [{ programCode: 'TPG101', packageSlug: 'pkg-4', displayName: 'Toddlers Playgroup' }] },
    ]);
    assert.equal(new Date(result.packages[0].endDate).toISOString().slice(0, 10), '2026-10-12');
    assert.equal(result.packages[0].sessionsScheduled, 4);
  } finally {
    Schedule.find = origScheduleFind;
    Pricing.find = origPricingFind;
  }
});
