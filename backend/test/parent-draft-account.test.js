/**
 * EnrollmentNotifs_OrphanedAccounts_EmailValidation.pdf item 2 — nothing is written to
 * the Users collection from an in-progress or abandoned enrollment attempt.
 *
 * Steps 2 (account details) and 3 (verify email) only touch PendingParentSignup. The
 * real User is created — with the pending record's _id — in the same request that
 * submits the completed enrollment with its payment proof, and is rolled back if any
 * part of that request fails.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const emailService = require('../utils/emailService');
emailService.sendEmail = async () => ({ ok: true });
emailService.getEmailErrorMessage = () => 'email failed';
emailService.logEmailError = () => {};
const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const validation = require('../utils/validation');
const User = require('../models/User');
const PendingParentSignup = require('../models/PendingParentSignup');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const Pricing = require('../models/Pricing');
const EnrollmentCounter = require('../models/EnrollmentCounter');
const AssessmentTemplate = require('../models/AssessmentTemplate');
const { registerParent, verifyParentOtp } = require('../controllers/parentAuthController');
const { submitEnrollment } = require('../controllers/enrollmentController');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const okBody = () => ({
  name: 'Maria Santos',
  email: 'maria@example.com',
  mobile: '09171234567',
  password: 'Abcd1234!',
});

/** Records every write to the Users collection so tests can assert there are none. */
function stubStores({ pendingByEmail = null, pendingById = null, userByEmail = null, mobileTaken = false } = {}) {
  const orig = {
    userFindOne: User.findOne, userExists: User.exists, userDeleteOne: User.deleteOne, userSave: User.prototype.save,
    pFindOne: PendingParentSignup.findOne, pFindById: PendingParentSignup.findById,
    pDeleteOne: PendingParentSignup.deleteOne, pSave: PendingParentSignup.prototype.save,
  };
  const log = { userSaves: [], userDeletes: [], pendingSaves: [], pendingDeletes: [] };
  User.findOne = () => ({ select: async () => userByEmail });
  User.exists = async () => (mobileTaken ? { _id: 'someone' } : null);
  User.deleteOne = async (q) => { log.userDeletes.push(q); return { deletedCount: 1 }; };
  User.prototype.save = async function () { log.userSaves.push(this); return this; };
  PendingParentSignup.findOne = () => ({ select: async () => pendingByEmail });
  PendingParentSignup.findById = () => ({ select: async () => pendingById });
  PendingParentSignup.deleteOne = async (q) => { log.pendingDeletes.push(q); return { deletedCount: 1 }; };
  PendingParentSignup.prototype.save = async function () { log.pendingSaves.push(this); return this; };
  return {
    log,
    restore() {
      User.findOne = orig.userFindOne; User.exists = orig.userExists; User.deleteOne = orig.userDeleteOne; User.prototype.save = orig.userSave;
      PendingParentSignup.findOne = orig.pFindOne; PendingParentSignup.findById = orig.pFindById;
      PendingParentSignup.deleteOne = orig.pDeleteOne; PendingParentSignup.prototype.save = orig.pSave;
    },
  };
}

// ── Step 2: register ─────────────────────────────────────────────────────────

