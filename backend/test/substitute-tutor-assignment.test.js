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
const Enrollment = require('../models/Enrollment');
const emailService = require('../utils/emailService');
const capturedEmails = [];
emailService.sendEmail = async (opts) => { capturedEmails.push(opts); return { success: true }; };
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

function stubCommon({ schedule, extraTutorLookups = {}, enrollments = [], coTutorStillSubstituted = false }) {
  const origScheduleFindById = Schedule.findById;
  const origScheduleFind = Schedule.find;
  const origUserFindOne = User.findOne;
  const origUserFindById = User.findById;
  const origTutorUnavailabilityExists = TutorUnavailability.exists;
  const origLogCreate = ScheduleSubstitutionLog.create;
  const origLogExists = ScheduleSubstitutionLog.exists;
  const origEnrollmentFind = Enrollment.find;

  // Same mutable doc returned every time — mutations from processSubstitutionForSchedule
  // are visible to the controller's own "refetch populated" query afterward, just like a
  // real DB round-trip would show them.
  Schedule.findById = () => mockQuery(schedule);
  Schedule.find = () => mockQuery([]); // no other sessions => never a conflict by default
  User.findOne = ({ _id }) => mockQuery({ _id, ...TUTOR_STUB, ...(extraTutorLookups[_id] || {}) });
  User.findById = (id) => mockQuery({ _id: id, firstName: extraTutorLookups[id]?.firstName || 'New', lastName: extraTutorLookups[id]?.lastName || 'Tutor', email: `${id}@example.com` });
  TutorUnavailability.exists = async () => false;
  ScheduleSubstitutionLog.create = async () => [{}];
  // "Revert to original tutor" clean-baseline check — whether some OTHER currently-assigned
  // (Playgroup co-)tutor still has a live substitution of their own. False by default.
  ScheduleSubstitutionLog.exists = async () => coTutorStillSubstituted;
  // Playgroup parent-notification lookup — empty by default (no parent found => no parent
  // emails sent); tests that care about it pass their own `enrollments` fixture.
  Enrollment.find = () => mockQuery(enrollments);

  return {
    restore() {
      Schedule.findById = origScheduleFindById;
      Schedule.find = origScheduleFind;
      User.findOne = origUserFindOne;
      User.findById = origUserFindById;
      TutorUnavailability.exists = origTutorUnavailabilityExists;
      ScheduleSubstitutionLog.create = origLogCreate;
      ScheduleSubstitutionLog.exists = origLogExists;
      Enrollment.find = origEnrollmentFind;
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

// ── "Revert to original tutor" ("what to do (10).pdf") ────────────────────────────────────
test('assignSubstituteTutor: a fresh (non-revert) substitution still sets isSubstitution/substitutionStatus normally — no regression', async () => {
  const schedule = makePlaygroupSchedule({ sessionType: 'one-on-one', tutors: ['jake'], isSubstitution: false, substitutionStatus: 'none' });
  const { restore } = stubCommon({ schedule });
  try {
    const res = mockRes();
    await assignSubstituteTutor({ params: { id: 'sched-pg-1' }, user: { id: 'admin-1' }, body: { replacementTutorId: 'maria', reason: 'Tutor is sick' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(schedule.isSubstitution, true);
    assert.equal(schedule.substitutionStatus, 'assigned');
    assert.equal(String(schedule.originalTutor), 'jake');
    assert.equal(String(schedule.substituteTutor), 'maria');
    assert.equal(schedule.substitutionReason, 'Tutor is sick');
  } finally { restore(); }
});

test('assignSubstituteTutor: reverting a 1-on-1 session\'s substitute back to the original tutor clears the substitution flags cleanly', async () => {
  const schedule = makePlaygroupSchedule({
    sessionType: 'one-on-one',
    tutor: { _id: 'jake', firstName: 'Jake', lastName: 'Soriano', email: 'jake@example.com' }, // the CURRENT substitute
    tutors: ['jake'],
    // Populated, not a bare id string — the real query populates `originalTutor` for
    // display, and a same-value comparison against it must unwrap `_id` or it silently
    // never matches (caught live: String({...}) !== any tutor's hex id).
    originalTutor: { _id: 'orig-tutor', firstName: 'Original', lastName: 'Tutor', email: 'orig-tutor@example.com' },
    substituteTutor: 'jake',
    isSubstitution: true,
    substitutionStatus: 'assigned',
    substitutionReason: 'Tutor unavailable',
  });
  capturedEmails.length = 0;
  const { restore } = stubCommon({ schedule, extraTutorLookups: { 'orig-tutor': { firstName: 'Original', lastName: 'Tutor' } } });
  try {
    const res = mockRes();
    await assignSubstituteTutor({
      params: { id: 'sched-pg-1' },
      user: { id: 'admin-1' },
      body: { replacementTutorId: 'orig-tutor', replacedTutorId: 'jake', reason: 'Reverted to original tutor' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(String(schedule.tutor), 'orig-tutor', 'the primary tutor field must show the original tutor again');
    assert.deepEqual(schedule.tutors.map(String), ['orig-tutor']);
    assert.equal(schedule.isSubstitution, false, 'no leftover "substitute assigned" flag once genuinely back to the original tutor');
    assert.equal(schedule.substitutionStatus, 'none');
    assert.equal(schedule.originalTutor, null, 'nothing left to track — the schedule is back to its pre-substitution baseline');
    assert.equal(schedule.substituteTutor, null);
    assert.equal(schedule.substitutionReason, 'Reverted to original tutor', 'the log/notification reason must reflect what actually just happened, not silently reset');

    // Both the outgoing substitute (Jake) and the returning original tutor must be notified,
    // and BOTH emails must carry the real reason, not a stale/fallback "Tutor unavailable".
    // (The replacement-tutor lookup is a fresh User.findById, whose stub always computes
    // `${id}@example.com` regardless of extraTutorLookups — only the name fields honor it.)
    const toJake = capturedEmails.find((e) => e.to === 'jake@example.com');
    const toOriginal = capturedEmails.find((e) => e.to === 'orig-tutor@example.com');
    assert.ok(toJake, 'expected the outgoing substitute to be notified');
    assert.ok(toOriginal, 'expected the returning original tutor to be notified');
    assert.match(toJake.text, /Reason: Reverted to original tutor/);
    assert.match(toOriginal.text, /Reason: Reverted to original tutor/);
    assert.doesNotMatch(toOriginal.text, /Reason: Tutor unavailable/);
  } finally { restore(); }
});

test('assignSubstituteTutor: reverting a Playgroup session\'s PRIMARY tutor while a co-tutor is STILL substituted keeps isSubstitution true', async () => {
  const schedule = makePlaygroupSchedule({
    tutor: { _id: 'jake', firstName: 'Jake', lastName: 'Soriano', email: 'jake@example.com' }, // current substitute in the PRIMARY seat
    tutors: ['jake', 'maria-co'], // maria-co is a co-tutor who is ALSO currently a live substitute
    originalTutor: { _id: 'orig-tutor', firstName: 'Original', lastName: 'Tutor', email: 'orig-tutor@example.com' },
    substituteTutor: 'jake',
    isSubstitution: true,
    substitutionStatus: 'assigned',
  });
  const { restore } = stubCommon({
    schedule,
    extraTutorLookups: { 'orig-tutor': { firstName: 'Original', lastName: 'Tutor' } },
    coTutorStillSubstituted: true, // maria-co's own substitution log entry still exists
  });
  try {
    const res = mockRes();
    await assignSubstituteTutor({
      params: { id: 'sched-pg-1' },
      user: { id: 'admin-1' },
      body: { replacementTutorId: 'orig-tutor', replacedTutorId: 'jake', reason: 'Reverted to original tutor' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(String(schedule.tutor), 'orig-tutor', 'the primary seat itself is correctly restored');
    assert.deepEqual(schedule.tutors.map(String), ['orig-tutor', 'maria-co'], 'the co-tutor is left completely untouched');
    assert.equal(schedule.isSubstitution, true, 'the whole session still has an active substitute (maria-co) — the flag must not be cleared');
    assert.equal(schedule.substitutionStatus, 'assigned');
  } finally { restore(); }
});

// ── Substitution-notification email "Student" field ("Student: Unknown" bug) ──────────────
test('notifyScheduleSubstitution: 1-on-1 session shows the enrolled student\'s real name, not "Unknown"', async () => {
  capturedEmails.length = 0;
  const schedule = makePlaygroupSchedule({
    sessionType: 'one-on-one',
    tutors: ['jake'],
    student: { _id: 'kid-1', firstName: 'Ana', lastName: 'Cruz', email: 'ana.parent@example.com' },
  });
  const { restore } = stubCommon({ schedule });
  try {
    const res = mockRes();
    await assignSubstituteTutor({ params: { id: 'sched-pg-1' }, user: { id: 'admin-1' }, body: { replacementTutorId: 'maria' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const toReplacement = capturedEmails.find((e) => e.subject === 'Bee Bright schedule update: you were assigned as substitute tutor');
    assert.ok(toReplacement, 'expected the "assigned as substitute tutor" email to have been sent');
    assert.match(toReplacement.text, /Student: Ana Cruz/);
    assert.doesNotMatch(toReplacement.text, /Student: Unknown/);
    assert.match(toReplacement.html, /Ana Cruz/);
  } finally { restore(); }
});

test('notifyScheduleSubstitution: Toddlers Playgroup session lists every enrolled child, not just "Unknown"', async () => {
  capturedEmails.length = 0;
  const schedule = makePlaygroupSchedule({
    students: [
      { _id: 'kid-1', firstName: 'Ana', lastName: 'Cruz', email: 'a@example.com' },
      { _id: 'kid-2', firstName: 'Ben', lastName: 'Santos', email: 'b@example.com' },
    ],
  });
  const { restore } = stubCommon({ schedule });
  try {
    const res = mockRes();
    await assignSubstituteTutor({
      params: { id: 'sched-pg-1' },
      user: { id: 'admin-1' },
      body: { replacementTutorId: 'maria-co', replacedTutorId: 'mariana' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const toReplacement = capturedEmails.find((e) => e.subject === 'Bee Bright schedule update: you were assigned as substitute tutor');
    assert.ok(toReplacement, 'expected the "assigned as substitute tutor" email to have been sent');
    assert.match(toReplacement.text, /Student: Ana Cruz, Ben Santos/);
    assert.doesNotMatch(toReplacement.text, /Student: Unknown/);
  } finally { restore(); }
});

test('notifyScheduleSubstitution: a genuinely-empty Playgroup roster still falls back to "Unknown" (no crash)', async () => {
  capturedEmails.length = 0;
  const schedule = makePlaygroupSchedule(); // student: null, students: [] — nobody actually enrolled
  const { restore } = stubCommon({ schedule });
  try {
    const res = mockRes();
    await assignSubstituteTutor({
      params: { id: 'sched-pg-1' },
      user: { id: 'admin-1' },
      body: { replacementTutorId: 'maria-co', replacedTutorId: 'mariana' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const toReplacement = capturedEmails.find((e) => e.subject === 'Bee Bright schedule update: you were assigned as substitute tutor');
    assert.match(toReplacement.text, /Student: Unknown/);
  } finally { restore(); }
});

// ── Playgroup parent notification (each enrolled child's own parent, one email each) ──────
test('notifyScheduleSubstitution: Toddlers Playgroup — each enrolled child\'s OWN parent gets a separate email with only their own child\'s info', async () => {
  capturedEmails.length = 0;
  const schedule = makePlaygroupSchedule({
    students: [
      { _id: 'kid-1', firstName: 'Ana', lastName: 'Cruz', email: 'a@example.com' },
      { _id: 'kid-2', firstName: 'Ben', lastName: 'Santos', email: 'b@example.com' },
    ],
  });
  const enrollments = [
    { student: 'kid-1', parent: { _id: 'parent-1', firstName: 'Carla', lastName: 'Cruz', email: 'carla.cruz@example.com' } },
    { student: 'kid-2', parent: { _id: 'parent-2', firstName: 'David', lastName: 'Santos', email: 'david.santos@example.com' } },
  ];
  const { restore } = stubCommon({ schedule, enrollments });
  try {
    const res = mockRes();
    await assignSubstituteTutor({
      params: { id: 'sched-pg-1' },
      user: { id: 'admin-1' },
      body: { replacementTutorId: 'maria-co', replacedTutorId: 'mariana' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));

    const toParents = capturedEmails.filter((e) => e.to === 'carla.cruz@example.com' || e.to === 'david.santos@example.com');
    assert.equal(toParents.length, 2, 'expected exactly one email per parent, not one combined email');

    const toCarla = toParents.find((e) => e.to === 'carla.cruz@example.com');
    assert.match(toCarla.text, /Ana Cruz/);
    assert.doesNotMatch(toCarla.text, /Ben Santos/, 'a parent must never see another child\'s name');
    assert.match(toCarla.text, /Toddlers Playgroup/);
    assert.match(toCarla.html, /Ana Cruz/);

    const toDavid = toParents.find((e) => e.to === 'david.santos@example.com');
    assert.match(toDavid.text, /Ben Santos/);
    assert.doesNotMatch(toDavid.text, /Ana Cruz/, 'a parent must never see another child\'s name');
  } finally { restore(); }
});

test('notifyScheduleSubstitution: 1-on-1 session never triggers the Playgroup-parent path (existing student notification unaffected)', async () => {
  capturedEmails.length = 0;
  const schedule = makePlaygroupSchedule({
    sessionType: 'one-on-one',
    tutors: ['jake'],
    student: { _id: 'kid-1', firstName: 'Ana', lastName: 'Cruz', email: 'ana.parent@example.com' },
  });
  const enrollments = [{ student: 'kid-1', parent: { _id: 'parent-1', firstName: 'Carla', lastName: 'Cruz', email: 'carla.cruz@example.com' } }];
  const { restore } = stubCommon({ schedule, enrollments });
  try {
    const res = mockRes();
    await assignSubstituteTutor({ params: { id: 'sched-pg-1' }, user: { id: 'admin-1' }, body: { replacementTutorId: 'maria' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const toParentEmail = capturedEmails.find((e) => e.to === 'carla.cruz@example.com');
    assert.equal(toParentEmail, undefined, 'a 1-on-1 session must never trigger the new Playgroup parent-notification path');
    const toStudent = capturedEmails.find((e) => e.to === 'ana.parent@example.com');
    assert.ok(toStudent, 'the existing 1-on-1 student-notification email must be completely unaffected');
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
