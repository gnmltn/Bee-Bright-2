/**
 * "bug (12).pdf" — the Payments tab's "Pending Payment Verification" list showed only
 * "View Proof" for every payment after Group V removed Verify/Reject entirely. That's
 * correct for down/initial payments (still owned by the Enrollments tab's Approve/Reject),
 * but left remaining-balance payments — which have no Enrollments-tab equivalent at all,
 * since the enrollment already happened — with literally no way to be actioned.
 *
 * Covers paymentController.js's verifyPayment (now remaining-balance-only, "Verify"/"Reject")
 * and the new approveRemainingPayment ("Approve", blocked until Verify has run first, same
 * block-not-warn idiom as adminApproveEnrollment's Group AH gate).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const emailService = require('../utils/emailService');
const capturedEmails = [];
emailService.sendEmail = async (opts) => { capturedEmails.push(opts); return { success: true }; };

const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const Payment = require('../models/Payment');
const User = require('../models/User');
const { verifyPayment, approveRemainingPayment } = require('../controllers/paymentController');

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
    permanentStudentId: 'BB-20260101-0001',
    parent: 'parent-1',
    status: 'approved',
    paymentStatus: 'partial',
    totalFee: 4000,
    studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' },
    ...overrides,
  };
  doc.save = async () => doc;
  return doc;
}

function makePaymentDoc(overrides = {}) {
  const doc = {
    _id: 'pay-remaining-1',
    parent: 'parent-1',
    amount: 2000,
    amountDue: 2000,
    paymentType: 'remaining',
    status: 'submitted',
    proofVerifiedAt: null,
    proofVerifiedBy: null,
    ...overrides,
  };
  doc.save = async () => doc;
  return doc;
}

function stubPaymentFindById(payment, enrollment) {
  const orig = Payment.findById;
  Payment.findById = () => ({
    populate: async () => { payment.enrollment = enrollment; return payment; },
  });
  return () => { Payment.findById = orig; };
}

function stubUserFindById(parentUser) {
  const orig = User.findById;
  User.findById = () => ({ select: () => ({ lean: async () => parentUser }) });
  return () => { User.findById = orig; };
}

test('verifyPayment: refuses a down/full payment — those stay Enrollments-tab-only', async () => {
  const enrollment = makeEnrollment();
  const payment = makePaymentDoc({ paymentType: 'down' });
  const restoreFind = stubPaymentFindById(payment, enrollment);
  try {
    const res = mockRes();
    await verifyPayment({ params: { paymentId: 'pay-remaining-1' }, user: { id: 'admin-1' }, body: { verified: true } }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /Enrollments tab/i);
    assert.equal(payment.proofVerifiedAt, null, 'nothing should have changed');
  } finally { restoreFind(); }
});

test('verifyPayment(verified:true): "Verify" marks the proof verified WITHOUT touching status or the enrollment balance', async () => {
  const enrollment = makeEnrollment({ paymentStatus: 'partial' });
  const payment = makePaymentDoc();
  const restoreFind = stubPaymentFindById(payment, enrollment);
  try {
    const res = mockRes();
    await verifyPayment({ params: { paymentId: 'pay-remaining-1' }, user: { id: 'admin-1' }, body: { verified: true } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.ok(payment.proofVerifiedAt instanceof Date, 'proof-verified timestamp should be set');
    assert.equal(payment.proofVerifiedBy, 'admin-1');
    assert.equal(payment.status, 'submitted', '"Verify" must not advance status — that is Approve\'s job');
    assert.equal(enrollment.paymentStatus, 'partial', '"Verify" must not touch the balance yet');
  } finally { restoreFind(); }
});

test('verifyPayment(verified:false): "Reject" returns the amount to outstanding and clears any prior verification', async () => {
  const enrollment = makeEnrollment({ paymentStatus: 'partial' });
  const payment = makePaymentDoc({ proofVerifiedAt: new Date(), proofVerifiedBy: 'admin-1' });
  const restoreFind = stubPaymentFindById(payment, enrollment);
  try {
    const res = mockRes();
    await verifyPayment({ params: { paymentId: 'pay-remaining-1' }, user: { id: 'admin-1' }, body: { verified: false, rejectionReason: 'Blurry proof' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(payment.status, 'rejected');
    assert.equal(payment.rejectionReason, 'Blurry proof');
    assert.equal(payment.proofVerifiedAt, null, 'a rejected payment should not still look "verified" if resubmitted');
    assert.equal(enrollment.paymentStatus, 'partial', 'still owed — never touches an already-active enrollment\'s status');
  } finally { restoreFind(); }
});

test('approveRemainingPayment: blocked with PROOF_NOT_VERIFIED when Verify has not run yet', async () => {
  const enrollment = makeEnrollment();
  const payment = makePaymentDoc({ proofVerifiedAt: null });
  const restoreFind = stubPaymentFindById(payment, enrollment);
  try {
    const res = mockRes();
    await approveRemainingPayment({ params: { paymentId: 'pay-remaining-1' }, user: { id: 'admin-1' } }, res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, 'PROOF_NOT_VERIFIED');
    assert.equal(payment.status, 'submitted', 'must not have been finalized');
    assert.equal(enrollment.paymentStatus, 'partial', 'balance must be untouched by a blocked approval');
  } finally { restoreFind(); }
});

test('approveRemainingPayment: refuses a down/full payment — those stay Enrollments-tab-only', async () => {
  const enrollment = makeEnrollment();
  const payment = makePaymentDoc({ paymentType: 'down', proofVerifiedAt: new Date() });
  const restoreFind = stubPaymentFindById(payment, enrollment);
  try {
    const res = mockRes();
    await approveRemainingPayment({ params: { paymentId: 'pay-remaining-1' }, user: { id: 'admin-1' } }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /Enrollments tab/i);
  } finally { restoreFind(); }
});

test('approveRemainingPayment: once verified, finalizes the payment and marks the balance paid, and emails the parent', async () => {
  capturedEmails.length = 0;
  const enrollment = makeEnrollment({ paymentStatus: 'partial' });
  const payment = makePaymentDoc({ proofVerifiedAt: new Date('2026-09-29T00:00:00.000Z'), proofVerifiedBy: 'admin-1' });
  const restoreFind = stubPaymentFindById(payment, enrollment);
  const restoreUser = stubUserFindById({ _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' });
  try {
    const res = mockRes();
    await approveRemainingPayment({ params: { paymentId: 'pay-remaining-1' }, user: { id: 'admin-1' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(payment.status, 'verified');
    assert.ok(payment.verifiedAt instanceof Date);
    assert.equal(payment.verifiedBy, 'admin-1');
    assert.equal(payment.amountPaid, 2000);
    assert.equal(enrollment.paymentStatus, 'paid');
    const toParent = capturedEmails.find((e) => e.to === 'parent1@example.com');
    assert.ok(toParent, 'expected the parent to be notified that their payment was approved');
  } finally { restoreFind(); restoreUser(); }
});

test('verifyPayment and approveRemainingPayment: end-to-end — Verify then Approve leaves the payment cleanly settled', async () => {
  capturedEmails.length = 0;
  const enrollment = makeEnrollment({ paymentStatus: 'partial' });
  const payment = makePaymentDoc();
  const restoreFind = stubPaymentFindById(payment, enrollment);
  const restoreUser = stubUserFindById({ _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' });
  try {
    const verifyRes = mockRes();
    await verifyPayment({ params: { paymentId: 'pay-remaining-1' }, user: { id: 'admin-1' }, body: { verified: true } }, verifyRes);
    assert.equal(verifyRes._status, 200);
    assert.equal(enrollment.paymentStatus, 'partial', 'still not finalized right after Verify');

    const approveRes = mockRes();
    await approveRemainingPayment({ params: { paymentId: 'pay-remaining-1' }, user: { id: 'admin-1' } }, approveRes);
    assert.equal(approveRes._status, 200, JSON.stringify(approveRes._body));
    assert.equal(payment.status, 'verified');
    assert.equal(enrollment.paymentStatus, 'paid');
  } finally { restoreFind(); restoreUser(); }
});
