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

test('Task 30b: a fresh trigger starts the guided intake — NO escalation yet', async () => {
  await withStubs(async ({ escalations }) => {
    const req = { user: { _id: 'u9', id: 'u9', role: 'student' }, body: {}, headers: {} };
    const reply = await handleExplicitHandoff(req, 'I want to talk to a real person please', []);
    assert.match(reply, /Reason:/i);
    assert.match(reply, /Explanation:/i);
    assert.equal(escalations.length, 0, 'no ticket is created on the trigger alone');
  });
});

test('handleExplicitHandoff: unauthenticated → null (D5 — public path stays removed)', async () => {
  await withStubs(async ({ escalations }) => {
    const reply = await handleExplicitHandoff({ body: {}, headers: {} }, 'let me talk to a human', []);
    assert.equal(reply, null);
    assert.equal(escalations.length, 0);
  });
});

function concernReq() {
  return { user: { _id: 'u9', id: 'u9', role: 'student' }, body: {}, headers: {} };
}

// Walk the guided flow, appending each turn to `history` like the chat widget does.
async function runConcernFlow(req, turns) {
  const history = [];
  let last = null;
  for (const msg of turns) {
    last = await handleExplicitHandoff(req, msg, history);
    history.push({ role: 'user', content: msg });
    if (last !== null) history.push({ role: 'assistant', content: last });
  }
  return { reply: last, history };
}

test('Task 30b: full flow, fields in one message, confirmed → escalation with reason + explanation', async () => {
  await withStubs(async ({ escalations }) => {
    const { reply } = await runConcernFlow(concernReq(), [
      'I want to raise a concern about my payment',
      'Reason: billing concern\nExplanation: I think I overpaid the remaining 50% balance. Can it be refunded?',
      'yes',
    ]);
    assert.match(reply, /submitted|naisumite/i);
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].source, 'handoff');
    assert.equal(escalations[0].status, 'open');
    assert.equal(escalations[0].concernReason, 'billing concern');
    assert.match(escalations[0].concernExplanation, /overpaid the remaining 50% balance/i);
  });
});

test('Task 30b: full flow, fields across two messages, confirmed → escalation', async () => {
  await withStubs(async ({ escalations }) => {
    const { reply } = await runConcernFlow(concernReq(), [
      'can I raise a concern',
      'my tutor has skipped three sessions without telling me',   // no labels → treated as explanation
      'tutor attendance',                                          // the short topic
      'yes',
    ]);
    assert.match(reply, /submitted|naisumite/i);
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].concernReason, 'tutor attendance');
    assert.match(escalations[0].concernExplanation, /skipped three sessions/i);
  });
});

test('Task 30b: declining at the confirmation step creates NO escalation', async () => {
  await withStubs(async ({ escalations }) => {
    const { reply } = await runConcernFlow(concernReq(), [
      'raise a concern',
      'Reason: schedule issue\nExplanation: my class time keeps changing',
      'no',
    ]);
    assert.match(reply, /won'?t submit|hindi ko/i);
    assert.equal(escalations.length, 0);
  });
});

test('Task 30b: abandoning mid-flow (unrelated message at confirm) creates NO escalation and yields to the pipeline', async () => {
  await withStubs(async ({ escalations }) => {
    const req = concernReq();
    const history = [];
    for (const msg of ['raise a concern', 'Reason: billing\nExplanation: overcharged']) {
      const r = await handleExplicitHandoff(req, msg, history);
      history.push({ role: 'user', content: msg });
      history.push({ role: 'assistant', content: r });
    }
    const out = await handleExplicitHandoff(req, 'actually, what are your office hours?', history);
    assert.equal(out, null, 'returns null so the normal pipeline answers the new question');
    assert.equal(escalations.length, 0);
  });
});

test('Task 30b: explicit "cancel" during collection abandons cleanly', async () => {
  await withStubs(async ({ escalations }) => {
    const { reply } = await runConcernFlow(concernReq(), [
      'i have a concern',
      'nevermind, cancel',
    ]);
    assert.match(reply, /won'?t submit|hindi ko|maitutulong/i);
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
