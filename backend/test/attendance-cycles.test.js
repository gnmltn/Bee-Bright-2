/**
 * Tutor "Attendance by student" follow-up — a renewed/re-enrolled program (same
 * permanent student id, same program) must not blend the old finished cycle with the
 * new one into one row. Schedule has no `enrollment` reference (confirmed — none of its
 * 4 creation call sites always has one available), so the cycle is resolved at READ
 * time from the student's real Enrollment history instead. See
 * utils/attendanceCycles.js for why a schema change was deliberately avoided.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Enrollment = require('../models/Enrollment');
const { resolveCycleId, attachCycleByStudent } = require('../utils/attendanceCycles');
const { getMySessions } = require('../controllers/scheduleController');
const Schedule = require('../models/Schedule');
const Pricing = require('../models/Pricing');

/** Generic chainable Mongoose-query stand-in — select/sort/populate all return itself,
 *  lean() resolves the given result, regardless of call order or count. Needed because
 *  getMySessions now runs TWO independent Enrollment/Schedule queries in sequence
 *  (attachCycleByStudent, then attachProgramDateRangeToCycles — see remainingDueDate.js),
 *  each with its own select/populate shape. */
function chainable(result) {
  const q = { select: () => q, sort: () => q, populate: () => q, lean: () => Promise.resolve(result) };
  return q;
}

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

// ── resolveCycleId (pure) ────────────────────────────────────────────────────

test('resolveCycleId: picks the LATEST enrollment whose date is on or before the session date', () => {
  const cycles = [
    { id: 'BB-OLD', enrollmentDate: '2026-01-01' },
    { id: 'BB-NEW', enrollmentDate: '2026-06-01' },
  ];
  assert.equal(resolveCycleId(cycles, '2026-03-15'), 'BB-OLD', 'a session before the renewal belongs to the old cycle');
  assert.equal(resolveCycleId(cycles, '2026-07-01'), 'BB-NEW', 'a session after the renewal belongs to the new cycle');
});

test('resolveCycleId: a session exactly ON the renewal date belongs to the NEW cycle', () => {
  const cycles = [
    { id: 'BB-OLD', enrollmentDate: '2026-01-01' },
    { id: 'BB-NEW', enrollmentDate: '2026-06-01' },
  ];
  assert.equal(resolveCycleId(cycles, '2026-06-01'), 'BB-NEW');
});

test('resolveCycleId: null when the session predates every enrollment on record', () => {
  assert.equal(resolveCycleId([{ id: 'BB-NEW', enrollmentDate: '2026-06-01' }], '2026-01-01'), null);
});

test('resolveCycleId: null for an empty/missing enrollment list', () => {
  assert.equal(resolveCycleId([], '2026-01-01'), null);
  assert.equal(resolveCycleId(undefined, '2026-01-01'), null);
});

// ── attachCycleByStudent ─────────────────────────────────────────────────────

test('attachCycleByStudent: a renewed 1-on-1 program resolves two separate cycle ids for sessions before vs after the renewal', async () => {
  const origFind = Enrollment.find;
  Enrollment.find = () => ({
    select: () => ({
      sort: () => ({
        lean: async () => [
          { student: 'kid-1', packages: [{ programCode: 'ACT102' }], enrollmentDate: '2026-01-01', enrollmentId: 'BB-OLD' },
          { student: 'kid-1', packages: [{ programCode: 'ACT102' }], enrollmentDate: '2026-06-01', enrollmentId: 'BB-NEW' },
        ],
      }),
    }),
  });
  try {
    const schedules = [
      { _id: 's1', student: 'kid-1', students: [], subject: { code: 'ACT102' }, date: '2026-02-01' },
      { _id: 's2', student: 'kid-1', students: [], subject: { code: 'ACT102' }, date: '2026-07-01' },
    ];
    const [withOld, withNew] = await attachCycleByStudent(schedules);
    assert.equal(withOld.cycleByStudent[0].enrollmentId, 'BB-OLD');
    assert.equal(withNew.cycleByStudent[0].enrollmentId, 'BB-NEW');
  } finally { Enrollment.find = origFind; }
});

test('attachCycleByStudent: a Playgroup session resolves each enrolled child to THEIR OWN cycle independently', async () => {
  const origFind = Enrollment.find;
  Enrollment.find = () => ({
    select: () => ({
      sort: () => ({
        lean: async () => [
          { student: 'child-a', packages: [{ programCode: 'TPG101' }], enrollmentDate: '2026-01-01', enrollmentId: 'BB-A1' },
          { student: 'child-b', packages: [{ programCode: 'TPG101' }], enrollmentDate: '2026-05-01', enrollmentId: 'BB-B1' },
        ],
      }),
    }),
  });
  try {
    const schedules = [
      { _id: 'grp-1', student: null, students: ['child-a', 'child-b'], subject: { code: 'TPG101' }, date: '2026-06-01' },
    ];
    const [withCycles] = await attachCycleByStudent(schedules);
    const byStudent = Object.fromEntries(withCycles.cycleByStudent.map((c) => [c.student, c.enrollmentId]));
    assert.deepEqual(byStudent, { 'child-a': 'BB-A1', 'child-b': 'BB-B1' });
  } finally { Enrollment.find = origFind; }
});

