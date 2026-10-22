/**
 * Regression: after the Feature 1 rejection-flow rework (Reject no longer deletes
 * anything — see frontend/src/lib/rejectionGate.ts), the login gate still only knew two
 * states for a parent account: approved (let in) and everything else (blocked with
 * "Enrollment is pending admin approval..."). A Rejected signup-sourced account fell
 * into "everything else" and got hard-blocked at login — "Login failed" — even though
 * it should log in successfully and land on the restricted upload-only screen
 * (RejectedAccountGate), per Feature 1's own spec.
 *
 * Root cause had TWO layers, both fixed here:
 *  1. getEnrollmentLoginBlock (authController.js) only read the User model's stale,
 *     denormalized `enrollmentStatus` field, which adminRejectEnrollment never
 *     updates — so a rejected account never even matched its own (already wrong,
 *     login-denying) 'rejected' branch and fell through to the generic pending block.
 *     Now queries Enrollment.allowResubmission directly (the same umbrella flag the
 *     frontend's rejectionGate.ts already uses) and lets it through.
 *  2. Even with (1) fixed, loginStart/verifyLoginOtp each had their OWN *separate*,
 *     redundant `!user.isActive` block that re-blocked student/parent accounts
 *     regardless of what getEnrollmentLoginBlock had just decided — previously harmless
 *     because getEnrollmentLoginBlock could only return null when isActive was already
 *     true (approved), so it never fired; (1) alone would have "fixed" the gate on
 *     paper while this second gate silently reinstated the exact same block.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// ── Patch module seams BEFORE requiring authController ─────────────────────
const trustedDeviceModule = require('../utils/trustedDevice');
trustedDeviceModule.validateTrustedDevice = async () => ({ trusted: true, record: { _id: 'device-1' } });

const authCookieModule = require('../utils/authCookie');
authCookieModule.setAuthCookie = () => {};

const settingsController = require('../controllers/settingsController');
settingsController.getMaintenanceEnabled = async () => false;

const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const { loginStart, getEnrollmentLoginBlock } = require('../controllers/authController');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

function mockReq(body) {
  return { body, protocol: 'http', get: () => 'localhost' };
}

const PARENT_ID = '507f1f77bcf86cd799439011';

function fakeUser(overrides = {}) {
  return {
    _id: PARENT_ID,
    role: 'parent',
    email: 'maria@example.com',
    firstName: 'Maria',
    lastName: 'Soriano',
    password: '$2a$10$hashedhashedhashedhashedhashedhashedhashedhashedhashed',
    isActive: false,
    isArchived: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    comparePassword: async () => true,
    ...overrides,
  };
}

function stubLoginFlow({ user, enrollmentExistsImpl }) {
  const orig = {
    uFindOne: User.findOne, uFindByIdAndUpdate: User.findByIdAndUpdate, uFindById: User.findById,
    eExists: Enrollment.exists,
  };
  User.findOne = () => ({ select: () => user });
  User.findByIdAndUpdate = async () => ({});
  User.findById = () => ({ select: () => ({ populate: () => ({ lean: async () => ({ ...user }) }) }) });
  Enrollment.exists = enrollmentExistsImpl;
  return {
    restore() {
      User.findOne = orig.uFindOne; User.findByIdAndUpdate = orig.uFindByIdAndUpdate; User.findById = orig.uFindById;
      Enrollment.exists = orig.eExists;
    },
  };
}

// Mirrors computeRejectionGateState's own "the only enrollment candidate is picked via
// allowResubmission" rule — the exact same flag — so the two layers (backend login gate,
// frontend dashboard gate) can never disagree about who is "still mid a reject cycle."
function enrollmentExists({ approved = false, resubmittable = false } = {}) {
  return async (filter) => {
    if (filter.allowResubmission) return resubmittable;
    return approved;
  };
}

// ── getEnrollmentLoginBlock (the core decision, tested directly) ───────────────────

test('getEnrollmentLoginBlock: a Rejected signup-sourced parent (allowResubmission true, never approved) is let through — null, not a block', async () => {
  const origExists = Enrollment.exists;
  Enrollment.exists = enrollmentExists({ approved: false, resubmittable: true });
  try {
    const result = await getEnrollmentLoginBlock(fakeUser({ isActive: false }));
    assert.equal(result, null);
  } finally { Enrollment.exists = origExists; }
});

test('getEnrollmentLoginBlock: a genuinely Pending parent (never rejected, allowResubmission false) is still blocked', async () => {
  const origExists = Enrollment.exists;
  Enrollment.exists = enrollmentExists({ approved: false, resubmittable: false });
  try {
    const result = await getEnrollmentLoginBlock(fakeUser({ isActive: false }));
    assert.ok(result, 'pending must still be blocked');
    assert.equal(result.code, 'ENROLLMENT_PENDING_APPROVAL');
  } finally { Enrollment.exists = origExists; }
});

test('getEnrollmentLoginBlock: an Add Child-sourced rejection never blocks — the parent already has an approved enrollment', async () => {
  const origExists = Enrollment.exists;
  let resubmittableQueried = false;
  Enrollment.exists = async (filter) => {
    if (filter.allowResubmission) { resubmittableQueried = true; return true; }
    return true; // an earlier, approved signup enrollment
  };
  try {
    const result = await getEnrollmentLoginBlock(fakeUser({ isActive: true }));
    assert.equal(result, null);
    assert.equal(resubmittableQueried, false, 'the approved check short-circuits — the resubmittable check never needs to run');
  } finally { Enrollment.exists = origExists; }
});

test('getEnrollmentLoginBlock: a non-parent/student role is never touched by any of this', async () => {
  const result = await getEnrollmentLoginBlock({ role: 'tutor' });
  assert.equal(result, null);
});

// ── loginStart end-to-end — reproduces the exact reported scenario ─────────────────

test('loginStart: a Rejected signup-sourced account logs in successfully (not "Login failed") so it can reach the restricted upload screen', async () => {
  const user = fakeUser({ isActive: false });
  const { restore } = stubLoginFlow({ user, enrollmentExistsImpl: enrollmentExists({ approved: false, resubmittable: true }) });
  try {
    const res = mockRes();
    await loginStart(mockReq({ email: user.email, password: 'whatever' }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.success, true);
    assert.notEqual(res._body.code, 'ENROLLMENT_PENDING_APPROVAL');
  } finally { restore(); }
});

test('loginStart: a genuinely Pending account (never acted on) is still correctly blocked from login', async () => {
  const user = fakeUser({ isActive: false });
  const { restore } = stubLoginFlow({ user, enrollmentExistsImpl: enrollmentExists({ approved: false, resubmittable: false }) });
  try {
    const res = mockRes();
    await loginStart(mockReq({ email: user.email, password: 'whatever' }), res);
    assert.equal(res._status, 403, JSON.stringify(res._body));
    assert.equal(res._body.code, 'ENROLLMENT_PENDING_APPROVAL');
  } finally { restore(); }
});

test('loginStart: an Add Child-sourced rejection still allows full normal login', async () => {
  const user = fakeUser({ isActive: true });
  const { restore } = stubLoginFlow({ user, enrollmentExistsImpl: enrollmentExists({ approved: true, resubmittable: true }) });
  try {
    const res = mockRes();
    await loginStart(mockReq({ email: user.email, password: 'whatever' }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.success, true);
  } finally { restore(); }
});
