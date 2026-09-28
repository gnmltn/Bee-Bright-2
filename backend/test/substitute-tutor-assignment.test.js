/**
 * "bug (7).pdf" Group X/Y — Assign Substitute Tutor.
 *
 * Root cause: processSubstitutionForSchedule only ever wrote the replacement to
 * `schedule.tutor` (the single primary field), never `schedule.tutors[]` (the roster
 * array a Toddlers Playgroup session's Schedule Details panel actually reads for its
 * multi-tutor display) — so a substitution was genuinely saved to the DB, but a
 * Playgroup session's tutor LIST never reflected it, before or after a refresh.
 * Fixed to always sync `tutors[]`, with an explicit `replacedTutorId` to resolve which
 * of several currently-assigned tutors is being substituted (only relevant when there is
 * more than one — a 1-on-1 session has no such ambiguity).
 *
 * Also covers getTutorsBySubject's new qualification + conflict filtering (previously
 * returned literally every active tutor regardless of subject or availability).
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

const { assignSubstituteTutor, getTutorsBySubject } = require('../controllers/scheduleController');

function mockQuery(result) {
  const q = {
    select: () => q,
    sort: () => q,
    populate: () => q,
    limit: () => q,
    session: () => q,
    // Real Mongoose: .lean() just flags the (still-chainable, still-awaitable) query —
    // it doesn't execute early. Some call sites chain .session() AFTER .lean(), so this
    // must keep returning `q` itself, not a settled Promise.
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

const SUBJECT_TPG101 = { _id: 'subj-tpg101', name: 'Toddlers Playgroup', code: 'TPG101' };
const TUTOR_STUB = { role: 'tutor', isActive: true, deletedAt: null, employmentType: 'full-time', availability: '' };

function makePlaygroupSchedule(overrides = {}) {
  const doc = {
    _id: 'sched-pg-1',
    sessionType: 'playgroup',
    date: new Date('2026-09-28T00:00:00.000Z'),
    startTime: '13:00',
    endTime: '15:00',
    subject: SUBJECT_TPG101,
    student: null,
    students: [],
    tutor: { _id: 'jake', firstName: 'Jake', lastName: 'Soriano', email: 'jake@example.com' },
    tutors: ['jake', 'mariana'],
    originalTutor: null,
    substituteTutor: null,
    substitutionStatus: 'none',
    substitutionAttemptCount: 0,
    ...overrides,
  };
  doc.save = async () => doc;
  return doc;
}

function stubCommon({ schedule, extraTutorLookups = {} }) {
  const origScheduleFindById = Schedule.findById;
  const origScheduleFind = Schedule.find;
  const origUserFindOne = User.findOne;
  const origUserFindById = User.findById;
  const origTutorUnavailabilityExists = TutorUnavailability.exists;
  const origLogCreate = ScheduleSubstitutionLog.create;

  // Same mutable doc returned every time — mutations from processSubstitutionForSchedule
  // are visible to the controller's own "refetch populated" query afterward, just like a
  // real DB round-trip would show them.
  Schedule.findById = () => mockQuery(schedule);
  Schedule.find = () => mockQuery([]); // no other sessions => never a conflict by default
  User.findOne = ({ _id }) => mockQuery({ _id, ...TUTOR_STUB, ...(extraTutorLookups[_id] || {}) });
  User.findById = (id) => mockQuery({ _id: id, firstName: extraTutorLookups[id]?.firstName || 'New', lastName: extraTutorLookups[id]?.lastName || 'Tutor', email: `${id}@example.com` });
  TutorUnavailability.exists = async () => false;
  ScheduleSubstitutionLog.create = async () => [{}];

  return {
    restore() {
      Schedule.findById = origScheduleFindById;
      Schedule.find = origScheduleFind;
      User.findOne = origUserFindOne;
      User.findById = origUserFindById;
      TutorUnavailability.exists = origTutorUnavailabilityExists;
      ScheduleSubstitutionLog.create = origLogCreate;
    },
  };
}

test('assignSubstituteTutor: single-tutor (1-on-1) session — replaces both `tutor` and `tutors[]`', async () => {
  const schedule = makePlaygroupSchedule({ sessionType: 'one-on-one', tutors: ['jake'] });
  const { restore } = stubCommon({ schedule });
  try {
    const res = mockRes();
    await assignSubstituteTutor({ params: { id: 'sched-pg-1' }, user: { id: 'admin-1' }, body: { replacementTutorId: 'maria' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(String(schedule.tutor), 'maria');
    assert.deepEqual(schedule.tutors.map(String), ['maria']);
  } finally { restore(); }
});

test('assignSubstituteTutor: multi-tutor Playgroup session — replacing a CO-tutor (not primary) only touches that one slot', async () => {
  const schedule = makePlaygroupSchedule(); // tutor: jake (primary), tutors: [jake, mariana]
  const { restore } = stubCommon({ schedule });
  try {
    const res = mockRes();
    await assignSubstituteTutor({
      params: { id: 'sched-pg-1' },
      user: { id: 'admin-1' },
      body: { replacementTutorId: 'maria-co', replacedTutorId: 'mariana' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    // Primary `tutor` untouched — Jake was never the one being replaced.
    assert.equal(String(schedule.tutor?._id || schedule.tutor), 'jake');
    // tutors[] has Mariana swapped for Maria Co; Jake stays exactly where he was.
    assert.deepEqual(schedule.tutors.map(String), ['jake', 'maria-co']);
  } finally { restore(); }
});

test('assignSubstituteTutor: multi-tutor session — replacing the PRIMARY tutor syncs both `tutor` and `tutors[]`', async () => {
  const schedule = makePlaygroupSchedule();
  const { restore } = stubCommon({ schedule });
  try {
    const res = mockRes();
    await assignSubstituteTutor({
      params: { id: 'sched-pg-1' },
      user: { id: 'admin-1' },
      body: { replacementTutorId: 'maria-co', replacedTutorId: 'jake' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(String(schedule.tutor), 'maria-co');
    assert.deepEqual(schedule.tutors.map(String), ['maria-co', 'mariana']);
  } finally { restore(); }
});

test('assignSubstituteTutor: rejects a replacedTutorId that is not actually assigned to this session', async () => {
  const schedule = makePlaygroupSchedule();
  const { restore } = stubCommon({ schedule });
  try {
    const res = mockRes();
    await assignSubstituteTutor({
      params: { id: 'sched-pg-1' },
      user: { id: 'admin-1' },
      body: { replacementTutorId: 'maria-co', replacedTutorId: 'someone-else-entirely' },
    }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /not currently assigned/i);
  } finally { restore(); }
});

test('assignSubstituteTutor: rejects a replacement tutor who is already assigned to this session (the other co-tutor)', async () => {
  const schedule = makePlaygroupSchedule();
  const { restore } = stubCommon({ schedule });
  try {
    const res = mockRes();
    // Trying to "replace" Jake with Mariana, who is already the other co-tutor on this
    // very session — nonsensical, must be rejected.
    await assignSubstituteTutor({
      params: { id: 'sched-pg-1' },
      user: { id: 'admin-1' },
      body: { replacementTutorId: 'mariana', replacedTutorId: 'jake' },
    }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /already assigned/i);
  } finally { restore(); }
});

test('assignSubstituteTutor: response includes a populated `tutors` array so the frontend can sync its detail panel immediately', async () => {
  const schedule = makePlaygroupSchedule();
  const { restore } = stubCommon({ schedule });
  try {
    const res = mockRes();
    await assignSubstituteTutor({
      params: { id: 'sched-pg-1' },
      user: { id: 'admin-1' },
      body: { replacementTutorId: 'maria-co', replacedTutorId: 'mariana' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.ok(Array.isArray(res._body.schedule.tutors));
    assert.deepEqual(res._body.schedule.tutors.map(String), ['jake', 'maria-co']);
  } finally { restore(); }
});

test('getTutorsBySubject: ALL active tutors are eligible regardless of subject — no subjectsTaught filter — only excludeTutorIds is applied', async () => {
  // Corrected per a follow-up ("bug (7).pdf" Group X correction): there is no per-program
  // qualification restriction — every active tutor can handle Toddlers Playgroup, Academic
  // Tutorial, or Examination Preparation. An earlier version of this fix wrongly filtered
  // by subjectsTaught, excluding valid tutors who simply hadn't been tagged for a subject.
  const origUserFind = User.find;
  let capturedQuery = null;
  User.find = (query) => {
    capturedQuery = query;
    return mockQuery([
      { _id: 'any-tutor-1', firstName: 'Any', lastName: 'One', ...TUTOR_STUB },
      { _id: 'any-tutor-2', firstName: 'Any', lastName: 'Two', ...TUTOR_STUB },
    ]);
  };
  try {
    const res = mockRes();
    await getTutorsBySubject({ query: { subjectId: SUBJECT_TPG101._id, excludeTutorIds: 'jake,mariana' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.ok(!('subjectsTaught' in capturedQuery), 'the query must not filter by subjectsTaught at all');
    assert.equal(res._body.tutors.length, 2);
    assert.deepEqual(res._body.tutors.map((t) => t._id).sort(), ['any-tutor-1', 'any-tutor-2']);
  } finally { User.find = origUserFind; }
});

test('getTutorsBySubject: a part-time tutor outside their availability window is excluded, but appears for a slot within it', async () => {
  const origUserFind = User.find;
  const origUserFindOne = User.findOne;
  const origScheduleFind = Schedule.find;
  const origTutorUnavailabilityExists = TutorUnavailability.exists;
  // "Mon, Wed 8:00 AM - 2:00 PM" style string, same format as Add Tutor's own field.
  const partTimeAvailability = 'Mon 1:00 PM - 5:00 PM; Wed 1:00 PM - 5:00 PM';
  const partTimeTutor = { _id: 'parttime-tutor', firstName: 'Part', lastName: 'Time', role: 'tutor', isActive: true, deletedAt: null, employmentType: 'part-time', availability: partTimeAvailability };
  User.find = () => mockQuery([partTimeTutor]);
  User.findOne = ({ _id }) => mockQuery({ ...partTimeTutor, _id });
  TutorUnavailability.exists = async () => false;
  Schedule.find = () => mockQuery([]); // never a conflict — isolating the availability-window check
  try {
    // 2026-09-28 is a Monday.
    const outsideRes = mockRes();
    await getTutorsBySubject({ query: { subjectId: SUBJECT_TPG101._id, date: '2026-09-28', startTime: '08:00', endTime: '10:00' } }, outsideRes);
    assert.equal(outsideRes._body.tutors.length, 0, 'a part-time tutor must not appear for a slot entirely outside their stored availability');

    const insideRes = mockRes();
    await getTutorsBySubject({ query: { subjectId: SUBJECT_TPG101._id, date: '2026-09-28', startTime: '13:00', endTime: '15:00' } }, insideRes);
    assert.equal(insideRes._body.tutors.length, 1, 'the same tutor must appear for a slot within their available hours');
    assert.equal(insideRes._body.tutors[0]._id, 'parttime-tutor');
  } finally { User.find = origUserFind; User.findOne = origUserFindOne; Schedule.find = origScheduleFind; TutorUnavailability.exists = origTutorUnavailabilityExists; }
});

test('getTutorsBySubject: with date+startTime given, drops a tutor who already has a conflicting session', async () => {
  const origUserFind = User.find;
  const origUserFindOne = User.findOne;
  const origScheduleFind = Schedule.find;
  const origTutorUnavailabilityExists = TutorUnavailability.exists;
  User.find = () => mockQuery([
    { _id: 'free-tutor', ...TUTOR_STUB },
    { _id: 'busy-tutor', ...TUTOR_STUB },
  ]);
  // canTutorHandleSchedule re-fetches the candidate via User.findOne to check role/active/availability.
  User.findOne = ({ _id }) => mockQuery({ _id, ...TUTOR_STUB });
  TutorUnavailability.exists = async () => false;
  Schedule.find = (query) => {
    const ids = query.$or?.map((c) => c.tutor || c.tutors).filter(Boolean) || [];
    const busy = ids.includes('busy-tutor');
    return mockQuery(busy ? [{ tutor: 'busy-tutor', student: null, startTime: '13:00', endTime: '15:00' }] : []);
  };
  try {
    const res = mockRes();
    await getTutorsBySubject({ query: { subjectId: SUBJECT_TPG101._id, date: '2026-09-28', startTime: '13:00', endTime: '15:00' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const ids = res._body.tutors.map((t) => t._id);
    assert.ok(ids.includes('free-tutor'));
    assert.ok(!ids.includes('busy-tutor'), 'a tutor with a conflicting session must be excluded');
  } finally { User.find = origUserFind; User.findOne = origUserFindOne; Schedule.find = origScheduleFind; TutorUnavailability.exists = origTutorUnavailabilityExists; }
});
