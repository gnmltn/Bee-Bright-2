/**
 * Panel-required change — built-in admin email composer: admin shouldn't have to open
 * Gmail by hand to reach a parent or tutor. Sends real email through the SAME SMTP
 * transport + the SAME branded template already used for OTP/verification codes
 * (sendAdminComposedEmail, emailService.js), one individually-addressed email per
 * selected recipient.
 *
 * sendAdminComposedEmail/sendEmail live in the SAME file and call each other by bare
 * function reference (not via module.exports), so an outside monkeypatch of
 * emailService.sendEmail can never intercept it (the same "destructured require"
 * limitation this codebase has hit before for same-file calls). Two separate, clean
 * seams are used instead: buildAdminComposedEmailMessage (a pure function, no I/O) is
 * tested directly for the actual template content, and
 * emailService.sendAdminComposedEmail — required by adminEmailController.js, a
 * DIFFERENT file, so a monkeypatch applied BEFORE that controller is first required
 * DOES correctly intercept it — is stubbed for the controller's own dispatch/validation
 * logic.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// ── Patch the module seam BEFORE requiring the controller ─────────────────
const emailService = require('../utils/emailService');
const composedEmailCalls = [];
const origSendAdminComposedEmail = emailService.sendAdminComposedEmail;
emailService.sendAdminComposedEmail = async (to, recipientName, subject, message) => {
  composedEmailCalls.push({ to, recipientName, subject, message });
  return Boolean(to); // simulates "no email on file" failing, everything else succeeding
};

const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const { getEmailRecipients, sendAdminEmail } = require('../controllers/adminEmailController');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

function mockQuery(result) {
  const q = { select: () => q, sort: () => q, lean: () => Promise.resolve(result) };
  return q;
}

function req(overrides = {}) {
  return { user: { _id: 'admin-1', role: 'admin' }, body: {}, query: {}, ...overrides };
}

test.afterEach(() => { composedEmailCalls.length = 0; });
test.after(() => { emailService.sendAdminComposedEmail = origSendAdminComposedEmail; });

// ── buildAdminComposedEmailMessage — the real template content (pure, no mocking) ──

test('buildAdminComposedEmailMessage: the admin Subject becomes the real email subject AND the template heading; the Message becomes the body', () => {
  const msg = emailService.buildAdminComposedEmailMessage(
    'jake@example.com',
    'Jake',
    'Bee Bright login verification code',
    'Your code is ready.'
  );
  assert.equal(msg.to, 'jake@example.com');
  assert.equal(msg.subject, 'Bee Bright login verification code');
  // Heading inside the branded template — same h2 the OTP email's "Login Verification" uses.
  assert.match(msg.html, /<h2[^>]*>Bee Bright login verification code<\/h2>/);
  assert.match(msg.html, /Your code is ready\./);
  assert.match(msg.text, /Your code is ready\./);
  // Same branded frame as every other email — logo header + "Tutorial Center".
  assert.match(msg.html, /Bee Bright/);
  assert.match(msg.html, /Tutorial Center/);
});

test('buildAdminComposedEmailMessage: a multi-line message is preserved as line breaks in the HTML body', () => {
  const msg = emailService.buildAdminComposedEmailMessage('jake@example.com', 'Jake', 'Reminder', 'Line one.\nLine two.');
  assert.match(msg.html, /Line one\.<br\/>Line two\./);
});

test('buildAdminComposedEmailMessage: escapes HTML in the admin-typed subject/message (never raw markup injection)', () => {
  const msg = emailService.buildAdminComposedEmailMessage('jake@example.com', 'Jake', '<b>Hi</b>', '<script>bad()</script>');
  assert.doesNotMatch(msg.html, /<script>/);
  assert.match(msg.html, /&lt;script&gt;/);
});

// ── getEmailRecipients ──────────────────────────────────────────────────────────

test('getEmailRecipients: rejects an invalid/missing role', async () => {
  const res = mockRes();
  await getEmailRecipients(req({ query: { role: 'student' } }), res);
  assert.equal(res._status, 400);
});

test('getEmailRecipients: parents — includes a rejected/unverified account, tagged with its status', async () => {
  const origUserFind = User.find;
  const origEnrollmentFind = Enrollment.find;
  User.find = () => mockQuery([
    { _id: 'parent-active', firstName: 'Ana', lastName: 'Cruz', email: 'ana@example.com', isArchived: false },
    { _id: 'parent-rejected', firstName: 'Jake', lastName: 'Soriano', email: 'jake@example.com', isArchived: false },
  ]);
  Enrollment.find = () => mockQuery([
    { parent: 'parent-active', status: 'approved', updatedAt: new Date('2026-01-01') },
    { parent: 'parent-rejected', status: 'rejected', updatedAt: new Date('2026-01-02') },
  ]);
  try {
    const res = mockRes();
    await getEmailRecipients(req({ query: { role: 'parent' } }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const names = res._body.recipients.map((r) => r.name);
    assert.ok(names.includes('Jake Soriano'), 'rejected/unverified parent must still be listed');
    const jake = res._body.recipients.find((r) => r.name === 'Jake Soriano');
    assert.equal(jake.status, 'rejected');
    const ana = res._body.recipients.find((r) => r.name === 'Ana Cruz');
    assert.equal(ana.status, 'approved');
  } finally { User.find = origUserFind; Enrollment.find = origEnrollmentFind; }
});

test('getEmailRecipients: tutors — never carry an enrollment-based status', async () => {
  const origUserFind = User.find;
  User.find = () => mockQuery([{ _id: 'tutor-1', firstName: 'Nicole', lastName: 'Monzada', email: 'nicole@example.com', isArchived: false }]);
  try {
    const res = mockRes();
    await getEmailRecipients(req({ query: { role: 'tutor' } }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.recipients.length, 1);
    assert.equal(res._body.recipients[0].status, null);
  } finally { User.find = origUserFind; }
});

// ── sendAdminEmail ──────────────────────────────────────────────────────────────

function stubRecipients(users) {
  const orig = User.find;
  User.find = () => mockQuery(users);
  return () => { User.find = orig; };
}

test('sendAdminEmail: rejects with no recipients selected', async () => {
  const res = mockRes();
  await sendAdminEmail(req({ body: { userIds: [], subject: 'Hi', message: 'Hello' } }), res);
  assert.equal(res._status, 400);
  assert.match(res._body.message, /recipient/i);
  assert.equal(composedEmailCalls.length, 0);
});

test('sendAdminEmail: Subject is required', async () => {
  const restore = stubRecipients([{ _id: 'u1', firstName: 'Jake', lastName: 'Soriano', email: 'jake@example.com' }]);
  try {
    const res = mockRes();
    await sendAdminEmail(req({ body: { userIds: ['u1'], subject: '   ', message: 'Hello' } }), res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /subject/i);
    assert.equal(composedEmailCalls.length, 0);
  } finally { restore(); }
});

test('sendAdminEmail: Message is required', async () => {
  const restore = stubRecipients([{ _id: 'u1', firstName: 'Jake', lastName: 'Soriano', email: 'jake@example.com' }]);
  try {
    const res = mockRes();
    await sendAdminEmail(req({ body: { userIds: ['u1'], subject: 'Hi', message: '' } }), res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /message/i);
    assert.equal(composedEmailCalls.length, 0);
  } finally { restore(); }
});

test('sendAdminEmail: multiple recipients each get their OWN individually-addressed email call, never one combined send', async () => {
  const restore = stubRecipients([
    { _id: 'u1', firstName: 'Jake', lastName: 'Soriano', email: 'jake@example.com' },
    { _id: 'u2', firstName: 'Ana', lastName: 'Cruz', email: 'ana@example.com' },
  ]);
  try {
    const res = mockRes();
    await sendAdminEmail(req({ body: { userIds: ['u1', 'u2'], subject: 'Reminder', message: 'Please log in.' } }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.sentCount, 2);
    assert.equal(composedEmailCalls.length, 2, 'expected 2 separate send calls, not one combined email');
    const addressed = composedEmailCalls.map((c) => c.to).sort();
    assert.deepEqual(addressed, ['ana@example.com', 'jake@example.com']);
    for (const c of composedEmailCalls) {
      assert.equal(c.subject, 'Reminder');
      assert.equal(c.message, 'Please log in.');
    }
  } finally { restore(); }
});

test('sendAdminEmail: a recipient with no email on file is skipped, reported, and never counted as sent', async () => {
  const restore = stubRecipients([
    { _id: 'u1', firstName: 'Jake', lastName: 'Soriano', email: 'jake@example.com' },
    { _id: 'u2', firstName: 'No', lastName: 'Email', email: null },
  ]);
  try {
    const res = mockRes();
    await sendAdminEmail(req({ body: { userIds: ['u1', 'u2'], subject: 'Hi', message: 'Hello' } }), res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.sentCount, 1);
    assert.equal(composedEmailCalls.length, 1);
    const skipped = res._body.results.find((r) => r.userId === 'u2');
    assert.equal(skipped.sent, false);
  } finally { restore(); }
});
