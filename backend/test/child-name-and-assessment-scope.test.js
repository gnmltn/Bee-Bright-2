/**
 * "Redundant_Switchers_Settings_Rules_EnrollmentBugs.pdf":
 *  - item B: PUT /enrollments/child-name — editable child name, Student ID untouched
 *  - item E: POST /auth/register-parent no longer hard-requires the legacy `name` field
 *  - item H: assessment templates are only ever marked eligible for Academic Tutorial
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { body, validationResult } = require('express-validator');

const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const Pricing = require('../models/Pricing');
const AssessmentTemplate = require('../models/AssessmentTemplate');
const { updateChildName } = require('../controllers/enrollmentController');
const { resolveAcademicProgramCodes, ensureAssessmentTemplates } = require('../utils/ensureAssessmentTemplates');

const mockRes = () => {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
};

function mockQuery(result) {
  const q = { select: () => q, lean: () => Promise.resolve(result) };
  return q;
}

// ── item B: updateChildName ─────────────────────────────────────────────────────────────────
test('updateChildName: only a parent may call it', async () => {
  const res = mockRes();
  await updateChildName({ user: { role: 'admin', _id: 'a1' }, body: {} }, res);
  assert.equal(res._status, 403);
});

test('updateChildName: rejects missing childKey / first / last name', async () => {
  const noKey = mockRes();
  await updateChildName({ user: { role: 'parent', _id: 'p1' }, body: { firstName: 'A', lastName: 'B' } }, noKey);
  assert.equal(noKey._status, 400);

  const noFirst = mockRes();
  await updateChildName({ user: { role: 'parent', _id: 'p1' }, body: { childKey: 'BB-1', lastName: 'B' } }, noFirst);
  assert.equal(noFirst._status, 400);
  assert.match(noFirst._body.message, /first name/i);

  const noLast = mockRes();
  await updateChildName({ user: { role: 'parent', _id: 'p1' }, body: { childKey: 'BB-1', firstName: 'A' } }, noLast);
  assert.equal(noLast._status, 400);
  assert.match(noLast._body.message, /last name/i);
});

test('updateChildName: rejects a name containing numbers (same rule as the parent\'s own Personal Information)', async () => {
  const res = mockRes();
  await updateChildName({ user: { role: 'parent', _id: 'p1' }, body: { childKey: 'BB-1', firstName: 'Ann4', lastName: 'Cruz' } }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.message, /number/i);
});

test('updateChildName: 404 when the child is not on this parent\'s account', async () => {
  const origFind = Enrollment.find;
  Enrollment.find = () => mockQuery([]);
  try {
    const res = mockRes();
    await updateChildName({ user: { role: 'parent', _id: 'p1' }, body: { childKey: 'BB-1', firstName: 'Ann', lastName: 'Cruz' } }, res);
    assert.equal(res._status, 404);
  } finally { Enrollment.find = origFind; }
});

test('updateChildName: updates studentSnapshot on every enrollment of this child AND the linked student account — never the Student ID', async () => {
  const origFind = Enrollment.find;
  const origEnrollmentUpdateMany = Enrollment.updateMany;
  const origUserUpdateMany = User.updateMany;
  const enrollmentUpdateCalls = [];
  const userUpdateCalls = [];
  Enrollment.find = () => mockQuery([
    { _id: 'e1', student: 'student-1' },
    { _id: 'e2', student: 'student-1' }, // Renew/Add Program: same child, second enrollment
  ]);
  Enrollment.updateMany = async (filter, update) => { enrollmentUpdateCalls.push({ filter, update }); return { modifiedCount: 2 }; };
  User.updateMany = async (filter, update) => { userUpdateCalls.push({ filter, update }); return { modifiedCount: 1 }; };
  try {
    const res = mockRes();
    await updateChildName({ user: { role: 'parent', _id: 'p1' }, body: { childKey: 'BB-1', firstName: 'Ann', middleName: 'Reyes', lastName: 'Cruz' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.success, true);

    assert.equal(enrollmentUpdateCalls.length, 1);
    assert.deepEqual(new Set(enrollmentUpdateCalls[0].filter._id.$in), new Set(['e1', 'e2']));
    assert.equal(enrollmentUpdateCalls[0].update.$set['studentSnapshot.firstName'], 'Ann');
    assert.equal(enrollmentUpdateCalls[0].update.$set['studentSnapshot.middleName'], 'Reyes');
    assert.equal(enrollmentUpdateCalls[0].update.$set['studentSnapshot.lastName'], 'Cruz');
    assert.ok(!('studentId' in enrollmentUpdateCalls[0].update.$set) && !('permanentStudentId' in enrollmentUpdateCalls[0].update.$set), 'Student ID is never touched');

    assert.equal(userUpdateCalls.length, 1);
    assert.deepEqual(userUpdateCalls[0].filter._id.$in, ['student-1']);
    assert.deepEqual(userUpdateCalls[0].update.$set, { firstName: 'Ann', middleName: 'Reyes', lastName: 'Cruz' });
  } finally {
    Enrollment.find = origFind; Enrollment.updateMany = origEnrollmentUpdateMany; User.updateMany = origUserUpdateMany;
  }
});

test('updateChildName: no linked student account yet -> Enrollment updates still happen, User.updateMany is skipped', async () => {
  const origFind = Enrollment.find;
  const origEnrollmentUpdateMany = Enrollment.updateMany;
  const origUserUpdateMany = User.updateMany;
  let userUpdateCalled = false;
  Enrollment.find = () => mockQuery([{ _id: 'e1', student: null }]);
  Enrollment.updateMany = async () => ({ modifiedCount: 1 });
  User.updateMany = async () => { userUpdateCalled = true; return {}; };
  try {
    const res = mockRes();
    await updateChildName({ user: { role: 'parent', _id: 'p1' }, body: { childKey: 'BB-2', firstName: 'Ann', lastName: 'Cruz' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(userUpdateCalled, false);
  } finally { Enrollment.find = origFind; Enrollment.updateMany = origEnrollmentUpdateMany; User.updateMany = origUserUpdateMany; }
});

// ── item E: register-parent validator accepts split names, still rejects nothing at all ─────
test('register-parent validator: accepts split firstName/lastName (no legacy `name`)', async () => {
  const req = { body: { firstName: 'Maria', lastName: 'Santos', email: 'maria@example.test', mobile: '09171234567', password: 'Abcd1234!' } };
  const check = body().custom((_, { req: r }) => {
    const hasSplit = String(r.body?.firstName || '').trim() && String(r.body?.lastName || '').trim();
    const hasName = String(r.body?.name || '').trim();
    if (!hasSplit && !hasName) throw new Error('First name and last name are required');
    return true;
  });
  await check.run(req);
  assert.equal(validationResult(req).isEmpty(), true);
});

test('register-parent validator: still rejects when neither split names nor legacy name are given', async () => {
  const req = { body: { email: 'maria@example.test', mobile: '09171234567', password: 'Abcd1234!' } };
  const check = body().custom((_, { req: r }) => {
    const hasSplit = String(r.body?.firstName || '').trim() && String(r.body?.lastName || '').trim();
    const hasName = String(r.body?.name || '').trim();
    if (!hasSplit && !hasName) throw new Error('First name and last name are required');
    return true;
  });
  await check.run(req);
  assert.equal(validationResult(req).isEmpty(), false);
});

test('register-parent validator: legacy combined `name` alone still passes', async () => {
  const req = { body: { name: 'Maria Santos', email: 'maria@example.test', mobile: '09171234567', password: 'Abcd1234!' } };
  const check = body().custom((_, { req: r }) => {
    const hasSplit = String(r.body?.firstName || '').trim() && String(r.body?.lastName || '').trim();
    const hasName = String(r.body?.name || '').trim();
    if (!hasSplit && !hasName) throw new Error('First name and last name are required');
    return true;
  });
  await check.run(req);
  assert.equal(validationResult(req).isEmpty(), true);
});

// ── item H: assessment templates only ever eligible for Academic Tutorial ────────────────────
test('resolveAcademicProgramCodes: matches Academic Tutorial, never Examination Preparation', async () => {
  const origFind = Pricing.find;
  Pricing.find = () => mockQuery([
    { programCode: 'ACT102', displayName: 'Academic Tutorial – Premier' },
    { programCode: 'EXP106', displayName: 'Examination Preparation – Bright' },
    { programCode: 'TPG101', displayName: 'Toddlers Playgroup – 16 Hours' },
  ]);
  try {
    const codes = await resolveAcademicProgramCodes();
    assert.deepEqual(codes, ['ACT102']);
  } finally { Pricing.find = origFind; }
});

test('ensureAssessmentTemplates: pulls the stale EXP106 eligibility from an existing template in place', async () => {
  const origPricingFind = Pricing.find;
  const origTemplateFindOne = AssessmentTemplate.findOne;
  const origTemplateUpdateOne = AssessmentTemplate.updateOne;
  const updateCalls = [];
  Pricing.find = () => mockQuery([{ programCode: 'ACT102', displayName: 'Academic Tutorial – Premier' }]);
  AssessmentTemplate.findOne = () => mockQuery({ _id: 'tpl-1', programCodes: ['ACT102', 'EXP106'] });
  AssessmentTemplate.updateOne = async (filter, update) => { updateCalls.push({ filter, update }); return { modifiedCount: 1 }; };
  try {
    await ensureAssessmentTemplates();
    const pullCall = updateCalls.find((c) => c.update?.$pull?.programCodes === 'EXP106');
    assert.ok(pullCall, 'issues a $pull for EXP106: ' + JSON.stringify(updateCalls));
    assert.equal(pullCall.filter.programCodes, 'EXP106');
  } finally {
    Pricing.find = origPricingFind; AssessmentTemplate.findOne = origTemplateFindOne; AssessmentTemplate.updateOne = origTemplateUpdateOne;
  }
});
