/**
 * Tutor Dashboard "Student summary" and "My Students" — both must show each child's
 * program start/end date range using the EXACT SAME computation (and data source) the
 * parent side already uses (Request 3, backend/utils/remainingDueDate.js's
 * attachRemainingDueDates), never a new estimate, so the dates a parent and a tutor see
 * for the same child's same program can never disagree.
 *
 * - "Student summary" (getMySessions): each session's cycleByStudent entries get
 *   startDate/endDate/status attached via the NEW attachProgramDateRangeToCycles,
 *   resolved to the SAME enrollment "cycle" attachCycleByStudent already matched.
 * - "My Students" (getMyStudentCards): each card's programs[] entries get their own
 *   startDate/endDate/status, computed by running attachRemainingDueDates over the
 *   card-building enrollments it already fetches.
 *
 * Both reuse sortedValidDates/lastSessionDueDate — the exact pure functions
 * invoiceDueDate (and the parent-side endDate) are already computed from.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Schedule = require('../models/Schedule');
const Pricing = require('../models/Pricing');
const Enrollment = require('../models/Enrollment');
const { attachProgramDateRangeToCycles } = require('../utils/remainingDueDate');
const { attachCycleByStudent } = require('../utils/attendanceCycles');
const { getMyStudentCards } = require('../controllers/scheduleController');

const mockQuery = (result) => {
  const q = { select: () => q, sort: () => q, populate: () => q, lean: () => Promise.resolve(result) };
  return q;
};

/** getMyStudentCards' own tutor-scoped Schedule.find (populated student/students, the
 *  REAL .populate() shape) and attachRemainingDueDates' own internal "every schedule for
 *  these students, any tutor" Schedule.find (plain, unpopulated ids — the real
 *  production shape, since it never calls .populate('student')) hit the SAME Schedule
 *  model in one request. Branch on query shape so each gets the shape it actually needs. */
function scheduleFindByQuery(tutorScopedRows, studentScopedRows) {
  return (query) => {
    const isTutorScoped = (query?.$or || []).some((c) => 'tutor' in c || 'tutors' in c);
    return mockQuery(isTutorScoped ? tutorScopedRows : studentScopedRows);
  };
}

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

// ── attachProgramDateRangeToCycles (Student summary) ──────────────────────────────

