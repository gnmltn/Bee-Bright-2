/**
 * BeeBright Scheduling Spec, Section 3 — Suspension (system-wide) and Emergency
 * (single-student) schedule auto-adjustment. Two deliberately separate functions:
 *   - suspendDates: reschedules every affected session (1-on-1 + Playgroup) to the
 *     next conflict-free occurrence for that same pair, per-date searched sequentially.
 *   - emergencyReschedule: admin manually picks the new date/time for ONE one-on-one
 *     session, with a required reason; rejected outright for Playgroup sessions since
 *     those are shared by multiple children (moving one child's date would move everyone).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');
const TutorUnavailability = require('../models/TutorUnavailability');
const TutoringArea = require('../models/TutoringArea');
const Schedule = require('../models/Schedule');
const Suspension = require('../models/Suspension');
const EmergencyReschedule = require('../models/EmergencyReschedule');
const { suspendDates, emergencyReschedule } = require('../controllers/scheduleController');

function mockQuery(result) {
  const q = {
    select: () => q,
    sort: () => q,
    populate: () => q,
    limit: () => q,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch: (fn) => Promise.resolve(result).catch(fn),
  };
  return q;
}

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

const SUBJECT_ACT102 = { _id: 'subj-act102', name: 'Academic Tutorial', code: 'ACT102' };
const TUTOR = { _id: 'tutor-1', role: 'tutor', isActive: true, deletedAt: null, employmentType: 'full-time', availability: '' };
const MONDAY_DATE = new Date('2026-09-14T00:00:00.000Z'); // confirmed Monday
const PLUS_7 = new Date('2026-09-21T00:00:00.000Z');
const PLUS_14 = new Date('2026-09-28T00:00:00.000Z');

function makeOneOnOneSchedule(overrides = {}) {
  const doc = {
    _id: 'sched-1',
    sessionType: 'one-on-one',
    date: new Date(MONDAY_DATE),
    startTime: '08:00',
    endTime: '09:00',
    subject: SUBJECT_ACT102,
    student: { _id: 'student-1', email: 'student1@example.com', firstName: 'Stu', lastName: 'Dent' },
    students: [],
    tutor: { _id: 'tutor-1', email: 'tutor1@example.com', firstName: 'Tu', lastName: 'Tor' },
    tutors: [],
    tutoringAreaId: null,
    ...overrides,
  };
  doc.save = async () => doc;
  return doc;
}

function stubCommon({ tutorConflictDates = [], studentConflictDates = [] } = {}) {
  const origUserFindOne = User.findOne;
  const origUserFind = User.find;
  const origTutorUnavailabilityExists = TutorUnavailability.exists;
  const origTutoringAreaFindById = TutoringArea.findById;
  const origScheduleCountDocuments = Schedule.countDocuments;
  const origScheduleFind = Schedule.find;

  User.findOne = () => mockQuery(TUTOR);
  User.find = () => mockQuery([]); // no admins -> notifyUnresolvedSuspension short-circuits
  TutorUnavailability.exists = async () => false;
  TutoringArea.findById = () => mockQuery({ areaType: 'tutoring_area', capacity: 15 });
  Schedule.countDocuments = async () => 0;

  const dateKey = (d) => new Date(d).toISOString().slice(0, 10);
  const tutorConflictKeys = new Set(tutorConflictDates.map(dateKey));
  const studentConflictKeys = new Set(studentConflictDates.map(dateKey));

  // Used only by canTutorHandleSchedule (hasTutorScheduleConflict) and
  // hasStudentScheduleConflict — the outer "all sessions in range" query for
  // suspendDates is stubbed separately per-test since its shape differs ({date:{$gte}}).
  Schedule.find = (query) => {
    if (query && query.$or && query.$or[0] && 'tutor' in query.$or[0]) {
      return mockQuery(tutorConflictKeys.has(dateKey(query.date)) ? [{ startTime: '08:00', endTime: '09:00' }] : []);
    }
    if (query && query.$or && query.$or[0] && 'student' in query.$or[0]) {
      return mockQuery(studentConflictKeys.has(dateKey(query.date)) ? [{ startTime: '08:00', endTime: '09:00' }] : []);
    }
    return mockQuery([]);
  };

  return {
    restore() {
      User.findOne = origUserFindOne;
      User.find = origUserFind;
      TutorUnavailability.exists = origTutorUnavailabilityExists;
      TutoringArea.findById = origTutoringAreaFindById;
      Schedule.countDocuments = origScheduleCountDocuments;
      Schedule.find = origScheduleFind;
    },
  };
}

test('suspendDates: moves a simple conflict-free session to +7 days', async () => {
  const schedule = makeOneOnOneSchedule();
  const { restore } = stubCommon();
  const origScheduleFindRange = Schedule.find;
  const origSuspensionCreate = Suspension.create;
  Schedule.find = (query) => {
    if (query && query.date && query.date.$gte) return mockQuery([schedule]);
    return origScheduleFindRange(query);
  };
  let createdSuspension = null;
  Suspension.create = async (data) => { createdSuspension = data; return { ...data, _id: 'susp-1' }; };
  try {
    const res = mockRes();
    await suspendDates({ user: { id: 'admin-1', role: 'admin' }, body: { startDate: '2026-09-14', reason: 'Typhoon' } }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(res._body.success, true);
    assert.equal(schedule.date.toISOString(), PLUS_7.toISOString());
    assert.equal(createdSuspension.movedCount, 1);
    assert.equal(createdSuspension.unresolvedCount, 0);
  } finally { restore(); Suspension.create = origSuspensionCreate; }
});

test('suspendDates: skips an occupied next-week date and compresses to the following open one', async () => {
  const schedule = makeOneOnOneSchedule();
  // The pair already has a regular session at +7 (normal weekly recurrence) -> must skip to +14.
  const { restore } = stubCommon({ studentConflictDates: [PLUS_7] });
  const origScheduleFindRange = Schedule.find;
  const origSuspensionCreate = Suspension.create;
  Schedule.find = (query) => {
    if (query && query.date && query.date.$gte) return mockQuery([schedule]);
    return origScheduleFindRange(query);
  };
  Suspension.create = async (data) => ({ ...data, _id: 'susp-2' });
  try {
    const res = mockRes();
    await suspendDates({ user: { id: 'admin-1', role: 'admin' }, body: { startDate: '2026-09-14', reason: 'Typhoon' } }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(schedule.date.toISOString(), PLUS_14.toISOString());
  } finally { restore(); Suspension.create = origSuspensionCreate; }
});

test('suspendDates: marks a session unresolved when no free date is found within the search cap', async () => {
  const schedule = makeOneOnOneSchedule();
  // Tutor is conflicted every single week -> never resolves within MAX_RESCHEDULE_ATTEMPTS.
  const allFutureMondays = Array.from({ length: 10 }, (_, i) => new Date(MONDAY_DATE.getTime() + (i + 1) * 7 * 86400000));
  const { restore } = stubCommon({ tutorConflictDates: allFutureMondays });
  const origScheduleFindRange = Schedule.find;
  const origSuspensionCreate = Suspension.create;
  Schedule.find = (query) => {
    if (query && query.date && query.date.$gte) return mockQuery([schedule]);
    return origScheduleFindRange(query);
  };
  let createdSuspension = null;
  Suspension.create = async (data) => { createdSuspension = data; return { ...data, _id: 'susp-3' }; };
  try {
    const res = mockRes();
    await suspendDates({ user: { id: 'admin-1', role: 'admin' }, body: { startDate: '2026-09-14', reason: 'Typhoon' } }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(createdSuspension.movedCount, 0);
    assert.equal(createdSuspension.unresolvedCount, 1);
    assert.equal(createdSuspension.details[0].status, 'unresolved');
    assert.equal(schedule.date.toISOString(), MONDAY_DATE.toISOString(), 'unresolved session must not have its date mutated');
  } finally { restore(); Suspension.create = origSuspensionCreate; }
});

test('emergencyReschedule: succeeds for a one-on-one session with a valid reason', async () => {
  const schedule = makeOneOnOneSchedule();
  const { restore } = stubCommon();
  const origScheduleFindById = Schedule.findById;
  const origRecordCreate = EmergencyReschedule.create;
  Schedule.findById = () => mockQuery(schedule);
  let createdRecord = null;
  EmergencyReschedule.create = async (data) => { createdRecord = data; return { ...data, _id: 'er-1' }; };
  try {
    const res = mockRes();
    await emergencyReschedule({
      user: { id: 'admin-1', role: 'admin' },
      params: { id: 'sched-1' },
      body: { newDate: '2026-09-19', newStartTime: '10:00', newEndTime: '11:00', reason: 'Family emergency' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.success, true);
    assert.equal(schedule.startTime, '10:00');
    assert.equal(schedule.endTime, '11:00');
    assert.equal(createdRecord.reason, 'Family emergency');
  } finally { restore(); Schedule.findById = origScheduleFindById; EmergencyReschedule.create = origRecordCreate; }
});

test('emergencyReschedule: rejected for a Playgroup session (shared by multiple children)', async () => {
  const schedule = makeOneOnOneSchedule({ sessionType: 'playgroup', students: [{ _id: 's1' }, { _id: 's2' }] });
  const { restore } = stubCommon();
  const origScheduleFindById = Schedule.findById;
  Schedule.findById = () => mockQuery(schedule);
  try {
    const res = mockRes();
    await emergencyReschedule({
      user: { id: 'admin-1', role: 'admin' },
      params: { id: 'sched-1' },
      body: { newDate: '2026-09-19', newStartTime: '10:00', newEndTime: '11:00', reason: 'Family emergency' },
    }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /only available for 1-on-1 sessions/i);
  } finally { restore(); Schedule.findById = origScheduleFindById; }
});

test('emergencyReschedule: rejected without a reason', async () => {
  const res = mockRes();
  await emergencyReschedule({
    user: { id: 'admin-1', role: 'admin' },
    params: { id: 'sched-1' },
    body: { newDate: '2026-09-19', newStartTime: '10:00', newEndTime: '11:00', reason: '   ' },
  }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.message, /reason is required/i);
});

test('emergencyReschedule: rejected when the new slot conflicts for the tutor', async () => {
  const schedule = makeOneOnOneSchedule();
  const targetDate = new Date('2026-09-19T00:00:00.000Z');
  const { restore } = stubCommon({ tutorConflictDates: [targetDate] });
  const origScheduleFindById = Schedule.findById;
  Schedule.findById = () => mockQuery(schedule);
  try {
    const res = mockRes();
    await emergencyReschedule({
      user: { id: 'admin-1', role: 'admin' },
      params: { id: 'sched-1' },
      body: { newDate: '2026-09-19', newStartTime: '08:00', newEndTime: '09:00', reason: 'Family emergency' },
    }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /already has another session/i);
  } finally { restore(); Schedule.findById = origScheduleFindById; }
});
