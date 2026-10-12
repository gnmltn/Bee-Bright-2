/**
 * Admin scheduling fix — Toddlers Playgroup time-window dropdown proactively disables
 * any window that would double-book a selected child against an EXISTING session (a
 * 1-on-1 Academic Tutorial/Examination Prep session, or a different Playgroup group),
 * instead of only rejecting it after the whole Step 2/3 form is filled out.
 *
 * checkPlaygroupWindows (new) is a read-only preview of the exact same overlap check
 * createOrJoinPlaygroupGroup already enforces at submit time (hasStudentScheduleConflict,
 * via the new findStudentScheduleConflictDetail which adds the conflicting schedule's
 * subject so the UI can say WHICH session is in the way). These tests cover the
 * overlap-vs-exact-match matrix the fix was specifically asked to verify.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Enrollment = require('../models/Enrollment');
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const { checkPlaygroupWindows } = require('../controllers/scheduleController');

function mockQuery(result) {
  const q = {
    select: () => q,
    sort: () => q,
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

// Next Monday from "today" so the test never flakes once the fixed anchor date becomes
// "the past" — matches the same technique test/step7ScheduleStartDate.test.tsx (frontend)
// already uses for the same reason.
function nextDow(dow) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
const MONDAY = 1;
const nextMonday = nextDow(MONDAY);
const nextMondayKey = nextMonday.toISOString().slice(0, 10);

const TIME_WINDOWS = [
  { startTime: '08:00', endTime: '10:00' },
  { startTime: '13:00', endTime: '15:00' },
];

/** Stubs Schedule.find so a conflict row is returned only when the queried date falls on
 * `weekday` — lets a test assert "wrong weekday never conflicts" without hand-generating
 * every real calendar date checkPlaygroupWindows will loop over. */
function stubScheduleConflict({ weekday, startTime, endTime, subjectName = 'Academic Tutorial', studentId = 'student-1' }) {
  Schedule.find = (query) => {
    if (!query || !query.$or) return mockQuery([]);
    // The real query's $or is [{student: id}, {students: id}] for the ONE studentId this
    // particular conflict lookup is for — only match when this stub's own conflicting
    // child is actually the one being queried, so multi-child tests correctly attribute
    // the conflict to the right enrollment instead of every lookup "finding" it.
    const queriedId = query.$or.map((clause) => clause.student ?? clause.students).find(Boolean);
    if (queriedId !== studentId) return mockQuery([]);
    const qWeekday = query.date ? new Date(query.date).getUTCDay() : null;
    if (qWeekday !== weekday) return mockQuery([]);
    return mockQuery([{ startTime, endTime, tutor: 'tutor-x', student: studentId, subject: { name: subjectName, code: 'ACT102' } }]);
  };
}

function stubModels({ enrollments, scheduleFind }) {
  const origEnrollmentFind = Enrollment.find;
  const origScheduleFind = Schedule.find;
  const origUserFind = User.find;
  Enrollment.find = () => mockQuery(enrollments);
  Schedule.find = scheduleFind || (() => mockQuery([]));
  // filterLiveSessions marks every referenced tutor/student id as live (not deleted).
  User.find = (query) => mockQuery((query?._id?.$in || []).map((id) => ({ _id: id })));
  return () => {
    Enrollment.find = origEnrollmentFind;
    Schedule.find = origScheduleFind;
    User.find = origUserFind;
  };
}

function baseReq(overrides = {}) {
  return {
    body: {
      enrollmentIds: ['enr-1'],
      daysOfWeek: [MONDAY],
      startDate: nextMondayKey,
      windows: TIME_WINDOWS,
      ...overrides,
    },
  };
}

const ENROLLMENT = { _id: 'enr-1', student: 'student-1' };

