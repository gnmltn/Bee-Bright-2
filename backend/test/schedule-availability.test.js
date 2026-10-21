/**
 * Request 1 — real tutor/student availability computation for the admin chatbot's
 * scheduling-suggestion reply. Reuses scheduleController.js's canTutorHandleSchedule/
 * hasStudentScheduleConflict (the SAME functions the real Scheduling Wizard uses) via
 * utils/scheduleAvailability.js, so these tests mock the real underlying models
 * (User/TutorUnavailability/Schedule) exactly the way the Wizard's own tests do,
 * rather than mocking scheduleAvailability.js's own dependencies away.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');
const Subject = require('../models/Subject');
const TutorUnavailability = require('../models/TutorUnavailability');
const Schedule = require('../models/Schedule');
const {
  computeOpenSlotsForTutor,
  checkSpecificDaySlot,
  isStudentAlreadyScheduledForProgram,
  formatTimeOfDay12h,
  formatFullDateWithWeekday,
  classifyTimeOfDay,
  nextDateForWeekday,
  dayNameToNumber,
} = require('../utils/scheduleAvailability');

// canTutorHandleSchedule's own tutor lookup is `await User.findOne(...).select(...)`
// with NO .lean() call — must be directly awaitable (a real thenable), or `await`
// silently resolves to the mock query object itself instead of the real data.
const mockQuery = (result) => {
  const q = {
    select: () => q,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
};

function stubTutor({ employmentType = 'part-time', availability = 'Mon, Wed 9:00 AM - 11:00 AM' } = {}) {
  const origFindOne = User.findOne;
  User.findOne = () => mockQuery({ _id: 'tutor-1', employmentType, availability });
  return () => { User.findOne = origFindOne; };
}

function stubNoConflicts() {
  const origUnavailExists = TutorUnavailability.exists;
  const origScheduleFind = Schedule.find;
  TutorUnavailability.exists = async () => false;
  Schedule.find = () => mockQuery([]);
  return () => { TutorUnavailability.exists = origUnavailExists; Schedule.find = origScheduleFind; };
}

// filterLiveSessions (used inside hasTutorScheduleConflict/hasStudentScheduleConflict)
// does its OWN real User.find({_id: {$in:...}, deletedAt: null}) to drop "ghost"
// sessions — stub it to treat every id in `liveIds` as a live, non-deleted account.
function stubLiveUsers(liveIds) {
  const origFind = User.find;
  User.find = () => mockQuery(liveIds.map((id) => ({ _id: id })));
  return () => { User.find = origFind; };
}

test('formatTimeOfDay12h / classifyTimeOfDay: real conversions, not placeholders', () => {
  assert.equal(formatTimeOfDay12h('09:00'), '9:00 AM');
  assert.equal(formatTimeOfDay12h('13:00'), '1:00 PM');
  assert.equal(formatTimeOfDay12h('00:00'), '12:00 AM');
  assert.equal(classifyTimeOfDay('09:00'), 'morning');
  assert.equal(classifyTimeOfDay('13:00'), 'afternoon');
  assert.equal(classifyTimeOfDay('18:00'), 'evening');
});

test('dayNameToNumber / nextDateForWeekday: real day-of-week resolution, UTC-midnight dates', () => {
  assert.equal(dayNameToNumber('Monday'), 1);
  assert.equal(dayNameToNumber('Saturday'), 6);
  assert.equal(dayNameToNumber('not-a-day'), null);
  const monday = nextDateForWeekday(1, new Date('2026-10-21T12:00:00.000Z')); // a Wednesday
  assert.equal(monday.getUTCDay(), 1);
  assert.ok(monday >= new Date('2026-10-21T00:00:00.000Z'));
});

test('computeOpenSlotsForTutor: returns [] for a tutor that does not exist/is not active — never a false "fully open"', async () => {
  const origFindOne = User.findOne;
  User.findOne = () => mockQuery(null);
  try {
    const slots = await computeOpenSlotsForTutor({ tutorId: 'ghost', subjectId: 'subj-1' });
    assert.deepEqual(slots, []);
  } finally {
    User.findOne = origFindOne;
  }
});

test('computeOpenSlotsForTutor: a real tutor with a genuinely free Mon/Wed 9-11AM window returns real open 1-hour slots', async () => {
  const restoreTutor = stubTutor();
  const restoreConflicts = stubNoConflicts();
  try {
    const slots = await computeOpenSlotsForTutor({ tutorId: 'tutor-1', subjectId: 'subj-1' });
    // Mon 9-11AM and Wed 9-11AM, split into 1-hour slots -> 4 total (9-10, 10-11 x2 days)
    assert.equal(slots.length, 4);
    assert.ok(slots.every((s) => [1, 3].includes(s.dayOfWeek)));
    assert.ok(slots.some((s) => s.dayOfWeek === 1 && s.startTime === '09:00'));
  } finally {
    restoreTutor();
    restoreConflicts();
  }
});

test('computeOpenSlotsForTutor: filters by timeOfDay — a tutor only available in the morning returns nothing for "afternoon"', async () => {
  const restoreTutor = stubTutor({ availability: 'Mon 9:00 AM - 11:00 AM' });
  const restoreConflicts = stubNoConflicts();
  try {
    const morning = await computeOpenSlotsForTutor({ tutorId: 'tutor-1', subjectId: 'subj-1', timeOfDay: 'morning' });
    const afternoon = await computeOpenSlotsForTutor({ tutorId: 'tutor-1', subjectId: 'subj-1', timeOfDay: 'afternoon' });
    assert.ok(morning.length > 0, 'the tutor really is free in the morning');
    assert.equal(afternoon.length, 0, 'the tutor has no afternoon availability at all');
  } finally {
    restoreTutor();
    restoreConflicts();
  }
});

test('computeOpenSlotsForTutor: a day the tutor already has ANOTHER session on is excluded — real conflict check, not just the weekly pattern', async () => {
  const restoreTutor = stubTutor({ availability: 'Mon 9:00 AM - 11:00 AM' });
  const origUnavailExists = TutorUnavailability.exists;
  const origScheduleFind = Schedule.find;
  TutorUnavailability.exists = async () => false;
  // Monday 9-10 is already booked for this tutor.
  Schedule.find = () => mockQuery([{ startTime: '09:00', endTime: '10:00', tutor: 'tutor-1', student: 'other-student' }]);
  const restoreUsers = stubLiveUsers(['tutor-1', 'other-student']);
  try {
    const slots = await computeOpenSlotsForTutor({ tutorId: 'tutor-1', subjectId: 'subj-1' });
    assert.ok(!slots.some((s) => s.startTime === '09:00'), 'the conflicting 9-10 slot must not be reported as open');
    assert.ok(slots.some((s) => s.startTime === '10:00'), 'the non-conflicting 10-11 slot is still open');
  } finally {
    TutorUnavailability.exists = origUnavailExists;
    Schedule.find = origScheduleFind;
    restoreUsers();
    restoreTutor();
  }
});

test('computeOpenSlotsForTutor: when a studentId is given, a slot where THAT student already has a session is also excluded', async () => {
  const restoreTutor = stubTutor({ availability: 'Mon 9:00 AM - 11:00 AM' });
  const origUnavailExists = TutorUnavailability.exists;
  const origScheduleFind = Schedule.find;
  TutorUnavailability.exists = async () => false;
  Schedule.find = (query) => {
    // hasTutorScheduleConflict queries by tutor; hasStudentScheduleConflict queries by student.
    if (query.$or?.some((c) => c.tutor === 'tutor-1' || c.tutors === 'tutor-1')) return mockQuery([]);
    return mockQuery([{ startTime: '09:00', endTime: '10:00', tutor: 'other-tutor', student: 'student-1' }]);
  };
  const restoreUsers = stubLiveUsers(['other-tutor', 'student-1']);
  try {
    const slots = await computeOpenSlotsForTutor({ tutorId: 'tutor-1', subjectId: 'subj-1', studentId: 'student-1' });
    assert.ok(!slots.some((s) => s.startTime === '09:00'), 'the student already has a conflicting session at 9-10, tutor side notwithstanding');
    assert.ok(slots.some((s) => s.startTime === '10:00'));
  } finally {
    TutorUnavailability.exists = origUnavailExists;
    Schedule.find = origScheduleFind;
    restoreUsers();
    restoreTutor();
  }
});

test('checkSpecificDaySlot: reports the REAL reason when the tutor cannot cover that day/time — the exact example from the request', async () => {
  const restoreTutor = stubTutor({ availability: 'Mon 9:00 AM - 11:00 AM, Tue 9:00 AM - 11:00 AM' });
  const origUnavailExists = TutorUnavailability.exists;
  const origScheduleFind = Schedule.find;
  TutorUnavailability.exists = async () => false;
  // Wednesday: outside the tutor's weekly availability entirely (not just booked).
  Schedule.find = () => mockQuery([]);
  try {
    const wed = await checkSpecificDaySlot({ tutorId: 'tutor-1', subjectId: 'subj-1', dayOfWeek: 3, startTime: '09:00', endTime: '10:00' });
    assert.equal(wed.ok, false);
    assert.match(wed.reason, /availability does not cover/i);
    assert.match(wed.date, /^\d{4}-\d{2}-\d{2}$/, 'the real checked date is returned alongside the reason, not just a bare weekday');
  } finally {
    TutorUnavailability.exists = origUnavailExists;
    Schedule.find = origScheduleFind;
    restoreTutor();
  }
});

// ── Date formatting: full calendar date + weekday together, never ambiguous ────────────

test('formatFullDateWithWeekday: weekday and date are read off the SAME real Date object, so they can never disagree', () => {
  // 2026-10-20 is a real, verifiable Tuesday.
  assert.equal(formatFullDateWithWeekday('2026-10-20'), 'Tuesday, October 20, 2026');
  // 2026-10-21 (the next day) must be a different weekday, not a copy/paste mismatch.
  assert.equal(formatFullDateWithWeekday('2026-10-21'), 'Wednesday, October 21, 2026');
});

test('computeOpenSlotsForTutor: a recurring open slot returns MULTIPLE real upcoming dates, each independently checked — not just the next occurrence', async () => {
  const restoreTutor = stubTutor({ availability: 'Mon 9:00 AM - 10:00 AM' });
  const restoreConflicts = stubNoConflicts();
  try {
    const slots = await computeOpenSlotsForTutor({ tutorId: 'tutor-1', subjectId: 'subj-1', daysOfWeek: [1] });
    assert.equal(slots.length, 1);
    assert.ok(Array.isArray(slots[0].dates));
    assert.ok(slots[0].dates.length >= 2, 'a consistently-free weekly slot should surface more than just the next date');
    // Every returned date must actually BE a Monday.
    for (const d of slots[0].dates) {
      const [y, m, day] = d.split('-').map(Number);
      assert.equal(new Date(Date.UTC(y, m - 1, day)).getUTCDay(), 1, `${d} must be a Monday`);
    }
    assert.equal(typeof slots[0].hasMore, 'boolean');
  } finally {
    restoreTutor();
    restoreConflicts();
  }
});

test('computeOpenSlotsForTutor: a one-off conflict on a LATER occurrence does not hide the slot entirely — only that specific date is excluded', async () => {
  const restoreTutor = stubTutor({ availability: 'Mon 9:00 AM - 10:00 AM' });
  const origUnavailExists = TutorUnavailability.exists;
  const origScheduleFind = Schedule.find;
  TutorUnavailability.exists = async () => false;
  // Block the SECOND upcoming Monday specifically (14 days from "today" in UTC terms);
  // the first and third Mondays stay free.
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  const diff = (1 - base.getUTCDay() + 7) % 7;
  const firstMonday = new Date(base.getTime() + diff * 86400000);
  const secondMonday = new Date(firstMonday.getTime() + 7 * 86400000);
  const secondMondayKey = secondMonday.toISOString().slice(0, 10);
  // hasTutorScheduleConflict's own Schedule.find queries by {$or, date} — report a
  // conflict only when the query's date matches the second Monday specifically.
  Schedule.find = (query) => {
    const queried = query?.date instanceof Date ? query.date.toISOString().slice(0, 10) : null;
    if (queried === secondMondayKey) return mockQuery([{ startTime: '09:00', endTime: '10:00', tutor: 'tutor-1', student: 'other' }]);
    return mockQuery([]);
  };
  const restoreUsers = stubLiveUsers(['tutor-1', 'other']);
  try {
    const slots = await computeOpenSlotsForTutor({ tutorId: 'tutor-1', subjectId: 'subj-1', daysOfWeek: [1] });
    assert.equal(slots.length, 1);
    assert.ok(!slots[0].dates.includes(secondMondayKey), 'the specifically-conflicting date must be excluded');
    assert.ok(slots[0].dates.length >= 1, 'the other, genuinely-free Mondays must still be reported');
  } finally {
    TutorUnavailability.exists = origUnavailExists;
    Schedule.find = origScheduleFind;
    restoreUsers();
    restoreTutor();
  }
});

// ── Scope: only students still needing scheduling (same rule the wizards use) ──────────

test('isStudentAlreadyScheduledForProgram: true once a live Schedule row exists for that student + program, false otherwise', async () => {
  const origSubjectFindOne = Subject.findOne;
  const origScheduleExists = Schedule.exists;
  Subject.findOne = () => mockQuery({ _id: 'subj-act102' });
  try {
    Schedule.exists = async () => true;
    assert.equal(await isStudentAlreadyScheduledForProgram('student-1', 'ACT102'), true);

    Schedule.exists = async () => false;
    assert.equal(await isStudentAlreadyScheduledForProgram('student-1', 'ACT102'), false, 'no Schedule row left (e.g. deleted) reads as unscheduled again');

    assert.equal(await isStudentAlreadyScheduledForProgram(null, 'ACT102'), false, 'no linked student user at all -> never scheduled');
  } finally {
    Subject.findOne = origSubjectFindOne;
    Schedule.exists = origScheduleExists;
  }
});
