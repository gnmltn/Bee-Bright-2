const test = require('node:test');
const assert = require('node:assert/strict');

const Escalation = require('../models/Escalation');
const AuditLog = require('../models/AuditLog');
const {
  detectExplicitHandoffTrigger,
  isUnhelpfulReply,
  getHandoffAcknowledgement,
} = require('../utils/handoffService');
const { handleExplicitHandoff, applyRepeatedNoMatchHandoff } = require('../controllers/aiController');

function withStubs(fn) {
  const origEsc = Escalation.create;
  const origAudit = AuditLog.create;
  const escalations = [];
  Escalation.create = async (doc) => { const d = { _id: 'esc-x', ...doc }; escalations.push(d); return d; };
  AuditLog.create = async (e) => e;
  return Promise.resolve(fn({ escalations })).finally(() => {
    Escalation.create = origEsc;
    AuditLog.create = origAudit;
  });
}

test('detectExplicitHandoffTrigger: human / billing / complaint', () => {
  assert.equal(detectExplicitHandoffTrigger('can I talk to a real person').category, 'human_requested');
  assert.equal(detectExplicitHandoffTrigger('I want to speak with a human').category, 'human_requested');
  assert.equal(detectExplicitHandoffTrigger('gusto ko makausap ng tao').category, 'human_requested');
  assert.equal(detectExplicitHandoffTrigger('I was double charged for tuition').category, 'billing_dispute');
  assert.equal(detectExplicitHandoffTrigger('I want a refund for my payment').category, 'billing_dispute');
  assert.equal(detectExplicitHandoffTrigger('I want to file a complaint about my tutor').category, 'complaint');
  assert.equal(detectExplicitHandoffTrigger('my tutor was rude and unprofessional').category, 'complaint');
});

test('detectExplicitHandoffTrigger: ordinary questions do not trigger', () => {
  for (const m of [
    'how do I contact my tutor',
    'what are the payment methods',
    'how much is the academic tutorial',
    'when is my next class',
    'who is my tutor',
  ]) {
    assert.equal(detectExplicitHandoffTrigger(m), null, `should not trigger: ${m}`);
  }
});

test('isUnhelpfulReply: recognises clarification / unavailable replies', () => {
  assert.equal(isUnhelpfulReply('Sorry, this information is not yet available in the system.'), true);
  assert.equal(isUnhelpfulReply('I want to make sure my answer matches your exact question. Please clarify your topic: login, enrollment...'), true);
  assert.equal(isUnhelpfulReply('I can guide you step by step. Which page are you on right now?'), true);
  assert.equal(isUnhelpfulReply(''), true);
  assert.equal(isUnhelpfulReply('Your next class is on Jun 3, 2026 at 10:00 with Maria Santos.'), false);
  assert.equal(isUnhelpfulReply('To enroll, open the Enrollment page and complete the payment step.'), false);
});

test('getHandoffAcknowledgement: category + language', () => {
  assert.match(getHandoffAcknowledgement('human_requested', 'english'), /a Bee Bright admin/i);
  assert.match(getHandoffAcknowledgement('billing_dispute', 'english'), /billing concern/i);
  assert.match(getHandoffAcknowledgement('repeated_no_match', 'filipino'), /Bee Bright admin/);
  assert.match(getHandoffAcknowledgement('complaint', 'taglish'), /Bee Bright admin/i);
  // "staff" wording must be gone — no such role exists (Task 12).
  for (const cat of ['human_requested', 'billing_dispute', 'complaint', 'repeated_no_match']) {
    for (const lang of ['english', 'filipino', 'taglish']) {
      assert.doesNotMatch(getHandoffAcknowledgement(cat, lang), /\bstaff\b/i);
    }
  }
});

test('handleExplicitHandoff: authenticated user → ack + normal open escalation', async () => {
  await withStubs(async ({ escalations }) => {
    const req = { user: { _id: 'u9', id: 'u9', role: 'student' }, body: {}, headers: {} };
    const reply = await handleExplicitHandoff(req, 'I want to talk to a real person please');
    assert.match(reply, /a Bee Bright admin|maitutulong pa ba ako/i);
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].source, 'handoff');
    assert.equal(escalations[0].category, 'human_requested');
    assert.equal(escalations[0].severity, 'normal');
    assert.equal(escalations[0].status, 'open');
  });
});

test('handleExplicitHandoff: unauthenticated → null (Task 9 owns the public path)', async () => {
  await withStubs(async ({ escalations }) => {
    const reply = await handleExplicitHandoff({ body: {}, headers: {} }, 'let me talk to a human');
    assert.equal(reply, null);
    assert.equal(escalations.length, 0);
  });
});

test('applyRepeatedNoMatchHandoff: two consecutive misses → escalate + append note', async () => {
  await withStubs(async ({ escalations }) => {
    const req = { user: { _id: 'u1', role: 'student' }, body: {}, headers: {} };
    const history = [
      { role: 'user', content: 'foo' },
      { role: 'assistant', content: 'Sorry, this information is not yet available in the system.' },
    ];
    const out = await applyRepeatedNoMatchHandoff(
      req,
      'still confused',
      history,
      'I can guide you step by step. Which page are you on right now?',
      'english',
    );
    assert.match(out, /Which page are you on right now\?/);      // original kept
    assert.match(out, /flagged it for a Bee Bright admin/i);     // note appended
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].category, 'repeated_no_match');
  });
});

test('applyRepeatedNoMatchHandoff: single miss → reply unchanged, no escalation', async () => {
  await withStubs(async ({ escalations }) => {
    const req = { user: { _id: 'u1', role: 'student' }, body: {}, headers: {} };
    const history = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello. How may I help you today?' },
    ];
    const reply = 'Sorry, this information is not yet available in the system.';
    const out = await applyRepeatedNoMatchHandoff(req, 'q', history, reply, 'english');
    assert.equal(out, reply);
    assert.equal(escalations.length, 0);
  });
});

test('applyRepeatedNoMatchHandoff: a helpful reply is never wrapped', async () => {
  await withStubs(async ({ escalations }) => {
    const req = { user: { _id: 'u1', role: 'student' }, body: {}, headers: {} };
    const history = [{ role: 'assistant', content: 'Sorry, this information is not yet available in the system.' }];
    const reply = 'Your next class is on Jun 3 at 10:00.';
    const out = await applyRepeatedNoMatchHandoff(req, 'q', history, reply, 'english');
    assert.equal(out, reply);
    assert.equal(escalations.length, 0);
  });
});
