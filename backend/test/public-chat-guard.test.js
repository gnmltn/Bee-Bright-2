const test = require('node:test');
const assert = require('node:assert/strict');

const Escalation = require('../models/Escalation');
const AuditLog = require('../models/AuditLog');
const { isAccountScopedQuestion } = require('../utils/publicChatGuard');
const { handleAnonymousChatGuards } = require('../controllers/aiController');

function withStubs(fn) {
  const oE = Escalation.create;
  const oA = AuditLog.create;
  const escalations = [];
  const audits = [];
  Escalation.create = async (d) => { const x = { _id: 'e1', ...d }; escalations.push(x); return x; };
  AuditLog.create = async (e) => { audits.push(e); return e; };
  return Promise.resolve(fn({ escalations, audits })).finally(() => {
    Escalation.create = oE; AuditLog.create = oA;
  });
}

const anonReq = (msg) => ({ body: { message: msg }, headers: {} });

test('isAccountScopedQuestion: account questions vs marketing/enrollment FAQ', () => {
  for (const m of [
    'what are my grades',
    "how is my child's progress",
    'what is my payment status',
    'when is my next class',
    'am i enrolled yet',
    'my enrollment status',
    'grado ko po',
    'kumusta ang anak ko',
  ]) {
    assert.equal(isAccountScopedQuestion(m), true, `account: ${m}`);
  }
  for (const m of [
    'how do i enroll my child',
    'how much is the academic tutorial',
    'what programs do you offer',
    'where is bee bright located',
    'how do payments work',
    'what are your hours',
  ]) {
    assert.equal(isAccountScopedQuestion(m), false, `FAQ: ${m}`);
  }
});

test('handleAnonymousChatGuards: authenticated user → null (normal pipeline)', async () => {
  await withStubs(async () => {
    const out = await handleAnonymousChatGuards({ user: { role: 'student' }, body: {}, headers: {} }, 'what are my grades');
    assert.equal(out, null);
  });
});

test('handleAnonymousChatGuards: anon account question → login prompt, nothing looked up', async () => {
  await withStubs(async ({ audits, escalations }) => {
    const out = await handleAnonymousChatGuards(anonReq('what is my payment status'), 'what is my payment status');
    assert.match(out, /log in/i);
    assert.match(out, /can't look up account details/i);
    assert.equal(escalations.length, 0);
    assert.equal(audits.find((a) => a.action === 'AI Chat').metadata.groundingPath, 'public-login-required');
  });
});

test('handleAnonymousChatGuards: anon marketing question → null (falls through to FAQ pipeline)', async () => {
  await withStubs(async () => {
    const out = await handleAnonymousChatGuards(anonReq('what programs do you offer'), 'what programs do you offer');
    assert.equal(out, null);
  });
});

test('handleAnonymousChatGuards: child-safety screen applies on the anonymous surface', async () => {
  await withStubs(async ({ audits, escalations }) => {
    const out = await handleAnonymousChatGuards(anonReq('i want to kill myself'), 'i want to kill myself');
    assert.match(out, /Thank you for telling me/);
    assert.match(out, /1553/);
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].source, 'child_safety');
    assert.equal(escalations[0].user, null);
    assert.equal(escalations[0].userIdentifier, 'anonymous');
    assert.equal(escalations[0].severity, 'urgent');
    const a = audits.find((x) => x.action === 'AI Chat');
    assert.equal(a.metadata.groundingPath, 'safety');
    assert.equal(a.metadata.safetyCategory, 'self_harm');
  });
});
