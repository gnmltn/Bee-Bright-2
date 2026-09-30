/**
 * "bug (16).pdf" — real-time push pilot (Socket.io, admin dashboard only). Covers the
 * event-wiring in enrollmentController.js: emitNewEnrollment fires on a brand-new
 * enrollment submission, emitNewPayment fires whenever a payment proof lands (bundled
 * with the enrollment itself, a standalone down-payment resubmission, or a
 * remaining-balance submission). The Socket.io transport itself (utils/realtime.js) is
 * NOT exercised here — `io` stays null under `node --test` (initRealtime is only ever
 * called from server.js), so emitNewEnrollment/emitNewPayment are safe no-ops unless
 * mocked, same gotcha class as the emailService/announcementController require-time
 * function-binding issue hit earlier this session: the mock must be set BEFORE
 * requiring enrollmentController, since it destructures these at ITS OWN require-time.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const emailService = require('../utils/emailService');
emailService.sendEmail = async () => ({ success: true });
emailService.logEmailError = () => {};
const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const realtime = require('../utils/realtime');
const emitted = { enrollments: [], payments: [] };
realtime.emitNewEnrollment = (payload) => emitted.enrollments.push(payload);
realtime.emitNewPayment = (payload) => emitted.payments.push(payload);

const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Pricing = require('../models/Pricing');
const EnrollmentCounter = require('../models/EnrollmentCounter');
const AssessmentTemplate = require('../models/AssessmentTemplate');
const { submitEnrollment, submitPaymentProof, submitRemainingPaymentProof } = require('../controllers/enrollmentController');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

const TINY_PNG_DATA_URL = 'data:image/png;base64,' + Buffer.from('fake-image-bytes').toString('base64');

// ─── submitEnrollment ──────────────────────────────────────────────────────────────

const PARENT_ID = '507f1f77bcf86cd799439011';
const PARENT = { _id: PARENT_ID, role: 'parent', firstName: 'Maria', lastName: 'Soriano', email: 'maria@example.com', enrollmentDraft: false };
const PRICING_ROW = { programCode: 'ACT102', packageSlug: 'premier-elementary', displayName: 'Academic Tutorial - Premier', priceFull: 2400, sessionCount: 12 };

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

function stubEnrollmentFlow() {
  const orig = {
    eSave: Enrollment.prototype.save, pSave: Payment.prototype.save,
    pricingFind: Pricing.find, counter: EnrollmentCounter.findOneAndUpdate,
    uFindByIdAndUpdate: User.findByIdAndUpdate, templateFind: AssessmentTemplate.find,
  };
  Pricing.find = () => ({ lean: async () => [PRICING_ROW] });
  EnrollmentCounter.findOneAndUpdate = async () => ({ seq: 9 });
  User.findByIdAndUpdate = async () => ({});
  AssessmentTemplate.find = () => ({ sort: () => ({ lean: async () => [] }) });
  Enrollment.prototype.save = async function () { return this; };
  Payment.prototype.save = async function () { return this; };
  return {
    restore() {
      Enrollment.prototype.save = orig.eSave; Payment.prototype.save = orig.pSave;
      Pricing.find = orig.pricingFind; EnrollmentCounter.findOneAndUpdate = orig.counter;
      User.findByIdAndUpdate = orig.uFindByIdAndUpdate; AssessmentTemplate.find = orig.templateFind;
    },
  };
}

test('submitEnrollment: fires emitNewEnrollment, and emitNewPayment too when the wizard bundled a down-payment proof', async () => {
  emitted.enrollments.length = 0; emitted.payments.length = 0;
  const { restore } = stubEnrollmentFlow();
  try {
    const res = mockRes();
    await submitEnrollment({ user: PARENT, body: baseBody({ proofDataUrl: TINY_PNG_DATA_URL }) }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(emitted.enrollments.length, 1);
    assert.equal(emitted.enrollments[0].studentName, 'Leo Soriano');
    assert.equal(emitted.payments.length, 1, 'a bundled proof should also notify the Payments tab');
    assert.equal(emitted.payments[0].paymentType, 'down');
  } finally { restore(); }
});

test('submitEnrollment: with NO proof bundled, only emitNewEnrollment fires (Payments tab has nothing new yet)', async () => {
  emitted.enrollments.length = 0; emitted.payments.length = 0;
  const { restore } = stubEnrollmentFlow();
  try {
    const res = mockRes();
    await submitEnrollment({ user: PARENT, body: baseBody() }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(emitted.enrollments.length, 1);
    assert.equal(emitted.payments.length, 0);
  } finally { restore(); }
});

// ─── submitPaymentProof (down payment, standalone) ─────────────────────────────────

function stubFsAndUser() {
  const fs = require('fs');
  const orig = { write: fs.writeFileSync, exists: fs.existsSync, mkdir: fs.mkdirSync, userFindById: User.findById };
  fs.writeFileSync = () => {};
  fs.existsSync = () => true;
  fs.mkdirSync = () => {};
  User.findById = () => ({ select: () => ({ lean: async () => ({ _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' }) }) });
  return () => { fs.writeFileSync = orig.write; fs.existsSync = orig.exists; fs.mkdirSync = orig.mkdir; User.findById = orig.userFindById; };
}

test('submitPaymentProof: fires emitNewPayment (paymentType: down)', async () => {
  emitted.enrollments.length = 0; emitted.payments.length = 0;
  const enrollment = {
    _id: 'enr-1', enrollmentId: 'BB-20260904-0001', parent: 'parent-1', status: 'approved',
    paymentStatus: 'pending', packages: [{ price: 4000 }], statusHistory: [],
    studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' },
  };
  enrollment.save = async () => enrollment;
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  const origPaymentSave = Payment.prototype.save;
  Enrollment.findOne = async () => enrollment;
  Payment.findOne = () => ({ sort: () => Promise.resolve(null) });
  Payment.prototype.save = async function () { return this; };
  const restoreFs = stubFsAndUser();
  try {
    const res = mockRes();
    await submitPaymentProof({ params: { enrollmentId: 'BB-20260904-0001' }, body: { proofDataUrl: TINY_PNG_DATA_URL, paymentMethod: 'gcash' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(emitted.payments.length, 1);
    assert.equal(emitted.payments[0].paymentType, 'down');
    assert.equal(emitted.payments[0].enrollmentId, 'BB-20260904-0001');
  } finally {
    Enrollment.findOne = origEnrollmentFindOne; Payment.findOne = origPaymentFindOne;
    Payment.prototype.save = origPaymentSave; restoreFs();
  }
});

// ─── submitRemainingPaymentProof ────────────────────────────────────────────────────

test('submitRemainingPaymentProof: fires emitNewPayment (paymentType: remaining)', async () => {
  emitted.enrollments.length = 0; emitted.payments.length = 0;
  const enrollment = {
    _id: 'enr-2', enrollmentId: 'BB-20260904-0002', parent: 'parent-1', status: 'approved',
    paymentStatus: 'active', totalFee: 4000, statusHistory: [],
    studentSnapshot: { firstName: 'Ben', lastName: 'Diaz' },
  };
  enrollment.save = async () => enrollment;
  const downPayment = { status: 'verified', amountPaid: 2000, amountDue: 2000, amount: 2000 };
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  const origPaymentSave = Payment.prototype.save;
  Enrollment.findOne = async () => enrollment;
  let call = 0;
  Payment.findOne = () => ({
    sort: () => Promise.resolve(call++ === 0 ? downPayment : null),
  });
  Payment.prototype.save = async function () { return this; };
  const restoreFs = stubFsAndUser();
  try {
    const res = mockRes();
    await submitRemainingPaymentProof({ params: { enrollmentId: 'BB-20260904-0002' }, body: { proofDataUrl: TINY_PNG_DATA_URL, paymentMethod: 'gcash' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(emitted.payments.length, 1);
    assert.equal(emitted.payments[0].paymentType, 'remaining');
    assert.equal(emitted.payments[0].amount, 2000);
  } finally {
    Enrollment.findOne = origEnrollmentFindOne; Payment.findOne = origPaymentFindOne;
    Payment.prototype.save = origPaymentSave; restoreFs();
  }
});
