/**
 * "bug (8).pdf" — "Mark tutor unavailable (day)".
 *
 * Per the code, this is meant to: mark a specific tutor unavailable for a given date,
 * find every session they're on that day, and attempt to auto-reassign each one to
 * another available tutor (reusing processSubstitutionForSchedule — the same mechanism
 * "Assign Substitute Tutor" uses), reporting reassigned vs. unresolved counts.
 *
 * Two real bugs, both explaining the reported "Reassigned: 0, unresolved: 0" on every
 * click:
 *   1. The affected-sessions query only matched `{ tutor: tutorId }` (the primary field)
 *      — a Toddlers Playgroup session where this tutor is a CO-tutor (in `tutors[]`) was
 *      silently never found at all, so both counts stayed at zero with no explanation.
 *   2. Even once found, nothing told processSubstitutionForSchedule WHICH of a
 *      multi-tutor session's tutors was actually the one going unavailable — it defaulted
 *      to the primary tutor, which for a co-tutor case would substitute out the WRONG
 *      person.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const mongoose = require('mongoose');
mongoose.startSession = async () => ({
  withTransaction: async (fn) => { await fn(); },
  endSession: async () => {},
});

const User = require('../models/User');
const TutorUnavailability = require('../models/TutorUnavailability');
const Schedule = require('../models/Schedule');
const ScheduleSubstitutionLog = require('../models/ScheduleSubstitutionLog');
const emailService = require('../utils/emailService');
emailService.sendEmail = async () => ({ success: true });
const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};
// The unavailability marker record itself isn't what these tests are about — stub it
// globally so every test doesn't need its own ObjectId-valid tutorId/markedBy just to
// satisfy Mongoose's schema casting.
TutorUnavailability.create = async (doc) => ({ ...doc, _id: 'marker-1' });

const { markTutorUnavailability } = require('../controllers/scheduleController');

function mockQuery(result) {
  const q = {
    select: () => q,
    sort: () => q,
    populate: () => q,
    limit: () => q,
    session: () => q,
    lean: () => q,
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

const SUBJECT = { _id: 'subj-exp106', name: 'Examination Preparation', code: 'EXP106' };
const TUTOR_STUB = { role: 'tutor', isActive: true, deletedAt: null, employmentType: 'full-time', availability: '' };
const TEST_DATE = new Date('2026-10-05T00:00:00.000Z'); // Monday

test('markTutorUnavailability: the affected-sessions query matches BOTH primary `tutor` and co-tutor `tutors[]`', async () => {
  const origUserFindOne = User.findOne;
  const origScheduleFind = Schedule.find;
  let capturedScheduleFindQuery = null;

  User.findOne = ({ _id }) => mockQuery({ _id, ...TUTOR_STUB, firstName: 'Mariana', lastName: 'Luis' });
  Schedule.find = (query) => {
    if (query.$or && query.date) { capturedScheduleFindQuery = query; return mockQuery([]); } // affected-sessions query
    return mockQuery([]); // admin notify lookups etc. fall through elsewhere
  };
  try {
    const res = mockRes();
    await markTutorUnavailability({
      user: { id: 'admin-1' },
      body: { tutorId: 'mariana', startDate: '2026-10-05', endDate: '2026-10-05', reason: 'Sick', autoAssign: true },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.ok(capturedScheduleFindQuery, 'expected a query with $or + date to have run');
    assert.deepEqual(capturedScheduleFindQuery.$or, [{ tutor: 'mariana' }, { tutors: 'mariana' }]);
  } finally { User.findOne = origUserFindOne; Schedule.find = origScheduleFind; }
});

test('markTutorUnavailability: single-tutor 1-on-1 session with a valid replacement reassigns successfully (not silently 0/0)', async () => {
  const origUserFindOne = User.findOne;
  const origUserFind = User.find;
  const origScheduleFindById = Schedule.findById;
  const origScheduleFind = Schedule.find;
  const origScheduleAggregate = Schedule.aggregate;
  const origTutorUnavailabilityExists = TutorUnavailability.exists;
  const origLogCreate = ScheduleSubstitutionLog.create;

  const schedule = {
    _id: 'sched-1on1', sessionType: 'one-on-one', date: TEST_DATE, startTime: '09:00', endTime: '10:00',
    subject: SUBJECT, student: null, students: [],
    tutor: { _id: 'mariana', firstName: 'Mariana', lastName: 'Luis', email: 'mariana@example.com' },
    tutors: ['mariana'], originalTutor: null, substituteTutor: null,
    substitutionStatus: 'none', substitutionAttemptCount: 0,
  };
  schedule.save = async () => schedule;

  User.findOne = ({ _id }) => {
    if (_id === 'mariana') return mockQuery({ _id, ...TUTOR_STUB, firstName: 'Mariana', lastName: 'Luis', email: 'mariana@example.com' });
    return mockQuery({ _id, ...TUTOR_STUB }); // canTutorHandleSchedule's own lookup for any candidate
  };
  User.find = (query) => {
    if (query.role?.$in) return mockQuery([]); // notifyNoSubstituteAlert's admin lookup — never hit on a success path anyway
    if (query._id?.$nin) return mockQuery([{ _id: 'replacement-tutor', employmentType: 'full-time', createdAt: new Date() }]); // findSubstituteTutorForSchedule candidates
    return mockQuery([]);
  };
  Schedule.findById = () => mockQuery(schedule);
  Schedule.find = (query) => {
    if (query.$or && query.date) return mockQuery([schedule]); // the affected-sessions query — returns our one session
    return mockQuery([]); // conflict checks etc. — no other sessions exist
  };
  Schedule.aggregate = async () => []; // findSubstituteTutorForSchedule's workload-ranking query — no existing load
  TutorUnavailability.exists = async () => false;
  ScheduleSubstitutionLog.create = async () => [{}];

  try {
    const res = mockRes();
    await markTutorUnavailability({
      user: { id: 'admin-1' },
      body: { tutorId: 'mariana', startDate: '2026-10-05', endDate: '2026-10-05', reason: 'Sick', autoAssign: true },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.affectedSchedules, 1);
    assert.equal(res._body.reassigned.length, 1, 'expected the one session to be auto-reassigned, not silently reported as 0/0');
    assert.equal(res._body.unresolved.length, 0);
    assert.equal(String(schedule.tutor), 'replacement-tutor');
  } finally {
    User.findOne = origUserFindOne; User.find = origUserFind;
    Schedule.findById = origScheduleFindById; Schedule.find = origScheduleFind; Schedule.aggregate = origScheduleAggregate;
    TutorUnavailability.exists = origTutorUnavailabilityExists; ScheduleSubstitutionLog.create = origLogCreate;
  }
});

test('markTutorUnavailability: no eligible replacement exists — reports unresolved:1, never silently 0/0', async () => {
  const origUserFindOne = User.findOne;
  const origUserFind = User.find;
  const origScheduleFindById = Schedule.findById;
  const origScheduleFind = Schedule.find;
  const origTutorUnavailabilityExists = TutorUnavailability.exists;
  const origLogCreate = ScheduleSubstitutionLog.create;

  const schedule = {
    _id: 'sched-1on1-b', sessionType: 'one-on-one', date: TEST_DATE, startTime: '09:00', endTime: '10:00',
    subject: SUBJECT, student: null, students: [],
    tutor: { _id: 'mariana', firstName: 'Mariana', lastName: 'Luis', email: 'mariana@example.com' },
    tutors: ['mariana'], originalTutor: null, substituteTutor: null,
    substitutionStatus: 'none', substitutionAttemptCount: 0,
  };
  schedule.save = async () => schedule;

  User.findOne = ({ _id }) => mockQuery({ _id, ...TUTOR_STUB });
  User.find = (query) => {
    if (query.role?.$in) return mockQuery([{ _id: 'admin-x', email: 'admin@example.com', firstName: 'A', lastName: 'B' }]);
    if (query._id?.$nin) return mockQuery([]); // no candidates at all
    return mockQuery([]);
  };
  Schedule.findById = () => mockQuery(schedule);
  Schedule.find = (query) => {
    if (query.$or && query.date) return mockQuery([schedule]);
    return mockQuery([]);
  };
  TutorUnavailability.exists = async () => false;
  ScheduleSubstitutionLog.create = async () => [{}];

  try {
    const res = mockRes();
    await markTutorUnavailability({
      user: { id: 'admin-1' },
      body: { tutorId: 'mariana', startDate: '2026-10-05', endDate: '2026-10-05', reason: 'Sick', autoAssign: true },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.affectedSchedules, 1);
    assert.equal(res._body.reassigned.length, 0);
    assert.equal(res._body.unresolved.length, 1, 'a genuinely unresolvable session must be reported, not silently dropped');
  } finally {
    User.findOne = origUserFindOne; User.find = origUserFind;
    Schedule.findById = origScheduleFindById; Schedule.find = origScheduleFind;
    TutorUnavailability.exists = origTutorUnavailabilityExists; ScheduleSubstitutionLog.create = origLogCreate;
  }
});

test('markTutorUnavailability: multi-tutor Playgroup session — marking a CO-tutor unavailable replaces only that co-tutor, primary untouched', async () => {
  const origUserFindOne = User.findOne;
  const origUserFind = User.find;
  const origScheduleFindById = Schedule.findById;
  const origScheduleFind = Schedule.find;
  const origScheduleAggregate = Schedule.aggregate;
  const origTutorUnavailabilityExists = TutorUnavailability.exists;
  const origLogCreate = ScheduleSubstitutionLog.create;

  const pgSchedule = {
    _id: 'sched-pg', sessionType: 'playgroup', date: TEST_DATE, startTime: '13:00', endTime: '15:00',
    subject: { _id: 'subj-tpg101', name: 'Toddlers Playgroup', code: 'TPG101' },
    student: null, students: [],
    tutor: { _id: 'jake', firstName: 'Jake', lastName: 'Soriano', email: 'jake@example.com' },
    tutors: ['jake', 'mariana'], originalTutor: null, substituteTutor: null,
    substitutionStatus: 'none', substitutionAttemptCount: 0,
  };
  pgSchedule.save = async () => pgSchedule;

  User.findOne = ({ _id }) => mockQuery({ _id, ...TUTOR_STUB });
  User.find = (query) => {
    if (query.role?.$in) return mockQuery([]);
    if (query._id?.$nin) {
      // Jake and the currently-assigned co-tutor must never be offered as "the replacement".
      assert.ok(query._id.$nin.includes('jake'), 'the primary tutor must be excluded from replacement candidates');
      assert.ok(query._id.$nin.includes('mariana'), 'the tutor being marked unavailable must be excluded from replacement candidates');
      return mockQuery([{ _id: 'maria-co', employmentType: 'full-time', createdAt: new Date() }]);
    }
    return mockQuery([]);
  };
  Schedule.findById = () => mockQuery(pgSchedule);
  Schedule.find = (query) => {
    if (query.$or && query.date) return mockQuery([pgSchedule]);
    return mockQuery([]);
  };
  Schedule.aggregate = async () => [];
  TutorUnavailability.exists = async () => false;
  ScheduleSubstitutionLog.create = async () => [{}];

  try {
    const res = mockRes();
    // Marking MARIANA (the co-tutor) unavailable — Jake, the primary, is unaffected.
    await markTutorUnavailability({
      user: { id: 'admin-1' },
      body: { tutorId: 'mariana', startDate: '2026-10-05', endDate: '2026-10-05', reason: 'Sick', autoAssign: true },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.reassigned.length, 1);
    assert.equal(String(pgSchedule.tutor?._id || pgSchedule.tutor), 'jake', 'the primary tutor field must stay Jake — he was never the one marked unavailable');
    assert.deepEqual(pgSchedule.tutors.map(String), ['jake', 'maria-co'], 'only Mariana\'s slot in tutors[] should be replaced');
  } finally {
    User.findOne = origUserFindOne; User.find = origUserFind;
    Schedule.findById = origScheduleFindById; Schedule.find = origScheduleFind; Schedule.aggregate = origScheduleAggregate;
    TutorUnavailability.exists = origTutorUnavailabilityExists; ScheduleSubstitutionLog.create = origLogCreate;
  }
});

// ── Multi-select "Mark Tutor Unavailable" follow-up (Group AD) ────────────────────────────
test('markTutorUnavailability: marking TWO different co-tutors unavailable (sequential calls, same session) reassigns BOTH — the second is not silently skipped once the first succeeds', async () => {
  const origUserFindOne = User.findOne;
  const origUserFind = User.find;
  const origScheduleFindById = Schedule.findById;
  const origScheduleFind = Schedule.find;
  const origScheduleAggregate = Schedule.aggregate;
  const origTutorUnavailabilityExists = TutorUnavailability.exists;
  const origLogCreate = ScheduleSubstitutionLog.create;

  const pgSchedule = {
    _id: 'sched-pg-multi', sessionType: 'playgroup', date: TEST_DATE, startTime: '09:00', endTime: '11:00',
    subject: { _id: 'subj-tpg101', name: 'Toddlers Playgroup', code: 'TPG101' },
    student: null, students: [],
    tutor: { _id: 'jake', firstName: 'Jake', lastName: 'Soriano', email: 'jake@example.com' },
    tutors: ['jake', 'mariana', 'carlos'], originalTutor: null, substituteTutor: null,
    substitutionStatus: 'none', substitutionAttemptCount: 0,
  };
  pgSchedule.save = async () => pgSchedule;

  User.findOne = ({ _id }) => mockQuery({ _id, ...TUTOR_STUB });
  User.find = (query) => {
    if (query.role?.$in) return mockQuery([]);
    if (query._id?.$nin) {
      // Whichever candidate the FIRST call already picked is excluded from the second call's
      // pool (it's now in tutors[]) — exactly like two real sequential requests.
      const excluded = query._id.$nin;
      const pool = [
        { _id: 'replacement-x', employmentType: 'full-time', createdAt: new Date('2026-01-01') },
        { _id: 'replacement-y', employmentType: 'full-time', createdAt: new Date('2026-01-02') },
      ];
      return mockQuery(pool.filter((c) => !excluded.includes(c._id)));
    }
    return mockQuery([]);
  };
  Schedule.findById = () => mockQuery(pgSchedule);
  Schedule.find = (query) => {
    if (query.$or && query.date) return mockQuery([pgSchedule]);
    return mockQuery([]);
  };
  Schedule.aggregate = async () => [];
  TutorUnavailability.exists = async () => false;
  ScheduleSubstitutionLog.create = async () => [{}];

  try {
    const res1 = mockRes();
    await markTutorUnavailability({
      user: { id: 'admin-1' },
      body: { tutorId: 'mariana', startDate: '2026-10-05', endDate: '2026-10-05', reason: 'Sick', autoAssign: true },
    }, res1);
    assert.equal(res1._status, 200, JSON.stringify(res1._body));
    assert.equal(res1._body.reassigned.length, 1, 'first co-tutor should be reassigned');

    // Before the fix: processSubstitutionForSchedule's idempotency guard checked the
    // WHOLE schedule's substitutionStatus ('assigned' after the first call above) rather
    // than whether THIS specific tutor still needed resolving — so this second call would
    // hit `skipped: true` and silently do nothing, even though Carlos was never touched.
    const res2 = mockRes();
    await markTutorUnavailability({
      user: { id: 'admin-1' },
      body: { tutorId: 'carlos', startDate: '2026-10-05', endDate: '2026-10-05', reason: 'Sick', autoAssign: true },
    }, res2);
    assert.equal(res2._status, 200, JSON.stringify(res2._body));
    assert.equal(res2._body.reassigned.length, 1, 'second co-tutor must ALSO be reassigned, not silently skipped');
    assert.equal(res2._body.unresolved.length, 0);

    assert.deepEqual(
      pgSchedule.tutors.map(String),
      ['jake', 'replacement-x', 'replacement-y'],
      'Jake untouched; Mariana and Carlos each independently replaced by a different tutor'
    );
  } finally {
    User.findOne = origUserFindOne; User.find = origUserFind;
    Schedule.findById = origScheduleFindById; Schedule.find = origScheduleFind; Schedule.aggregate = origScheduleAggregate;
    TutorUnavailability.exists = origTutorUnavailabilityExists; ScheduleSubstitutionLog.create = origLogCreate;
  }
});
