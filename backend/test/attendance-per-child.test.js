/**
 * Tutor Attendance feature — 3 fixes:
 *   Group 1: Toddlers Playgroup attendance is marked PER CHILD, not one toggle for the
 *     whole session (Schedule.attendanceByStudent[]). A one-on-one session (no
 *     students[]) is completely unaffected — it still uses the single attendanceStatus
 *     field, exactly as before.
 *   Group 3: marking attendance emits 'schedule:changed' to every tutor assigned to the
 *     session (co-tutors on the same Playgroup group), reusing the existing realtime
 *     infra — covered here only by confirming the call never throws (utils/realtime.js
 *     safely no-ops without a live Socket.io server under `node --test`, same as every
 *     other emit call site in this codebase); genuine cross-socket delivery needs a
 *     live browser and is covered by this session's separate live-verification pass.
 *
 * Group 2 (disabling Present once the 3-day grace period auto-resolves to Absent) is a
 * frontend-only, display-derived concern — see
 * frontend/src/test/attendanceTab.test.tsx.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Schedule = require('../models/Schedule');
const { markAttendance } = require('../controllers/scheduleController');
const { isSessionFullyMarked, attendanceStatusForStudent, effectiveAttendanceStatusForStudent, ATTENDANCE_GRACE_DAYS } = require('../utils/schedulingPolicy');

function mockQuery(result) {
  const q = {
    select: () => q,
    populate: () => q,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

function fakeScheduleDoc(overrides = {}) {
  return {
    _id: 'sched-1',
    tutor: 'tutor-a',
    tutors: [],
    student: null,
    students: [],
    subject: 'subj-1',
    date: new Date(),
    startTime: '08:00',
    endTime: '09:00',
    attendanceStatus: 'unmarked',
    attendanceMarkedAt: null,
    attendanceByStudent: [],
    save: async function () { return this; },
    ...overrides,
  };
}

function stub(doc) {
  const origFindOne = Schedule.findOne;
  const origFindById = Schedule.findById;
  const origUpdateMany = Schedule.updateMany;
  let updateManyCalled = false;
  Schedule.findOne = async () => doc;
  Schedule.findById = () => mockQuery({ ...doc });
  Schedule.updateMany = async () => { updateManyCalled = true; return { modifiedCount: 0 }; };
  return {
    wasUpdateManyCalled: () => updateManyCalled,
    restore() {
      Schedule.findOne = origFindOne;
      Schedule.findById = origFindById;
      Schedule.updateMany = origUpdateMany;
    },
  };
}

function req(body) {
  return { user: { id: 'tutor-a', role: 'tutor' }, params: { id: 'sched-1' }, body };
}

// ── markAttendance: per-child (Group 1) ──────────────────────────────────────

test('markAttendance: per-child marking changes only the given studentId, leaving the rest of the group untouched', async () => {
  const doc = fakeScheduleDoc({
    students: ['child-a', 'child-b', 'child-c'],
    tutors: ['tutor-a'],
    attendanceByStudent: [{ student: 'child-a', status: 'present', markedAt: new Date('2026-01-01') }],
  });
  const h = stub(doc);
  try {
    const res = mockRes();
    await markAttendance(req({ status: 'absent', studentId: 'child-b' }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const byStudent = Object.fromEntries(doc.attendanceByStudent.map((a) => [a.student, a.status]));
    assert.equal(byStudent['child-a'], 'present', 'child-a must stay untouched');
    assert.equal(byStudent['child-b'], 'absent', 'child-b newly marked');
    assert.equal(doc.attendanceByStudent.length, 2, 'child-c has no entry at all — still genuinely unmarked, not force-added');
  } finally { h.restore(); }
});

test('markAttendance: re-marking the SAME child replaces their own entry, not duplicates it', async () => {
  const doc = fakeScheduleDoc({
    students: ['child-a', 'child-b'],
    tutors: ['tutor-a'],
    attendanceByStudent: [{ student: 'child-a', status: 'present', markedAt: new Date('2026-01-01') }],
  });
  const h = stub(doc);
  try {
    await markAttendance(req({ status: 'absent', studentId: 'child-a' }), mockRes());
    const mine = doc.attendanceByStudent.filter((a) => a.student === 'child-a');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, 'absent');
  } finally { h.restore(); }
});

test('markAttendance: 2 Present + 1 Absent is a valid, independently-stored outcome for the same Playgroup session', async () => {
  const doc = fakeScheduleDoc({ students: ['a', 'b', 'c'], tutors: ['tutor-a'] });
  const h = stub(doc);
  try {
    await markAttendance(req({ status: 'present', studentId: 'a' }), mockRes());
    await markAttendance(req({ status: 'present', studentId: 'b' }), mockRes());
    await markAttendance(req({ status: 'absent', studentId: 'c' }), mockRes());
    const byStudent = Object.fromEntries(doc.attendanceByStudent.map((e) => [e.student, e.status]));
    assert.deepEqual(byStudent, { a: 'present', b: 'present', c: 'absent' });
  } finally { h.restore(); }
});

test('markAttendance: rejects a studentId that is not actually enrolled in this session', async () => {
  const doc = fakeScheduleDoc({ students: ['child-a'], tutors: ['tutor-a'] });
  const h = stub(doc);
  try {
    const res = mockRes();
    await markAttendance(req({ status: 'present', studentId: 'not-enrolled' }), res);
    assert.equal(res._status, 400);
  } finally { h.restore(); }
});

test('markAttendance: a group session with NO studentId (the older Schedule-tab/Overview popup) marks every enrolled child with the same status, and keeps the legacy top-level field in sync for that popup\'s own display', async () => {
  const doc = fakeScheduleDoc({ students: ['child-a', 'child-b'], tutors: ['tutor-a'] });
  const h = stub(doc);
  try {
    const res = mockRes();
    await markAttendance(req({ status: 'present' }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(doc.attendanceByStudent.length, 2);
    assert.ok(doc.attendanceByStudent.every((a) => a.status === 'present'));
    assert.equal(doc.attendanceStatus, 'present', 'legacy whole-session field stays in sync for the old popup');
  } finally { h.restore(); }
});

test('markAttendance: one-on-one sessions are completely unaffected — still the single attendanceStatus field, never attendanceByStudent', async () => {
  const doc = fakeScheduleDoc({ student: 'kid-1', students: [] });
  const h = stub(doc);
  try {
    const res = mockRes();
    await markAttendance(req({ status: 'present' }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(doc.attendanceStatus, 'present');
    assert.equal(doc.attendanceByStudent.length, 0);
  } finally { h.restore(); }
});

test('markAttendance: marking a group session Present today does NOT run the one-on-one "auto-mark past sessions present" side effect (no singular student to safely match on)', async () => {
  const doc = fakeScheduleDoc({ students: ['child-a'], tutors: ['tutor-a'] });
  const h = stub(doc);
  try {
    await markAttendance(req({ status: 'present', studentId: 'child-a' }), mockRes());
    assert.equal(h.wasUpdateManyCalled(), false, 'this bulk query matches on `student` (null for group rows) and must never run for a group session');
  } finally { h.restore(); }
});

test('markAttendance: never throws when the session has co-tutors (Group 3 realtime emit path)', async () => {
  const doc = fakeScheduleDoc({ students: ['child-a', 'child-b'], tutors: ['tutor-a', 'tutor-b'] });
  const h = stub(doc);
  try {
    const res = mockRes();
    await markAttendance(req({ status: 'present', studentId: 'child-a' }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
  } finally { h.restore(); }
});

// Real bug found while wiring the parent-side Progress tab's attendance calendar: the
// realtime push on a mark only ever passed tutorIds to emitScheduleChanged, never
// studentIds — so emitScheduleChanged's own emitToParents branch (see its definition,
// scheduleController.js ~line 56) never fired, and a parent with the Progress tab open
// never actually got a live update when a tutor marked attendance, despite that tab
// listening for the exact same 'schedule:changed' event every other live feature here
// does. Fixed by also resolving student(s) off the schedule, the same way
// emitScheduleChangedForSchedule already does for schedule creation. Genuine
// cross-socket delivery (that emitToParents reaches a real connected parent) needs a
// live Socket.io server and is out of reach for this test harness — same acknowledged
// limitation as the co-tutors test above; this just confirms the fix doesn't throw for
// BOTH a one-on-one session (singular `student`) and a group session (`students[]`),
// the two shapes the new studentIds computation has to handle.
test('markAttendance: never throws for a one-on-one session with a real student (parent-notification studentIds computation)', async () => {
  const doc = fakeScheduleDoc({ student: 'kid-1', students: [] });
  const h = stub(doc);
  try {
    const res = mockRes();
    await markAttendance(req({ status: 'present' }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
  } finally { h.restore(); }
});

// ── isSessionFullyMarked / attendanceStatusForStudent (schedulingPolicy.js) ──

test('isSessionFullyMarked: one-on-one is fully marked once attendanceStatus is present or absent', () => {
  assert.equal(isSessionFullyMarked({ students: [], attendanceStatus: 'unmarked' }), false);
  assert.equal(isSessionFullyMarked({ students: [], attendanceStatus: 'present' }), true);
  assert.equal(isSessionFullyMarked({ students: [], attendanceStatus: 'absent' }), true);
});

test('isSessionFullyMarked: a group session requires EVERY enrolled child to have an attendanceByStudent entry', () => {
  const schedule = { students: ['a', 'b'], attendanceByStudent: [{ student: 'a', status: 'present' }] };
  assert.equal(isSessionFullyMarked(schedule), false, 'child b has no entry yet');
  schedule.attendanceByStudent.push({ student: 'b', status: 'absent' });
  assert.equal(isSessionFullyMarked(schedule), true);
});

test('attendanceStatusForStudent: resolves the right child\'s own status on a group session; unmarked for one with no entry yet', () => {
  const schedule = { students: ['a', 'b'], attendanceByStudent: [{ student: 'a', status: 'absent' }] };
  assert.equal(attendanceStatusForStudent(schedule, 'a'), 'absent');
  assert.equal(attendanceStatusForStudent(schedule, 'b'), 'unmarked');
});

test('attendanceStatusForStudent: falls back to the whole-session field for a one-on-one session', () => {
  assert.equal(attendanceStatusForStudent({ students: [], attendanceStatus: 'present' }, 'anyone'), 'present');
  assert.equal(attendanceStatusForStudent({ students: [], attendanceStatus: 'unmarked' }, 'anyone'), 'unmarked');
});

// ── effectiveAttendanceStatusForStudent: the 3-day-grace auto-absent rule, backend side ──
// Mirrors frontend/src/lib/attendanceGrace.ts's resolveAttendanceStatus exactly, so a
// backend-computed attendance SUMMARY (the tutor/parent chatbot's attendance replies)
// can never disagree with what the tutor's own Attendance tab already shows.

function daysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

test('effectiveAttendanceStatusForStudent: a session still within the grace window stays unmarked', () => {
  const schedule = { students: [], attendanceStatus: 'unmarked', date: daysAgo(ATTENDANCE_GRACE_DAYS) };
  assert.equal(effectiveAttendanceStatusForStudent(schedule, 'anyone', new Date()), 'unmarked');
});

test('effectiveAttendanceStatusForStudent: a session older than the grace window with nothing marked auto-resolves to absent', () => {
  const schedule = { students: [], attendanceStatus: 'unmarked', date: daysAgo(ATTENDANCE_GRACE_DAYS + 1) };
  assert.equal(effectiveAttendanceStatusForStudent(schedule, 'anyone', new Date()), 'absent');
});

test('effectiveAttendanceStatusForStudent: an 8-day-old unmarked session (the exact reported case) resolves to absent', () => {
  const schedule = { students: [], attendanceStatus: 'unmarked', date: daysAgo(8) };
  assert.equal(effectiveAttendanceStatusForStudent(schedule, 'anyone', new Date()), 'absent');
});

test('effectiveAttendanceStatusForStudent: a future/today unmarked session is never auto-resolved', () => {
  const schedule = { students: [], attendanceStatus: 'unmarked', date: new Date() };
  assert.equal(effectiveAttendanceStatusForStudent(schedule, 'anyone', new Date()), 'unmarked');
});

test('effectiveAttendanceStatusForStudent: a session already marked present/absent keeps its real status, never overridden regardless of age', () => {
  const oldDate = daysAgo(90);
  assert.equal(effectiveAttendanceStatusForStudent({ students: [], attendanceStatus: 'present', date: oldDate }, 'anyone', new Date()), 'present');
  assert.equal(effectiveAttendanceStatusForStudent({ students: [], attendanceStatus: 'absent', date: oldDate }, 'anyone', new Date()), 'absent');
});

test('effectiveAttendanceStatusForStudent: resolves the right child on a group session, including auto-absent for an overdue unmarked child', () => {
  const schedule = {
    students: ['a', 'b'],
    date: daysAgo(10),
    attendanceByStudent: [{ student: 'a', status: 'present' }],
  };
  assert.equal(effectiveAttendanceStatusForStudent(schedule, 'a', new Date()), 'present');
  assert.equal(effectiveAttendanceStatusForStudent(schedule, 'b', new Date()), 'absent');
});
