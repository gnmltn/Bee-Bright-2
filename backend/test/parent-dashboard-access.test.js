/**
 * Final Implementation Prompt Section 2 — reframing the Student Dashboard so a
 * parent can actually view their child's schedule/progress.
 *
 * Root cause fixed here: getStudentClasses hard-required req.user.role === 'student'
 * and queried by req.user._id — for a parent (whose own account id never appears
 * as a `student` on any Schedule), this returned an explicit 403 the frontend
 * caught and showed empty. It now accepts role 'parent' + a verified `studentId`
 * query param.
 *
 * (2026-09-22: the getAssignedMaterials coverage that used to live here was
 * removed along with the Learning Materials feature itself. 2026-09-30: the
 * getMyProgress/Grade coverage that used to live here was removed along with
 * the Grade model/feature itself, superseded by Student Remarks.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Schedule = require('../models/Schedule');
const Enrollment = require('../models/Enrollment');

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