test('attachProgramDateRangeToCycles: attaches the correct startDate/endDate/status onto an existing cycleByStudent entry', async () => {
  const studentId = new mongoose.Types.ObjectId().toString();
  const origEnrollmentFind = Enrollment.find;
  const origScheduleFind = Schedule.find;
  const origPricingFind = Pricing.find;

  Enrollment.find = () => mockQuery([
    { _id: 'enr-1', student: studentId, enrollmentId: 'BB-1', status: 'approved', enrollmentDate: '2026-01-01', packages: [{ programCode: 'ACT102', packageSlug: 'act-2', displayName: 'Academic Tutorial' }] },
  ]);
  Schedule.find = () => mockQuery([
    { student: studentId, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-05' },
    { student: studentId, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-19' },
  ]);
  Pricing.find = () => mockQuery([{ programCode: 'ACT102', packageSlug: 'act-2', sessionCount: 2 }]);

  try {
    const schedules = [{ subject: { code: 'ACT102' }, cycleByStudent: [{ student: studentId, enrollmentId: 'BB-1' }] }];
    const [result] = await attachProgramDateRangeToCycles(schedules);
    const cycle = result.cycleByStudent[0];
    assert.equal(new Date(cycle.startDate).toISOString().slice(0, 10), '2026-10-05');
    assert.equal(new Date(cycle.endDate).toISOString().slice(0, 10), '2026-10-19');
    assert.equal(cycle.status, 'approved');
  } finally {
    Enrollment.find = origEnrollmentFind;
    Schedule.find = origScheduleFind;
    Pricing.find = origPricingFind;
  }
});

test('attachProgramDateRangeToCycles: the SAME student\'s two different program cycles each get their own independent range', async () => {
  const studentId = new mongoose.Types.ObjectId().toString();
  const origEnrollmentFind = Enrollment.find;
  const origScheduleFind = Schedule.find;
  const origPricingFind = Pricing.find;

  Enrollment.find = () => mockQuery([
    { _id: 'enr-at', student: studentId, enrollmentId: 'BB-AT', status: 'approved', enrollmentDate: '2026-01-01', packages: [{ programCode: 'ACT102', packageSlug: 'act-2', displayName: 'Academic Tutorial' }] },
    { _id: 'enr-tpg', student: studentId, enrollmentId: 'BB-TPG', status: 'active', enrollmentDate: '2026-01-01', packages: [{ programCode: 'TPG101', packageSlug: 'tpg-2', displayName: 'Toddlers Playgroup' }] },
  ]);
  Schedule.find = () => mockQuery([
    { student: studentId, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-17' },
    { student: studentId, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-11-26' },
    { student: studentId, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: '2026-09-01' },
    { student: studentId, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: '2026-10-13' },
  ]);
  Pricing.find = () => mockQuery([
    { programCode: 'ACT102', packageSlug: 'act-2', sessionCount: 2 },
    { programCode: 'TPG101', packageSlug: 'tpg-2', sessionCount: 2 },
  ]);

  try {
    const schedules = [
      { subject: { code: 'ACT102' }, cycleByStudent: [{ student: studentId, enrollmentId: 'BB-AT' }] },
      { subject: { code: 'TPG101' }, cycleByStudent: [{ student: studentId, enrollmentId: 'BB-TPG' }] },
    ];
    const [atRow, tpgRow] = await attachProgramDateRangeToCycles(schedules);
    assert.equal(new Date(atRow.cycleByStudent[0].endDate).toISOString().slice(0, 10), '2026-11-26');
    assert.equal(new Date(tpgRow.cycleByStudent[0].endDate).toISOString().slice(0, 10), '2026-10-13');
  } finally {
    Enrollment.find = origEnrollmentFind;
    Schedule.find = origScheduleFind;
    Pricing.find = origPricingFind;
  }
});

test('attachProgramDateRangeToCycles: still returns the real dates for a COMPLETED program (status carries through so the UI can hide the range, not the backend)', async () => {
  const studentId = new mongoose.Types.ObjectId().toString();
  const origEnrollmentFind = Enrollment.find;
  const origScheduleFind = Schedule.find;
  const origPricingFind = Pricing.find;

  Enrollment.find = () => mockQuery([
    { _id: 'enr-1', student: studentId, enrollmentId: 'BB-1', status: 'completed', enrollmentDate: '2026-01-01', packages: [{ programCode: 'ACT102', packageSlug: 'act-2', displayName: 'Academic Tutorial' }] },
  ]);
  Schedule.find = () => mockQuery([
    { student: studentId, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-05' },
    { student: studentId, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-19' },
  ]);
  Pricing.find = () => mockQuery([{ programCode: 'ACT102', packageSlug: 'act-2', sessionCount: 2 }]);

  try {
    const schedules = [{ subject: { code: 'ACT102' }, cycleByStudent: [{ student: studentId, enrollmentId: 'BB-1' }] }];
    const [result] = await attachProgramDateRangeToCycles(schedules);
    assert.equal(result.cycleByStudent[0].status, 'completed');
    assert.equal(new Date(result.cycleByStudent[0].endDate).toISOString().slice(0, 10), '2026-10-19');
  } finally {
    Enrollment.find = origEnrollmentFind;
    Schedule.find = origScheduleFind;
    Pricing.find = origPricingFind;
  }
});

test('attachProgramDateRangeToCycles: no matching enrollment (enrollmentId null) -> empty range, not a crash', async () => {
  const schedules = [{ subject: { code: 'ACT102' }, cycleByStudent: [{ student: 'kid-1', enrollmentId: null }] }];
  const [result] = await attachProgramDateRangeToCycles(schedules);
  assert.equal(result.cycleByStudent[0].startDate, null);
  assert.equal(result.cycleByStudent[0].endDate, null);
});

// ── getMyStudentCards programs[] (My Students) ─────────────────────────────────────

test('getMyStudentCards: each card\'s program gets the correct startDate/endDate, reusing attachRemainingDueDates', async () => {
  const origScheduleFind = Schedule.find;
  const origEnrollmentFind = Enrollment.find;
  const origPricingFind = Pricing.find;

  // Only one session scheduled so far against a 2-session package — partial, so endDate
  // correctly stays null.
  Schedule.find = scheduleFindByQuery(
    [{ student: { _id: 'student-1', firstName: 'Ana', lastName: 'Cruz' }, students: [], tutor: 'tutor-1', subject: { name: 'Academic Tutorial', code: 'ACT102' }, date: '2026-10-05', startTime: '09:00', endTime: '10:00' }],
    [{ student: 'student-1', students: [], subject: { name: 'Academic Tutorial', code: 'ACT102' }, date: '2026-10-05' }],
  );
  Enrollment.find = () => mockQuery([
    {
      _id: 'enr-1',
      student: 'student-1',
      permanentStudentId: 'BB-20260101-0001',
      enrollmentId: 'BB-20260101-0001',
      status: 'approved',
      enrollmentDate: '2026-01-01',
      packages: [{ programCode: 'ACT102', packageSlug: 'act-2', displayName: 'Academic Tutorial' }],
      parent: { firstName: 'Rosa', lastName: 'Cruz', email: 'rosa@example.test' },
    },
  ]);
  Pricing.find = () => mockQuery([{ programCode: 'ACT102', packageSlug: 'act-2', sessionCount: 2 }]);

  try {
    const res = mockRes();
    await getMyStudentCards({ user: { id: 'tutor-1', role: 'tutor' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const [card] = res._body.students;
    assert.equal(card.programs.length, 1);
    assert.equal(card.programs[0].displayName, 'Academic Tutorial');
    assert.equal(card.programs[0].programCode, 'ACT102');
    assert.equal(card.programs[0].status, 'approved');
    // Only 1 of 2 required sessions is scheduled (this is the tutor's own Schedule.find
    // mock, reused by BOTH the roster fetch and attachRemainingDueDates' own fetch) — so
    // endDate correctly stays null, matching "never a premature guess".
    assert.equal(card.programs[0].endDate, null);
    assert.ok(card.programs[0].startDate);
  } finally {
    Schedule.find = origScheduleFind;
    Enrollment.find = origEnrollmentFind;
    Pricing.find = origPricingFind;
  }
});

test('getMyStudentCards: a child with 2 programs gets 2 separate, independent program ranges on the SAME card', async () => {
  const origScheduleFind = Schedule.find;
  const origEnrollmentFind = Enrollment.find;
  const origPricingFind = Pricing.find;

  Schedule.find = scheduleFindByQuery(
    [
      { student: { _id: 'student-1', firstName: 'Maria', lastName: 'Cruz' }, students: [], tutor: 'tutor-1', subject: { name: 'Academic Tutorial', code: 'ACT102' }, date: '2026-10-17', startTime: '09:00', endTime: '10:00' },
      { student: { _id: 'student-1', firstName: 'Maria', lastName: 'Cruz' }, students: [], tutor: 'tutor-1', subject: { name: 'Academic Tutorial', code: 'ACT102' }, date: '2026-11-26', startTime: '09:00', endTime: '10:00' },
      { student: null, students: [{ _id: 'student-1', firstName: 'Maria', lastName: 'Cruz' }], tutor: 'tutor-1', subject: { name: 'Toddlers Playgroup', code: 'TPG101' }, date: '2026-09-01', startTime: '08:00', endTime: '09:00' },
      { student: null, students: [{ _id: 'student-1', firstName: 'Maria', lastName: 'Cruz' }], tutor: 'tutor-1', subject: { name: 'Toddlers Playgroup', code: 'TPG101' }, date: '2026-10-13', startTime: '08:00', endTime: '09:00' },
    ],
    [
      { student: 'student-1', students: [], subject: { name: 'Academic Tutorial', code: 'ACT102' }, date: '2026-10-17' },
      { student: 'student-1', students: [], subject: { name: 'Academic Tutorial', code: 'ACT102' }, date: '2026-11-26' },
      { student: null, students: ['student-1'], subject: { name: 'Toddlers Playgroup', code: 'TPG101' }, date: '2026-09-01' },
      { student: null, students: ['student-1'], subject: { name: 'Toddlers Playgroup', code: 'TPG101' }, date: '2026-10-13' },
    ],
  );
  Enrollment.find = () => mockQuery([
    {
      _id: 'enr-2',
      student: 'student-1',
      permanentStudentId: 'BB-20260101-0002',
      enrollmentId: 'BB-20260101-0002',
      status: 'approved',
      enrollmentDate: '2026-01-01',
      packages: [
        { programCode: 'ACT102', packageSlug: 'act-2', displayName: 'Academic Tutorial' },
        { programCode: 'TPG101', packageSlug: 'tpg-2', displayName: 'Toddlers Playgroup' },
      ],
      parent: { firstName: 'Rosa', lastName: 'Cruz', email: 'rosa@example.test' },
    },
  ]);
  Pricing.find = () => mockQuery([
    { programCode: 'ACT102', packageSlug: 'act-2', sessionCount: 2 },
    { programCode: 'TPG101', packageSlug: 'tpg-2', sessionCount: 2 },
  ]);

  try {
    const res = mockRes();
    await getMyStudentCards({ user: { id: 'tutor-1', role: 'tutor' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const [card] = res._body.students;
    assert.equal(card.programs.length, 2);
    const act = card.programs.find((p) => p.programCode === 'ACT102');
    const tpg = card.programs.find((p) => p.programCode === 'TPG101');
    assert.equal(new Date(act.endDate).toISOString().slice(0, 10), '2026-11-26');
    assert.equal(new Date(tpg.endDate).toISOString().slice(0, 10), '2026-10-13');
  } finally {
    Schedule.find = origScheduleFind;
    Enrollment.find = origEnrollmentFind;
    Pricing.find = origPricingFind;
  }
});

test('getMyStudentCards: when one of 2 programs is completed, its range is distinguishable by status while the card (and the still-active program) stays', async () => {
  const origScheduleFind = Schedule.find;
  const origEnrollmentFind = Enrollment.find;
  const origPricingFind = Pricing.find;

  Schedule.find = scheduleFindByQuery(
    [
      { student: { _id: 'student-1', firstName: 'Maria', lastName: 'Cruz' }, students: [], tutor: 'tutor-1', subject: { name: 'Academic Tutorial', code: 'ACT102' }, date: '2026-10-17', startTime: '09:00', endTime: '10:00' },
      { student: null, students: [{ _id: 'student-1', firstName: 'Maria', lastName: 'Cruz' }], tutor: 'tutor-1', subject: { name: 'Toddlers Playgroup', code: 'TPG101' }, date: '2026-09-01', startTime: '08:00', endTime: '09:00' },
      { student: null, students: [{ _id: 'student-1', firstName: 'Maria', lastName: 'Cruz' }], tutor: 'tutor-1', subject: { name: 'Toddlers Playgroup', code: 'TPG101' }, date: '2026-10-13', startTime: '08:00', endTime: '09:00' },
    ],
    [
      { student: 'student-1', students: [], subject: { name: 'Academic Tutorial', code: 'ACT102' }, date: '2026-10-17' },
      { student: null, students: ['student-1'], subject: { name: 'Toddlers Playgroup', code: 'TPG101' }, date: '2026-09-01' },
      { student: null, students: ['student-1'], subject: { name: 'Toddlers Playgroup', code: 'TPG101' }, date: '2026-10-13' },
    ],
  );
  Enrollment.find = () => mockQuery([
    // Toddlers Playgroup cycle already completed.
    {
      _id: 'enr-tpg', student: 'student-1', enrollmentId: 'BB-TPG', status: 'completed', enrollmentDate: '2026-01-01',
      packages: [{ programCode: 'TPG101', packageSlug: 'tpg-2', displayName: 'Toddlers Playgroup' }],
      parent: { firstName: 'Rosa', lastName: 'Cruz', email: 'rosa@example.test' },
    },
    // Academic Tutorial still active/in progress.
    {
      _id: 'enr-at', student: 'student-1', enrollmentId: 'BB-AT', status: 'approved', enrollmentDate: '2026-01-01',
      packages: [{ programCode: 'ACT102', packageSlug: 'act-2', displayName: 'Academic Tutorial' }],
      parent: { firstName: 'Rosa', lastName: 'Cruz', email: 'rosa@example.test' },
    },
  ]);
  Pricing.find = () => mockQuery([
    { programCode: 'ACT102', packageSlug: 'act-2', sessionCount: 2 },
    { programCode: 'TPG101', packageSlug: 'tpg-2', sessionCount: 2 },
  ]);

  try {
    const res = mockRes();
    await getMyStudentCards({ user: { id: 'tutor-1', role: 'tutor' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const [card] = res._body.students;
    // The card stays, with BOTH programs still listed.
    assert.equal(card.programs.length, 2);
    const act = card.programs.find((p) => p.programCode === 'ACT102');
    const tpg = card.programs.find((p) => p.programCode === 'TPG101');
    assert.equal(act.status, 'approved');
    assert.equal(tpg.status, 'completed', 'the completed program\'s status is correctly distinguishable, so the UI (formatProgramLabelWithRange) hides only ITS range');
    assert.equal(new Date(tpg.endDate).toISOString().slice(0, 10), '2026-10-13', 'the real date is still returned — hiding it is a display concern, not a data one');
  } finally {
    Schedule.find = origScheduleFind;
    Enrollment.find = origEnrollmentFind;
    Pricing.find = origPricingFind;
  }
});