test('attachCycleByStudent: falls back to null (not a crash) when no matching enrollment exists for that program', async () => {
  const origFind = Enrollment.find;
  Enrollment.find = () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) });
  try {
    const schedules = [{ _id: 's1', student: 'kid-1', students: [], subject: { code: 'ACT102' }, date: '2026-02-01' }];
    const [row] = await attachCycleByStudent(schedules);
    assert.equal(row.cycleByStudent[0].enrollmentId, null);
  } finally { Enrollment.find = origFind; }
});

test('attachCycleByStudent: no enrolled students at all -> empty cycleByStudent, no Enrollment query needed', async () => {
  let called = false;
  const origFind = Enrollment.find;
  Enrollment.find = () => { called = true; return { select: () => ({ sort: () => ({ lean: async () => [] }) }) }; };
  try {
    const [row] = await attachCycleByStudent([{ _id: 's1', student: null, students: [], subject: { code: 'ACT102' }, date: '2026-02-01' }]);
    assert.deepEqual(row.cycleByStudent, []);
    assert.equal(called, false);
  } finally { Enrollment.find = origFind; }
});

// ── getMySessions wiring ─────────────────────────────────────────────────────

test('getMySessions: response schedules include cycleByStudent', async () => {
  const origScheduleFind = Schedule.find;
  const origEnrollmentFind = Enrollment.find;
  const origPricingFind = Pricing.find;
  Schedule.find = () => chainable([
    { _id: 's1', student: { _id: 'kid-1' }, students: [], tutor: 'tutor-1', subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-02-01', startTime: '08:00', endTime: '09:00' },
  ]);
  Enrollment.find = () => chainable([
    { student: 'kid-1', packages: [{ programCode: 'ACT102', displayName: 'Academic Tutorial' }], enrollmentDate: '2026-01-01', enrollmentId: 'BB-OLD', status: 'approved' },
  ]);
  Pricing.find = () => chainable([]);
  try {
    const res = mockRes();
    await getMySessions({ user: { id: 'tutor-1', role: 'tutor' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.schedules[0].cycleByStudent[0].enrollmentId, 'BB-OLD');
  } finally { Schedule.find = origScheduleFind; Enrollment.find = origEnrollmentFind; Pricing.find = origPricingFind; }
});

test('getMySessions: cycleByStudent also carries startDate/endDate/status — the SAME computation the parent side uses (Request 3), never a frontend estimate', async () => {
  const origScheduleFind = Schedule.find;
  const origEnrollmentFind = Enrollment.find;
  const origPricingFind = Pricing.find;
  // A fully-scheduled 1-session package: one real schedule row for this program/student,
  // sessionCount 1 -> both startDate and endDate resolve to that one date. Branches on
  // query shape: the tutor-scoped original query (populated student) vs
  // attachProgramDateRangeToCycles' own "every schedule for these students, any tutor"
  // query (plain, unpopulated student ids — the real production shape).
  Schedule.find = (query) => {
    const isTutorScoped = (query?.$or || []).some((c) => 'tutor' in c || 'tutors' in c);
    if (isTutorScoped) {
      return chainable([
        { _id: 's1', student: { _id: 'kid-1' }, students: [], tutor: 'tutor-1', subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-02-01', startTime: '08:00', endTime: '09:00' },
      ]);
    }
    return chainable([
      { student: 'kid-1', students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-02-01' },
    ]);
  };
  Enrollment.find = () => chainable([
    { student: 'kid-1', packages: [{ programCode: 'ACT102', packageSlug: 'basic', displayName: 'Academic Tutorial' }], enrollmentDate: '2026-01-01', enrollmentId: 'BB-OLD', status: 'approved' },
  ]);
  Pricing.find = () => chainable([{ programCode: 'ACT102', packageSlug: 'basic', sessionCount: 1 }]);
  try {
    const res = mockRes();
    await getMySessions({ user: { id: 'tutor-1', role: 'tutor' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const cycle = res._body.schedules[0].cycleByStudent[0];
    assert.equal(cycle.status, 'approved');
    assert.equal(new Date(cycle.startDate).toISOString().slice(0, 10), '2026-02-01');
    assert.equal(new Date(cycle.endDate).toISOString().slice(0, 10), '2026-02-01');
  } finally { Schedule.find = origScheduleFind; Enrollment.find = origEnrollmentFind; Pricing.find = origPricingFind; }
});
