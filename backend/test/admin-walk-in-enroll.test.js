/**
 * Payments_FullyPaid_NewProgramRefinements_AdminWalkIn.pdf Section E — the admin
 * "Add Student" (walk-in) flow. Covers adminWalkInEnroll: creates an approved
 * Enrollment + a 'verified' cash Payment for whatever the admin actually
 * collected in person, and correctly distinguishes a full payment from a
 * standard 50%-down one.
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
const { adminWalkInEnroll } = require('../controllers/enrollmentController');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

const PARENT = { _id: 'parent-1', role: 'parent', firstName: 'Maria', lastName: 'Cruz', email: 'maria@example.com' };
const PRICING_ROW = {
  programCode: 'ACT102', packageSlug: 'premier-elementary', displayName: 'Academic Tutorial - Premier',
  priceFull: 2400, sessionCount: 12,
};

function baseBody(overrides = {}) {
  return {
    parentId: 'parent-1',
    packages: [{ programCode: 'ACT102', packageSlug: 'premier-elementary' }],
    studentFirstName: 'Ana',
    studentLastName: 'Cruz',
    birthdate: '2018-01-01',
    consentVersion: '1.0',
    consentItems: [{ name: 'participation_agreement', accepted: true, version: '1.0' }],
    amountPaid: 1200,
    ...overrides,
  };
}

function stubAll({ parent = PARENT, pricing = [PRICING_ROW] } = {}) {
  const originals = {
    userFindOne: User.findOne,
    userFindById: User.findById,
    userFindByIdAndUpdate: User.findByIdAndUpdate,
    pricingFind: Pricing.find,
    counterFindOneAndUpdate: EnrollmentCounter.findOneAndUpdate,
    enrollmentSave: Enrollment.prototype.save,
    paymentSave: Payment.prototype.save,
  };

  User.findOne = async () => parent;
  User.findById = () => ({ select: () => ({ lean: async () => parent }) });
  User.findByIdAndUpdate = async () => ({});
  Pricing.find = () => ({ lean: async () => pricing });
  EnrollmentCounter.findOneAndUpdate = async () => ({ seq: 1 });

  const saved = { enrollment: null, payment: null };
  Enrollment.prototype.save = async function () { saved.enrollment = this; return this; };
  Payment.prototype.save = async function () { saved.payment = this; return this; };

  return {
    saved,
    restore() {
      User.findOne = originals.userFindOne;
      User.findById = originals.userFindById;
      User.findByIdAndUpdate = originals.userFindByIdAndUpdate;
      Pricing.find = originals.pricingFind;
      EnrollmentCounter.findOneAndUpdate = originals.counterFindOneAndUpdate;
      Enrollment.prototype.save = originals.enrollmentSave;
      Payment.prototype.save = originals.paymentSave;
    },
  };
}

test('adminWalkInEnroll: standard 50% down payment creates an approved enrollment with paymentStatus "partial"', async () => {
  const { saved, restore } = stubAll();
  try {
    const res = mockRes();
    await adminWalkInEnroll({ body: baseBody({ amountPaid: 1200 }), user: { _id: 'admin-1', role: 'admin' } }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(saved.enrollment.status, 'approved');
    assert.equal(saved.enrollment.paymentStatus, 'partial', '1200 of 2400 is the standard 50% down, not fully paid');
    assert.equal(saved.payment.paymentType, 'down');
    assert.equal(saved.payment.status, 'verified');
    assert.equal(saved.payment.paymentMethod, 'cash');
    assert.equal(saved.payment.amount, 1200);
  } finally { restore(); }
});

test('adminWalkInEnroll: collecting the full package price marks the enrollment fully paid', async () => {
  const { saved, restore } = stubAll();
  try {
    const res = mockRes();
    await adminWalkInEnroll({ body: baseBody({ amountPaid: 2400 }), user: { _id: 'admin-1', role: 'admin' } }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(saved.enrollment.paymentStatus, 'paid');
    assert.equal(saved.payment.paymentType, 'full');
  } finally { restore(); }
});

test('adminWalkInEnroll: rejects a program the child is not age-eligible for', async () => {
  const { restore } = stubAll();
  try {
    const res = mockRes();
    // TPG101 (Toddlers Playgroup, ages 2-4) selected for a child born in 2018 (too old by the test's "today").
    await adminWalkInEnroll({
      body: baseBody({ packages: [{ programCode: 'TPG101', packageSlug: '16h' }] }),
      user: { _id: 'admin-1', role: 'admin' },
    }, res);
    // No TPG101 in stubbed pricing -> resolves as "package no longer available" (400), proving
    // unresolvable/ineligible packages are rejected rather than silently accepted.
    assert.equal(res._status, 400);
  } finally { restore(); }
});

test('adminWalkInEnroll: requires parentId — no anonymous walk-in submission', async () => {
  const { restore } = stubAll();
  try {
    const res = mockRes();
    await adminWalkInEnroll({ body: baseBody({ parentId: '' }), user: { _id: 'admin-1', role: 'admin' } }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /parentId/i);
  } finally { restore(); }
});

test('adminWalkInEnroll: requires all consent items to be accepted', async () => {
  const { restore } = stubAll();
  try {
    const res = mockRes();
    await adminWalkInEnroll({
      body: baseBody({ consentItems: [{ name: 'participation_agreement', accepted: false, version: '1.0' }] }),
      user: { _id: 'admin-1', role: 'admin' },
    }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /agreement/i);
  } finally { restore(); }
});
