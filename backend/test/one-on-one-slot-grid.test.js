/**
 * Request: the 1-on-1 wizard's Step 3 must show a REAL monthly calendar grid (Sun-Sat
 * columns, weeks as rows, prev/next month navigable) — not just a representative date
 * per weekday. getMonthlySlotGrid (backend/controllers/scheduleController.js) now
 * returns every ACTUAL calendar date within the student's one-month generation window
 * that matches a chosen weekday, each with all 8 standard hourly slots' cross-tutor
 * availability — keyed by date (YYYY-MM-DD), not by day-of-week.
 *
 * For performance (a real month can have dozens of matching dates × 8 slots × several
 * tutors), this is computed as ONE batched pass (getAvailableTutorsGridForWindow) over
 * a single tutor-roster fetch + a single Schedule fetch + a single TutorUnavailability
 * fetch for the whole window, rather than one Mongo round-trip per tutor per slot per
 * date. It reuses the exact same RULES canTutorHandleSchedule/hasStudentScheduleConflict/
 * isOneOnOneHourFull already enforce (parseAvailability window containment, ghost-session
 * filtering via filterLiveSessions, the ONE_ON_ONE_SLOT_CAP) — no new scheduling rule.
 * The cross-validation test below directly compares the batched grid's verdict against
 * canTutorHandleSchedule/hasStudentScheduleConflict for the same inputs, to guard
 * against the two ever silently disagreeing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Subject = require('../models/Subject');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const TutoringArea = require('../models/TutoringArea');
const TutorUnavailability = require('../models/TutorUnavailability');
const Schedule = require('../models/Schedule');
const { getMonthlySlotGrid, checkMonthlySchedule, canTutorHandleSchedule, hasStudentScheduleConflict } = require('../controllers/scheduleController');

const mockQuery = (result) => {
  const q = {
    select: () => q, sort: () => q, populate: () => q,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
};
const mockRes = () => {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
};

const SUBJECT = { _id: 'subj-act102', name: 'Academic Tutorial', code: 'ACT102' };
const ENROLLMENT = {
  _id: 'enr-1', student: 'student-1', status: 'approved', startDate: new Date(),
  packages: [{ programCode: 'ACT102' }], selectedSubjects: [],
};

const TUTOR_A = { _id: 'tutor-a', firstName: 'Nicole', lastName: 'Monzada', employmentType: 'full-time', availability: '' };
const TUTOR_B = { _id: 'tutor-b', firstName: 'Jake', lastName: 'Soriano', employmentType: 'full-time', availability: '' };
const TUTOR_PARTTIME = { _id: 'tutor-c', firstName: 'Liza', lastName: 'Reyes', employmentType: 'part-time', availability: 'Mon 1:00 PM - 3:00 PM' };

/** `scheduleRows` is the FULL list of live Schedule rows for the whole window (the new
 *  batched endpoint fetches them all in one query, then groups by date in-memory). */
function stubGrid({ tutors = [TUTOR_A, TUTOR_B], scheduleRows = [], unavailRows = [] } = {}) {
  const orig = {
    subjectFindById: Subject.findById,
    enrollmentFindOne: Enrollment.findOne,
    userFindOne: User.findOne,
    userFind: User.find,
    areaFindOne: TutoringArea.findOne,
    areaFindById: TutoringArea.findById,
    unavailFind: TutorUnavailability.find,
    unavailExists: TutorUnavailability.exists,
    scheduleFind: Schedule.find,
  };
  Subject.findById = () => mockQuery(SUBJECT);
  Enrollment.findOne = () => mockQuery(ENROLLMENT);
  User.findOne = (query) => {
    // resolveExistingStudentId's own lookup, confirming the enrollment's linked
    // student User still exists.
    if (query?.role === 'student') return mockQuery({ _id: query._id, role: 'student', deletedAt: null });
    return mockQuery(tutors.find((t) => String(t._id) === String(query._id)) || null);
  };
  User.find = (query) => {
    if (query?.role === 'tutor') return mockQuery(tutors);
    // filterLiveSessions' own User.find({_id:{$in:...}}) — everyone involved is live.
    const ids = (query?._id?.$in || []).map(String);
    return mockQuery(ids.map((id) => ({ _id: id })));
  };
  TutoringArea.findOne = () => mockQuery({ _id: 'area-1' });
  TutoringArea.findById = () => mockQuery({ areaType: 'tutoring_area', capacity: 15 });
  TutorUnavailability.find = () => mockQuery(unavailRows);
  TutorUnavailability.exists = async () => false;
  Schedule.find = () => mockQuery(scheduleRows);
  return () => {
    Subject.findById = orig.subjectFindById;
    Enrollment.findOne = orig.enrollmentFindOne;
    User.findOne = orig.userFindOne;
    User.find = orig.userFind;
    TutoringArea.findOne = orig.areaFindOne;
    TutoringArea.findById = orig.areaFindById;
    TutorUnavailability.find = orig.unavailFind;
    TutorUnavailability.exists = orig.unavailExists;
    Schedule.find = orig.scheduleFind;
  };
}

