/**
 * NewProgram_Modal_AgeCheck_PaymentBug_ContactTutor.pdf Section C — submitPaymentProof
 * returned a blanket "Payment record not found" 404 for any enrollment with no
 * matching Payment document, including enrollments that are already fully paid
 * (misleading — nothing is actually wrong) and enrollments with a genuine gap
 * (blocking the parent from ever paying). Covers both branches of the fix.
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
const { submitPaymentProof } = require('../controllers/enrollmentController');

const TINY_PNG_DATA_URL = 'data:image/png;base64,' + Buffer.from('fake-image-bytes').toString('base64');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

function makeEnrollment(overrides = {}) {
  const doc = {
    _id: 'enr-1',
    enrollmentId: 'BB-20260904-0001',
    parent: 'parent-1',
    status: 'approved',
    paymentStatus: 'paid',
    packages: [{ price: 2400 }],
    statusHistory: [],
    studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' },
    ...overrides,
  };
  doc.save = async () => doc;
  return doc;
}

function stubFsAndUser() {
  const fs = require('fs');
  const origWrite = fs.writeFileSync;
  const origExists = fs.existsSync;
  const origMkdir = fs.mkdirSync;
  const origUserFindById = User.findById;
  fs.writeFileSync = () => {};
  fs.existsSync = () => true;
  fs.mkdirSync = () => {};
  User.findById = () => ({ select: () => ({ lean: async () => ({ _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' }) }) });
  return () => {
    fs.writeFileSync = origWrite;
    fs.existsSync = origExists;
    fs.mkdirSync = origMkdir;
    User.findById = origUserFindById;
  };
}

test('submitPaymentProof: an already-paid enrollment with no Payment record returns a clear "already paid" response, not a false 404', async () => {
  const enrollment = makeEnrollment({ paymentStatus: 'paid' });
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  Enrollment.findOne = async () => enrollment;
  Payment.findOne = () => ({ sort: () => Promise.resolve(null) });
  const restore = stubFsAndUser();
  try {
    const res = mockRes();
    await submitPaymentProof({ params: { enrollmentId: 'BB-20260904-0001' }, body: { proofDataUrl: TINY_PNG_DATA_URL, paymentMethod: 'gcash' } }, res);
    assert.equal(res._status, 409, JSON.stringify(res._body));
    assert.equal(res._body.alreadyPaid, true);
    assert.match(res._body.message, /already fully paid/i);
  } finally {
    Enrollment.findOne = origEnrollmentFindOne;
    Payment.findOne = origPaymentFindOne;
    restore();
  }
});

test('submitPaymentProof: a not-yet-paid enrollment with a missing Payment record self-heals by creating one, instead of permanently blocking the parent', async () => {
  const enrollment = makeEnrollment({ paymentStatus: 'pending', packages: [{ price: 4000 }] });
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  const origPaymentSave = Payment.prototype.save;
  let savedPayment = null;
  Enrollment.findOne = async () => enrollment;
  Payment.findOne = () => ({ sort: () => Promise.resolve(null) });
  Payment.prototype.save = async function () { savedPayment = this; return this; };
  const restore = stubFsAndUser();
  try {
    const res = mockRes();
    await submitPaymentProof({ params: { enrollmentId: 'BB-20260904-0001' }, body: { proofDataUrl: TINY_PNG_DATA_URL, paymentMethod: 'gcash' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.ok(savedPayment, 'a Payment document should have been created and saved');
    assert.equal(savedPayment.paymentType, 'down');
    assert.equal(savedPayment.amount, 2000, 'self-healed payment uses the standard 50%-down policy');
    assert.equal(savedPayment.proofUrl != null, true, 'the proof should be attached to the newly-created payment');
    assert.equal(enrollment.paymentStatus, 'submitted');
  } finally {
    Enrollment.findOne = origEnrollmentFindOne;
    Payment.findOne = origPaymentFindOne;
    Payment.prototype.save = origPaymentSave;
    restore();
  }
});
