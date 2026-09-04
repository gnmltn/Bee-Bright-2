const test = require('node:test');
const assert = require('node:assert/strict');

const Escalation = require('../models/Escalation');
const AuditLog = require('../models/AuditLog');
const { screenMessageForDistress, getChildSafetyMessage } = require('../utils/childSafetyFilter');
const { handleChildSafetyScreen } = require('../controllers/aiController');

function withStubs(fn) {
  const origEsc = Escalation.create;
  const origAudit = AuditLog.create;
  const escalations = [];
  const audits = [];
  Escalation.create = async (doc) => { const d = { _id: 'esc-1', ...doc }; escalations.push(d); return d; };
  AuditLog.create = async (entry) => { audits.push(entry); return entry; };
  return Promise.resolve(fn({ escalations, audits })).finally(() => {
    Escalation.create = origEsc;
    AuditLog.create = origAudit;
  });
}

test('screen flags self-harm phrasing (EN + FIL)', () => {
  for (const msg of [
    'i want to kill myself',
    "i don't want to live anymore",
    'i keep thinking about suicide',
    'sometimes i want to hurt myself',
    'gusto ko nang mamatay',
    'wala nang saysay ang buhay ko',
  ]) {
    const r = screenMessageForDistress(msg);
    assert.equal(r.flagged, true, `should flag: ${msg}`);
    assert.equal(r.category, 'self_harm', `category for: ${msg}`);
    assert.equal(r.severity, 'urgent');
  }
});

test('screen flags abuse phrasing', () => {
  for (const msg of [
    'my dad hits me when he is angry',
    'my tito touched me and i felt weird',
    "i'm scared to go home",
    'sinasaktan ako sa bahay',
  ]) {
    const r = screenMessageForDistress(msg);
    assert.equal(r.flagged, true, `should flag: ${msg}`);
    assert.equal(r.category, 'abuse', `category for: ${msg}`);
  }
});

test('screen flags bullying phrasing', () => {
  for (const msg of [
    'i am being bullied at school',
    'my classmates bully me every day',
    'everyone picks on me at school',
    'bina-bully ako ng kaklase ko',
  ]) {
    const r = screenMessageForDistress(msg);
    assert.equal(r.flagged, true, `should flag: ${msg}`);
    assert.equal(r.category, 'bullying', `category for: ${msg}`);
  }
});

test('screen does NOT flag ordinary stress / hyperbole / homework talk', () => {
  for (const msg of [
    'this homework is killing me',
    'my mom will kill me if i fail this test',
    "i'm so stressed about the exam next week",
    'i want to die of embarrassment lol',
    'the bully in my story needs a name',
    'how do i submit my assignment',
    'when is my next class',
    'i hate math',
  ]) {
    const r = screenMessageForDistress(msg);
    assert.equal(r.flagged, false, `should NOT flag: ${msg}`);
  }
});

test('safety message: self_harm includes the crisis hotline, others do not', () => {
  assert.match(getChildSafetyMessage('self_harm', 'english'), /NCMH Crisis Hotline at 1553/);
  assert.match(getChildSafetyMessage('self_harm', 'filipino'), /1553/);
  assert.doesNotMatch(getChildSafetyMessage('bullying', 'english'), /1553/);
  assert.doesNotMatch(getChildSafetyMessage('abuse', 'taglish'), /1553/);
  // Warm + names-the-concern wording
  assert.match(getChildSafetyMessage('bullying', 'english'), /Thank you for telling me/);
  assert.match(getChildSafetyMessage('bullying', 'english'), /trusted adult|parent, guardian, teacher/i);
});

test('handleChildSafetyScreen: student hit → fixed reply + urgent open escalation + audit', async () => {
  await withStubs(async ({ escalations, audits }) => {
    const req = {
      user: { _id: 'stu-1', id: 'stu-1', role: 'student' },
      body: { message: 'i want to kill myself' },
      headers: { 'user-agent': 'test' },
      ip: '10.0.0.9',
    };
    const reply = await handleChildSafetyScreen(req, 'i want to kill myself');

    assert.match(reply, /Thank you for telling me/);
    assert.match(reply, /1553/);

    assert.equal(escalations.length, 1);
    const esc = escalations[0];
    assert.equal(esc.source, 'child_safety');
    assert.equal(esc.category, 'self_harm');
    assert.equal(esc.severity, 'urgent');
    assert.equal(esc.status, 'open');
    assert.equal(esc.user, 'stu-1');
    assert.equal(esc.conversationSnippet, 'i want to kill myself');

    // one audit for the escalation, one for the AI interaction
    const aiAudit = audits.find((a) => a.action === 'AI Chat');
    assert.ok(aiAudit, 'AI Chat audit written');
    assert.equal(aiAudit.metadata.groundingPath, 'safety');
    assert.equal(aiAudit.metadata.safetyCategory, 'self_harm');
    assert.ok(audits.some((a) => a.action === 'AI Escalation Created'));
  });
});

test('handleChildSafetyScreen: non-student sender is not screened', async () => {
  await withStubs(async ({ escalations }) => {
    const req = { user: { _id: 'p-1', role: 'parent' }, body: {}, headers: {} };
    const reply = await handleChildSafetyScreen(req, 'i want to kill myself');
    assert.equal(reply, null);
    assert.equal(escalations.length, 0);
  });
});

test('handleChildSafetyScreen: unauthenticated sender is not screened here (Task 9 covers public)', async () => {
  await withStubs(async ({ escalations }) => {
    const reply = await handleChildSafetyScreen({ body: {}, headers: {} }, 'my dad hits me');
    assert.equal(reply, null);
    assert.equal(escalations.length, 0);
  });
});

test('handleChildSafetyScreen: ordinary student question passes through untouched', async () => {
  await withStubs(async ({ escalations }) => {
    const req = { user: { _id: 'stu-2', role: 'student' }, body: {}, headers: {} };
    const reply = await handleChildSafetyScreen(req, 'where can i see my grades');
    assert.equal(reply, null);
    assert.equal(escalations.length, 0);
  });
});
