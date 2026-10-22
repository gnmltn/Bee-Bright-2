/**
 * Enrollment_Approval_Gate_and_Status_Email.pdf, Features 2+3 — automatic parent
 * email when admin approves or rejects a pending enrollment (replaces a separate
 * parent-facing "track my enrollment" screen). This mechanism already existed in
 * adminApproveEnrollment/adminRejectEnrollment (enrollmentController.js) and reuses
 * the same sendEmail utility as the Suspension/Emergency Adjustment notifications —
 * this file adds the regression coverage that was missing for it.
 *
 * Panel-required change (follow-up): adminRejectEnrollment used to hard-delete the
 * account/enrollment on reject. It no longer does — Reject now only flips status to
 * 'rejected' (or 'cancelled', via the legacy updateEnrollmentStatus alias) + sets
 * rejectionReason/allowResubmission, the same non-destructive status-update pattern
 * adminVerifyPayment's own reject branch already used. The reject-specific tests below
 * were rewritten for this; adminApproveEnrollment's own tests above are unaffected.
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

const realtimeModule = require('../utils/realtime');
const emitToParentCalls = [];
realtimeModule.emitToParent = (parentId, event, payload) => { emitToParentCalls.push({ parentId, event, payload }); };

const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const Payment = require('../models/Payment');
const { adminApproveEnrollment, adminRejectEnrollment, updateEnrollmentStatus } = require('../controllers/enrollmentController');

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

// Approval previously emitted no realtime event at all — anything gated purely on "is this
// child's enrollment approved" (Renew/Add Program lock, Viewing-child switcher) had no way
// to update live; the parent only learned about it on their next full page load.
test('adminApproveEnrollment: pushes a live enrollment:statusChanged event to the parent', async () => {
  sentEmails.length = 0;
  emitToParentCalls.length = 0;
  const enrollment = makeEnrollment();
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser });
  try {
    const res = mockRes();
    await adminApproveEnrollment({ params: { id: 'enr-1' }, user: { _id: 'admin-1', role: 'admin' }, body: {} }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(emitToParentCalls.length, 1);
    assert.equal(emitToParentCalls[0].parentId, 'parent-1');
    assert.equal(emitToParentCalls[0].event, 'enrollment:statusChanged');
    assert.equal(emitToParentCalls[0].payload.status, 'approved');
  } finally { restore(); }
});

test('adminApproveEnrollment: BLOCKED approval (payment not verified) never emits the live status event', async () => {
  sentEmails.length = 0;
  emitToParentCalls.length = 0;
  const enrollment = makeEnrollment({ status: 'payment_under_verification' });
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser, payments: [{ status: 'submitted', paymentType: 'down' }] });
  try {
    const res = mockRes();
    await adminApproveEnrollment({ params: { id: 'enr-1' }, user: { _id: 'admin-1', role: 'admin' }, body: {} }, res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.equal(emitToParentCalls.length, 0);
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

test('adminRejectEnrollment: does NOT delete the enrollment or the account — sets status to rejected, keeps everything else', async () => {
  sentEmails.length = 0;
  const enrollment = makeEnrollment();
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser });
  const origDeleteOne = Enrollment.deleteOne;
  const origDeleteMany = Payment.deleteMany;
  let deleteOneCalled = false;
  let deleteManyCalled = false;
  Enrollment.deleteOne = async () => { deleteOneCalled = true; return {}; };
  Payment.deleteMany = async () => { deleteManyCalled = true; return {}; };
  try {
    const res = mockRes();
    await adminRejectEnrollment({
      params: { id: 'enr-1' },
      user: { _id: 'admin-1', role: 'admin' },
      body: { reason: 'Payment proof was unreadable' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(deleteOneCalled, false, 'the enrollment must never be deleted');
    assert.equal(deleteManyCalled, false, 'payment records must never be deleted');
    assert.equal(enrollment.status, 'rejected');
    assert.equal(enrollment.rejectionReason, 'Payment proof was unreadable');
    assert.equal(enrollment.allowResubmission, true, 'resubmission must be allowed by default');
    assert.equal(enrollment.paymentStatus, 'rejected');
  } finally { restore(); Enrollment.deleteOne = origDeleteOne; Payment.deleteMany = origDeleteMany; }
});

test('adminRejectEnrollment: an Add Child enrollment (source: "add_child") is rejected the exact same non-destructive way — admin side never branches on source', async () => {
  sentEmails.length = 0;
  const enrollment = makeEnrollment({ source: 'add_child' });
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser });
  const origDeleteOne = Enrollment.deleteOne;
  let deleteOneCalled = false;
  Enrollment.deleteOne = async () => { deleteOneCalled = true; return {}; };
  try {
    const res = mockRes();
    await adminRejectEnrollment({
      params: { id: 'enr-1' },
      user: { _id: 'admin-1', role: 'admin' },
      body: { reason: 'Photo requirement unreadable' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(deleteOneCalled, false, 'the Add Child enrollment must never be deleted either');
    assert.equal(enrollment.status, 'rejected');
    assert.equal(enrollment.allowResubmission, true);
  } finally { restore(); Enrollment.deleteOne = origDeleteOne; }
});

test('adminRejectEnrollment: emails the parent naming the child and the reason, with a log-in-and-resubmit path (not a dead end)', async () => {
  sentEmails.length = 0;
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

    const rejectionEmail = sentEmails.find((e) => e.label === 'enrollment rejected');
    assert.ok(rejectionEmail, 'expected an "enrollment rejected" email to be sent');
    assert.equal(rejectionEmail.opts.to, 'parent1@example.com');
    assert.match(rejectionEmail.opts.html, /Ana Cruz/);
    assert.match(rejectionEmail.opts.html, /Payment proof was unreadable/);
    // The account still exists — invite the parent to log in and resubmit, not to start over.
    assert.match(rejectionEmail.opts.html, /log ?in/i);
    assert.doesNotMatch(rejectionEmail.opts.html, /start a new enrollment/i);
  } finally { restore(); }
});

test('adminRejectEnrollment: still emails the parent when no rejection reason is given', async () => {
  sentEmails.length = 0;
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
    assert.equal(enrollment.rejectionReason, 'No reason provided.');

    const rejectionEmail = sentEmails.find((e) => e.label === 'enrollment rejected');
    assert.ok(rejectionEmail, 'expected an "enrollment rejected" email to be sent even without an explicit reason');
    assert.equal(rejectionEmail.opts.to, 'parent1@example.com');
  } finally { restore(); }
});

test('adminRejectEnrollment: pushes a live enrollment:statusChanged event to the parent', async () => {
  sentEmails.length = 0;
  emitToParentCalls.length = 0;
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
    assert.equal(emitToParentCalls.length, 1);
    assert.equal(emitToParentCalls[0].parentId, 'parent-1');
    assert.equal(emitToParentCalls[0].event, 'enrollment:statusChanged');
    assert.equal(emitToParentCalls[0].payload.status, 'rejected');
  } finally { restore(); }
});

// Legacy "cancel" alias — explicitly passes allowResubmission: false, a DIFFERENT, terminal
// outcome from a genuine Reject: no resubmission offered, and the email still points at
// starting a brand-new enrollment rather than logging back in.
test('updateEnrollmentStatus(cancelled): sets status to cancelled, NOT rejected, and disallows resubmission', async () => {
  sentEmails.length = 0;
  const enrollment = makeEnrollment();
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser });
  try {
    const res = mockRes();
    await updateEnrollmentStatus({
      params: { id: 'enr-1' },
      user: { _id: 'admin-1', role: 'admin' },
      body: { status: 'cancelled' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(enrollment.status, 'cancelled');
    assert.equal(enrollment.allowResubmission, false);

    const rejectionEmail = sentEmails.find((e) => e.label === 'enrollment rejected');
    assert.ok(rejectionEmail);
    assert.match(rejectionEmail.opts.html, /new enrollment/i);
    assert.doesNotMatch(rejectionEmail.opts.html, /log ?in and resubmit/i);
  } finally { restore(); }
});

test('adminRejectEnrollment: rejecting again after a resubmission cycles back to rejected correctly', async () => {
  sentEmails.length = 0;
  // Simulates the enrollment having already gone through one reject -> resubmit cycle:
  // status is back to payment_under_verification, allowResubmission still true from the
  // first reject (submitPaymentProof never clears it).
  const enrollment = makeEnrollment({ status: 'payment_under_verification', allowResubmission: true, rejectionReason: 'First proof was unreadable' });
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser });
  try {
    const res = mockRes();
    await adminRejectEnrollment({
      params: { id: 'enr-1' },
      user: { _id: 'admin-1', role: 'admin' },
      body: { reason: 'Second proof is also invalid' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(enrollment.status, 'rejected');
    assert.equal(enrollment.rejectionReason, 'Second proof is also invalid');
    assert.equal(enrollment.allowResubmission, true);
  } finally { restore(); }
});
