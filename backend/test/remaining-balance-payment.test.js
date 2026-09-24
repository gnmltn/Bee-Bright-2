/**
 * Parent_Payments_50Percent_Display_and_Payment_Methods.pdf — the enrollment used to
 * be marked paymentStatus: 'paid' (fully settled) the moment admin approved it, even
 * though only the 50% down payment had been verified. Covers the fix (adminApproveEnrollment
 * now sets 'partial', not 'paid') and the new remaining-balance payment flow
 * (submitRemainingPaymentProof + adminVerifyPayment's paymentType branching).
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
const {
  adminApproveEnrollment,
  adminVerifyPayment,
  submitRemainingPaymentProof,
} = require('../controllers/enrollmentController');

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
    enrollmentId: 'BB-20260101-0001',
    parent: 'parent-1',
    status: 'pending_approval',
    paymentStatus: 'partial',
    totalFee: 4000,
    statusHistory: [],
    studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' },
    ...overrides,
  };
  doc.save = async () => doc;
  return doc;
}

function makePaymentDoc(overrides = {}) {
  const doc = {
    _id: 'pay-1',
    enrollment: 'enr-1',
    parent: 'parent-1',
    amount: 2000,
    amountDue: 2000,
    paymentType: 'down',
    status: 'submitted',
    ...overrides,
  };
  doc.save = async () => doc;
  doc.isNew = overrides.isNew !== undefined ? overrides.isNew : true;
  return doc;
}

function stubEnrollmentAndUser({ enrollment, parentUser }) {
  const origEnrollmentFindById = Enrollment.findById;
  const origEnrollmentCountDocuments = Enrollment.countDocuments;
  const origUserFindByIdAndUpdate = User.findByIdAndUpdate;
  const origUserFindById = User.findById;

  Enrollment.findById = async () => enrollment;
  Enrollment.countDocuments = async () => 0;
  User.findByIdAndUpdate = async () => ({});
  User.findById = () => ({ select: () => ({ lean: async () => parentUser }) });

  return {
    restore() {
      Enrollment.findById = origEnrollmentFindById;
      Enrollment.countDocuments = origEnrollmentCountDocuments;
      User.findByIdAndUpdate = origUserFindByIdAndUpdate;
      User.findById = origUserFindById;
    },
  };
}

test('adminApproveEnrollment: sets paymentStatus to partial, not paid — the remaining 50% is still owed', async () => {
  const enrollment = makeEnrollment({ status: 'submitted' });
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubEnrollmentAndUser({ enrollment, parentUser });
  try {
    const res = mockRes();
    await adminApproveEnrollment({ params: { id: 'enr-1' }, user: { _id: 'admin-1', role: 'admin' }, body: {} }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(enrollment.status, 'approved');
    assert.equal(enrollment.paymentStatus, 'partial', 'must not claim the full package is paid off a 50% down payment');
  } finally { restore(); }
});

test('adminVerifyPayment: verifying the DOWN payment sets paymentStatus to partial (not paid), and pushes pending_approval', async () => {
  const enrollment = makeEnrollment({ paymentStatus: 'submitted' });
  const payment = makePaymentDoc({ paymentType: 'down' });
  const origEnrollmentFindById = Enrollment.findById;
  const origPaymentFindById = Payment.findById;
  const origUserFindById = User.findById;
  Enrollment.findById = async () => enrollment;
  Payment.findById = async () => payment;
  User.findById = () => ({ select: () => ({ lean: async () => ({ _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' }) }) });
  try {
    const res = mockRes();
    await adminVerifyPayment({ params: { id: 'enr-1' }, user: { _id: 'admin-1', role: 'admin' }, body: { verified: true, paymentId: 'pay-1' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(payment.status, 'verified');
    assert.equal(enrollment.paymentStatus, 'partial');
    assert.ok(enrollment.statusHistory.some((h) => h.status === 'pending_approval'), 'down-payment verification still advances the approval pipeline');
  } finally {
    Enrollment.findById = origEnrollmentFindById;
    Payment.findById = origPaymentFindById;
    User.findById = origUserFindById;
  }
});

test('adminVerifyPayment: verifying the REMAINING-balance payment sets paymentStatus to paid, without touching status history', async () => {
  const enrollment = makeEnrollment({ status: 'approved', paymentStatus: 'pending_verification' });
  const payment = makePaymentDoc({ paymentType: 'remaining', amount: 2000, amountDue: 2000 });
  const origEnrollmentFindById = Enrollment.findById;
  const origPaymentFindById = Payment.findById;
  const origUserFindById = User.findById;
  Enrollment.findById = async () => enrollment;
  Payment.findById = async () => payment;
  User.findById = () => ({ select: () => ({ lean: async () => ({ _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' }) }) });
  try {
    const res = mockRes();
    await adminVerifyPayment({ params: { id: 'enr-1' }, user: { _id: 'admin-1', role: 'admin' }, body: { verified: true, paymentId: 'pay-1' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(payment.status, 'verified');
    assert.equal(enrollment.paymentStatus, 'paid', 'fully paid only once the remaining balance is also verified');
    assert.equal(enrollment.status, 'approved', 'verifying the remaining balance must not touch enrollment.status');
    assert.equal(enrollment.statusHistory.length, 0, 'must not re-push an approval-pipeline status entry for a second-installment payment');
  } finally {
    Enrollment.findById = origEnrollmentFindById;
    Payment.findById = origPaymentFindById;
    User.findById = origUserFindById;
  }
});

test('adminVerifyPayment: rejecting the REMAINING-balance payment reverts to partial, not failed/cancelled', async () => {
  const enrollment = makeEnrollment({ status: 'approved', paymentStatus: 'pending_verification' });
  const payment = makePaymentDoc({ paymentType: 'remaining' });
  const origEnrollmentFindById = Enrollment.findById;
  const origPaymentFindById = Payment.findById;
  const origUserFindById = User.findById;
  Enrollment.findById = async () => enrollment;
  Payment.findById = async () => payment;
  User.findById = () => ({ select: () => ({ lean: async () => null }) });
  try {
    const res = mockRes();
    await adminVerifyPayment({ params: { id: 'enr-1' }, user: { _id: 'admin-1', role: 'admin' }, body: { verified: false, paymentId: 'pay-1', note: 'Blurry receipt' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(payment.status, 'rejected');
    assert.equal(enrollment.paymentStatus, 'partial');
    assert.equal(enrollment.status, 'approved', 'a rejected remaining-balance payment must not cancel an already-active enrollment');
  } finally {
    Enrollment.findById = origEnrollmentFindById;
    Payment.findById = origPaymentFindById;
    User.findById = origUserFindById;
  }
});

test('submitRemainingPaymentProof: blocked until the down payment is verified', async () => {
  const enrollment = makeEnrollment({ status: 'approved', paymentStatus: 'submitted' });
  const downPayment = makePaymentDoc({ paymentType: 'down', status: 'submitted' });
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  Enrollment.findOne = async () => enrollment;
  Payment.findOne = (filter) => ({
    sort: () => Promise.resolve(filter.paymentType?.$ne === 'remaining' ? downPayment : null),
  });
  try {
    const res = mockRes();
    await submitRemainingPaymentProof({ params: { enrollmentId: 'BB-20260101-0001' }, body: { proofDataUrl: TINY_PNG_DATA_URL } }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /down payment must be verified/i);
  } finally {
    Enrollment.findOne = origEnrollmentFindOne;
    Payment.findOne = origPaymentFindOne;
  }
});

test('submitRemainingPaymentProof: computes the remaining amount as totalFee minus what was already paid, and creates a remaining-type Payment', async () => {
  const enrollment = makeEnrollment({ status: 'approved', paymentStatus: 'partial', totalFee: 4000 });
  const downPayment = makePaymentDoc({ paymentType: 'down', status: 'verified', amountPaid: 2000 });
  const fs = require('fs');
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  const origPaymentSave = Payment.prototype.save;
  const origUserFindById = User.findById;
  const origFsWrite = fs.writeFileSync;
  const origFsExists = fs.existsSync;
  const origFsMkdir = fs.mkdirSync;

  let savedPaymentType = null;
  Enrollment.findOne = async () => enrollment;
  Payment.findOne = (filter) => ({
    sort: () => Promise.resolve(filter.paymentType?.$ne === 'remaining' ? downPayment : null),
  });
  User.findById = () => ({ select: () => ({ lean: async () => ({ _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' }) }) });
  // A real `new Payment(data)` document is used (not a plain object) — stubbing
  // .save() avoids hitting a real DB connection while still exercising the
  // controller's actual field-mapping (paymentType/amount/amountDue) via `this`.
  Payment.prototype.save = async function () { savedPaymentType = this.paymentType; return this; };
  fs.writeFileSync = () => {};
  fs.existsSync = () => true;
  fs.mkdirSync = () => {};

  try {
    const res = mockRes();
    await submitRemainingPaymentProof({ params: { enrollmentId: 'BB-20260101-0001' }, body: { proofDataUrl: TINY_PNG_DATA_URL, payerReference: 'REF123' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.amount, 2000, 'remaining balance = totalFee(4000) - amountPaid(2000)');
    assert.equal(savedPaymentType, 'remaining');
    assert.equal(enrollment.paymentStatus, 'pending_verification');
  } finally {
    Enrollment.findOne = origEnrollmentFindOne;
    Payment.findOne = origPaymentFindOne;
    Payment.prototype.save = origPaymentSave;
    User.findById = origUserFindById;
    fs.writeFileSync = origFsWrite;
    fs.existsSync = origFsExists;
    fs.mkdirSync = origFsMkdir;
  }
});
