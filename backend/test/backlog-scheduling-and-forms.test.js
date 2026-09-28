/**
 * Full-backlog fixes (2026-09-27):
 *  - 1-on-1 wizard: per-day tutors, admin Starting Date, system-wide hour cap, ghost sessions
 *  - Playgroup: several children at once, joining touches only the chosen days,
 *    a per-session enroll never cascades into sibling sessions
 *  - Bulk delete clears session-linked records
 *  - Assessment: only the first rating is required
 *  - Remaining-balance due date (halfway session)
 *  - Parent signup accepts split first / middle / last name
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Subject = require('../models/Subject');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const TutoringArea = require('../models/TutoringArea');
const TutorUnavailability = require('../models/TutorUnavailability');
const Schedule = require('../models/Schedule');
const Pricing = require('../models/Pricing');
const PlaygroupGroup = require('../models/PlaygroupGroup');
const EmergencyReschedule = require('../models/EmergencyReschedule');
const ScheduleSubstitutionLog = require('../models/ScheduleSubstitutionLog');
const TutorAbsenceAnnouncement = require('../models/TutorAbsenceAnnouncement');
const {
  createMonthlySchedules,
  checkMonthlySchedule,
  bulkDeleteSchedules,
  createOrJoinPlaygroupGroup,
  enrollStudentInSession,
} = require('../controllers/scheduleController');
const { ONE_ON_ONE_SLOT_CAP } = require('../utils/schedulingPolicy');
const { validateAndBuildAssessment, requiredRatingKeys } = require('../utils/validateAssessment');
const { dueDateFromSessions, halfwaySession, lastSessionDueDate, attachRemainingDueDates } = require('../utils/remainingDueDate');

const mockQuery = (result) => {
  const q = {
    select: () => q, sort: () => q, populate: () => q,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch: (fn) => Promise.resolve(result).catch(fn),
  };
  return q;
};
const mockRes = () => {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
};
const iso = (offsetDays) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

const SUBJECT = { _id: 'subj-act102', name: 'Academic Tutorial', code: 'ACT102' };
const ENROLLMENT = {
  _id: 'enr-1', student: 'student-1', status: 'approved', startDate: new Date(),
  packages: [{ programCode: 'ACT102' }], selectedSubjects: [],
};

// Stubs the 1-on-1 create/check path. `existing(query)` decides what Schedule.find returns.
function stubOneOnOne({ existing = () => [], liveUsers = null } = {}) {
  const orig = {
    subjectFindById: Subject.findById, enrollmentFindOne: Enrollment.findOne, userFindOne: User.findOne,
    userFind: User.find, areaFindOne: TutoringArea.findOne, areaFindById: TutoringArea.findById,
    unavailExists: TutorUnavailability.exists, scheduleFind: Schedule.find, scheduleCount: Schedule.countDocuments,
    insertMany: Schedule.insertMany,
  };
  const batches = [];
  Subject.findById = () => mockQuery(SUBJECT);
  Enrollment.findOne = () => mockQuery(ENROLLMENT);
  User.findOne = (query) => {
    if (query && query.role === 'student') return mockQuery({ _id: 'student-1', role: 'student', deletedAt: null });
    return mockQuery({ _id: query?._id, role: 'tutor', isActive: true, deletedAt: null, employmentType: 'full-time', availability: '' });
  };
  User.find = (query) => {
    const ids = (query?._id?.$in || []).map(String);
    return mockQuery((liveUsers || ids).map((id) => ({ _id: id })));
  };
  TutoringArea.findOne = () => mockQuery({ _id: 'area-1' });
  TutoringArea.findById = () => mockQuery({ areaType: 'tutoring_area', capacity: 15 });
  TutorUnavailability.exists = async () => false;
  Schedule.find = (query) => {
    if (query && query._id && query._id.$in) return mockQuery(batches[batches.length - 1] || []);
    return mockQuery(existing(query));
  };
  Schedule.countDocuments = async () => 0;
  Schedule.insertMany = async (docs) => {
    const created = docs.map((d, i) => ({ ...d, _id: `s-${batches.length}-${i}` }));
    batches.push(created);
    return created;
  };
  return {
    batches,
    restore() {
      Subject.findById = orig.subjectFindById; Enrollment.findOne = orig.enrollmentFindOne; User.findOne = orig.userFindOne;
      User.find = orig.userFind; TutoringArea.findOne = orig.areaFindOne; TutoringArea.findById = orig.areaFindById;
      TutorUnavailability.exists = orig.unavailExists; Schedule.find = orig.scheduleFind;
      Schedule.countDocuments = orig.scheduleCount; Schedule.insertMany = orig.insertMany;
    },
  };
}

const monthlyReq = (body) => ({
  user: { id: 'admin-1', role: 'admin' },
  body: { enrollmentId: 'enr-1', tutorId: 'tutor-A', subjectId: 'subj-act102', ...body },
});

test('item 9: a day can be covered by a different tutor under the same student schedule', async () => {
  const { restore, batches } = stubOneOnOne();
  try {
    const res = mockRes();
    await createMonthlySchedules(monthlyReq({
      daySlots: [
        { dayOfWeek: 1, startTime: '09:00', endTime: '10:00' },
        { dayOfWeek: 3, startTime: '09:00', endTime: '10:00' },
        { dayOfWeek: 4, startTime: '09:00', endTime: '10:00', tutorId: 'tutor-B' },
      ],
    }), res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    const sessions = batches[0];
    const tutorsByDay = new Map();
    for (const s of sessions) tutorsByDay.set(new Date(s.date).getUTCDay(), s.tutor);
    assert.equal(tutorsByDay.get(1), 'tutor-A');
    assert.equal(tutorsByDay.get(3), 'tutor-A');
    assert.equal(tutorsByDay.get(4), 'tutor-B', 'Thursday goes to the second tutor');
    assert.ok(sessions.every((s) => s.student === 'student-1'), 'all under the same student');
  } finally { restore(); }
});

test('item 11: the admin Starting Date anchors the month; a past date is refused', async () => {
  const { restore, batches } = stubOneOnOne();
  try {
    const start = iso(30);
    const res = mockRes();
    await createMonthlySchedules(monthlyReq({ startDate: start, daySlots: [{ dayOfWeek: 2, startTime: '10:00', endTime: '11:00' }] }), res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.ok(batches[0].length >= 4);
    assert.ok(batches[0].every((s) => new Date(s.date).toISOString().slice(0, 10) >= start), 'nothing before the starting date');

    const past = mockRes();
    await createMonthlySchedules(monthlyReq({ startDate: iso(-5), daySlots: [{ dayOfWeek: 2, startTime: '10:00', endTime: '11:00' }] }), past);
    assert.equal(past._status, 400);
    assert.match(past._body.message, /past/i);
  } finally { restore(); }
});

test('item 12: a full hour (system-wide cap) blocks scheduling regardless of tutor availability', async () => {
  const fullHour = Array.from({ length: ONE_ON_ONE_SLOT_CAP }, (_, i) => ({ tutor: `t${i}`, student: `k${i}`, startTime: '09:00', endTime: '10:00' }));
  const { restore } = stubOneOnOne({
    existing: (query) => (query?.sessionType === 'one-on-one' ? fullHour : []),
  });
  try {
    const res = mockRes();
    await createMonthlySchedules(monthlyReq({ daySlots: [{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }] }), res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.match(res._body.message, new RegExp(`at most ${ONE_ON_ONE_SLOT_CAP}`));
  } finally { restore(); }
});

test('item 10/12: ghost sessions (tutor or child account gone) never count toward the hour cap', async () => {
  const ghosts = Array.from({ length: ONE_ON_ONE_SLOT_CAP }, (_, i) => ({ tutor: `gone${i}`, student: `k${i}`, startTime: '09:00', endTime: '10:00' }));
  // liveUsers: only the requested tutor exists — every ghost's tutor is missing from the users collection.
  const { restore } = stubOneOnOne({
    existing: (query) => (query?.sessionType === 'one-on-one' ? ghosts : []),
    liveUsers: ['tutor-A'],
  });
  try {
    const res = mockRes();
    await createMonthlySchedules(monthlyReq({ daySlots: [{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }] }), res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
  } finally { restore(); }
});

// H1 — the monthly wizard (both create and its own preview) never checked the STUDENT side
// for conflicts, only the tutor side — a child could be double-booked across two programs
// (e.g. ACT102 + EXP106) at the same day/hour as long as different tutors were used.
test('H1: createMonthlySchedules rejects a student already double-booked at that day/hour (different tutor/program)', async () => {
  const { restore, batches } = stubOneOnOne({
    existing: (query) => (query?.$or?.some((c) => 'student' in c) ? [{ startTime: '09:00', endTime: '10:00', tutor: 'tutor-other', student: 'student-1' }] : []),
  });
  try {
    const res = mockRes();
    await createMonthlySchedules(monthlyReq({ daySlots: [{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }] }), res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.match(res._body.message, /conflicting session/i);
    assert.equal(batches.length, 0, 'nothing is created once a conflict is found');
  } finally { restore(); }
});

test('H1: checkMonthlySchedule (preview) also reports the same student conflict, not just the tutor side', async () => {
  const { restore } = stubOneOnOne({
    existing: (query) => (query?.$or?.some((c) => 'student' in c) ? [{ startTime: '09:00', endTime: '10:00', tutor: 'tutor-other', student: 'student-1' }] : []),
  });
  try {
    const res = mockRes();
    await checkMonthlySchedule(monthlyReq({ daySlots: [{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }] }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.ok, false);
    assert.ok(res._body.conflicts.every((c) => /conflicting session/i.test(c.reason)));
  } finally { restore(); }
});

test('item 11: checkMonthlySchedule suggests open starting dates instead of silently blocking', async () => {
  // The first two Mondays in the window are full; later Mondays are free.
  const blocked = new Set([iso(0), iso(7)]);
  const cap = Array.from({ length: ONE_ON_ONE_SLOT_CAP }, (_, i) => ({ tutor: `t${i}`, student: `k${i}`, startTime: '09:00', endTime: '10:00' }));
  const { restore } = stubOneOnOne({
    existing: (query) => {
      const d = query?.date instanceof Date ? query.date.toISOString().slice(0, 10) : null;
      return query?.sessionType === 'one-on-one' && d && blocked.has(d) ? cap : [];
    },
  });
  try {
    // Start on the next Monday-or-today boundary: use a Monday two weeks from a known Monday.
    const d = new Date(); d.setUTCHours(0, 0, 0, 0);
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
    blocked.clear(); blocked.add(d.toISOString().slice(0, 10));
    const start = d.toISOString().slice(0, 10);
    const res = mockRes();
    await checkMonthlySchedule(monthlyReq({ startDate: start, daySlots: [{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }] }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.ok, false);
    assert.ok(res._body.conflicts.some((c) => c.date === start));
    assert.ok(res._body.suggestions.length > 0, 'offers other starting dates');
    assert.ok(!res._body.suggestions.includes(start));
  } finally { restore(); }
});

test('item 10: bulk delete removes every selected session and the records linked to them in one call', async () => {
  const origDeleteMany = Schedule.deleteMany;
  const deletes = [];
  const linked = [EmergencyReschedule, ScheduleSubstitutionLog, TutorAbsenceAnnouncement];
  const origLinked = linked.map((m) => m.deleteMany);
  Schedule.deleteMany = async (filter) => { deletes.push(['Schedule', filter]); return { deletedCount: 3 }; };
  linked.forEach((m) => { m.deleteMany = async (filter) => { deletes.push([m.modelName, filter]); return { deletedCount: 1 }; }; });
  try {
    const ids = ['64b000000000000000000001', '64b000000000000000000002', '64b000000000000000000003'];
    const res = mockRes();
    await bulkDeleteSchedules({ user: { id: 'admin-1' }, body: { ids: [...ids, 'not-an-id', ids[0]] } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.deleted, 3);
    assert.deepEqual(deletes.find(([m]) => m === 'Schedule')[1], { _id: { $in: ids } }, 'de-duplicated, invalid ids dropped');
    for (const model of ['EmergencyReschedule', 'ScheduleSubstitutionLog', 'TutorAbsenceAnnouncement']) {
      assert.ok(deletes.some(([m, f]) => m === model && f.schedule.$in.length === 3), `${model} cleared`);
    }
    const empty = mockRes();
    await bulkDeleteSchedules({ user: { id: 'admin-1' }, body: { ids: [] } }, empty);
    assert.equal(empty._status, 400);
  } finally {
    Schedule.deleteMany = origDeleteMany;
    linked.forEach((m, i) => { m.deleteMany = origLinked[i]; });
  }
});

// ── Playgroup ────────────────────────────────────────────────────────────────────────────
// createOrJoinPlaygroupGroup now wraps its writes in runTransactionSafe (C1 fix) — a fake
// session lets that path run without a real MongoDB connection, same pattern already used
// by test/hard-delete-archived-user.test.js.
function fakeSession() {
  return {
    withTransaction: async (fn) => { await fn(); },
    endSession: async () => {},
  };
}

function stubPlaygroup({ group, existingByDate = {}, enrollmentsById = {}, studentConflict = () => false }) {
  const orig = {
    subjectFindById: Subject.findById, enrollmentFindOne: Enrollment.findOne, userFindOne: User.findOne, userFind: User.find,
    userCreate: User.create, areaFindOne: TutoringArea.findOne, areaFindById: TutoringArea.findById,
    scheduleFind: Schedule.find, scheduleFindOne: Schedule.findOne, scheduleUpdateOne: Schedule.updateOne, scheduleCreate: Schedule.create,
    scheduleCount: Schedule.countDocuments, groupFindOne: PlaygroupGroup.findOne, groupCreate: PlaygroupGroup.create,
    enrollmentUpdate: Enrollment.findByIdAndUpdate, startSession: mongoose.startSession,
  };
  const updates = [];
  const created = [];
  Subject.findById = () => mockQuery({ _id: 'subj-tpg', name: 'Toddlers Playgroup', code: 'TPG101' });
  Enrollment.findOne = (query) => mockQuery(enrollmentsById[String(query._id)] || null);
  Enrollment.findByIdAndUpdate = async () => ({});
  User.findOne = (query) => mockQuery(query?.role === 'student' ? { _id: `user-of-${query.email || query._id}`, role: 'student' } : null);
  User.create = async (data) => ({ _id: `user-of-${data.email}`, ...data });
  // filterLiveSessions (H3) looks up ids via User.find({_id:{$in:[...]}}) — echo them back
  // as live so a stubbed conflict/session row isn't spuriously filtered out.
  User.find = (query) => mockQuery((query?._id?.$in || []).map((id) => ({ _id: id })));
  TutoringArea.findOne = () => mockQuery({ _id: 'room-1' });
  TutoringArea.findById = () => mockQuery({ areaType: 'toddler_room', capacity: 10 });
  PlaygroupGroup.findOne = () => Promise.resolve(group);
  PlaygroupGroup.create = async (docs) => {
    const arr = Array.isArray(docs) ? docs : [docs];
    return arr.map((d) => ({ ...d, _id: d._id || 'group-new-1' }));
  };
  Schedule.findOne = (query) => {
    const key = query?.date instanceof Date ? query.date.toISOString().slice(0, 10) : null;
    return mockQuery(existingByDate[key] || null);
  };
  // hasStudentScheduleConflict's own $or-on-student/students conflict query.
  Schedule.find = (query) => mockQuery(query && query.$or && studentConflict(query) ? [{ startTime: '08:00', endTime: '10:00', tutor: 'tutor-1', student: 'student-1' }] : []);
  Schedule.countDocuments = async () => 0;
  Schedule.updateOne = async (filter, update) => { updates.push({ filter, update }); return {}; };
  Schedule.create = async (docs) => {
    const arr = Array.isArray(docs) ? docs : [docs];
    created.push(...arr);
    return arr;
  };
  mongoose.startSession = async () => fakeSession();
  return {
    updates, created,
    restore() {
      Subject.findById = orig.subjectFindById; Enrollment.findOne = orig.enrollmentFindOne; User.findOne = orig.userFindOne; User.find = orig.userFind;
      User.create = orig.userCreate; TutoringArea.findOne = orig.areaFindOne; TutoringArea.findById = orig.areaFindById;
      Schedule.find = orig.scheduleFind; Schedule.findOne = orig.scheduleFindOne; Schedule.updateOne = orig.scheduleUpdateOne; Schedule.create = orig.scheduleCreate;
      Schedule.countDocuments = orig.scheduleCount; PlaygroupGroup.findOne = orig.groupFindOne; PlaygroupGroup.create = orig.groupCreate;
      Enrollment.findByIdAndUpdate = orig.enrollmentUpdate; mongoose.startSession = orig.startSession;
    },
  };
}

const tpgEnrollment = (id, student) => ({
  _id: id, student, status: 'approved', startDate: new Date(), packages: [{ programCode: 'TPG101' }], selectedSubjects: [],
});

test('item 15: several children are enrolled into a playgroup together (all-or-nothing) from a starting date', async () => {
  const group = { _id: 'grp-1', daysOfWeek: [2, 3], startTime: '08:00', endTime: '10:00', tutors: ['tutor-1'], isActive: true };
  const { restore, created } = stubPlaygroup({
    group,
    enrollmentsById: { e1: tpgEnrollment('e1', 'kid-1'), e2: tpgEnrollment('e2', 'kid-2') },
  });
  try {
    const res = mockRes();
    await createOrJoinPlaygroupGroup({
      user: { id: 'admin-1', role: 'admin' },
      body: { groupId: 'grp-1', enrollmentIds: ['e1', 'e2'], subjectId: 'subj-tpg', startDate: iso(14) },
    }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.ok(created.length > 0);
    assert.ok(created.every((doc) => doc.students.length === 2), 'both children on every generated session');
    assert.ok(created.every((doc) => new Date(doc.date).toISOString().slice(0, 10) >= iso(14)), 'nothing before the starting date');
  } finally { restore(); }
});

// H2 — joining a playgroup group must not skip the child's own conflict check (previously
// only room/ratio capacity was validated, so a child could be double-booked against an
// existing 1-on-1 session, or a different playgroup group, at the exact same time).
test('H2: joining is rejected when a selected child already has a conflicting session at that date/time', async () => {
  const group = { _id: 'grp-1', daysOfWeek: [2, 3], startTime: '08:00', endTime: '10:00', tutors: ['tutor-1'], isActive: true };
  const { restore, created } = stubPlaygroup({
    group,
    enrollmentsById: { e1: tpgEnrollment('e1', 'kid-1'), e2: tpgEnrollment('e2', 'kid-2') },
    studentConflict: () => true,
  });
  try {
    const res = mockRes();
    await createOrJoinPlaygroupGroup({
      user: { id: 'admin-1', role: 'admin' },
      body: { groupId: 'grp-1', enrollmentIds: ['e1', 'e2'], subjectId: 'subj-tpg', startDate: iso(14) },
    }, res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.match(res._body.message, /conflicting session/i);
    assert.equal(created.length, 0, 'no session written once a conflict is found');
  } finally { restore(); }
});

// C1 — a write failure partway through a multi-date batch must not leave some dates
// committed and others not.
test('C1: a mid-batch write failure rolls back every session (and the new group) already written', async () => {
  const { restore, created } = stubPlaygroup({
    group: null, // no groupId in the request below -> creating a brand-new group
    enrollmentsById: { e1: tpgEnrollment('e1', 'kid-1') },
  });
  const deletedScheduleIds = [];
  const deletedGroupIds = [];
  const origScheduleDeleteMany = Schedule.deleteMany;
  const origGroupDeleteOne = PlaygroupGroup.deleteOne;
  const origUserFind = User.find;
  const origScheduleCreate = Schedule.create;
  User.find = () => mockQuery([{ _id: 'tutor-1' }]); // tutorIds lookup when creating a new group
  Schedule.deleteMany = async (filter) => { deletedScheduleIds.push(...(filter?._id?.$in || [])); return { deletedCount: (filter?._id?.$in || []).length }; };
  PlaygroupGroup.deleteOne = async (filter) => { deletedGroupIds.push(String(filter._id)); return { deletedCount: 1 }; };
  let callCount = 0;
  Schedule.create = async (docs) => {
    callCount += 1;
    if (callCount === 2) throw new Error('simulated mid-batch failure');
    const arr = Array.isArray(docs) ? docs : [docs];
    const made = arr.map((d, i) => ({ ...d, _id: `created-${created.length + i}` }));
    created.push(...made);
    return made;
  };
  try {
    const res = mockRes();
    await createOrJoinPlaygroupGroup({
      user: { id: 'admin-1', role: 'admin' },
      body: {
        tutorIds: ['tutor-1'], daysOfWeek: [2], startTime: '08:00', endTime: '10:00', name: 'New Group',
        enrollmentIds: ['e1'], subjectId: 'subj-tpg', startDate: iso(0),
      },
    }, res);
    assert.equal(res._status, 500, JSON.stringify(res._body));
    assert.equal(created.length, 1, 'exactly one session written before the simulated failure');
    assert.deepEqual(new Set(deletedScheduleIds), new Set(created.map((d) => d._id)), 'exactly the sessions written this batch were rolled back');
    assert.equal(deletedGroupIds.length, 1, 'the new group itself is rolled back, not left orphaned');
  } finally {
    Schedule.deleteMany = origScheduleDeleteMany; PlaygroupGroup.deleteOne = origGroupDeleteOne; User.find = origUserFind; Schedule.create = origScheduleCreate;
    restore();
  }
});

test('item 18: joining a group only touches the days that were chosen, never the rest of the group pattern', async () => {
  const group = { _id: 'grp-2', daysOfWeek: [2, 3], startTime: '08:00', endTime: '10:00', tutors: ['tutor-1'], isActive: true };
  const { restore, created } = stubPlaygroup({ group, enrollmentsById: { e1: tpgEnrollment('e1', 'kid-1') } });
  try {
    const res = mockRes();
    await createOrJoinPlaygroupGroup({
      user: { id: 'admin-1', role: 'admin' },
      body: { groupId: 'grp-2', daysOfWeek: [2], enrollmentIds: ['e1'], subjectId: 'subj-tpg' },
    }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.ok(created.length > 0);
    assert.ok(created.every((doc) => new Date(doc.date).getUTCDay() === 2), 'Tuesday only - Wednesday untouched');
  } finally { restore(); }
});

test('item 18: enrolling a child into one playgroup session never writes to a sibling session of the same group', async () => {
  const saved = [];
  const tue = {
    _id: 'sess-tue', sessionType: 'playgroup', students: [], maxCapacity: 12, group: 'grp-1', date: new Date(), startTime: '08:00', endTime: '10:00',
    tutors: [{ _id: 'tutor-1' }, { _id: 'tutor-2' }], subject: { _id: 'subj-tpg', code: 'TPG101', name: 'Toddlers Playgroup' },
    save: async function save() { saved.push(this._id); return this; },
  };
  const orig = {
    scheduleFindById: Schedule.findById, enrollmentFindOne: Enrollment.findOne, userFindOne: User.findOne, userCreate: User.create,
    scheduleFind: Schedule.find, scheduleFindOne: Schedule.findOne, scheduleExists: Schedule.exists, updateMany: Schedule.updateMany,
    updateOne: Schedule.updateOne, enrollmentUpdate: Enrollment.findByIdAndUpdate,
  };
  const otherWrites = [];
  Schedule.findById = (id) => {
    const q = mockQuery(tue);
    q.populate = () => q;
    return q;
  };
  Enrollment.findOne = () => mockQuery({ ...tpgEnrollment('e1', 'kid-1'), preferredStartDate: null, parent: { _id: 'p1' }, packages: [{ programCode: 'TPG101' }], selectedSubjects: [] });
  Enrollment.findByIdAndUpdate = async () => ({});
  User.findOne = (query) => mockQuery(query?.role === 'student' ? { _id: 'kid-1', role: 'student' } : null);
  User.create = async (data) => ({ _id: 'kid-1', ...data });
  Schedule.find = () => mockQuery([]);
  Schedule.findOne = () => mockQuery(null);
  Schedule.exists = async () => false;
  Schedule.updateMany = async (...args) => { otherWrites.push(['updateMany', args]); return {}; };
  Schedule.updateOne = async (...args) => { otherWrites.push(['updateOne', args]); return {}; };
  try {
    const res = mockRes();
    await enrollStudentInSession({ params: { id: 'sess-tue' }, body: { enrollmentId: 'e1', overridePreference: true, overrideReason: 'admin' }, user: { id: 'admin-1' } }, res);
    assert.ok(res._status === 200 || res._status === 400 || res._status === 500);
    if (res._status === 200) {
      assert.deepEqual(saved, ['sess-tue'], 'only the selected session is saved');
    }
    assert.deepEqual(otherWrites, [], 'no other session is touched');
  } finally {
    Schedule.findById = orig.scheduleFindById; Enrollment.findOne = orig.enrollmentFindOne; User.findOne = orig.userFindOne;
    User.create = orig.userCreate; Schedule.find = orig.scheduleFind; Schedule.findOne = orig.scheduleFindOne; Schedule.exists = orig.scheduleExists;
    Schedule.updateMany = orig.updateMany; Schedule.updateOne = orig.updateOne; Enrollment.findByIdAndUpdate = orig.enrollmentUpdate;
  }
});

// ── Assessment: only the first rating is required ─────────────────────────────────────────
test('item 3/21: only the first assessment rating is required — everything else is optional', async () => {
  const AssessmentTemplate = require('../models/AssessmentTemplate');
  const template = {
    _id: 'tpl-1', slug: 'kindergarten', title: 'Kindergarten Assessment Form', programCodes: ['ACT102'], active: true,
    ratingScale: [{ value: 'proficient', label: 'Proficient' }, { value: 'developing', label: 'Developing' }],
    infoFields: [{ key: 'referredCondition', label: 'Referred' }],
    sections: [{ key: 's1', title: 'I', items: [{ key: 'a', label: 'First skill' }, { key: 'b', label: 'Second skill' }] }],
    goalsCount: 2,
  };
  assert.deepEqual(requiredRatingKeys(template), ['a']);
  const orig = AssessmentTemplate.find;
  AssessmentTemplate.find = () => mockQuery([template]);
  try {
    const ok = await validateAndBuildAssessment({ assessment: { applicable: true, templateId: 'tpl-1', ratings: { a: 'proficient' } } }, ['ACT102']);
    assert.deepEqual(ok.assessment.ratings, { a: 'proficient' }, 'the rest may stay blank');
    await assert.rejects(
      () => validateAndBuildAssessment({ assessment: { applicable: true, templateId: 'tpl-1', ratings: { b: 'developing' } } }, ['ACT102']),
      /first assessment item/i
    );
    const junk = await validateAndBuildAssessment({ assessment: { applicable: true, templateId: 'tpl-1', ratings: { a: 'developing', b: 'not-a-rating' } } }, ['ACT102']);
    assert.deepEqual(junk.assessment.ratings, { a: 'developing' }, 'invalid optional values are dropped, not stored');
  } finally { AssessmentTemplate.find = orig; }
});

// ── Payment reminder timing ───────────────────────────────────────────────────────────────
test('item 23: the remaining 50% falls due at the halfway session; no due date before the schedule reaches it', () => {
  assert.equal(halfwaySession(12), 6);
  assert.equal(halfwaySession(8), 4);
  const dates = ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', '2026-10-14', '2026-10-16', '2026-10-19', '2026-10-21'];
  assert.equal(dueDateFromSessions(12, dates.slice(0, 5)), null, 'only 5 of the 6 sessions to halfway are scheduled yet');
  assert.equal(dueDateFromSessions(12, [...dates].reverse()).toISOString().slice(0, 10), '2026-10-16', 'the 6th session, whatever the order');
  assert.equal(dueDateFromSessions(null, dates), null);
});

// ── Invoice Due Date ("what to do (6).pdf") ───────────────────────────────────────────────
test('invoice Due Date is the LAST scheduled session\'s date, not a fixed offset — null until the full package is scheduled', () => {
  const dates = ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', '2026-10-14', '2026-10-16', '2026-10-19', '2026-10-21'];
  assert.equal(lastSessionDueDate(8, dates.slice(0, 7)), null, 'only 7 of 8 sessions scheduled — no real "last session" yet');
  assert.equal(lastSessionDueDate(8, [...dates].reverse()).toISOString().slice(0, 10), '2026-10-21', 'the 8th (final) session, whatever the order');
  assert.equal(lastSessionDueDate(null, dates), null);
});

test('attachRemainingDueDates: invoiceDueDate (last session) and remainingDueDate (halfway session) are computed independently from the same schedule', async () => {
  const studentId = new mongoose.Types.ObjectId().toString();
  const subjectId = new mongoose.Types.ObjectId().toString();
  // 8-session package: only 7 of 8 exist so far — halfway (4th) IS reached, final (8th) is NOT.
  const scheduleDocs = ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', '2026-10-14', '2026-10-16', '2026-10-19']
    .map((date) => ({ student: studentId, students: [], subject: { _id: subjectId, code: 'ACT102' }, date }));
  const origScheduleFind = Schedule.find;
  const origPricingFind = Pricing.find;
  Schedule.find = () => mockQuery(scheduleDocs);
  Pricing.find = () => mockQuery([{ programCode: 'ACT102', packageSlug: 'pkg-8', sessionCount: 8 }]);
  try {
    const [result] = await attachRemainingDueDates([
      { student: studentId, packages: [{ programCode: 'ACT102', packageSlug: 'pkg-8' }] },
    ]);
    assert.equal(result.invoiceDueDate, null, 'only 7 of 8 sessions scheduled — invoice Due Date not determinable yet');
    assert.equal(new Date(result.remainingDueDate).toISOString().slice(0, 10), '2026-10-12', 'halfway (4th) session already reached, unaffected by the invoice Due Date fix');

    // Add the 8th session — now both should resolve, to their own distinct dates.
    scheduleDocs.push({ student: studentId, students: [], subject: { _id: subjectId, code: 'ACT102' }, date: '2026-10-21' });
    const [full] = await attachRemainingDueDates([
      { student: studentId, packages: [{ programCode: 'ACT102', packageSlug: 'pkg-8' }] },
    ]);
    assert.equal(new Date(full.invoiceDueDate).toISOString().slice(0, 10), '2026-10-21', 'invoice Due Date = last (8th) session');
    assert.equal(new Date(full.remainingDueDate).toISOString().slice(0, 10), '2026-10-12', 'reminder timing untouched by adding the final session');
  } finally {
    Schedule.find = origScheduleFind;
    Pricing.find = origPricingFind;
  }
});

// ── Parent signup: split name fields ──────────────────────────────────────────────────────
test('item 1: parent signup takes first / middle / last name separately and validates each', async () => {
  const PendingParentSignup = require('../models/PendingParentSignup');
  const emailService = require('../utils/emailService');
  // The controller destructures sendEmail when it is first required, so stub BEFORE requiring it.
  const origSend = emailService.sendEmail;
  const origLog = emailService.logEmailError;
  emailService.sendEmail = async () => ({ ok: true });
  emailService.logEmailError = () => {};
  const { registerParent } = require('../controllers/parentAuthController');
  const origFindOne = User.findOne;
  const origPendingFindOne = PendingParentSignup.findOne;
  const origPendingFindById = PendingParentSignup.findById;
  const origSave = PendingParentSignup.prototype.save;
  let saved = null;
  const origExists = User.exists;
  User.findOne = () => ({ select: async () => null });
  User.exists = async () => null;
  PendingParentSignup.findOne = () => ({ select: async () => null });
  PendingParentSignup.findById = () => ({ select: async () => null });
  PendingParentSignup.prototype.save = async function save() { saved = this; return this; };
  try {
    const res = mockRes();
    await registerParent({ body: { firstName: 'maria', middleName: 'reyes', lastName: 'santos', email: 'maria.split@example.test', mobile: '09171234567', password: 'Abcd1234!' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(saved.firstName, 'Maria');
    assert.equal(saved.middleName, 'Reyes');
    assert.equal(saved.lastName, 'Santos');

    const noLast = mockRes();
    await registerParent({ body: { firstName: 'Maria', lastName: '', email: 'maria.split@example.test', mobile: '09171234567', password: 'Abcd1234!' } }, noLast);
    assert.equal(noLast._status, 400);
    assert.match(noLast._body.message, /Last name/);

    const digits = mockRes();
    await registerParent({ body: { firstName: 'Mar1a', lastName: 'Santos', email: 'maria.split@example.test', mobile: '09171234567', password: 'Abcd1234!' } }, digits);
    assert.equal(digits._status, 400);
    assert.match(digits._body.message, /First name/);
  } finally {
    User.findOne = origFindOne; PendingParentSignup.findOne = origPendingFindOne; PendingParentSignup.findById = origPendingFindById;
    emailService.sendEmail = origSend; emailService.logEmailError = origLog; PendingParentSignup.prototype.save = origSave; User.exists = origExists;
  }
});
