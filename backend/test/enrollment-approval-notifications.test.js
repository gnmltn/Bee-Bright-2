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

const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
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

function stubCommon({ enrollment, parentUser }) {
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

test('adminRejectEnrollment: emails the parent, naming the child and including the rejection reason', async () => {
  sentEmails.length = 0;
  const enrollment = makeEnrollment();
  const parentUser = { _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' };
  const { restore } = stubCommon({ enrollment, parentUser });
  try {
    const res = mockRes();
    await adminRejectEnrollment({
      params: { id: 'enr-1' },
      user: { _id: 'admin-1', role: 'admin' },
      body: { reason: 'Payment proof was unreadable', allowResubmission: true },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(enrollment.status, 'rejected');

    const rejectionEmail = sentEmails.find((e) => e.label === 'enrollment rejected');
    assert.ok(rejectionEmail, 'expected an "enrollment rejected" email to be sent');
    assert.equal(rejectionEmail.opts.to, 'parent1@example.com');
    assert.match(rejectionEmail.opts.html, /Ana Cruz/);
    assert.match(rejectionEmail.opts.html, /Payment proof was unreadable/);
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

    const rejectionEmail = sentEmails.find((e) => e.label === 'enrollment rejected');
    assert.ok(rejectionEmail, 'expected an "enrollment rejected" email to be sent even without an explicit reason');
    assert.equal(rejectionEmail.opts.to, 'parent1@example.com');
  } finally { restore(); }
});
