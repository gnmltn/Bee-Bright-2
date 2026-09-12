/**
 * Task 35 — fixes for the two bugs found while live-testing Task 34's classifier routes.
 *
 * Bug 1: isLocationQuestion's bare "address" match caught "email address" and returned the
 *        physical-location reply instead of contact info.
 * Bug 2: billing_dispute's bare "refund" match intercepted informational policy questions
 *        ("what is your refund policy") before the FAQ dataset lookup ever ran.
 * Bug 3 (transfer_payment dataset scoring) is explicitly deferred, not part of this task.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { detectExplicitHandoffTrigger } = require('../utils/handoffService');
const { isLocationQuestion } = require('../controllers/aiController');
const { getIntentReply } = require('../utils/chatIntentModel');

// ── Fix 1: isLocationQuestion no longer matches "email address" ────────────────────────
test('Fix 1: "email address" phrasings are no longer treated as a location question', () => {
  assert.equal(isLocationQuestion('what is your email address'), false);
  assert.equal(isLocationQuestion('what is your email address?'), false);
  assert.equal(isLocationQuestion("what's your email address"), false);
  assert.equal(isLocationQuestion('can i have your email address'), false);
});

test('Fix 1: genuine physical-location phrasings still match', () => {
  assert.equal(isLocationQuestion('where are you located'), true);
  assert.equal(isLocationQuestion('what is your address'), true);
  assert.equal(isLocationQuestion('what is your physical address'), true);
  assert.equal(isLocationQuestion('saan malolocate ang beebright'), true);
  assert.equal(isLocationQuestion('where is bee bright'), true);
  assert.equal(isLocationQuestion('do you have a map'), true);
});

// ── Fix 1b: the OLD word-weighted classifier (chatIntentModel.js / chat_intents.json)
// has its own separate "location" intent with a bare "address" keyword, which was the
// actual source of the wrong reply reaching the user — isLocationQuestion's regex is
// used by other codepaths, but aiController.js trusts this classifier's `intent` field
// directly (see the `classifierResult?.intent === 'location'` branch). Both had to be
// fixed for the bug to actually go away end-to-end.
test('Fix 1: the legacy keyword-weighted classifier no longer predicts "location" for email-address phrasings', () => {
  assert.equal(getIntentReply('what is your email address').intent, 'contact');
  assert.equal(getIntentReply("what's your email address?").intent, 'contact');
});

test('Fix 1: the legacy classifier still predicts "location" for genuine location phrasings', () => {
  assert.equal(getIntentReply('what is your address').intent, 'location');
  assert.equal(getIntentReply('where are you located').intent, 'location');
  assert.equal(getIntentReply('give me the center address').intent, 'location');
});

// ── Fix 2: billing_dispute no longer fires on a bare informational "refund" mention ────
test('Fix 2: informational refund/policy questions no longer trigger billing_dispute', () => {
  assert.equal(detectExplicitHandoffTrigger('what is your refund policy'), null);
  assert.equal(detectExplicitHandoffTrigger('what is your refund policy if we cancel'), null);
  assert.equal(detectExplicitHandoffTrigger('can I get a refund'), null);
  assert.equal(detectExplicitHandoffTrigger('is my payment refundable'), null);
  assert.equal(detectExplicitHandoffTrigger('are payments refundable'), null);
});

test('Fix 2: genuine refund disputes/demands still trigger billing_dispute', () => {
  assert.equal(detectExplicitHandoffTrigger('I want a refund for my payment').category, 'billing_dispute');
  assert.equal(detectExplicitHandoffTrigger('I want a refund').category, 'billing_dispute');
  assert.equal(detectExplicitHandoffTrigger('my refund wasn\'t given').category, 'billing_dispute');
  assert.equal(detectExplicitHandoffTrigger('please give me my refund').category, 'billing_dispute');
  assert.equal(detectExplicitHandoffTrigger('this refund policy isn\'t fair').category, 'billing_dispute');
});

test('Fix 2: "raise a concern about my refund" still reaches Task 30\'s concern flow (unaffected by Fix 2)', () => {
  const result = detectExplicitHandoffTrigger('I want to raise a concern about my refund');
  assert.equal(result.category, 'human_requested');
});

test('Fix 2: other billing_dispute triggers (unrelated to refund) are unaffected', () => {
  assert.equal(detectExplicitHandoffTrigger('I was double charged for tuition').category, 'billing_dispute');
  assert.equal(detectExplicitHandoffTrigger('I want to dispute a charge').category, 'billing_dispute');
  assert.equal(detectExplicitHandoffTrigger('mali ang singil sa akin').category, 'billing_dispute');
});

test('Fix 2: non-refund complaint/human-requested triggers are unaffected', () => {
  assert.equal(detectExplicitHandoffTrigger('can I talk to a real person').category, 'human_requested');
  assert.equal(detectExplicitHandoffTrigger('I want to file a complaint about my tutor').category, 'complaint');
});
