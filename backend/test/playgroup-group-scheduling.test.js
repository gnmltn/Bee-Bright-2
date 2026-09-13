/**
 * BeeBright Scheduling Spec, Section 2 — regression tests for the new group-based
 * Toddlers Playgroup scheduling (createOrJoinPlaygroupGroup / listPlaygroupGroups).
 *
 * A "group" (PlaygroupGroup) identifies a recurring roster: fixed tutors, a
 * day-of-week pattern, and a fixed time window. It stores no roster of its own — the
 * child roster lives on the generated Schedule docs (Schedule.group ref), read back on
 * demand. createOrJoinPlaygroupGroup pre-validates every target date (ratio, capacity,
 * room conflict) before committing anything — no partial commits.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Subject = require('../models/Subject');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const TutoringArea = require('../models/TutoringArea');
const Schedule = require('../models/Schedule');
const PlaygroupGroup = require('../models/PlaygroupGroup');
const { createOrJoinPlaygroupGroup, listPlaygroupGroups } = require('../controllers/scheduleController');

function mockQuery(result) {
  const q = {
    select: () => q,
    sort: () => q,
    populate: () => q,
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

const SUBJECT_TPG101 = { _id: 'subj-tpg101', name: 'Toddlers Playgroup', code: 'TPG101' };
const TUTOR_A = { _id: 'tutor-a' };
const STUDENT_USER = { _id: 'student-1', role: 'student', deletedAt: null };

// Monday, matching JS Date#getUTCDay() convention used throughout scheduleController.
const MONDAY = 1;

const EXISTING_GROUP = { _id: 'group-1', tutors: ['tutor-a'], daysOfWeek: [MONDAY], startTime: '08:00', endTime: '10:00' };

function stubModels({ enrollment, existingScheduleStudents = null, tutorIdsFound = ['tutor-a'], roomAtCapacity = false, groupDoc = EXISTING_GROUP }) {
  const origSubjectFindById = Subject.findById;
  const origEnrollmentFindOne = Enrollment.findOne;
  const origUserFindOne = User.findOne;
  const origUserFind = User.find;
  const origTutoringAreaFindOne = TutoringArea.findOne;
  const origTutoringAreaFindById = TutoringArea.findById;
  const origScheduleFindOne = Schedule.findOne;
  const origScheduleUpdateOne = Schedule.updateOne;
  const origScheduleCreate = Schedule.create;
  const origScheduleCountDocuments = Schedule.countDocuments;
  const origGroupFind = PlaygroupGroup.find;
  const origGroupFindOne = PlaygroupGroup.findOne;
  const origGroupCreate = PlaygroupGroup.create;

  const createdSchedules = [];
  const updatedIds = [];
  const createdGroups = [];

  Subject.findById = () => mockQuery(SUBJECT_TPG101);
  Enrollment.findOne = () => mockQuery(enrollment);
  User.findOne = (query) => mockQuery(query && query.role === 'student' ? STUDENT_USER : null);
  User.find = () => mockQuery(tutorIdsFound.map((id) => ({ _id: id })));
  TutoringArea.findOne = () => mockQuery({ _id: 'toddler-room-1' });
  TutoringArea.findById = () => mockQuery({ areaType: 'toddler_room', capacity: 10 });
  Schedule.findOne = () => mockQuery(
    existingScheduleStudents
      ? { _id: 'existing-sched-1', students: existingScheduleStudents }
      : null
  );
  Schedule.updateOne = async (filter) => { updatedIds.push(filter._id); return { acknowledged: true }; };
  Schedule.create = async (data) => {
    const doc = { ...data, _id: `sched-${createdSchedules.length}` };
    createdSchedules.push(doc);
    return doc;
  };
  Schedule.countDocuments = async () => (roomAtCapacity ? 1 : 0);
  PlaygroupGroup.find = () => mockQuery([]);
  PlaygroupGroup.findOne = () => mockQuery(groupDoc);
  PlaygroupGroup.create = async (data) => {
    const doc = { ...data, _id: 'group-new-1' };
    createdGroups.push(doc);
    return doc;
  };

  return {
    createdSchedules,
    updatedIds,
    createdGroups,
    restore() {
      Subject.findById = origSubjectFindById;
      Enrollment.findOne = origEnrollmentFindOne;
      User.findOne = origUserFindOne;
      User.find = origUserFind;
      TutoringArea.findOne = origTutoringAreaFindOne;
      TutoringArea.findById = origTutoringAreaFindById;
      Schedule.findOne = origScheduleFindOne;
      Schedule.updateOne = origScheduleUpdateOne;
      Schedule.create = origScheduleCreate;
      Schedule.countDocuments = origScheduleCountDocuments;
      PlaygroupGroup.find = origGroupFind;
      PlaygroupGroup.findOne = origGroupFindOne;
      PlaygroupGroup.create = origGroupCreate;
    },
  };
}

function baseEnrollment(overrides = {}) {
  return {
    _id: 'enr-1',
    student: 'student-1',
    status: 'active',
    startDate: new Date(),
    packages: [{ programCode: 'TPG101' }],
    selectedSubjects: [],
    ...overrides,
  };
}

function baseReq(overrides = {}) {
  return {
    user: { id: 'admin-1', role: 'admin' },
    body: {
      tutorIds: ['tutor-a'],
      daysOfWeek: [MONDAY],
      startTime: '08:00',
      endTime: '10:00',
      name: 'Morning Group',
      enrollmentId: 'enr-1',
      subjectId: 'subj-tpg101',
      ...overrides,
    },
  };
}

test('createOrJoinPlaygroupGroup: creates a new group and generates a month of sessions', async () => {
  const enrollment = baseEnrollment();
  const { restore, createdSchedules, createdGroups } = stubModels({ enrollment });
  try {
    const res = mockRes();
    await createOrJoinPlaygroupGroup(baseReq(), res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(res._body.success, true);
    assert.ok(createdSchedules.length > 0);
    assert.equal(createdGroups.length, 1);
    for (const sched of createdSchedules) {
      assert.deepEqual(sched.students, ['student-1']);
      assert.equal(sched.sessionType, 'playgroup');
      assert.equal(sched.startTime, '08:00');
      assert.equal(sched.endTime, '10:00');
      assert.equal(sched.maxCapacity, 12);
    }
  } finally { restore(); }
});

test('createOrJoinPlaygroupGroup: rejects an off-window time before touching the database', async () => {
  const enrollment = baseEnrollment();
  const { restore, createdSchedules, createdGroups } = stubModels({ enrollment });
  try {
    const res = mockRes();
    await createOrJoinPlaygroupGroup(baseReq({ startTime: '09:00', endTime: '11:00' }), res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /8:00 AM to 10:00 AM or 1:00 PM to 3:00 PM/i);
    assert.equal(createdSchedules.length, 0);
    assert.equal(createdGroups.length, 0);
  } finally { restore(); }
});

test('createOrJoinPlaygroupGroup: a colliding day pattern leaves no orphaned group behind (no partial commits)', async () => {
  const enrollment = baseEnrollment();
  const { restore, createdSchedules, createdGroups } = stubModels({ enrollment, roomAtCapacity: true });
  try {
    const res = mockRes();
    await createOrJoinPlaygroupGroup(baseReq(), res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /already booked/i);
    assert.equal(createdSchedules.length, 0);
    assert.equal(createdGroups.length, 0, 'PlaygroupGroup.create must not run until every target date has passed validation');
  } finally { restore(); }
});

test('createOrJoinPlaygroupGroup: joining is blocked when the group has insufficient tutors for the new child count', async () => {
  const enrollment = baseEnrollment();
  // Existing session already has 2 children and only 1 tutor -> a 3rd child needs 2 tutors.
  const { restore } = stubModels({ enrollment, existingScheduleStudents: ['child-a', 'child-b'] });
  try {
    const res = mockRes();
    await createOrJoinPlaygroupGroup(baseReq({ groupId: 'group-1', tutorIds: undefined }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, 'INSUFFICIENT_TUTORS');
    assert.match(res._body.message, /Insufficient tutor coverage/i);
  } finally { restore(); }
});

test('createOrJoinPlaygroupGroup: joining is idempotent — already-enrolled student makes no changes and is rejected', async () => {
  const enrollment = baseEnrollment();
  const { restore, updatedIds, createdSchedules } = stubModels({ enrollment, existingScheduleStudents: ['student-1'] });
  try {
    const res = mockRes();
    await createOrJoinPlaygroupGroup(baseReq({ groupId: 'group-1', tutorIds: undefined }), res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /already enrolled in this group/i);
    assert.equal(updatedIds.length, 0);
    assert.equal(createdSchedules.length, 0);
  } finally { restore(); }
});

test('createOrJoinPlaygroupGroup: joining an existing group with room adds the child via $addToSet, no new Schedule created', async () => {
  const enrollment = baseEnrollment();
  const { restore, updatedIds, createdSchedules } = stubModels({ enrollment, existingScheduleStudents: ['child-a'] });
  try {
    const res = mockRes();
    await createOrJoinPlaygroupGroup(baseReq({ groupId: 'group-1', tutorIds: undefined }), res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.ok(updatedIds.length > 0);
    assert.equal(createdSchedules.length, 0);
  } finally { restore(); }
});

test('createOrJoinPlaygroupGroup: a colliding day pattern is blocked by the existing room-conflict check', async () => {
  const enrollment = baseEnrollment();
  const { restore, createdSchedules } = stubModels({ enrollment, roomAtCapacity: true });
  try {
    const res = mockRes();
    await createOrJoinPlaygroupGroup(baseReq(), res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /already booked/i);
    assert.equal(createdSchedules.length, 0);
  } finally { restore(); }
});

test('createOrJoinPlaygroupGroup: creating a new group requires at least 1 tutor', async () => {
  const enrollment = baseEnrollment();
  const { restore } = stubModels({ enrollment });
  try {
    const res = mockRes();
    await createOrJoinPlaygroupGroup(baseReq({ tutorIds: [] }), res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /at least 1 tutor/i);
  } finally { restore(); }
});

test('createOrJoinPlaygroupGroup: rejects when the enrollment does not cover TPG101', async () => {
  const enrollment = baseEnrollment({ packages: [{ programCode: 'ACT102' }] });
  const { restore } = stubModels({ enrollment });
  try {
    const res = mockRes();
    await createOrJoinPlaygroupGroup(baseReq(), res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /not enrolled in this subject/i);
  } finally { restore(); }
});

test('listPlaygroupGroups: reports ratio status computed from a representative Schedule doc', async () => {
  const origGroupFind = PlaygroupGroup.find;
  const origScheduleFindOne = Schedule.findOne;
  PlaygroupGroup.find = () => mockQuery([
    { _id: 'group-1', name: 'Morning Group', tutors: [{ _id: 'tutor-a', firstName: 'Ana' }], daysOfWeek: [MONDAY], startTime: '08:00', endTime: '10:00' },
  ]);
  Schedule.findOne = () => mockQuery({ students: ['child-a', 'child-b'] });
  try {
    const res = mockRes();
    await listPlaygroupGroups({ query: {} }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.groups.length, 1);
    const group = res._body.groups[0];
    assert.equal(group.childCount, 2);
    assert.equal(group.tutorCount, 1);
    // 3rd child would require ceil(3/2)=2 tutors, group only has 1 -> no room.
    assert.equal(group.hasRoom, false);
  } finally {
    PlaygroupGroup.find = origGroupFind;
    Schedule.findOne = origScheduleFindOne;
  }
});

test('listPlaygroupGroups: filters to an exact day-set match when daysOfWeek is provided', async () => {
  const origGroupFind = PlaygroupGroup.find;
  const origScheduleFindOne = Schedule.findOne;
  PlaygroupGroup.find = () => mockQuery([
    { _id: 'group-1', name: 'MWF Group', tutors: [], daysOfWeek: [1, 3, 5], startTime: '08:00', endTime: '10:00' },
    { _id: 'group-2', name: 'Mon Only Group', tutors: [], daysOfWeek: [1], startTime: '08:00', endTime: '10:00' },
  ]);
  Schedule.findOne = () => mockQuery(null);
  try {
    const res = mockRes();
    await listPlaygroupGroups({ query: { daysOfWeek: '1' } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.groups.length, 1);
    assert.equal(res._body.groups[0]._id, 'group-2');
  } finally {
    PlaygroupGroup.find = origGroupFind;
    Schedule.findOne = origScheduleFindOne;
  }
});