const gridReq = (body) => ({ user: { id: 'admin-1', role: 'admin' }, body: { enrollmentId: 'enr-1', subjectId: 'subj-act102', ...body } });

/** The first real date (within the response's own startDate..subscriptionEnd window)
 *  that falls on the given dayOfWeek — used so these tests never hardcode "today". */
function firstDateKeyForDay(grid, dayOfWeek) {
  return Object.keys(grid)
    .filter((key) => new Date(`${key}T00:00:00.000Z`).getUTCDay() === dayOfWeek)
    .sort()[0];
}

test('the response is a REAL monthly calendar — keyed by actual date, every chosen weekday has several real occurrences across the month, each with all 8 standard slots', async () => {
  const restore = stubGrid();
  try {
    const res = mockRes();
    await getMonthlySlotGrid(gridReq({ days: [1, 3] }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const dateKeys = Object.keys(res._body.grid);
    assert.ok(dateKeys.length >= 6, `expected several real dates across the month for 2 weekdays, got ${dateKeys.length}`);
    for (const key of dateKeys) {
      assert.match(key, /^\d{4}-\d{2}-\d{2}$/, 'grid must be keyed by a real calendar date, not a day-of-week number');
      assert.equal(res._body.grid[key].length, 8, 'each real date has all 8 standard hourly slots');
    }
    // Chronological sanity: sorted date keys must be strictly increasing real dates.
    const sorted = [...dateKeys].sort();
    assert.deepEqual(dateKeys.slice().sort(), sorted);
  } finally { restore(); }
});

test('a slot where EVERY tutor is already booked is reported as unavailable, with the "no available tutor" reason', async () => {
  // First, a quick probe (no schedule rows) just to learn which real date the grid
  // resolves for "the first Monday" — then re-stub with a conflict landing on THAT
  // exact date, since the fixture needs a real Date, not an abstract day-of-week.
  const probeRestore = stubGrid({ tutors: [TUTOR_A, TUTOR_B] });
  const probe = mockRes();
  await getMonthlySlotGrid(gridReq({ days: [1] }), probe);
  const mondayKey = firstDateKeyForDay(probe._body.grid, 1);
  probeRestore();

  const restore3 = stubGrid({
    tutors: [TUTOR_A, TUTOR_B],
    scheduleRows: [
      { tutor: 'tutor-a', tutors: ['tutor-a'], date: new Date(`${mondayKey}T00:00:00.000Z`), startTime: '09:00', endTime: '10:00', sessionType: 'one-on-one' },
      { tutor: 'tutor-b', tutors: ['tutor-b'], date: new Date(`${mondayKey}T00:00:00.000Z`), startTime: '09:00', endTime: '10:00', sessionType: 'one-on-one' },
    ],
  });
  try {
    const res = mockRes();
    await getMonthlySlotGrid(gridReq({ days: [1] }), res);
    const nineToTen = res._body.grid[mondayKey].find((s) => s.startTime === '09:00');
    assert.equal(nineToTen.available, false);
    assert.equal(nineToTen.tutors.length, 0);
    assert.match(nineToTen.reason, /no available tutor/i);

    const tenToEleven = res._body.grid[mondayKey].find((s) => s.startTime === '10:00');
    assert.equal(tenToEleven.available, true, 'a different hour with no conflicts is still open');
  } finally { restore3(); }
});

// Real bug (live-reported): the 8:00 AM slot showed "No available tutor" right after a
// brand-new full-time tutor account was created, which reads as "the new tutor isn't
// being picked up". Investigated directly against the real dev database: the new tutor
// (isActive:true, deletedAt:null, employmentType:'full-time', availability:'' — exactly
// the schema's own defaults for a freshly created tutor, set by User.js's pre-save hook,
// never touched by anything else) DOES correctly appear as available for 8AM and every
// other standard slot once nothing else blocks it — confirmed live. These tests lock
// that in, using the exact same "fresh account" shape (empty availability string, zero
// existing schedules) rather than an already-seeded tutor fixture.
test('a freshly created full-time tutor (empty availability string, zero existing schedules) is available at 8AM and every other standard slot, immediately', async () => {
  const BRAND_NEW_TUTOR = { _id: 'tutor-fresh', firstName: 'Joy', lastName: 'Cruz', employmentType: 'full-time', availability: '' };
  const restore = stubGrid({ tutors: [BRAND_NEW_TUTOR], scheduleRows: [] });
  try {
    const res = mockRes();
    await getMonthlySlotGrid(gridReq({ days: [1] }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const mondayKey = firstDateKeyForDay(res._body.grid, 1);
    for (const entry of res._body.grid[mondayKey]) {
      assert.equal(entry.available, true, `${entry.startTime} should be open for a brand-new full-time tutor with no conflicts`);
      assert.deepEqual(entry.tutors.map((t) => t._id), ['tutor-fresh']);
    }
    const eightAm = res._body.grid[mondayKey].find((s) => s.startTime === '08:00');
    assert.ok(eightAm, '8:00 AM must be one of the standard slots');
    assert.equal(eightAm.available, true);
  } finally { restore(); }
});

// The REAL root cause behind the live report: a brand-new tutor existing doesn't help
// when the block is tutor-INDEPENDENT — the student already has a conflicting session on
// a later occurrence of the SAME weekday elsewhere in the one-month window (the "whole
// pattern" rule, documented at the top of getAvailableTutorsGridForWindow). The backend's
// own `reason` text already correctly says so (never the generic "no available tutor"
// text in this case) — confirmed directly against the real dev database with a real
// recurring-conflict student. The frontend's unavailableSlotLabel (OneOnOneSchedulingWizard.tsx)
// relies on this distinction to avoid showing a misleading "No available tutor" label for
// a block that no new tutor account could ever fix.
test('a slot blocked by the STUDENT\'s own later-occurrence conflict reports the real reason, even with a brand-new, fully-free tutor in the pool', async () => {
  const BRAND_NEW_TUTOR = { _id: 'tutor-fresh', firstName: 'Joy', lastName: 'Cruz', employmentType: 'full-time', availability: '' };
  const probeRestore = stubGrid({ tutors: [BRAND_NEW_TUTOR] });
  const probe = mockRes();
  await getMonthlySlotGrid(gridReq({ days: [1] }), probe);
  const mondayKeys = Object.keys(probe._body.grid).sort();
  const firstMonday = mondayKeys[0];
  const laterMonday = mondayKeys[mondayKeys.length - 1];
  probeRestore();
  assert.notEqual(firstMonday, laterMonday, 'test needs at least 2 real Mondays in the window');

  // The enrolled student already has a conflicting session on a LATER Monday — not the
  // first one — so the first Monday's own slot is genuinely free on its own date, yet
  // must still read as blocked (by the student's schedule, not the tutor).
  const restore = stubGrid({
    tutors: [BRAND_NEW_TUTOR],
    scheduleRows: [
      // tutor/tutors must be set to a real, live tutor id — filterLiveSessions (this
      // conflicting session's OWN tutor, from a different program, is irrelevant to this
      // test) drops any row with no real tutor as a "ghost" session.
      { tutor: 'tutor-fresh', tutors: ['tutor-fresh'], student: 'student-1', students: [], date: new Date(`${laterMonday}T00:00:00.000Z`), startTime: '08:00', endTime: '09:00', sessionType: 'one-on-one' },
    ],
  });
  try {
    const res = mockRes();
    await getMonthlySlotGrid(gridReq({ days: [1] }), res);
    const eightAmFirstMonday = res._body.grid[firstMonday].find((s) => s.startTime === '08:00');
    assert.equal(eightAmFirstMonday.available, false);
    assert.equal(eightAmFirstMonday.tutors.length, 0);
    // Must NOT be the generic "no available tutor" reason — a brand-new tutor exists and
    // is otherwise completely free; the real blocker is the student's own schedule.
    assert.doesNotMatch(eightAmFirstMonday.reason, /no available tutor/i);
    assert.match(eightAmFirstMonday.reason, /conflicting session/i);
  } finally { restore(); }
});

test('a slot where at least one tutor is free shows EXACTLY those tutors, not every tutor', async () => {
  const probeRestore = stubGrid({ tutors: [TUTOR_A, TUTOR_B] });
  const probe = mockRes();
  await getMonthlySlotGrid(gridReq({ days: [1] }), probe);
  const mondayKey = firstDateKeyForDay(probe._body.grid, 1);
  probeRestore();

  const restore = stubGrid({
    tutors: [TUTOR_A, TUTOR_B],
    scheduleRows: [{ tutor: 'tutor-a', tutors: ['tutor-a'], date: new Date(`${mondayKey}T00:00:00.000Z`), startTime: '09:00', endTime: '10:00', sessionType: 'one-on-one' }],
  });
  try {
    const res = mockRes();
    await getMonthlySlotGrid(gridReq({ days: [1] }), res);
    const nineToTen = res._body.grid[mondayKey].find((s) => s.startTime === '09:00');
    assert.equal(nineToTen.available, true);
    assert.deepEqual(nineToTen.tutors.map((t) => t._id), ['tutor-b']);
  } finally { restore(); }
});

test('a part-time tutor outside their availability window is excluded from that slot on EVERY matching date, even with zero conflicts', async () => {
  const restore = stubGrid({ tutors: [TUTOR_PARTTIME] });
  try {
    const res = mockRes();
    await getMonthlySlotGrid(gridReq({ days: [1] }), res);
    const mondayKeys = Object.keys(res._body.grid);
    assert.ok(mondayKeys.length >= 2, 'several real Mondays across the month');
    for (const key of mondayKeys) {
      const nineToTen = res._body.grid[key].find((s) => s.startTime === '09:00');
      assert.equal(nineToTen.available, false, `${key} 9-10 AM is outside Liza's declared window`);
      const oneToTwo = res._body.grid[key].find((s) => s.startTime === '13:00');
      assert.equal(oneToTwo.available, true, `${key} 1-2 PM is inside Liza's declared 1-3 PM window`);
      assert.deepEqual(oneToTwo.tutors.map((t) => t._id), ['tutor-c']);
    }
  } finally { restore(); }
});

test('the student\'s own existing session (e.g. overlapping Toddlers Playgroup) on ONE occurrence grays out that slot on EVERY occurrence of the weekday, not just that date', async () => {
  // Bug fix: assigning a weekday/slot commits every real occurrence of it across the
  // month (createMonthlySchedules inserts one session per datesForWeekday match and
  // aborts the whole batch if any fails; checkMonthlySchedule's conflict list is built
  // the same way, one entry per failing occurrence). A conflict on a LATER occurrence
  // must therefore also gray out an EARLIER occurrence's cell here — otherwise the grid
  // would say a slot is pickable when generating the month would actually fail partway
  // through. See also the CROSS-CHECK-PATTERN test below for the tutor-side version of
  // this same fix (the actual bug report: a tutor shown free for one date here while
  // checkMonthlySchedule correctly reported them unavailable because of a conflict on a
  // later occurrence of the same weekday).
  const probeRestore = stubGrid({ tutors: [TUTOR_A, TUTOR_B] });
  const probe = mockRes();
  await getMonthlySlotGrid(gridReq({ days: [1] }), probe);
  const mondayKeys = Object.keys(probe._body.grid).sort();
  assert.ok(mondayKeys.length >= 2, 'need at least 2 real Mondays in the window for this test');
  const [firstMondayKey, secondMondayKey] = mondayKeys;
  probeRestore();

  const restore = stubGrid({
    tutors: [TUTOR_A, TUTOR_B],
    scheduleRows: [{ student: 'student-1', students: [], tutor: 'some-other-tutor', tutors: ['some-other-tutor'], date: new Date(`${secondMondayKey}T00:00:00.000Z`), startTime: '09:00', endTime: '10:00', sessionType: 'playgroup' }],
  });
  try {
    const res = mockRes();
    await getMonthlySlotGrid(gridReq({ days: [1] }), res);

    const conflictDateSlot = res._body.grid[secondMondayKey].find((s) => s.startTime === '09:00');
    assert.equal(conflictDateSlot.available, false);
    assert.equal(conflictDateSlot.tutors.length, 0);
    assert.match(conflictDateSlot.reason, /already has a conflicting session/i);

    // The EARLIER Monday has no conflict of its own, but the whole weekday pattern is
    // still blocked because a LATER occurrence conflicts — matching what
    // checkMonthlySchedule/createMonthlySchedules would actually enforce.
    const earlierDateSlot = res._body.grid[firstMondayKey].find((s) => s.startTime === '09:00');
    assert.equal(earlierDateSlot.available, false, 'a later occurrence\'s conflict must also block an earlier occurrence\'s cell');
    assert.equal(earlierDateSlot.tutors.length, 0);
    assert.match(earlierDateSlot.reason, /already has a conflicting session/i);

    // A different hour (no conflict at all, any date) is still fully open.
    const unrelatedHour = res._body.grid[firstMondayKey].find((s) => s.startTime === '10:00');
    assert.equal(unrelatedHour.available, true);
  } finally { restore(); }
});

test('rejects a non-one-on-one program (e.g. Toddlers Playgroup) — this grid is 1-on-1 only, untouched Playgroup flow', async () => {
  const restore = stubGrid({ tutors: [TUTOR_A] });
  const origFindById = Subject.findById;
  Subject.findById = () => mockQuery({ _id: 'subj-tpg101', name: 'Toddlers Playgroup', code: 'TPG101' });
  try {
    const res = mockRes();
    await getMonthlySlotGrid(gridReq({ days: [1] }), res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /one-on-one/i);
  } finally {
    Subject.findById = origFindById;
    restore();
  }
});

// ── Cross-validation: the batched grid must never disagree with the real per-call rule
// functions it's reusing the RULES of, for the same scenario. ─────────────────────────
test('CROSS-CHECK: the batched grid\'s verdict for a slot matches canTutorHandleSchedule/hasStudentScheduleConflict called directly for the same tutor/date/time', async () => {
  const restore = stubGrid({
    tutors: [TUTOR_PARTTIME],
    scheduleRows: [],
  });
  try {
    const res = mockRes();
    await getMonthlySlotGrid(gridReq({ days: [1] }), res);
    const mondayKey = firstDateKeyForDay(res._body.grid, 1);
    const nineToTen = res._body.grid[mondayKey].find((s) => s.startTime === '09:00');
    const oneToTwo = res._body.grid[mondayKey].find((s) => s.startTime === '13:00');

    const directCheckOutside = await canTutorHandleSchedule({
      tutorId: 'tutor-c', subjectId: 'subj-act102', date: new Date(`${mondayKey}T00:00:00.000Z`), startTime: '09:00', endTime: '10:00',
    });
    const directCheckInside = await canTutorHandleSchedule({
      tutorId: 'tutor-c', subjectId: 'subj-act102', date: new Date(`${mondayKey}T00:00:00.000Z`), startTime: '13:00', endTime: '14:00',
    });

    assert.equal(nineToTen.available, directCheckOutside.ok, 'batched grid must agree with canTutorHandleSchedule for the outside-window slot');
    assert.equal(oneToTwo.available, directCheckInside.ok, 'batched grid must agree with canTutorHandleSchedule for the inside-window slot');
  } finally { restore(); }
});

// ── Bug report: the "tutors free" grid showed a tutor as free for Mon 8am while the
// checkMonthlySchedule-driven per-day results list showed the SAME tutor/day/time as
// NOT available, citing a conflict on a LATER real date (e.g. "Mon 8:00 AM — Not
// available (Nov 2, 2026: Tutor already has another session at this time)" even though
// the clicked date was Oct 26). Root cause: getAvailableTutorsGridForWindow decided
// "available" per SINGLE clicked date only, while checkMonthlySchedule (correctly)
// checks EVERY real occurrence of that weekday across the whole generation window,
// since createMonthlySchedules has to insert all of them and aborts entirely if any one
// fails. A tutor with a conflict on only a LATER occurrence was therefore shown as free
// for an EARLIER occurrence by the grid, while checkMonthlySchedule already (correctly)
// reported them unavailable. Fix: the grid now requires a tutor to be free on EVERY
// occurrence of the weekday in the window before listing them as available for ANY of
// them — so the two can never disagree again for the same reason. ─────────────────────
test('BUG FIX: a tutor with a real conflict on a LATER occurrence of a chosen weekday is NOT listed as free for an EARLIER occurrence either — the "tutors free" grid and the checkMonthlySchedule results list must agree', async () => {
  const probeRestore = stubGrid({ tutors: [TUTOR_A, TUTOR_B] });
  const probe = mockRes();
  await getMonthlySlotGrid(gridReq({ days: [1] }), probe);
  const mondayKeys = Object.keys(probe._body.grid).sort();
  assert.ok(mondayKeys.length >= 2, 'need at least 2 real Mondays in the window for this test');
  const [firstMondayKey, secondMondayKey] = mondayKeys;
  probeRestore();

  // Mariana (TUTOR_A) has a real booked session 8-9 AM on the SECOND Monday only —
  // the first Monday (the one the admin actually clicks) has no conflict of its own.
  const restore = stubGrid({
    tutors: [TUTOR_A, TUTOR_B],
    scheduleRows: [{ tutor: 'tutor-a', tutors: ['tutor-a'], date: new Date(`${secondMondayKey}T00:00:00.000Z`), startTime: '08:00', endTime: '09:00', sessionType: 'one-on-one' }],
  });
  try {
    // 1. The "tutors free" grid for the FIRST (clicked) Monday must NOT list Mariana as
    //    free at 8 AM — only Jake, who has no conflict on either Monday.
    const gridRes = mockRes();
    await getMonthlySlotGrid(gridReq({ days: [1] }), gridRes);
    const eightAm = gridRes._body.grid[firstMondayKey].find((s) => s.startTime === '08:00');
    assert.deepEqual(eightAm.tutors.map((t) => t._id), ['tutor-b'], 'Mariana must not be listed as free — she has a real conflict later in the recurring pattern');

    // 2. The per-day results list (checkMonthlySchedule), asked whether Mariana
    //    specifically works for Monday 8 AM, must agree she is NOT available — never
    //    "ok" while the grid also hides her.
    const checkRes = mockRes();
    await checkMonthlySchedule(gridReq({ daySlots: [{ dayOfWeek: 1, startTime: '08:00', endTime: '09:00', tutorId: 'tutor-a' }] }), checkRes);
    assert.equal(checkRes._status, 200, JSON.stringify(checkRes._body));
    assert.equal(checkRes._body.ok, false, 'checkMonthlySchedule must also report Mariana as unavailable for the Monday 8 AM pattern');
    const mondayConflict = checkRes._body.conflicts.find((c) => c.dayOfWeek === 1);
    assert.ok(mondayConflict, 'a conflict entry for Monday must be present');
    assert.match(mondayConflict.reason, /already has another session/i);

    // 3. Sanity: the fix didn't just make everything unavailable — Jake (no conflict on
    //    either Monday) is still correctly listed as free by the grid (already asserted
    //    in step 1 above: eightAm.tutors is exactly ['tutor-b'], not an empty list).
  } finally { restore(); }
});