test('exact-match: an existing session at the SAME time as a candidate window is flagged, not just caught at submit time', async () => {
  const restore = stubModels({ enrollments: [ENROLLMENT] });
  stubScheduleConflict({ weekday: MONDAY, startTime: '08:00', endTime: '10:00' });
  try {
    const res = mockRes();
    await checkPlaygroupWindows(baseReq(), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const [morning, afternoon] = res._body.windows;
    assert.equal(morning.ok, false, 'the exact-match 8-10 AM window must be flagged');
    assert.equal(morning.conflicts.length, 1);
    assert.equal(morning.conflicts[0].subjectLabel, 'Academic Tutorial');
    assert.equal(afternoon.ok, true, 'the unrelated 1-3 PM window must stay open');
  } finally { restore(); }
});

test('overlapping but NOT identical: existing Academic Tutorial 8-9 AM blocks a Playgroup 8-10 AM window (item 4)', async () => {
  const restore = stubModels({ enrollments: [ENROLLMENT] });
  stubScheduleConflict({ weekday: MONDAY, startTime: '08:00', endTime: '09:00' });
  try {
    const res = mockRes();
    await checkPlaygroupWindows(baseReq({ windows: [{ startTime: '08:00', endTime: '10:00' }] }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.windows[0].ok, false, '8-9 AM overlaps 8-10 AM even though the times are not identical');
  } finally { restore(); }
});

test('genuinely non-overlapping: an existing 8-9 AM session does not block the unrelated 1-3 PM window (no false positive, item 5)', async () => {
  const restore = stubModels({ enrollments: [ENROLLMENT] });
  stubScheduleConflict({ weekday: MONDAY, startTime: '08:00', endTime: '09:00' });
  try {
    const res = mockRes();
    await checkPlaygroupWindows(baseReq({ windows: [{ startTime: '13:00', endTime: '15:00' }] }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.windows[0].ok, true);
    assert.equal(res._body.windows[0].conflicts.length, 0);
  } finally { restore(); }
});

test('back-to-back, not overlapping: an existing session ending exactly at 08:00 does not conflict with a window starting at 08:00 (item 6)', async () => {
  const restore = stubModels({ enrollments: [ENROLLMENT] });
  stubScheduleConflict({ weekday: MONDAY, startTime: '06:00', endTime: '08:00' });
  try {
    const res = mockRes();
    await checkPlaygroupWindows(baseReq({ windows: [{ startTime: '08:00', endTime: '10:00' }] }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.windows[0].ok, true, 'touching, not overlapping — must NOT be flagged as a conflict');
  } finally { restore(); }
});

test('the conflicting session is only checked on the days it actually falls on — a Tuesday-only query ignores a Monday-only conflict', async () => {
  const restore = stubModels({ enrollments: [ENROLLMENT] });
  stubScheduleConflict({ weekday: MONDAY, startTime: '08:00', endTime: '10:00' });
  try {
    const res = mockRes();
    const TUESDAY = 2;
    await checkPlaygroupWindows(baseReq({ daysOfWeek: [TUESDAY] }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.ok(res._body.windows.every((w) => w.ok), 'a Monday-only conflict must not block a Tuesday-only request');
  } finally { restore(); }
});

test('a child not yet linked to a student account is skipped (no crash, no fabricated conflict, no account created)', async () => {
  const restore = stubModels({ enrollments: [{ _id: 'enr-2', student: null }] });
  stubScheduleConflict({ weekday: MONDAY, startTime: '08:00', endTime: '10:00' });
  try {
    const res = mockRes();
    await checkPlaygroupWindows(baseReq({ enrollmentIds: ['enr-2'] }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.ok(res._body.windows.every((w) => w.ok));
  } finally { restore(); }
});

test('multiple selected children: reports the conflict against whichever one actually has it', async () => {
  const restore = stubModels({
    enrollments: [
      { _id: 'enr-1', student: 'student-1' },
      { _id: 'enr-2', student: 'student-2' },
    ],
  });
  stubScheduleConflict({ weekday: MONDAY, startTime: '08:00', endTime: '10:00', studentId: 'student-2' });
  try {
    const res = mockRes();
    await checkPlaygroupWindows(baseReq({ enrollmentIds: ['enr-1', 'enr-2'], windows: [{ startTime: '08:00', endTime: '10:00' }] }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.windows[0].ok, false);
    assert.equal(res._body.windows[0].conflicts[0].enrollmentId, 'enr-2');
  } finally { restore(); }
});

test('validation: missing enrollmentIds/daysOfWeek/windows is rejected with 400, not a crash', async () => {
  const restore = stubModels({ enrollments: [ENROLLMENT] });
  try {
    const res = mockRes();
    await checkPlaygroupWindows({ body: { enrollmentIds: [], daysOfWeek: [MONDAY], windows: TIME_WINDOWS } }, res);
    assert.equal(res._status, 400);
  } finally { restore(); }
});
