/**
 * Security audit fix #2 — enrollmentId is a sequential, guessable value
 * (BB-YYYYMMDD-NNNN), so submitPaymentProof/submitRemainingPaymentProof must verify
 * the calling user actually owns the enrollment (or is an admin) before accepting a
 * payment proof against it. Previously neither function checked this at all.
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
const { submitPaymentProof, submitRemainingPaymentProof } = require('../controllers/enrollmentController');

// A real, minimal valid 1x1 PNG — enrollmentController now verifies the actual bytes
// via magic-byte sniffing, not just the declared data: URL prefix, so a fake payload
// would be rejected.
const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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
    parent: 'owning-parent',
    status: 'approved',
    paymentStatus: 'pending',
    totalFee: 4000,
    packages: [{ price: 4000 }],
    statusHistory: [],
    studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' },
    ...overrides,
  };
  doc.save = async () => doc;
  return doc;
}

function stubFsAndUser() {
  const fs = require('fs');
  const orig = { write: fs.writeFileSync, exists: fs.existsSync, mkdir: fs.mkdirSync, userFindById: User.findById };
  fs.writeFileSync = () => {};
  fs.existsSync = () => true;
  fs.mkdirSync = () => {};
  User.findById = () => ({ select: () => ({ lean: async () => ({ _id: 'owning-parent', email: 'owner@example.com', firstName: 'Maria', lastName: 'Cruz' }) }) });
  return () => { fs.writeFileSync = orig.write; fs.existsSync = orig.exists; fs.mkdirSync = orig.mkdir; User.findById = orig.userFindById; };
}

// ── submitPaymentProof (down payment) ────────────────────────────────────────

test('submitPaymentProof: a DIFFERENT parent is forbidden — cannot submit a proof against someone else\'s enrollment', async () => {
  const enrollment = makeEnrollment();
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  Enrollment.findOne = async () => enrollment;
  let paymentFindOneCalled = false;
  Payment.findOne = () => { paymentFindOneCalled = true; return { sort: () => Promise.resolve(null) }; };
  const restoreFs = stubFsAndUser();
  try {
    const res = mockRes();
    await submitPaymentProof({
      params: { enrollmentId: 'BB-20260904-0001' },
      user: { _id: 'a-different-parent', role: 'parent' },
      body: { proofDataUrl: TINY_PNG_DATA_URL, paymentMethod: 'gcash' },
    }, res);
    assert.equal(res._status, 403, JSON.stringify(res._body));
    assert.match(res._body.message, /not authorized/i);
    assert.equal(paymentFindOneCalled, false, 'must reject before ever touching Payment records');
  } finally {
    Enrollment.findOne = origEnrollmentFindOne;
    Payment.findOne = origPaymentFindOne;
    restoreFs();
  }
});

test('submitPaymentProof: the OWNING parent can still submit normally', async () => {
  const enrollment = makeEnrollment();
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  const origPaymentSave = Payment.prototype.save;
  Enrollment.findOne = async () => enrollment;
  Payment.findOne = () => ({ sort: () => Promise.resolve(null) });
  Payment.prototype.save = async function () { return this; };
  const restoreFs = stubFsAndUser();
  try {
    const res = mockRes();
    await submitPaymentProof({
      params: { enrollmentId: 'BB-20260904-0001' },
      user: { _id: 'owning-parent', role: 'parent' },
      body: { proofDataUrl: TINY_PNG_DATA_URL, paymentMethod: 'gcash' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
  } finally {
    Enrollment.findOne = origEnrollmentFindOne;
    Payment.findOne = origPaymentFindOne;
    Payment.prototype.save = origPaymentSave;
    restoreFs();
  }
});

test('submitPaymentProof: an admin can submit on behalf of any enrollment', async () => {
  const enrollment = makeEnrollment();
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  const origPaymentSave = Payment.prototype.save;
  Enrollment.findOne = async () => enrollment;
  Payment.findOne = () => ({ sort: () => Promise.resolve(null) });
  Payment.prototype.save = async function () { return this; };
  const restoreFs = stubFsAndUser();
  try {
    const res = mockRes();
    await submitPaymentProof({
      params: { enrollmentId: 'BB-20260904-0001' },
      user: { _id: 'admin-1', role: 'admin' },
      body: { proofDataUrl: TINY_PNG_DATA_URL, paymentMethod: 'gcash' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
  } finally {
    Enrollment.findOne = origEnrollmentFindOne;
    Payment.findOne = origPaymentFindOne;
    Payment.prototype.save = origPaymentSave;
    restoreFs();
  }
});

// ── submitRemainingPaymentProof ──────────────────────────────────────────────

function makeDownPayment() {
  return { status: 'verified', amountPaid: 2000, amountDue: 2000, amount: 2000 };
}

test('submitRemainingPaymentProof: a DIFFERENT parent is forbidden', async () => {
  const enrollment = makeEnrollment({ paymentStatus: 'partial' });
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  Enrollment.findOne = async () => enrollment;
  let paymentFindOneCalled = false;
  Payment.findOne = () => { paymentFindOneCalled = true; return { sort: () => Promise.resolve(makeDownPayment()) }; };
  const restoreFs = stubFsAndUser();
  try {
    const res = mockRes();
    await submitRemainingPaymentProof({
      params: { enrollmentId: 'BB-20260904-0001' },
      user: { _id: 'a-different-parent', role: 'parent' },
      body: { proofDataUrl: TINY_PNG_DATA_URL, paymentMethod: 'gcash' },
    }, res);
    assert.equal(res._status, 403, JSON.stringify(res._body));
    assert.match(res._body.message, /not authorized/i);
    assert.equal(paymentFindOneCalled, false, 'must reject before ever touching Payment records');
  } finally {
    Enrollment.findOne = origEnrollmentFindOne;
    Payment.findOne = origPaymentFindOne;
    restoreFs();
  }
});

test('submitRemainingPaymentProof: the OWNING parent can still submit normally', async () => {
  const enrollment = makeEnrollment({ paymentStatus: 'partial' });
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  const origPaymentSave = Payment.prototype.save;
  Enrollment.findOne = async () => enrollment;
  let call = 0;
  Payment.findOne = () => ({ sort: () => Promise.resolve(call++ === 0 ? makeDownPayment() : null) });
  Payment.prototype.save = async function () { return this; };
  const restoreFs = stubFsAndUser();
  try {
    const res = mockRes();
    await submitRemainingPaymentProof({
      params: { enrollmentId: 'BB-20260904-0001' },
      user: { _id: 'owning-parent', role: 'parent' },
      body: { proofDataUrl: TINY_PNG_DATA_URL, paymentMethod: 'gcash' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
  } finally {
    Enrollment.findOne = origEnrollmentFindOne;
    Payment.findOne = origPaymentFindOne;
    Payment.prototype.save = origPaymentSave;
    restoreFs();
  }
});

test('submitRemainingPaymentProof: an admin can submit on behalf of any enrollment', async () => {
  const enrollment = makeEnrollment({ paymentStatus: 'partial' });
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  const origPaymentSave = Payment.prototype.save;
  Enrollment.findOne = async () => enrollment;
  let call = 0;
  Payment.findOne = () => ({ sort: () => Promise.resolve(call++ === 0 ? makeDownPayment() : null) });
  Payment.prototype.save = async function () { return this; };
  const restoreFs = stubFsAndUser();
  try {
    const res = mockRes();
    await submitRemainingPaymentProof({
      params: { enrollmentId: 'BB-20260904-0001' },
      user: { _id: 'admin-1', role: 'admin' },
      body: { proofDataUrl: TINY_PNG_DATA_URL, paymentMethod: 'gcash' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
  } finally {
    Enrollment.findOne = origEnrollmentFindOne;
    Payment.findOne = origPaymentFindOne;
    Payment.prototype.save = origPaymentSave;
    restoreFs();
  }
});
