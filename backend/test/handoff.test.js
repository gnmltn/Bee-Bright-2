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

test('Task 30a: "raise a concern" phrasing + standalone "concern" trigger; feature questions do not', () => {
  for (const m of [
    'I want to raise a concern about my payment',
    'can I raise a concern',
    'raise concern about my schedule',
    'gusto kong mag-raise ng concern',
    'may i-raise ako ng concern',
    'i have a concern',
    'i have some concerns about my tutor',
  ]) {
    assert.equal(detectExplicitHandoffTrigger(m)?.category, 'human_requested', `should trigger: ${m}`);
  }
  for (const m of [
    'what does raise a concern mean',
    'what is the raise a concern feature',
    'no concerns here, thanks',
    "i don't have any concerns",
  ]) {
    assert.equal(detectExplicitHandoffTrigger(m), null, `should NOT trigger: ${m}`);
  }
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

// 2026-10-15, retired: "raise a concern" no longer starts a guided intake or ever creates
// an escalation — a detected trigger gets a direct redirect to BeeBright's own contact
// channels instead (wording lives in concernRedirectToContact, handoffService.js).
test('Task 30 retired: a fresh trigger gets the email/social-media redirect — NOT the old guided intake, no escalation', async () => {
  await withStubs(async ({ escalations }) => {
    const req = { user: { _id: 'u9', id: 'u9', role: 'parent' }, body: {}, headers: {} };
    const reply = await handleExplicitHandoff(req, 'I want to talk to a real person please', []);
    assert.doesNotMatch(reply, /Reason:/i, 'must not start the old guided intake');
    assert.doesNotMatch(reply, /Explanation:/i);
    assert.match(reply, /beebrightph@gmail\.com/i);
    assert.match(reply, /facebook/i);
    assert.match(reply, /instagram/i);
    assert.equal(escalations.length, 0, 'no ticket is ever created any more');
  });
});

test('Task 30 retired: every trigger category (human_requested / billing_dispute / complaint / bare "concern") gets the same redirect, never an escalation', async () => {
  await withStubs(async ({ escalations }) => {
    const triggers = [
      'can I talk to a real person',
      'I was double charged for tuition',
      'I want to file a complaint about my tutor',
      'I have a concern',
    ];
    for (const message of triggers) {
      const req = { user: { _id: 'u9', id: 'u9', role: 'parent' }, body: {}, headers: {} };
      const reply = await handleExplicitHandoff(req, message, []);
      assert.match(reply, /beebrightph@gmail\.com/i, `message: ${message}`);
    }
    assert.equal(escalations.length, 0);
  });
});

test('Task 30 retired: stale pre-deploy history (an old guided-intake assistant turn) gets redirected cleanly too, and never creates an escalation', async () => {
  await withStubs(async ({ escalations }) => {
    const req = { user: { _id: 'u9', id: 'u9', role: 'parent' }, body: {}, headers: {} };
    // Shape of a pre-retirement "awaiting_confirmation" assistant turn, in case any
    // browser tab still has it in local history across the deploy. Even here, a reply to
    // it gets the new redirect rather than being silently dropped or reviving the flow.
    const staleHistory = [
      { role: 'user', content: 'raise a concern' },
      { role: 'assistant', content: 'Reason: billing concern\nExplanation: overcharged\n\nReply "yes" to submit this, or "no" to cancel.' },
    ];
    const reply = await handleExplicitHandoff(req, 'yes', staleHistory);
    assert.match(reply, /beebrightph@gmail\.com/i);
    assert.doesNotMatch(reply, /submitted|naisumite/i, 'must not act as if an escalation was confirmed/submitted');
    assert.equal(escalations.length, 0);
  });
});

test('handleExplicitHandoff: unauthenticated → null (D5 — public path stays removed)', async () => {
  await withStubs(async ({ escalations }) => {
    const reply = await handleExplicitHandoff({ body: {}, headers: {} }, 'let me talk to a human', []);
    assert.equal(reply, null);
    assert.equal(escalations.length, 0);
  });
});

// Batch 19 — "raise a concern" is parent/tutor-side only now (see the dedicated role-gate
// tests near the bottom of this file).
function concernReq() {
  return { user: { _id: 'u9', id: 'u9', role: 'parent' }, body: {}, headers: {} };
}

test('Task 30 retired: a conversation that used to walk the full guided intake now never creates an escalation at any turn', async () => {
  await withStubs(async ({ escalations }) => {
    const req = concernReq();
    const history = [];
    const turns = [
      'I want to raise a concern about my payment',
      'Reason: billing concern\nExplanation: I think I overpaid the remaining 50% balance. Can it be refunded?',
      'yes',
    ];
    for (const msg of turns) {
      const out = await handleExplicitHandoff(req, msg, history);
      history.push({ role: 'user', content: msg });
      if (out !== null) history.push({ role: 'assistant', content: out });
    }
    assert.equal(escalations.length, 0, 'no escalation at any point in what used to be the full flow');
  });
});

// Batch 19 — the implicit "two consecutive misses → auto-flag" handoff was removed
// entirely per the user's explicit direction (it was landing in admin's own Requests
// queue with no user intent behind it at all, including for admin's own messages).
// applyRepeatedNoMatchHandoff is now a no-op: always returns the reply unchanged, for
// every role, even on two consecutive unhelpful replies, with no Escalation created.
test('Batch 19: applyRepeatedNoMatchHandoff is a no-op — two consecutive misses create NO escalation and the reply is unchanged, for every role', async () => {
  await withStubs(async ({ escalations }) => {
    const history = [
      { role: 'user', content: 'foo' },
      { role: 'assistant', content: 'Sorry, this information is not yet available in the system.' },
    ];
    const reply = 'I can guide you step by step. Which page are you on right now?';
    for (const role of ['admin', 'super_admin', 'parent', 'tutor', 'student']) {
      const req = { user: { _id: 'u1', role }, body: {}, headers: {} };
      const out = await applyRepeatedNoMatchHandoff(req, 'still confused', history, reply, 'english');
      assert.equal(out, reply, `role=${role}`);
    }
    assert.equal(escalations.length, 0);
  });
});

test('Batch 19: handleExplicitHandoff is parent/tutor-only — admin, super_admin, and student get null (fall through to the normal pipeline)', async () => {
  await withStubs(async ({ escalations }) => {
    for (const role of ['admin', 'super_admin', 'student']) {
      const req = { user: { _id: 'u9', id: 'u9', role }, body: {}, headers: {} };
      const reply = await handleExplicitHandoff(req, 'I want to raise a concern about my payment', []);
      assert.equal(reply, null, `role=${role}`);
    }
    assert.equal(escalations.length, 0);
  });
});

test('Batch 19: handleExplicitHandoff still works for parent and tutor', async () => {
  await withStubs(async ({ escalations }) => {
    for (const role of ['parent', 'tutor']) {
      const req = { user: { _id: 'u9', id: 'u9', role }, body: {}, headers: {} };
      const reply = await handleExplicitHandoff(req, 'I want to raise a concern about my payment', []);
      assert.match(reply, /beebrightph@gmail\.com/i, `role=${role}`);
    }
    assert.equal(escalations.length, 0);
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
