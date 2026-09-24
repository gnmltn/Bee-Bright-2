/**
 * Fixes_and_Features PDF item 1 — Renew / Add Program must keep the child's permanent
 * Student ID and student record instead of minting a new one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const emailService = require('../utils/emailService');
emailService.sendEmail = async () => ({ success: true });
emailService.logEmailError = () => {};
const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Pricing = require('../models/Pricing');
const EnrollmentCounter = require('../models/EnrollmentCounter');
const AssessmentTemplate = require('../models/AssessmentTemplate');
const { submitEnrollment, adminApproveEnrollment } = require('../controllers/enrollmentController');
const { ensureStudentUserForEnrollment } = require('../controllers/scheduleController');
const { backfillPermanentStudentIds, permanentIdOf } = require('../utils/studentIdentity');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

const PARENT_ID = '507f1f77bcf86cd799439011';
const STUDENT_USER_ID = '507f1f77bcf86cd799439022';
const SOURCE_ID = '507f1f77bcf86cd799439033';
const PARENT = { _id: PARENT_ID, role: 'parent', firstName: 'Maria', lastName: 'Soriano', email: 'maria@example.com', enrollmentDraft: false };
const PRICING_ROW = { programCode: 'ACT102', packageSlug: 'premier-elementary', displayName: 'Academic Tutorial - Premier', priceFull: 2400, sessionCount: 12 };

function sourceEnrollment(overrides = {}) {
  return {
    _id: SOURCE_ID, enrollmentId: 'BB-20260924-0006', permanentStudentId: 'BB-20260924-0006',
    parent: PARENT_ID, student: STUDENT_USER_ID,
    studentSnapshot: { firstName: 'Leo', middleName: '', lastName: 'Soriano', birthdate: new Date('2018-03-04') },
    ...overrides,
  };
}

function baseBody(overrides = {}) {
  return {
    packages: [{ programCode: 'ACT102', packageSlug: 'premier-elementary' }],
    studentFirstName: 'Leo', studentLastName: 'Soriano', birthdate: '2018-03-04',
    paymentMethod: 'gcash',
    consentVersion: '1.0', consentItems: [{ name: 'participation_agreement', accepted: true, version: '1.0' }],
    assessment: { applicable: false, skipReason: 'Not applicable' },
    ...overrides,
  };
}

function stubEnrollmentFlow({ source = sourceEnrollment(), seq = 7 } = {}) {
  const orig = {
    eFindOne: Enrollment.findOne, eSave: Enrollment.prototype.save, pSave: Payment.prototype.save,
    pricingFind: Pricing.find, counter: EnrollmentCounter.findOneAndUpdate,
    uFindByIdAndUpdate: User.findByIdAndUpdate, templateFind: AssessmentTemplate.find,
  };
  const queried = [];
  Enrollment.findOne = (filter) => { queried.push(filter); return { lean: async () => source }; };
  Pricing.find = () => ({ lean: async () => [PRICING_ROW] });
  EnrollmentCounter.findOneAndUpdate = async () => ({ seq });
  User.findByIdAndUpdate = async () => ({});
  AssessmentTemplate.find = () => ({ sort: () => ({ lean: async () => [] }) });
  const saved = {};
  Enrollment.prototype.save = async function () { saved.enrollment = this; return this; };
  Payment.prototype.save = async function () { saved.payment = this; return this; };
  return {
    saved, queried,
    restore() {
      Enrollment.findOne = orig.eFindOne; Enrollment.prototype.save = orig.eSave; Payment.prototype.save = orig.pSave;
      Pricing.find = orig.pricingFind; EnrollmentCounter.findOneAndUpdate = orig.counter;
      User.findByIdAndUpdate = orig.uFindByIdAndUpdate; AssessmentTemplate.find = orig.templateFind;
    },
  };
}

test('submitEnrollment (renewal): reuses the permanent Student ID, student record and stored name - never a new ID', async () => {
  const { saved, queried, restore } = stubEnrollmentFlow();
  try {
    const res = mockRes();
    // The browser sends a different (tampered) name; the stored snapshot must win.
    await submitEnrollment({ user: PARENT, body: baseBody({ renewalOfEnrollmentId: SOURCE_ID, studentFirstName: 'Someone', studentLastName: 'Else' }) }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.notEqual(saved.enrollment.enrollmentId, 'BB-20260924-0006', 'the renewal still gets its own enrollment/application ID');
    assert.equal(saved.enrollment.permanentStudentId, 'BB-20260924-0006');
    assert.equal(res._body.permanentStudentId, 'BB-20260924-0006', 'the submit response tells the client the permanent ID to display');
    assert.equal(String(saved.enrollment.student), STUDENT_USER_ID);
    assert.equal(String(saved.enrollment.renewalOf), SOURCE_ID);
    assert.equal(saved.enrollment.studentSnapshot.firstName, 'Leo');
    assert.equal(saved.enrollment.studentSnapshot.lastName, 'Soriano');
    assert.equal(String(queried[0].parent), PARENT_ID, 'the source lookup is scoped to the calling parent');
  } finally { restore(); }
});

test('submitEnrollment (renewal): a source enrollment that is not the caller\'s is rejected', async () => {
  const { restore } = stubEnrollmentFlow({ source: null });
  try {
    const res = mockRes();
    await submitEnrollment({ user: PARENT, body: baseBody({ renewalOfEnrollmentId: SOURCE_ID }) }, res);
    assert.equal(res._status, 400);
  } finally { restore(); }
});

test('submitEnrollment (brand-new child): the permanent Student ID is the enrollment\'s own BB- ID', async () => {
  const { saved, restore } = stubEnrollmentFlow();
  try {
    const res = mockRes();
    await submitEnrollment({ user: PARENT, body: baseBody() }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(saved.enrollment.permanentStudentId, saved.enrollment.enrollmentId);
    assert.equal(saved.enrollment.student, null);
    assert.equal(saved.enrollment.renewalOf, null);
  } finally { restore(); }
});

test('adminApproveEnrollment: the Student ID is the permanent ID, so a renewal approval keeps the original', async () => {
  const origFindById = Enrollment.findById;
  const origUpdate = User.findByIdAndUpdate;
  const origUFindById = User.findById;
  const doc = {
    _id: 'e2', enrollmentId: 'BB-20260924-0007', permanentStudentId: 'BB-20260924-0006', status: 'pending_approval',
    parent: PARENT_ID, studentSnapshot: { firstName: 'Leo', lastName: 'Soriano' }, statusHistory: [],
    save: async () => doc,
  };
  Enrollment.findById = async () => doc;
  User.findByIdAndUpdate = async () => ({});
  User.findById = () => ({ select: () => ({ lean: async () => ({ email: 'maria@example.com', firstName: 'Maria', lastName: 'Soriano' }) }) });
  try {
    const res = mockRes();
    await adminApproveEnrollment({ params: { id: 'e2' }, user: { _id: 'admin-1', role: 'admin' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.studentId, 'BB-20260924-0006');
    assert.equal(doc.studentId, 'BB-20260924-0006');
  } finally { Enrollment.findById = origFindById; User.findByIdAndUpdate = origUpdate; User.findById = origUFindById; }
});

test('ensureStudentUserForEnrollment: a renewal reuses the sibling enrollment\'s student User instead of creating a second one', async () => {
  const origEFindOne = Enrollment.findOne;
  const origUFindOne = User.findOne;
  const origCreate = User.create;
  let created = false;
  const siblingUser = { _id: STUDENT_USER_ID, role: 'student', firstName: 'Leo', lastName: 'Soriano' };
  Enrollment.findOne = () => ({ select: () => ({ lean: async () => ({ student: STUDENT_USER_ID }) }) });
  User.findOne = async () => siblingUser;
  User.create = async () => { created = true; return {}; };
  try {
    let saved = false;
    const renewal = {
      _id: 'e2', enrollmentId: 'BB-20260924-0007', permanentStudentId: 'BB-20260924-0006', parent: PARENT_ID, student: null,
      studentSnapshot: { firstName: 'Leo', lastName: 'Soriano' }, save: async () => { saved = true; },
    };
    const user = await ensureStudentUserForEnrollment(renewal);
    assert.equal(String(user._id), STUDENT_USER_ID);
    assert.equal(created, false, 'no duplicate student record');
    assert.equal(renewal.student, STUDENT_USER_ID);
    assert.equal(saved, true);
  } finally { Enrollment.findOne = origEFindOne; User.findOne = origUFindOne; User.create = origCreate; }
});

test('backfillPermanentStudentIds: groups a child\'s enrollments under the FIRST enrollment\'s ID and never rewrites an existing ID', async () => {
  const origFind = Enrollment.find;
  const origBulk = Enrollment.bulkWrite;
  const snap = { firstName: 'Leo', lastName: 'Soriano', birthdate: new Date('2018-03-04') };
  const rows = [
    { _id: 'a', enrollmentId: 'BB-20260924-0006', parent: PARENT_ID, studentSnapshot: snap, createdAt: new Date('2026-09-24T01:00:00Z') },
    { _id: 'b', enrollmentId: 'BB-20260924-0007', parent: PARENT_ID, studentSnapshot: { ...snap, firstName: 'leo' }, createdAt: new Date('2026-09-24T02:00:00Z') },
    { _id: 'c', enrollmentId: 'BB-20260924-0008', parent: PARENT_ID, studentSnapshot: { firstName: 'Mia', lastName: 'Soriano' }, createdAt: new Date('2026-09-24T03:00:00Z'), permanentStudentId: 'BB-KEEP' },
    { _id: 'd', enrollmentId: 'BB-20260924-0009', parent: PARENT_ID, studentSnapshot: { firstName: 'Mia', lastName: 'Soriano' }, createdAt: new Date('2026-09-24T04:00:00Z') },
  ];
  let ops = null;
  Enrollment.find = () => ({ select: () => ({ sort: () => ({ lean: async () => rows }) }) });
  Enrollment.bulkWrite = async (o) => { ops = o; };
  try {
    const n = await backfillPermanentStudentIds();
    const byId = Object.fromEntries(ops.map((o) => [o.updateOne.filter._id, o.updateOne.update.$set]));
    assert.equal(byId.a.permanentStudentId, 'BB-20260924-0006');
    assert.equal(byId.b.permanentStudentId, 'BB-20260924-0006', 'second Leo (case-insensitive name match) joins the first one');
    assert.equal(byId.b.renewalOf, 'a');
    assert.equal(byId.c, undefined, 'the root already has an ID and nothing to link - untouched');
    assert.equal(byId.d.permanentStudentId, 'BB-KEEP', 'a later Mia inherits the existing ID of her group root');
    assert.equal(n, ops.length);
  } finally { Enrollment.find = origFind; Enrollment.bulkWrite = origBulk; }
});

test('permanentIdOf: falls back to the enrollment ID for legacy records', () => {
  assert.equal(permanentIdOf({ enrollmentId: 'BB-1' }), 'BB-1');
  assert.equal(permanentIdOf({ enrollmentId: 'BB-2', permanentStudentId: 'BB-1' }), 'BB-1');
  assert.equal(permanentIdOf(null), null);
});
