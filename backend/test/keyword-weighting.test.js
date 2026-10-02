const test = require('node:test');
const assert = require('node:assert/strict');

const {
  contentTokens,
  isMostlyFiller,
  hasVagueFollowUpShape,
  resolveDomainCategory,
  weightedOverlapScore,
  isOutOfScopeMetricsQuestion,
} = require('../utils/keywordWeighting');
const {
  applyConversationContext,
  isOnlineClassQuestion,
  getClassFormatReply,
  findDatasetMatch,
} = require('../controllers/aiController');

// ── Task 20 — filler stripping + weighting ────────────────────────────────

test('contentTokens strips filler / greetings / pronouns', () => {
  assert.deepEqual(contentTokens('can you please help me with billing'), ['billing']);
  assert.deepEqual(contentTokens('pwede mo ba ako tulungan sa schedule'), ['schedule']);
  assert.deepEqual(contentTokens('hello po good morning'), []);
});

test('weightedOverlapScore: a topic word beats filler overlap', () => {
  const role = 'visitor';
  const billing = weightedOverlapScore('can you help me with billing', 'billing concern payment', role);
  const generic = weightedOverlapScore('can you help me with billing', 'can you help me please', role);
  assert.ok(billing > generic, `billing ${billing} should beat generic ${generic}`);
  assert.equal(generic, 0); // shared words were all filler
});

test('findDatasetMatch: pure filler never matches', () => {
  assert.equal(findDatasetMatch('can you please help me', 'visitor'), null);
  assert.equal(findDatasetMatch('hello po', 'student'), null);
  assert.equal(findDatasetMatch('salamat', 'tutor'), null);
});

// Batch 9 — monitor-only overlapping entries (same general topic, different exact
// question/answer). Not a live bug: findDatasetMatch's `itemScore > bestScore` (strictly
// greater) plus role-specific entries sorted first in the search pool already make this
// deterministic. Locked in here so a future dataset/pool-order change that accidentally
// flips the winner gets caught immediately instead of silently shipping a wrong answer.
test('findDatasetMatch: S009 vs V008 resolve by role, never swap', () => {
  // A logged-in student asking about THEIR OWN status gets the dashboard answer (S009),
  // not the logged-out Track Enrollment answer (V008) — even though both entries share
  // the words "enrollment status".
  assert.equal(findDatasetMatch('what is my enrollment status', 'student')?.id, 'S009');
  // A visitor (no student pool at all) asking the same words gets V008 — there is no
  // S009 in their search pool to begin with.
  assert.equal(findDatasetMatch('what is my enrollment status', 'visitor')?.id, 'V008');
  // The visitor-specific "without logging in" phrasing always resolves to V008, for
  // either role — a student asking it that way still means the public Track Enrollment
  // flow, not the dashboard.
  assert.equal(findDatasetMatch('how do i check my enrollment status without logging in', 'visitor')?.id, 'V008');
  assert.equal(findDatasetMatch('how do i check my enrollment status without logging in', 'student')?.id, 'V008');
});

test('findDatasetMatch: V005 vs V012 resolve by exact question, never swap', () => {
  // "How do I enroll?" (general steps) vs "what is the pre-enrollment assessment for?"
  // (a specific sub-topic) share the word "enroll(ment)" but must never cross-answer.
  assert.equal(findDatasetMatch('how do i enroll', 'visitor')?.id, 'V005');
  assert.equal(findDatasetMatch('what is the pre-enrollment assessment for', 'visitor')?.id, 'V012');
  assert.equal(findDatasetMatch('what is the pre-enrollment assessment for', 'student')?.id, 'V012');
});

test('resolveDomainCategory: trilingual phrasing resolves to the same category', () => {
  for (const m of [
    'how much is the academic tutorial',              // EN
    'magkano ang academic tutorial',                  // FIL
    'how much yung academic tutorial package',        // Taglish
  ]) {
    assert.equal(resolveDomainCategory(m, 'public')?.category, 'programs_pricing', m);
  }
  for (const m of [
    'when is my next class',
    'kailan ang susunod na klase',
    'anong class schedule this week',
  ]) {
    assert.equal(resolveDomainCategory(m, 'parent')?.category, 'schedule', m);
  }
});

test('resolveDomainCategory: tutor at-risk vs student-notes', () => {
  assert.equal(resolveDomainCategory('which of my students are struggling', 'tutor')?.category, 'at_risk_students');
  assert.equal(resolveDomainCategory('summarize my remarks on Ana', 'tutor')?.category, 'student_notes');
});

test('isOutOfScopeMetricsQuestion: internal metrics stay out of the chatbot', () => {
  assert.equal(isOutOfScopeMetricsQuestion('how often does the phi fallback trigger'), true);
  assert.equal(isOutOfScopeMetricsQuestion('how many messages processed today'), true);
  assert.equal(isOutOfScopeMetricsQuestion('what is the model accuracy of the chatbot'), true);
  assert.equal(isOutOfScopeMetricsQuestion('how many students do we have'), false);
});

test('onsite-only class-format clarification', () => {
  for (const m of ['do you have online classes', 'may online ba kayo', 'wala ba kayong online', 'is it face to face only']) {
    assert.equal(isOnlineClassQuestion(m), true, m);
  }
  assert.equal(isOnlineClassQuestion('can i pay online'), false);
  assert.equal(isOnlineClassQuestion('is there an online enrollment form'), false);
  assert.match(getClassFormatReply('english'), /onsite/i);
  assert.match(getClassFormatReply('filipino'), /wala kaming online/i);
});

// ── Task 21 — single-conversation topic retention ─────────────────────────

test('hasVagueFollowUpShape', () => {
  assert.equal(hasVagueFollowUpShape('tulungan mo ako uli dyan'), true);
  assert.equal(hasVagueFollowUpShape('can you help with that again'), true);
  assert.equal(hasVagueFollowUpShape('what about that'), true);
  assert.equal(hasVagueFollowUpShape('how do I enroll my child'), false);
  assert.equal(hasVagueFollowUpShape('billing concern'), false);
});

test('applyConversationContext: vague follow-up resolves to the prior concrete message', () => {
  const history = [
    { role: 'user', content: 'I have a billing concern about my payment' },
    { role: 'assistant', content: 'A billing concern like this needs a Bee Bright admin...' },
  ];
  const out = applyConversationContext('tulungan mo ako uli dyan', history);
  assert.equal(out.isFollowUp, true);
  assert.match(out.message, /billing concern/i);
});

test('applyConversationContext: a new topic keyword is NOT overridden (topic switch)', () => {
  const history = [
    { role: 'user', content: 'I have a billing concern' },
    { role: 'assistant', content: '...' },
  ];
  const out = applyConversationContext('when is my next class', history);
  assert.equal(out.isFollowUp, false);
  assert.equal(out.message, 'when is my next class');
});

test('applyConversationContext: vague follow-up with no prior concrete message is left alone', () => {
  const out = applyConversationContext('uli nga', [{ role: 'user', content: 'hello po' }]);
  assert.equal(out.isFollowUp, false);
});

test('applyConversationContext: for each role, follow-up carries the topic', () => {
  for (const first of [
    'how do payments work',        // public
    "my child's schedule please",  // parent
    'summarize my remarks on Ben', // tutor
    'how many tutors do we have',  // admin
  ]) {
    const out = applyConversationContext('can you help with that again', [
      { role: 'user', content: first },
      { role: 'assistant', content: '...' },
    ]);
    assert.equal(out.message, first, first);
  }
});
