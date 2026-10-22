/**
 * Panel-required change — the Add Child flow must follow the same Reject-moves-to-
 * Rejected-tab pattern as the main Enrollment page (already true — submitEnrollment is
 * the SAME endpoint/controller for both), but is displayed differently on the parent's
 * side: a scoped "Submit Proof of Payment" action on that one child's "My Child" card,
 * never a full-dashboard lock (see frontend/src/lib/rejectionGate.ts). Telling the two
 * entry points apart requires a persisted signal — this adds Enrollment.source,
 * written once at submission time: 'signup' for the main Enrollment page / account-
 * creation wizard (no live session yet), 'add_child' for an already-authenticated
 * parent adding another child, 'renewal' for Renew / Add Program (an existing child,
 * a new program — stays fully out of scope per the panel's instruction, but still
 * needs its own label so it is never mistaken for a brand-new signup).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const emailService = require('../utils/emailService');
emailService.sendEmail = async () => ({ success: true });
emailService.logEmailError = () => {};
const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const User = require('../models/User');
const PendingParentSignup = require('../models/PendingParentSignup');
const Pricing = require('../models/Pricing');
const EnrollmentCounter = require('../models/EnrollmentCounter');
const AssessmentTemplate = require('../models/AssessmentTemplate');
const { submitEnrollment } = require('../controllers/enrollmentController');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

const PARENT_ID = '507f1f77bcf86cd799439011';
const SOURCE_ID = '507f1f77bcf86cd799439033';
const PENDING_ID = '507f1f77bcf86cd799439044';
const PARENT = { _id: PARENT_ID, role: 'parent', firstName: 'Maria', lastName: 'Soriano', email: 'maria@example.com', enrollmentDraft: false };
const PRICING_ROW = { programCode: 'ACT102', packageSlug: 'premier-elementary', displayName: 'Academic Tutorial - Premier', priceFull: 2400 };

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

function stubEnrollmentFlow({ renewalSource = null, pending = null } = {}) {
  const orig = {
    eFindOne: Enrollment.findOne, eSave: Enrollment.prototype.save, pSave: Payment.prototype.save,
    pricingFind: Pricing.find, pricingFindOne: Pricing.findOne, counter: EnrollmentCounter.findOneAndUpdate,
    uFindByIdAndUpdate: User.findByIdAndUpdate, uSave: User.prototype.save, uExists: User.exists,
    templateFind: AssessmentTemplate.find,
    pendFindById: PendingParentSignup.findById, pendDeleteOne: PendingParentSignup.deleteOne,
  };
  Enrollment.findOne = () => ({ lean: async () => renewalSource });
  Pricing.find = () => ({ lean: async () => [PRICING_ROW] });
  Pricing.findOne = () => ({ select: () => ({ lean: () => Promise.resolve(null) }) });
  EnrollmentCounter.findOneAndUpdate = async () => ({ seq: 7 });
  User.findByIdAndUpdate = async () => ({});
  User.prototype.save = async function () { return this; };
  // Used by assertPendingReady (email uniqueness) and checkMobileNumberUnique (mobile
  // uniqueness) for the signup path below — neither taken email nor mobile here.
  User.exists = async () => null;
  AssessmentTemplate.find = () => ({ sort: () => ({ lean: async () => [] }) });
  PendingParentSignup.findById = () => ({ select: async () => pending });
  PendingParentSignup.deleteOne = async () => ({ deletedCount: 1 });
  const saved = {};
  Enrollment.prototype.save = async function () { saved.enrollment = this; return this; };
  Payment.prototype.save = async function () { saved.payment = this; return this; };
  return {
    saved,
    restore() {
      Enrollment.findOne = orig.eFindOne; Enrollment.prototype.save = orig.eSave; Payment.prototype.save = orig.pSave;
      Pricing.find = orig.pricingFind; Pricing.findOne = orig.pricingFindOne; EnrollmentCounter.findOneAndUpdate = orig.counter;
      User.findByIdAndUpdate = orig.uFindByIdAndUpdate; User.prototype.save = orig.uSave; User.exists = orig.uExists;
      AssessmentTemplate.find = orig.templateFind;
      PendingParentSignup.findById = orig.pendFindById; PendingParentSignup.deleteOne = orig.pendDeleteOne;
    },
  };
}

test('submitEnrollment: an already-logged-in parent (Add Child) gets source "add_child"', async () => {
  const { saved, restore } = stubEnrollmentFlow();
  try {
    const res = mockRes();
    await submitEnrollment({ user: PARENT, body: baseBody() }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(saved.enrollment.source, 'add_child');
  } finally { restore(); }
});

test('submitEnrollment: Renew / Add Program (renewalOfEnrollmentId given) gets source "renewal", even though the caller is also authenticated', async () => {
  const sourceEnrollment = {
    _id: SOURCE_ID, enrollmentId: 'BB-20260924-0006', permanentStudentId: 'BB-20260924-0006', parent: PARENT_ID,
    studentSnapshot: { firstName: 'Leo', middleName: '', lastName: 'Soriano', birthdate: new Date('2018-03-04') },
  };
  const { saved, restore } = stubEnrollmentFlow({ renewalSource: sourceEnrollment });
  try {
    const res = mockRes();
    await submitEnrollment({ user: PARENT, body: baseBody({ renewalOfEnrollmentId: SOURCE_ID }) }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(saved.enrollment.source, 'renewal');
  } finally { restore(); }
});

test('submitEnrollment: a brand-new account signup (verified pending, no live session) gets source "signup"', async () => {
  const pending = {
    _id: PENDING_ID, firstName: 'Maria', middleName: '', lastName: 'Soriano', email: 'maria@example.com',
    phone: '09171234567', passwordHash: '$2a$10$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvabcdefghi', emailVerifiedAt: new Date(),
  };
  const { saved, restore } = stubEnrollmentFlow({ pending });
  try {
    const res = mockRes();
    const req = {
      user: null,
      headers: { authorization: `Bearer ${jwt.sign({ id: PENDING_ID, scope: 'enrollment' }, process.env.JWT_SECRET, { expiresIn: '2h' })}` },
      body: baseBody(),
    };
    await submitEnrollment(req, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(saved.enrollment.source, 'signup');
  } finally { restore(); }
});
