/**
 * "assessment (1).pdf" — item 25: Tutor Dashboard Assessments preview panel.
 * GET /api/enrollments/tutor/assessments (getTutorAssessments) — the pre-enrollment
 * Kindergarten/Grade-level Assessment Form the parent filled out, scoped to:
 *  - this tutor's own students (via Schedule, singular `tutor` OR the `tutors[]` array)
 *  - Academic Tutorial only (packages.programCode === 'ACT102')
 *  - only a form the parent actually answered (`applicable: true`) — "not applicable" or
 *    never-reached still stamps `completedAt`, but must show nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Schedule = require('../models/Schedule');
const Enrollment = require('../models/Enrollment');
const { getTutorAssessments } = require('../controllers/enrollmentController');

const mockRes = () => {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
};

function mockQuery(result) {
  const q = {
    select: () => q, sort: () => q, populate: () => q,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

function stub({ sessions, enrollments }) {
  const orig = { scheduleFind: Schedule.find, enrollmentFind: Enrollment.find };
  const enrollmentQueries = [];
  Schedule.find = () => mockQuery(sessions);
  Enrollment.find = (filter) => { enrollmentQueries.push(filter); return mockQuery(enrollments); };
  return {
    enrollmentQueries,
    restore() { Schedule.find = orig.scheduleFind; Enrollment.find = orig.enrollmentFind; },
  };
}

test('getTutorAssessments: no assigned sessions yet -> empty, no enrollment query', async () => {
  const { restore, enrollmentQueries } = stub({ sessions: [], enrollments: [] });
  try {
    const res = mockRes();
    await getTutorAssessments({ user: { _id: 'tutor-1' } }, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { success: true, enrollments: [] });
    assert.equal(enrollmentQueries.length, 0, 'never queries Enrollment when the tutor has no sessions');
  } finally { restore(); }
});

test('getTutorAssessments: matches sessions on both the singular tutor field and the tutors[] array', async () => {
  const { restore, enrollmentQueries } = stub({
    sessions: [{ tutor: 'tutor-1', student: 'kid-1' }, { tutors: ['tutor-1'], students: ['kid-2'] }],
    enrollments: [],
  });
  try {
    const res = mockRes();
    await getTutorAssessments({ user: { _id: 'tutor-1' } }, res);
    assert.equal(res._status, 200);
    // Not asserted on the Schedule.find call args directly (mocked to always return `sessions`),
    // but both student ids from both session shapes must reach the Enrollment filter.
    assert.equal(enrollmentQueries.length, 1);
    assert.deepEqual(new Set(enrollmentQueries[0].student.$in), new Set(['kid-1', 'kid-2']));
  } finally { restore(); }
});

test('getTutorAssessments: the Enrollment query is scoped to ACT102 and applicable:true', async () => {
  const { restore, enrollmentQueries } = stub({ sessions: [{ tutor: 'tutor-1', student: 'kid-1' }], enrollments: [] });
  try {
    const res = mockRes();
    await getTutorAssessments({ user: { _id: 'tutor-1' } }, res);
    assert.equal(res._status, 200);
    const filter = enrollmentQueries[0];
    assert.equal(filter['packages.programCode'], 'ACT102', 'never Examination Preparation, per the spec');
    assert.equal(filter['preEnrollmentAssessment.applicable'], true, 'not just "completedAt set" — actually answered');
  } finally { restore(); }
});

test('getTutorAssessments: returns whatever Enrollment matched (a completed ACT102 assessment)', async () => {
  const enrollment = {
    _id: 'enr-1', enrollmentId: 'BB-1', student: 'kid-1', studentSnapshot: { firstName: 'Kai', lastName: 'Cruz' },
    packages: [{ programCode: 'ACT102', displayName: 'Academic Tutorial – Premier' }], status: 'approved',
    preEnrollmentAssessment: { applicable: true, templateTitle: 'Kindergarten Assessment Form', completedAt: '2026-09-01T00:00:00.000Z', ratings: { a: 'proficient' } },
  };
  const { restore } = stub({ sessions: [{ tutor: 'tutor-1', student: 'kid-1' }], enrollments: [enrollment] });
  try {
    const res = mockRes();
    await getTutorAssessments({ user: { _id: 'tutor-1' } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.deepEqual(res._body.enrollments, [enrollment]);
  } finally { restore(); }
});
