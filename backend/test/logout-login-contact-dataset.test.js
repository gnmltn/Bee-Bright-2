/**
 * Batch 16 — two separate matching bugs, both found in the same stretch of live QA
 * testing, fixed together with the Batch 15/16 sanitizer-pattern broadening.
 *
 * 1. findDatasetMatch (backend/controllers/aiController.js) scores a message against
 *    every dataset Q&A entry for the user's role and returns whichever scores highest
 *    above DATASET_MATCH_THRESHOLD. "login" and "logout" entries share almost every word
 *    the scorer actually weighs (the role name, "account", "credentials", "log") and
 *    differ only by "in" vs "out" — too short to carry weight on its own. So "how do i
 *    log out on my tutor account?" scored 0.600 against T001 ("How do I log in as a
 *    tutor?", topic: 'login') — above the 0.55 threshold — and returned the LOGIN
 *    instructions ("Visit /login, use your tutor email and password...") for someone
 *    asking how to sign OUT. Fixed by skipping every topic:'login' dataset entry whenever
 *    the message itself reads as a logout question (reusing the already-correct
 *    isLogoutQuestion check), so the message falls through to the real, dedicated
 *    logout handling instead.
 *
 * 2. isPersonInfoQuery's bare `contact` keyword alternative (meant for "contact number of
 *    so-and-so") doesn't distinguish a specific-person lookup from a "who do i go to for
 *    help" question. "who should i contact if my tutor account information is incorrect?"
 *    matched purely on the word "contact" and was misrouted into
 *    getRoleAwarePersonInfoReply's tutor branch ("Tutor-to-tutor personal details are
 *    restricted") — unrelated to a question about getting one's own account record fixed.
 *    Fixed with an early guard for the "who/what should/can/do/would i contact" shape.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findDatasetMatch,
  getContextualDatasetResponse,
  isPersonInfoQuery,
} = require('../controllers/aiController');

test('findDatasetMatch: a logout-phrased question no longer matches a login dataset entry', () => {
  const match = findDatasetMatch('how do i log out on my tutor account?', 'tutor');
  assert.equal(match, null, 'should not match any dataset entry (falls through to real logout handling)');
});

test('getContextualDatasetResponse: logout-phrased question does not return login instructions', () => {
  const reply = getContextualDatasetResponse('how do i log out on my tutor account?', 'tutor', 'english');
  if (reply) {
    assert.doesNotMatch(reply, /Visit \/login/i);
  }
});

test('findDatasetMatch: genuine login questions are unaffected', () => {
  const match = findDatasetMatch('how do i log in as a tutor?', 'tutor');
  assert.ok(match, 'a real login question should still match');
  assert.equal(match.topic, 'login');
  assert.match(match.expectedReply.en, /Visit \/login/i);
});

test('isPersonInfoQuery: "who should i contact if..." is a help question, not a person-info lookup', () => {
  assert.equal(
    isPersonInfoQuery('who should i contact if my tutor account information is incorrect?'),
    false
  );
  assert.equal(
    isPersonInfoQuery('what should i contact for billing concerns?'),
    false
  );
});

test('isPersonInfoQuery: genuine contact-info requests still match', () => {
  assert.equal(isPersonInfoQuery('what is his contact number?'), true);
  assert.equal(isPersonInfoQuery('contact number of maria santos'), true);
});
