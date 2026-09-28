/**
 * Enrollment_Approval_Gate_and_Status_Email.pdf, Features 2+3 — automatic parent
 * email when admin approves or rejects a pending enrollment (replaces a separate
 * parent-facing "track my enrollment" screen). This mechanism already existed in
 * adminApproveEnrollment/adminRejectEnrollment (enrollmentController.js) and reuses
 * the same sendEmail utility as the Suspension/Emergency Adjustment notifications —
 * this file adds the regression coverage that was missing for it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// ── Patch the module seams BEFORE requiring the controller ────────────────
const emailService = require('../utils/emailService');
const sentEmails = [];
emailService.sendEmail = async (opts, label) => {
  sentEmails.push({ opts, label });
  return { success: true };
};
emailService.logEmailError = () => {};

const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

// adminRejectEnrollment now hard-deletes instead of just flagging the enrollment — patch the
// same module seam pattern as above, before the controller (which destructures these) is
// first required, so its captured reference is already the stub.
const hardDeleteUserModule = require('../utils/hardDeleteUser');
const hardDeleteCalls = [];
hardDeleteUserModule.hardDeleteUser = async (user, session) => {
  hardDeleteCalls.push({ user, session });
  return { deletedUsers: 1 };
};
const runTransactionSafeModule = require('../utils/runTransactionSafe');
runTransactionSafeModule.runTransactionSafe = async (work) => work(null);

const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const Payment = require('../models/Payment');
const { adminApproveEnrollment, adminRejectEnrollment } = require('../controllers/enrollmentController');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

function makeEnrollment(overrides = {}) {
  const doc = {
    _id: 'enr-1',
    enrollmentId: 'ENR-2026-0001',
    parent: 'parent-1',
    status: 'pending_approval',
    paymentStatus: 'paid',
    studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' },
    ...overrides,
  };
  doc.save = async () => doc;
  return doc;
}

// Chainable AND directly-awaitable: adminApproveEnrollment calls
// `User.findById(id).select(...).lean()` while adminRejectEnrollment calls plain
// `await User.findById(id)` (it needs the full doc, not a lean projection, to pass into
// hardDeleteUser) — this one mock satisfies both calling conventions.
function findByIdMock(result) {
  const chainable = {
    select: () => chainable,
    lean: async () => result,
    then: (resolve) => resolve(result),
  };
  return chainable;
}

function mockQuery(result) {
  const q = { select: () => q, lean: () => Promise.resolve(result) };
  return q;
}

function stubCommon({ enrollment, parentUser, payments }) {
  const origEnrollmentFindById = Enrollment.findById;
  const origEnrollmentCountDocuments = Enrollment.countDocuments;
  const origUserFindByIdAndUpdate = User.findByIdAndUpdate;
  const origUserFindById = User.findById;
  const origPaymentDeleteMany = Payment.deleteMany;
  const origPaymentFind = Payment.find;
  const origEnrollmentDeleteOne = Enrollment.deleteOne;

  Enrollment.findById = async () => enrollment;
  Enrollment.countDocuments = async () => 0;
  User.findByIdAndUpdate = async () => ({});
  User.findById = () => findByIdMock(parentUser);
  Payment.deleteMany = async () => ({});
  // adminApproveEnrollment's payment-verified gate — a verified down payment by default so
  // every EXISTING test in this file (which assumes approval succeeds) keeps working; the
  // unverified-block test below overrides this per-call.
  Payment.find = () => mockQuery(payments ?? [{ status: 'verified', paymentType: 'down' }]);
  Enrollment.deleteOne = async () => ({});

  return {
    restore() {
      Enrollment.findById = origEnrollmentFindById;
      Enrollment.countDocuments = origEnrollmentCountDocuments;
      User.findByIdAndUpdate = origUserFindByIdAndUpdate;
      User.findById = origUserFindById;
      Payment.deleteMany = origPaymentDeleteMany;
      Payment.find = origPaymentFind;
      Enrollment.deleteOne = origEnrollmentDeleteOne;
    },
  };
}

test('adminApproveEnrollment: emails the parent\'s registered address, naming the child, on approval', async () => {
  sentEmails.length = 0;
  const enrollment = makeEnrollment();
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser });
  try {
    const res = mockRes();
    await adminApproveEnrollment({ params: { id: 'enr-1' }, user: { _id: 'admin-1', role: 'admin' }, body: {} }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(enrollment.status, 'approved');

    const approvalEmail = sentEmails.find((e) => e.label === 'enrollment approved');
    assert.ok(approvalEmail, 'expected an "enrollment approved" email to be sent');
    assert.equal(approvalEmail.opts.to, 'parent1@example.com');
    assert.match(approvalEmail.opts.subject, /approved/i);
    assert.match(approvalEmail.opts.html, /Ana Cruz/);
  } finally { restore(); }
});

// ── "bug (9).pdf" Group AH — Approve is BLOCKED (not warn-and-override) until the payment
// is actually verified, so an enrollment can never end up "approved" while its payment is
// still unverified. ────────────────────────────────────────────────────────────────────
test('adminApproveEnrollment: BLOCKS approval when the down payment has not been verified — never approves, never emails', async () => {
  sentEmails.length = 0;
  const enrollment = makeEnrollment({ status: 'payment_under_verification' });
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  // No verified, non-remaining payment at all — proof was submitted but never verified.
  const { restore } = stubCommon({ enrollment, parentUser, payments: [{ status: 'submitted', paymentType: 'down' }] });
  try {
    const res = mockRes();
    await adminApproveEnrollment({ params: { id: 'enr-1' }, user: { _id: 'admin-1', role: 'admin' }, body: {} }, res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.equal(res._body.code, 'PAYMENT_NOT_VERIFIED');
    assert.match(res._body.message, /not been verified/i);
    // The enrollment must be left completely untouched — no partial/conflicting state.
    assert.equal(enrollment.status, 'payment_under_verification');
    assert.equal(sentEmails.find((e) => e.label === 'enrollment approved'), undefined, 'must never send the approval email when blocked');
  } finally { restore(); }
});

test('adminApproveEnrollment: a rejected/resubmitted payment (no currently-verified one) still blocks approval', async () => {
  sentEmails.length = 0;
  const enrollment = makeEnrollment({ status: 'payment_under_verification' });
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser, payments: [{ status: 'rejected', paymentType: 'down' }, { status: 'submitted', paymentType: 'down' }] });
  try {
    const res = mockRes();
    await adminApproveEnrollment({ params: { id: 'enr-1' }, user: { _id: 'admin-1', role: 'admin' }, body: {} }, res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.equal(res._body.code, 'PAYMENT_NOT_VERIFIED');
  } finally { restore(); }
});

test('adminApproveEnrollment: a verified REMAINING payment alone does not count as the down payment being verified', async () => {
  sentEmails.length = 0;
  const enrollment = makeEnrollment({ status: 'payment_under_verification' });
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser, payments: [{ status: 'verified', paymentType: 'remaining' }] });
  try {
    const res = mockRes();
    await adminApproveEnrollment({ params: { id: 'enr-1' }, user: { _id: 'admin-1', role: 'admin' }, body: {} }, res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.equal(res._body.code, 'PAYMENT_NOT_VERIFIED');
  } finally { restore(); }
});

test('adminApproveEnrollment: once the down payment IS verified, approval proceeds with no warning', async () => {
  sentEmails.length = 0;
  const enrollment = makeEnrollment({ status: 'pending_approval' });
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser, payments: [{ status: 'verified', paymentType: 'down' }] });
  try {
    const res = mockRes();
    await adminApproveEnrollment({ params: { id: 'enr-1' }, user: { _id: 'admin-1', role: 'admin' }, body: {} }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(enrollment.status, 'approved');
    assert.ok(sentEmails.find((e) => e.label === 'enrollment approved'), 'expected the approval email once payment is verified');
  } finally { restore(); }
});

test('adminRejectEnrollment: emails the parent, naming the child and including the rejection reason, then hard-deletes the account', async () => {
  sentEmails.length = 0;
  hardDeleteCalls.length = 0;
  const enrollment = makeEnrollment();
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser });
  try {
    const res = mockRes();
    await adminRejectEnrollment({
      params: { id: 'enr-1' },
      user: { _id: 'admin-1', role: 'admin' },
      body: { reason: 'Payment proof was unreadable' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.wholeAccountDeleted, true);

    // Reused the same transaction-safe hard-delete utility the Archive → Delete flow uses.
    assert.equal(hardDeleteCalls.length, 1, 'expected hardDeleteUser to be called once');
    assert.equal(hardDeleteCalls[0].user, parentUser);

    const rejectionEmail = sentEmails.find((e) => e.label === 'enrollment rejected');
    assert.ok(rejectionEmail, 'expected an "enrollment rejected" email to be sent');
    assert.equal(rejectionEmail.opts.to, 'parent1@example.com');
    assert.match(rejectionEmail.opts.html, /Ana Cruz/);
    assert.match(rejectionEmail.opts.html, /Payment proof was unreadable/);
    // The account no longer exists once this email is sent — never invite the parent to
    // log in or resubmit into it.
    assert.doesNotMatch(rejectionEmail.opts.html, /log ?in/i);
    assert.match(rejectionEmail.opts.html, /new enrollment/i);
  } finally { restore(); }
});

test('adminRejectEnrollment: still emails the parent and hard-deletes when no rejection reason is given', async () => {
  sentEmails.length = 0;
  hardDeleteCalls.length = 0;
  const enrollment = makeEnrollment();
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser });
  try {
    const res = mockRes();
    await adminRejectEnrollment({
      params: { id: 'enr-1' },
      user: { _id: 'admin-1', role: 'admin' },
      body: {},
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(hardDeleteCalls.length, 1);

    const rejectionEmail = sentEmails.find((e) => e.label === 'enrollment rejected');
    assert.ok(rejectionEmail, 'expected an "enrollment rejected" email to be sent even without an explicit reason');
    assert.equal(rejectionEmail.opts.to, 'parent1@example.com');
  } finally { restore(); }
});

test('adminRejectEnrollment: a parent with another enrollment keeps their account — only this enrollment is deleted', async () => {
  sentEmails.length = 0;
  hardDeleteCalls.length = 0;
  const enrollment = makeEnrollment();
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser });
  const origCount = Enrollment.countDocuments;
  Enrollment.countDocuments = async () => 1; // an unrelated, already-approved enrollment exists
  const deletedPaymentFilters = [];
  const deletedEnrollmentFilters = [];
  Payment.deleteMany = async (filter) => { deletedPaymentFilters.push(filter); return {}; };
  Enrollment.deleteOne = async (filter) => { deletedEnrollmentFilters.push(filter); return {}; };
  try {
    const res = mockRes();
    await adminRejectEnrollment({
      params: { id: 'enr-1' },
      user: { _id: 'admin-1', role: 'admin' },
      body: { reason: 'Payment proof was unreadable' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.wholeAccountDeleted, false);
    assert.equal(hardDeleteCalls.length, 0, 'the whole account must NOT be deleted when other enrollments exist');
    assert.equal(deletedPaymentFilters.length, 1);
    assert.equal(deletedEnrollmentFilters.length, 1);
    assert.equal(String(deletedEnrollmentFilters[0]._id), 'enr-1');
  } finally { restore(); Enrollment.countDocuments = origCount; }
});
