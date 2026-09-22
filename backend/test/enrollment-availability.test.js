/**
 * Schedule pref availability - implementation.pdf — Step 7's live tutor-capacity
 * endpoint. Public, reuses scheduleController.canTutorHandleSchedule as the
 * per-tutor-per-slot primitive.
 *
 * 2026-09-22 fix: the tutor pool (M) is EVERY active tutor, not filtered by
 * subjectsTaught — tutors are never individually scoped to a program in
 * practice (account creation only sets employmentType; nothing populates
 * subjectsTaught), so that filter made M always 0 in the real dev DB. The
 * programCode param is still used, but only to resolve slot *structure*
 * (hourly for ACT102/EXP106 vs TPG101's 2 fixed 2-hour blocks) — never to
 * filter which tutors count.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// ── Patch the module seam BEFORE requiring enrollmentController, since it
// destructures canTutorHandleSchedule at require-time (CommonJS bindings don't
// re-resolve after the fact). ────────────────────────────────────────────────
const scheduleController = require('../controllers/scheduleController');
let handleScheduleCheck = async () => ({ ok: true });
scheduleController.canTutorHandleSchedule = (...args) => handleScheduleCheck(...args);

const User = require('../models/User');
const { getEnrollmentAvailability } = require('../controllers/enrollmentController');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

function mockQuery(result) {
  return { select: () => ({ lean: async () => result }) };
}

function stubTutors(tutors) {
  const origUserFind = User.find;
  User.find = () => mockQuery(tutors);
  return () => { User.find = origUserFind; };
}

test('getEnrollmentAvailability: ACT102 returns 8 hourly slots with correct 12-hour labels', async () => {
  const tutors = [{ _id: 't1' }, { _id: 't2' }];
  handleScheduleCheck = async () => ({ ok: true }); // everyone free
  const restore = stubTutors(tutors);
  try {
    const res = mockRes();
    await getEnrollmentAvailability({ query: { date: '2026-10-05', programCode: 'ACT102' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const keys = Object.keys(res._body.slots);
    assert.deepEqual(keys, [
      '08:00-09:00', '09:00-10:00', '10:00-11:00', '11:00-12:00',
      '13:00-14:00', '14:00-15:00', '15:00-16:00', '16:00-17:00',
    ]);
    assert.equal(res._body.slots['08:00-09:00'].label, '8AM-9AM');
    assert.equal(res._body.slots['13:00-14:00'].label, '1PM-2PM');
    assert.equal(res._body.slots['16:00-17:00'].label, '4PM-5PM');
    // No slot for the 12:00-13:00 lunch block anywhere in the keys.
    assert.ok(!keys.some((k) => k.startsWith('12:00')));
    assert.equal(res._body.slots['08:00-09:00'].available, 2);
    assert.equal(res._body.slots['08:00-09:00'].total, 2);
  } finally { restore(); }
});

test('getEnrollmentAvailability: TPG101 returns exactly the 2 fixed 2-hour blocks, not hourly', async () => {
  const tutors = [{ _id: 't1' }];
  handleScheduleCheck = async () => ({ ok: true });
  const restore = stubTutors(tutors);
  try {
    const res = mockRes();
    await getEnrollmentAvailability({ query: { date: '2026-10-05', programCode: 'TPG101' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.deepEqual(Object.keys(res._body.slots), ['08:00-10:00', '13:00-15:00']);
    assert.equal(res._body.slots['08:00-10:00'].label, '8AM-10AM');
    assert.equal(res._body.slots['13:00-15:00'].label, '1PM-3PM');
  } finally { restore(); }
});

test('getEnrollmentAvailability: partial availability reports the correct N of M', async () => {
  const tutors = [{ _id: 't1' }, { _id: 't2' }, { _id: 't3' }];
  // t1 free, t2 and t3 busy, regardless of slot — enough to exercise the counting logic.
  handleScheduleCheck = async ({ tutorId }) => ({ ok: tutorId === 't1' });
  const restore = stubTutors(tutors);
  try {
    const res = mockRes();
    await getEnrollmentAvailability({ query: { date: '2026-10-05', programCode: 'ACT102' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.slots['08:00-09:00'].available, 1);
    assert.equal(res._body.slots['08:00-09:00'].total, 3);
  } finally { restore(); }
});

test('getEnrollmentAvailability: fully booked slot reports available=0', async () => {
  const tutors = [{ _id: 't1' }, { _id: 't2' }];
  handleScheduleCheck = async () => ({ ok: false });
  const restore = stubTutors(tutors);
  try {
    const res = mockRes();
    await getEnrollmentAvailability({ query: { date: '2026-10-05', programCode: 'ACT102' } }, res);
    assert.equal(res._body.slots['08:00-09:00'].available, 0);
    assert.equal(res._body.slots['08:00-09:00'].total, 2);
  } finally { restore(); }
});

test('getEnrollmentAvailability: rejects a request missing date or programCode', async () => {
  const res1 = mockRes();
  await getEnrollmentAvailability({ query: { programCode: 'ACT102' } }, res1);
  assert.equal(res1._status, 400);

  const res2 = mockRes();
  await getEnrollmentAvailability({ query: { date: '2026-10-05' } }, res2);
  assert.equal(res2._status, 400);
});

test('getEnrollmentAvailability: rejects an unknown programCode', async () => {
  const res = mockRes();
  await getEnrollmentAvailability({ query: { date: '2026-10-05', programCode: 'NOPE999' } }, res);
  assert.equal(res._status, 400);
});

test('getEnrollmentAvailability: M is every active tutor regardless of programCode — a tutor with an empty/irrelevant subjectsTaught still counts', async () => {
  const tutors = [
    { _id: 't1', subjectsTaught: [] },                 // never populated in practice
    { _id: 't2', subjectsTaught: ['subj-tpg101-only'] }, // "wrong" program, if that concept existed
  ];
  handleScheduleCheck = async () => ({ ok: true });
  const restore = stubTutors(tutors);
  try {
    const res = mockRes();
    await getEnrollmentAvailability({ query: { date: '2026-10-05', programCode: 'ACT102' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    // Both tutors count toward total, and both are free -> available === total.
    assert.equal(res._body.slots['08:00-09:00'].total, 2);
    assert.equal(res._body.slots['08:00-09:00'].available, 2);
  } finally { restore(); }
});