test('registering saves a PENDING signup and writes NOTHING to Users', async () => {
  const { log, restore } = stubStores();
  try {
    const res = fakeRes();
    await registerParent({ body: okBody() }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(log.userSaves.length, 0, 'no User document may be written');
    assert.equal(log.pendingSaves.length, 1);
    const pending = log.pendingSaves[0];
    assert.equal(pending.email, 'maria@example.com');
    assert.notEqual(pending.passwordHash, 'Abcd1234!', 'the plain password is never stored');
    assert.match(pending.passwordHash, /^\$2[aby]\$/);
    assert.ok(pending.expiresAt instanceof Date, 'abandoned signups expire by TTL');
    assert.equal(res.body.parentId, String(pending._id), 'the pending id is what the wizard tracks');
  } finally { restore(); }
});

test('going Back and changing the email updates the SAME pending record (still no User)', async () => {
  const sessionPending = {
    _id: '507f1f77bcf86cd799439011', email: 'typo@example.com', emailVerifiedAt: new Date(), otpLastSentAt: null,
    save: async function () { this.saved = true; return this; },
  };
  const { log, restore } = stubStores({ pendingById: sessionPending });
  try {
    const res = fakeRes();
    await registerParent({ body: { ...okBody(), email: 'fixed@example.com', draftId: sessionPending._id } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(sessionPending.email, 'fixed@example.com');
    assert.equal(sessionPending.emailVerifiedAt, null, 'a changed email must be re-verified');
    assert.equal(sessionPending.saved, true);
    assert.equal(log.pendingSaves.length, 0, 'no second pending record');
    assert.equal(log.userSaves.length, 0);
  } finally { restore(); }
});

test('an email that belongs to a real account is rejected', async () => {
  const { log, restore } = stubStores({ userByEmail: { role: 'parent', enrollmentDraft: false, emailVerifiedAt: new Date(), isActive: true } });
  try {
    const res = fakeRes();
    await registerParent({ body: okBody() }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /already registered/i);
    assert.equal(log.pendingSaves.length + log.userSaves.length, 0);
  } finally { restore(); }
});

test('a mobile number on a real account is rejected', async () => {
  const { restore } = stubStores({ mobileTaken: true });
  try {
    const res = fakeRes();
    await registerParent({ body: okBody() }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /mobile number is already registered/i);
  } finally { restore(); }
});

test('a leftover legacy DRAFT user holding the email is retired, not reused', async () => {
  const { log, restore } = stubStores({ userByEmail: { _id: 'old-draft', role: 'parent', enrollmentDraft: true } });
  try {
    const res = fakeRes();
    await registerParent({ body: okBody() }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(log.userDeletes[0], { _id: 'old-draft', enrollmentDraft: true });
    assert.equal(log.userSaves.length, 0);
  } finally { restore(); }
});

test('a disallowed email character is rejected with a specific message before anything is saved', async () => {
  const { log, restore } = stubStores();
  try {
    const res = fakeRes();
    await registerParent({ body: { ...okBody(), email: 'ma(ria@example.com' } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /"\("/);
    assert.equal(log.pendingSaves.length + log.userSaves.length, 0);
  } finally { restore(); }
});

test('checkMobileNumberUnique still ignores legacy enrollment drafts', async () => {
  const orig = User.exists;
  let seenQuery = null;
  User.exists = async (q) => { seenQuery = q; return null; };
  try {
    assert.equal(await validation.checkMobileNumberUnique('09171234567'), true);
    assert.deepEqual(seenQuery.enrollmentDraft, { $ne: true });
  } finally { User.exists = orig; }
});

// ── Step 3: verify email ─────────────────────────────────────────────────────

test('verifying the email marks the pending signup verified and STILL writes nothing to Users', async () => {
  const crypto = require('crypto');
  const pending = {
    _id: '507f1f77bcf86cd799439012', email: 'maria@example.com', emailVerifiedAt: null,
    otpHash: crypto.createHash('sha256').update('123456').digest('hex'),
    otpExpires: new Date(Date.now() + 60000), otpAttempts: 0,
    save: async function () { return this; },
  };
  const { log, restore } = stubStores({ pendingByEmail: pending });
  try {
    const res = fakeRes();
    await verifyParentOtp({ body: { email: 'maria@example.com', code: '123456' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(pending.emailVerifiedAt instanceof Date);
    const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
    assert.equal(decoded.id, pending._id);
    assert.equal(decoded.scope, 'enrollment');
    assert.equal(res.body.parentId, pending._id);
    assert.equal(log.userSaves.length, 0, 'an abandoned signup that stopped after verification leaves no User');
  } finally { restore(); }
});

test('a wrong code is rejected and writes nothing to Users', async () => {
  const crypto = require('crypto');
  const pending = {
    _id: '507f1f77bcf86cd799439012', email: 'maria@example.com', emailVerifiedAt: null,
    otpHash: crypto.createHash('sha256').update('123456').digest('hex'),
    otpExpires: new Date(Date.now() + 60000), otpAttempts: 0, save: async function () { return this; },
  };
  const { log, restore } = stubStores({ pendingByEmail: pending });
  try {
    const res = fakeRes();
    await verifyParentOtp({ body: { email: 'maria@example.com', code: '000000' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(pending.emailVerifiedAt, null);
    assert.equal(log.userSaves.length, 0);
  } finally { restore(); }
});

// ── Completed enrollment: the account appears here, and only here ────────────

const PENDING_ID = '507f1f77bcf86cd799439033';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function verifiedPending(overrides = {}) {
  return {
    _id: PENDING_ID, firstName: 'Maria', middleName: '', lastName: 'Santos', email: 'maria@example.com',
    phone: '09171234567', passwordHash: '$2a$10$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvabcdefghi', emailVerifiedAt: new Date(),
    ...overrides,
  };
}

function submitBody(overrides = {}) {
  return {
    packages: [{ programCode: 'ACT102', packageSlug: 'premier-elementary' }],
    studentFirstName: 'Leo', studentLastName: 'Santos', birthdate: '2018-03-04', paymentMethod: 'gcash',
    consentVersion: '1.0', consentItems: [{ name: 'participation_agreement', accepted: true, version: '1.0' }],
    assessment: { applicable: false, skipReason: 'Not applicable' },
    proofDataUrl: TINY_PNG, payerReference: 'REF123',
    ...overrides,
  };
}

function stubSubmit(pending, { failEnrollmentSave = false } = {}) {
  const base = stubStores({ pendingById: pending });
  const orig = {
    eSave: Enrollment.prototype.save, eDeleteOne: Enrollment.deleteOne, pSave: Payment.prototype.save,
    pricing: Pricing.find, counter: EnrollmentCounter.findOneAndUpdate, tmpl: AssessmentTemplate.find,
    write: fs.writeFileSync, uUpdate: User.findByIdAndUpdate,
  };
  const order = [];
  const saved = {};
  User.prototype.save = async function () { order.push('user'); base.log.userSaves.push(this); return this; };
  Enrollment.prototype.save = async function () {
    if (failEnrollmentSave) throw new Error('db down');
    order.push('enrollment'); saved.enrollment = this; return this;
  };
  Enrollment.deleteOne = async () => ({ deletedCount: 1 });
  Payment.prototype.save = async function () { order.push('payment'); saved.payment = this; return this; };
  Pricing.find = () => ({ lean: async () => [{ programCode: 'ACT102', packageSlug: 'premier-elementary', displayName: 'Academic Tutorial - Premier', priceFull: 2400 }] });
  EnrollmentCounter.findOneAndUpdate = async () => ({ seq: 9 });
  AssessmentTemplate.find = () => ({ sort: () => ({ lean: async () => [] }) });
  fs.writeFileSync = () => {};
  User.findByIdAndUpdate = async () => ({});
  return {
    ...base, saved, order,
    restore() {
      base.restore();
      Enrollment.prototype.save = orig.eSave; Enrollment.deleteOne = orig.eDeleteOne; Payment.prototype.save = orig.pSave;
      Pricing.find = orig.pricing; EnrollmentCounter.findOneAndUpdate = orig.counter; AssessmentTemplate.find = orig.tmpl;
      fs.writeFileSync = orig.write; User.findByIdAndUpdate = orig.uUpdate;
    },
  };
}

const wizardReq = (body) => ({
  user: null,
  headers: { authorization: `Bearer ${jwt.sign({ id: PENDING_ID, scope: 'enrollment' }, process.env.JWT_SECRET, { expiresIn: '2h' })}` },
  body,
});

test('submitting the completed enrollment creates the account, enrollment and payment proof TOGETHER', async () => {
  const s = stubSubmit(verifiedPending());
  try {
    const res = fakeRes();
    await submitEnrollment(wizardReq(submitBody()), res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepEqual(s.order, ['user', 'enrollment', 'payment'], 'account is created at the same point as the enrollment');

    const user = s.log.userSaves[0];
    assert.equal(String(user._id), PENDING_ID, 'the pending id becomes the User _id so the wizard token keeps working');
    assert.equal(user.role, 'parent');
    assert.equal(user.email, 'maria@example.com');
    assert.equal(user.isActive, false, 'login stays gated on admin approval');
    assert.equal(user.password, verifiedPending().passwordHash, 'the stored hash is copied, not re-hashed');
    assert.equal(user.$locals.passwordAlreadyHashed, true);

    assert.equal(String(s.saved.enrollment.parent), PENDING_ID);
    assert.equal(s.saved.enrollment.status, 'payment_under_verification', 'same state the separate proof upload used to produce');
    assert.equal(s.saved.enrollment.paymentStatus, 'submitted', 'proof arrived with the submission');
    assert.equal(s.saved.payment.status, 'submitted');
    assert.match(s.saved.payment.proofUrl, /^\/uploads\/payments\/proof-/);
    assert.equal(s.saved.payment.payerReference, 'REF123');
    assert.equal(res.body.proofSubmitted, true);
    assert.equal(s.log.pendingDeletes.length, 1, 'the pending signup is discarded once the account exists');
  } finally { s.restore(); }
});

test('an unverified pending signup cannot submit — nothing is written', async () => {
  const s = stubSubmit(verifiedPending({ emailVerifiedAt: null }));
  try {
    const res = fakeRes();
    await submitEnrollment(wizardReq(submitBody()), res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(s.order, []);
    assert.equal(s.log.userSaves.length, 0);
  } finally { s.restore(); }
});

test('if creating the enrollment fails the just-created account is rolled back (and the pending signup is kept for a retry)', async () => {
  const s = stubSubmit(verifiedPending(), { failEnrollmentSave: true });
  try {
    const res = fakeRes();
    await submitEnrollment(wizardReq(submitBody()), res);
    assert.equal(res.statusCode, 500);
    assert.equal(s.log.userSaves.length, 1, 'the account was created first...');
    assert.equal(s.log.userDeletes.length, 1, '...and removed again');
    assert.equal(String(s.log.userDeletes[0]._id), PENDING_ID);
    assert.equal(s.log.pendingDeletes.length, 0, 'the verified signup survives so the parent can retry');
  } finally { s.restore(); }
});

test('an invalid payment proof fails the request BEFORE any account is created', async () => {
  const s = stubSubmit(verifiedPending());
  try {
    const res = fakeRes();
    await submitEnrollment(wizardReq(submitBody({ proofDataUrl: 'data:text/plain;base64,aGk=' })), res);
    assert.equal(res.statusCode, 400);
    assert.equal(s.log.userSaves.length, 0);
    assert.deepEqual(s.order, []);
  } finally { s.restore(); }
});

test('a token that is not enrollment-scoped is not treated as a pending signup', async () => {
  const s = stubSubmit(verifiedPending());
  try {
    const res = fakeRes();
    const req = wizardReq(submitBody());
    req.headers.authorization = `Bearer ${jwt.sign({ id: PENDING_ID }, process.env.JWT_SECRET)}`;
    await submitEnrollment(req, res);
    assert.equal(res.statusCode, 401, 'falls through to the legacy email check, which needs an email');
    assert.equal(s.log.userSaves.length, 0);
  } finally { s.restore(); }
});
