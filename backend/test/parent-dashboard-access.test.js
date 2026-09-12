/**
 * Final Implementation Prompt Section 2 — reframing the Student Dashboard so a
 * parent can actually view their child's schedule/progress/materials.
 *
 * Root cause fixed here: getMyProgress / getAssignedMaterials / getStudentClasses
 * all hard-required req.user.role === 'student' and queried by req.user._id —
 * for a parent (whose own account id never appears as a `student` on any
 * Schedule/Grade/LearningMaterial), this silently returned nothing (or, for
 * getStudentClasses, an explicit 403 the frontend caught and showed empty).
 * Each now accepts role 'parent' + a verified `studentId` query param.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Grade = require('../models/Grade');
const LearningMaterial = require('../models/LearningMaterial');
const Schedule = require('../models/Schedule');
const Enrollment = require('../models/Enrollment');

const { getMyProgress } = require('../controllers/gradeController');
const { getAssignedMaterials } = require('../controllers/learningMaterialController');
const { getStudentClasses } = require('../controllers/scheduleController');
const { parentOwnsStudent } = require('../utils/parentChildAccess');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

function stubFind(model, rows) {
  const orig = model.find;
  const chain = {
    populate() { return chain; }, sort() { return chain; },
    select() { return chain; }, lean() { return Promise.resolve(rows); },
  };
  model.find = () => chain;
  return () => { model.find = orig; };
}

const parent = { _id: 'parent-1', id: 'parent-1', role: 'parent' };
const student = { _id: 'student-1', id: 'student-1', role: 'student' };
const myChild = 'child-1';
const someoneElsesChild = 'child-999';

// ── parentOwnsStudent ───────────────────────────────────────────────────────
test('parentOwnsStudent: true only for an active enrollment actually linking this parent to this child', async () => {
  const origExists = Enrollment.exists;
  Enrollment.exists = async (q) => q.parent === 'parent-1' && q.student === myChild;
  try {
    assert.equal(await parentOwnsStudent('parent-1', myChild), true);
    assert.equal(await parentOwnsStudent('parent-1', someoneElsesChild), false);
    assert.equal(await parentOwnsStudent('parent-1', ''), false);
    assert.equal(await parentOwnsStudent('', myChild), false);
  } finally { Enrollment.exists = origExists; }
});

// ── getMyProgress ────────────────────────────────────────────────────────────
test('getMyProgress: student role unaffected — still scoped to req.user._id, no studentId needed', async () => {
  const restore = stubFind(Grade, [{ student: 'student-1', score: 9, maxScore: 10 }]);
  try {
    const res = mockRes();
    await getMyProgress({ user: student, query: {} }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.grades.length, 1);
  } finally { restore(); }
});

test('getMyProgress: parent without a studentId is rejected, not silently empty', async () => {
  const res = mockRes();
  await getMyProgress({ user: parent, query: {} }, res);
  assert.equal(res._status, 403);
  assert.equal(res._body.success, false);
});

test('getMyProgress: parent asking for a child that is not theirs is rejected', async () => {
  const origExists = Enrollment.exists;
  Enrollment.exists = async () => false;
  try {
    const res = mockRes();
    await getMyProgress({ user: parent, query: { studentId: someoneElsesChild } }, res);
    assert.equal(res._status, 403);
  } finally { Enrollment.exists = origExists; }
});

test('getMyProgress: parent asking for their OWN child gets that child\'s real grades', async () => {
  const origExists = Enrollment.exists;
  Enrollment.exists = async (q) => q.parent === 'parent-1' && q.student === myChild;
  const restore = stubFind(Grade, [{ student: myChild, score: 8, maxScore: 10 }]);
  try {
    const res = mockRes();
    await getMyProgress({ user: parent, query: { studentId: myChild } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.grades.length, 1);
    assert.equal(res._body.grades[0].percentage, 80);
  } finally { Enrollment.exists = origExists; restore(); }
});

test('getMyProgress: non-student, non-parent roles are rejected', async () => {
  const res = mockRes();
  await getMyProgress({ user: { _id: 't1', role: 'tutor' }, query: {} }, res);
  assert.equal(res._status, 403);
});

// ── getAssignedMaterials ─────────────────────────────────────────────────────
test('getAssignedMaterials: student role unaffected', async () => {
  const restore = stubFind(LearningMaterial, [{ _id: 'm1' }]);
  try {
    const res = mockRes();
    await getAssignedMaterials({ user: student, query: {} }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.materials.length, 1);
  } finally { restore(); }
});

test('getAssignedMaterials: parent without studentId is rejected', async () => {
  const res = mockRes();
  await getAssignedMaterials({ user: parent, query: {} }, res);
  assert.equal(res._status, 403);
});

test('getAssignedMaterials: parent with their own child gets that child\'s materials', async () => {
  const origExists = Enrollment.exists;
  Enrollment.exists = async (q) => q.parent === 'parent-1' && q.student === myChild;
  const restore = stubFind(LearningMaterial, [{ _id: 'm1' }, { _id: 'm2' }]);
  try {
    const res = mockRes();
    await getAssignedMaterials({ user: parent, query: { studentId: myChild } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.materials.length, 2);
  } finally { Enrollment.exists = origExists; restore(); }
});

// ── getStudentClasses ────────────────────────────────────────────────────────
test('getStudentClasses: student role unaffected', async () => {
  const restore = stubFind(Schedule, [{ _id: 's1', student: 'student-1' }]);
  try {
    const res = mockRes();
    await getStudentClasses({ user: student, query: {} }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.schedules.length, 1);
  } finally { restore(); }
});

test('getStudentClasses: parent without studentId is rejected', async () => {
  const res = mockRes();
  await getStudentClasses({ user: parent, query: {} }, res);
  assert.equal(res._status, 403);
});

test('getStudentClasses: parent with their own child gets that child\'s classes', async () => {
  const origExists = Enrollment.exists;
  Enrollment.exists = async (q) => q.parent === 'parent-1' && q.student === myChild;
  const restore = stubFind(Schedule, [{ _id: 's1', student: myChild }]);
  try {
    const res = mockRes();
    await getStudentClasses({ user: parent, query: { studentId: myChild } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.schedules.length, 1);
  } finally { Enrollment.exists = origExists; restore(); }
});

test('getStudentClasses: admin/tutor roles are still rejected (unchanged)', async () => {
  const res = mockRes();
  await getStudentClasses({ user: { _id: 'a1', role: 'admin' }, query: {} }, res);
  assert.equal(res._status, 403);
});
