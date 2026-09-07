/**
 * Step-2 "premature account creation" fix.
 *
 * The parent record created at "Create Account & Send Code" is now a DRAFT
 * (enrollmentDraft:true). It does not reserve the mobile / email against other
 * users, it is updated in place when the parent goes Back to fix a typo, and it
 * is finalized only when the enrollment is submitted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// ── Patch the module seams BEFORE requiring the controller ────────────────
const emailService = require('../utils/emailService');
emailService.sendEmail = async () => ({ ok: true });
emailService.getEmailErrorMessage = () => 'email failed';
emailService.logEmailError = () => {};

const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const validation = require('../utils/validation');
const User = require('../models/User');
const { registerParent } = require('../controllers/parentAuthController');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// findOne(...).select(...) → resolves to whatever `router` returns for the query
function stubUser({ findOne, exists, deleteOne, save }) {
  const orig = {
    findOne: User.findOne,
    exists: User.exists,
    deleteOne: User.deleteOne,
    save: User.prototype.save,
  };
  if (findOne) User.findOne = (q) => ({ select: () => Promise.resolve(findOne(q)) });
  if (exists) User.exists = exists;
  if (deleteOne) User.deleteOne = deleteOne;
  if (save) User.prototype.save = save;
  return () => {
    User.findOne = orig.findOne;
    User.exists = orig.exists;
    User.deleteOne = orig.deleteOne;
    User.prototype.save = orig.save;
  };
}

const okBody = () => ({
  name: 'Maria Santos',
  email: 'maria@example.com',
  mobile: '09171234567',
  password: 'Abcd1234!',
});

test('fresh registration creates a DRAFT account (enrollmentDraft + draftExpiresAt)', async () => {
  let saved = null;
  const restore = stubUser({
    findOne: () => null,               // email not taken, no session draft
    exists: async () => null,          // mobile free
    async save() { saved = this; return this; },
  });
  try {
    const res = fakeRes();
    await registerParent({ body: okBody() }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(saved, 'a user document was saved');
    assert.equal(saved.enrollmentDraft, true);
    assert.ok(saved.draftExpiresAt instanceof Date);
    assert.equal(saved.isActive, false);
    assert.equal(saved.email, 'maria@example.com');
  } finally { restore(); }
});

test('going Back and changing the email updates the SAME draft in place (no second record)', async () => {
  const draft = {
    _id: '507f1f77bcf86cd799439011',
    role: 'parent',
    enrollmentDraft: true,
    email: 'typo@example.com',
    emailVerifiedAt: new Date(),
    draftExpiresAt: new Date(),
    parentOtpLastSentAt: null,
    save: async function () { return this; },
  };
  let newDocSaved = false;
  let deleteCalled = false;
  const restore = stubUser({
    findOne: (q) => {
      if (q && q.enrollmentDraft === true) return draft;   // session draft lookup
      if (q && q.email) return null;                       // new email is free
      return null;
    },
    exists: async () => null,
    deleteOne: async () => { deleteCalled = true; return { deletedCount: 0 }; },
    async save() { newDocSaved = true; return this; },     // only hit for `new User`
  });
  try {
    const res = fakeRes();
    await registerParent(
      { body: { ...okBody(), email: 'fixed@example.com', draftId: draft._id } },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(newDocSaved, false, 'no brand-new user was created');
    assert.equal(deleteCalled, false, 'the session draft was not deleted');
    assert.equal(draft.email, 'fixed@example.com', 'draft email was updated');
    assert.equal(draft.emailVerifiedAt, null, 'changed email must be re-verified');
  } finally { restore(); }
});

test('email already owned by a finalized+verified account is rejected', async () => {
  const restore = stubUser({
    findOne: (q) => (q && q.email
      ? { role: 'parent', enrollmentDraft: false, emailVerifiedAt: new Date(), isActive: true }
      : null),
    exists: async () => null,
    async save() { return this; },
  });
  try {
    const res = fakeRes();
    await registerParent({ body: okBody() }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /already registered/i);
  } finally { restore(); }
});

test('mobile number already on a finalized account is rejected', async () => {
  const restore = stubUser({
    findOne: () => null,
    exists: async () => ({ _id: 'someone-else' }),   // number taken
    async save() { return this; },
  });
  try {
    const res = fakeRes();
    await registerParent({ body: okBody() }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /mobile number is already registered/i);
  } finally { restore(); }
});

test('checkMobileNumberUnique ignores enrollment drafts', async () => {
  const orig = User.exists;
  let seenQuery = null;
  User.exists = async (q) => { seenQuery = q; return null; };
  try {
    const free = await validation.checkMobileNumberUnique('09171234567');
    assert.equal(free, true);
    assert.deepEqual(seenQuery.enrollmentDraft, { $ne: true });
  } finally { User.exists = orig; }
});
