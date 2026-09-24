/**
 * BeeBright Scheduling Spec, Section 1 — regression tests for createMonthlySchedules'
 * two real bug fixes (found during the 1-on-1 wizard investigation) and the new
 * 1-hour session duration:
 *   1. Enrollment-subject matching now uses enrollmentCoversSubject (checks
 *      packages[].programCode), not the dead selectedSubjects-only check — a
 *      package-only enrollment (what the live enrollment wizard actually creates)
 *      can now be scheduled.
 *   2. Enrollment-status check now uses isSchedulableEnrollmentStatus (active OR
 *      approved), not a hardcoded status: 'active' filter.
 *   3. Sessions must be exactly 1 hour (schedulingPolicy.js durationMinutes 120->60);
 *      a 2-hour daySlot is now rejected instead of accepted.
 *
 * 2026-09-19: isSchedulableEnrollmentStatus previously also accepted ANY status
 * (other than cancelled/rejected) as long as paymentStatus was 'paid' — which
 * wrongly let a still-pending_approval enrollment (payment proof submitted, but
 * admin hasn't approved yet) be scheduled. That paymentStatus shortcut is removed;
 * only 'active'/'approved' are schedulable now — see the two new tests below.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Subject = require('../models/Subject');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const TutoringArea = require('../models/TutoringArea');
const TutorUnavailability = require('../models/TutorUnavailability');
const Schedule = require('../models/Schedule');
const { createMonthlySchedules } = require('../controllers/scheduleController');

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

const SUBJECT_ACT102 = { _id: 'subj-act102', name: 'Academic Tutorial', code: 'ACT102' };
const TUTOR = {
  _id: 'tutor-1',
  role: 'tutor',
  isActive: true,
  deletedAt: null,
  employmentType: 'full-time', // Mon-Sat 08:00-18:00, covers any 1-hour daytime slot
  availability: '',
};
const STUDENT_USER = { _id: 'student-1', role: 'student', deletedAt: null };

// Monday, matching JS Date#getUTCDay() convention used throughout scheduleController.
const MONDAY = 1;

function stubModels({ enrollment }) {
  const origSubjectFindById = Subject.findById;
  const origEnrollmentFindOne = Enrollment.findOne;
  const origEnrollmentFindByIdAndUpdate = Enrollment.findByIdAndUpdate;
  const origUserFindOne = User.findOne;
  const origTutoringAreaFindOne = TutoringArea.findOne;
  const origTutoringAreaFindById = TutoringArea.findById;
  const origTutorUnavailabilityExists = TutorUnavailability.exists;
  const origScheduleFind = Schedule.find;
  const origScheduleCountDocuments = Schedule.countDocuments;
  const origScheduleInsertMany = Schedule.insertMany;

  const insertedBatches = [];

  const origUserCreate = User.create;

  Subject.findById = () => mockQuery(SUBJECT_ACT102);
  Enrollment.findOne = () => mockQuery(enrollment);
  Enrollment.findByIdAndUpdate = async () => enrollment;
  User.findOne = (query) => {
    if (query && query.role === 'student') return mockQuery(STUDENT_USER);
    if (query && query.email) return mockQuery(null); // no existing account yet -> create path
    return mockQuery(TUTOR);
  };
  User.create = async (data) => ({ _id: 'student-new-1', ...data });
  TutoringArea.findOne = () => mockQuery({ _id: 'area-1' });
  TutoringArea.findById = () => mockQuery({ areaType: 'tutoring_area', capacity: 15 });
  TutorUnavailability.exists = async () => false;
  Schedule.find = (query) => {
    if (query && query._id && query._id.$in) {
      return mockQuery(insertedBatches[insertedBatches.length - 1] || []);
    }
    return mockQuery([]); // no existing tutor/room conflicts
  };
  Schedule.countDocuments = async () => 0; // room never at capacity
  Schedule.insertMany = async (docs) => {
    const created = docs.map((d, i) => ({ ...d, _id: `sched-${insertedBatches.length}-${i}` }));
    insertedBatches.push(created);
    return created;
  };

  return {
    insertedBatches,
    restore() {
      Subject.findById = origSubjectFindById;
      Enrollment.findOne = origEnrollmentFindOne;
      Enrollment.findByIdAndUpdate = origEnrollmentFindByIdAndUpdate;
      User.findOne = origUserFindOne;
      TutoringArea.findOne = origTutoringAreaFindOne;
      TutoringArea.findById = origTutoringAreaFindById;
      TutorUnavailability.exists = origTutorUnavailabilityExists;
      Schedule.find = origScheduleFind;
      Schedule.countDocuments = origScheduleCountDocuments;
      Schedule.insertMany = origScheduleInsertMany;
      User.create = origUserCreate;
    },
  };
}

function baseReq(overrides = {}) {
  return {
    user: { id: 'admin-1', role: 'admin' },
    body: {
      studentId: 'student-1',
      tutorId: 'tutor-1',
      subjectId: 'subj-act102',
      daySlots: [{ dayOfWeek: MONDAY, startTime: '08:00', endTime: '09:00' }],
      ...overrides,
    },
  };
}

test('createMonthlySchedules: package-only enrollment (no selectedSubjects) can be scheduled', async () => {
  const enrollment = {
    _id: 'enr-1',
    student: 'student-1',
    status: 'active',
    startDate: new Date(),
    packages: [{ programCode: 'ACT102' }],
    selectedSubjects: [],
  };
  const { restore, insertedBatches } = stubModels({ enrollment });
  try {
    const res = mockRes();
    await createMonthlySchedules(baseReq(), res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(res._body.success, true);
    assert.ok(res._body.count > 0);
    assert.ok(insertedBatches[0].length > 0);
  } finally { restore(); }
});

test('createMonthlySchedules: approved-status enrollment (not yet active) can be scheduled', async () => {
  const enrollment = {
    _id: 'enr-2',
    student: 'student-1',
    status: 'approved',
    startDate: new Date(),
    packages: [{ programCode: 'ACT102' }],
    selectedSubjects: [],
  };
  const { restore } = stubModels({ enrollment });
  try {
    const res = mockRes();
    await createMonthlySchedules(baseReq(), res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(res._body.success, true);
  } finally { restore(); }
});

test('createMonthlySchedules: pending_approval enrollment with paymentStatus=paid is rejected (not yet admin-approved)', async () => {
  const enrollment = {
    _id: 'enr-pending',
    student: 'student-1',
    status: 'pending_approval',
    paymentStatus: 'paid',
    startDate: new Date(),
    packages: [{ programCode: 'ACT102' }],
    selectedSubjects: [],
  };
  const { restore } = stubModels({ enrollment });
  try {
    const res = mockRes();
    await createMonthlySchedules(baseReq(), res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.match(res._body.message, /no active enrollment/i);
  } finally { restore(); }
});

test('createMonthlySchedules: payment_under_verification enrollment with paymentStatus=paid is rejected', async () => {
  const enrollment = {
    _id: 'enr-under-verification',
    student: 'student-1',
    status: 'payment_under_verification',
    paymentStatus: 'paid',
    startDate: new Date(),
    packages: [{ programCode: 'ACT102' }],
    selectedSubjects: [],
  };
  const { restore } = stubModels({ enrollment });
  try {
    const res = mockRes();
    await createMonthlySchedules(baseReq(), res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.match(res._body.message, /no active enrollment/i);
  } finally { restore(); }
});

test('createMonthlySchedules: enrollment with neither packages nor selectedSubjects covering the subject is rejected', async () => {
  const enrollment = {
    _id: 'enr-3',
    student: 'student-1',
    status: 'active',
    startDate: new Date(),
    packages: [{ programCode: 'EXP106' }],
    selectedSubjects: [],
  };
  const { restore } = stubModels({ enrollment });
  try {
    const res = mockRes();
    await createMonthlySchedules(baseReq(), res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /not enrolled in this subject/i);
  } finally { restore(); }
});

test('createMonthlySchedules: 1-hour daySlot is accepted', async () => {
  const enrollment = {
    _id: 'enr-4',
    student: 'student-1',
    status: 'active',
    startDate: new Date(),
    packages: [{ programCode: 'ACT102' }],
    selectedSubjects: [],
  };
  const { restore, insertedBatches } = stubModels({ enrollment });
  try {
    const res = mockRes();
    await createMonthlySchedules(baseReq({
      daySlots: [{ dayOfWeek: MONDAY, startTime: '08:00', endTime: '09:00' }],
    }), res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    for (const sched of insertedBatches[0]) {
      assert.equal(sched.startTime, '08:00');
      assert.equal(sched.endTime, '09:00');
    }
  } finally { restore(); }
});

test('createMonthlySchedules: 2-hour daySlot is rejected under the new 1-hour policy', async () => {
  const enrollment = {
    _id: 'enr-5',
    student: 'student-1',
    status: 'active',
    startDate: new Date(),
    packages: [{ programCode: 'ACT102' }],
    selectedSubjects: [],
  };
  const { restore } = stubModels({ enrollment });
  try {
    const res = mockRes();
    await createMonthlySchedules(baseReq({
      daySlots: [{ dayOfWeek: MONDAY, startTime: '08:00', endTime: '10:00' }],
    }), res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /1 hour/i);
  } finally { restore(); }
});

test('createMonthlySchedules: enrollmentId resolves the enrollment and lazily creates the student User when none is linked yet', async () => {
  const enrollment = {
    _id: 'enr-6',
    student: null, // freshly approved enrollment, never scheduled/assigned before
    status: 'active',
    startDate: new Date(),
    packages: [{ programCode: 'ACT102' }],
    selectedSubjects: [],
    studentSnapshot: { firstName: 'Carlo', lastName: 'Reyes' },
  };
  const { restore, insertedBatches } = stubModels({ enrollment });
  try {
    const res = mockRes();
    const req = baseReq();
    delete req.body.studentId;
    req.body.enrollmentId = 'enr-6';
    await createMonthlySchedules(req, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(res._body.success, true);
    assert.equal(insertedBatches[0][0].student, 'student-new-1');
  } finally { restore(); }
});

// Admin_Schedule_and_MultiProgram_Days_Fixes.pdf #2 — generated sessions must anchor to
// the parent's Preferred Start Date, not to enrollment.startDate/createdAt (submission
// time). A Monday 5 weeks out, well past both "today" and startDate/createdAt (both
// "now" in this fixture) — the bug would have generated the earliest session near today
// instead of near preferredStartDate.
test('createMonthlySchedules: anchors generated sessions to the enrollment\'s Preferred Start Date, not submission/creation time', async () => {
  const now = new Date();
  const preferredStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 35));
  // Walk forward to the next Monday on/after preferredStartDate (daySlots below asks for Monday).
  while (preferredStartDate.getUTCDay() !== MONDAY) {
    preferredStartDate.setUTCDate(preferredStartDate.getUTCDate() + 1);
  }

  const enrollment = {
    _id: 'enr-preferred-date',
    student: 'student-1',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    startDate: null,
    paymentVerifiedAt: null,
    preferredStartDate,
    packages: [{ programCode: 'ACT102' }],
    selectedSubjects: [],
  };
  const { restore, insertedBatches } = stubModels({ enrollment });
  try {
    const res = mockRes();
    await createMonthlySchedules(baseReq(), res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.ok(insertedBatches[0].length > 0, 'expected at least one generated session');

    const earliestDate = insertedBatches[0]
      .map((s) => new Date(s.date))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    assert.equal(
      earliestDate.getTime(),
      preferredStartDate.getTime(),
      `earliest generated session must land on the parent's Preferred Start Date (${preferredStartDate.toISOString()}), not near "today"/createdAt (got ${earliestDate.toISOString()})`
    );
  } finally { restore(); }
});
