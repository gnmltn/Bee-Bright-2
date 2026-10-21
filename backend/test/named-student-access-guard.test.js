/**
 * Security fix — the chatbot had no access control for a specific named student.
 * Live-reproduced: an anonymous user typing "can you assist me with my child alez
 * soriano" got a friendly, confident confirmation from Gemini ("Yes, I can help you
 * with your child Alez Soriano...") — "Alez" was actually a one-letter typo of a REAL
 * child in the database, and Gemini never checked. Root cause: nothing stopped the
 * Gemini-first chatbot (see the "Gemini-first" restructuring) from engaging with a
 * named student before/independent of the already-safe, role-scoped DB grounding layer.
 *
 * Fix: a new hard, code-level guard (verifyNamedStudentReference), run BEFORE
 * grounding/Gemini in both chat() and ollamaChat() — never an LLM-judgment call. Public
 * users are always declined; a logged-in parent/tutor naming someone not actually
 * linked/assigned to them is also declined — one uniform decline message regardless of
 * WHY (never distinguishing "doesn't exist" from "not yours", which would itself leak
 * information).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const Escalation = require('../models/Escalation');
const Enrollment = require('../models/Enrollment');
const Schedule = require('../models/Schedule');
const geminiClient = require('../utils/geminiClient');
const {
  chat,
  ollamaChat,
  extractChildNameReference,
  findChildNameReferenceInConversation,
  verifyNamedStudentReference,
  isRestrictedPublicTopicQuestion,
  nameMatchesAnyPerson,
} = require('../controllers/aiController');

AuditLog.create = async () => ({});
Escalation.create = async () => ({});

function mockFindQuery(result) {
  const q = {
    select: () => q,
    populate: () => q,
    sort: () => q,
    limit: () => q,
    lean: () => Promise.resolve(result),
  };
  return q;
}

// Decline wording varies by detected language (english/filipino/taglish) — these match
// across all 3 variants of each decline type (see getNamedStudentAccessDecline).
const PUBLIC_DECLINE_RE = /can't look up or confirm|hindi ko matitingnan o makukumpirma|hindi ko ma-look up o ma-confirm/i;
const NON_PUBLIC_DECLINE_RE = /can't find or access|hindi ko mahanap o ma-access/i;
// getLoginPromptReply (the topic-based gate's wording, publicChatGuard.js) — a message
// can now be correctly declined via EITHER this guard or the named-student guard; both
// are valid, so tests should accept either one.
const LOGIN_PROMPT_RE = /account details|account details dito/i;
const ANY_DECLINE_RE = new RegExp(`${PUBLIC_DECLINE_RE.source}|${NON_PUBLIC_DECLINE_RE.source}|${LOGIN_PROMPT_RE.source}`, 'i');

function invoke(handler, body, user) {
  return new Promise((resolve) => {
    const req = { body, user, headers: { 'user-agent': 'test' }, ip: '127.0.0.1' };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(p) { resolve({ status: this.statusCode, ...p }); return this; },
    };
    handler(req, res);
  });
}

// ── unit — extraction ─────────────────────────────────────────────────────

test('extractChildNameReference: catches the exact reported phrasing and real variations', () => {
  assert.equal(extractChildNameReference('can you assist me with my child alez soriano'), 'alez soriano');
  assert.equal(extractChildNameReference('my child alex soriano'), 'alex soriano');
  assert.equal(extractChildNameReference('anak ko si pedro'), 'pedro');
  assert.equal(extractChildNameReference('my son is named jake'), 'jake');
});

test('extractChildNameReference: does NOT false-positive on topic-only or action/question phrasing', () => {
  for (const msg of [
    "my child's schedule",
    'my son is in grade 5',
    'my daughter is doing great',
    'anak ko',
    'how do i enroll',
    'what are the payment methods',
    'can my child bring a snack to class',
    'can my child use the online portal',
    'is my daughter doing ok',
  ]) {
    assert.equal(extractChildNameReference(msg), null, `should NOT match: ${msg}`);
  }
});

test('findChildNameReferenceInConversation: catches a name established in an earlier turn', () => {
  const history = [
    { role: 'user', content: 'can you assist me with my child alez soriano' },
    { role: 'assistant', content: 'some reply' },
  ];
  assert.equal(findChildNameReferenceInConversation('what about the schedule?', history), 'alez soriano');
});

// Follow-up fix — live QA testing found a real bypass: "my child X"/"anak ko X" were
// the only recognized relationship cues, so a bare Filipino proper-noun reference
// ("gusto ko kay alex soriano", "schedule ni alex") named a specific student with
// neither "my child" nor "anak" anywhere in that turn, so extraction never fired at
// all and the guard silently let it through.
test('extractChildNameReference: catches "si/kay/ni X" (the reported bypass) and more natural variations', () => {
  assert.equal(extractChildNameReference('gusto ko kay alex soriano'), 'alex soriano');
  assert.equal(extractChildNameReference('pwede ko ba makita ang schedule ni alex?'), 'alex');
  assert.equal(extractChildNameReference('para kay alex soriano'), 'alex soriano');
  assert.equal(extractChildNameReference('si alex soriano ang anak ko'), 'alex soriano');
});

test('extractChildNameReference: "si/kay/ni" does NOT false-positive on grammatical uses unrelated to naming a person', () => {
  for (const msg of [
    'pwede mo ba ako tulungan sa schedules?',
    'kay ganda ng bee bright', // "kay" as exclamative intensifier ("how beautiful"), not a dative name-marker
    'si tutor ang nagbigay ng schedule', // names a ROLE, not a specific person
    'pwede ko po makausap si admin',
    'kay mahal ng tuition',
  ]) {
    assert.equal(extractChildNameReference(msg), null, `should NOT match: ${msg}`);
  }
});

// Found while re-testing per the user's request to check "a few more natural
// phrasings" — the English equivalent of the same bypass shape ("I mean X" with no
// "my child" framing) also wasn't caught by the deterministic guard; it only survived
// by luck via the system-prompt-level defense-in-depth layer (Gemini itself declining),
// which is not a reliable guarantee. Closed the same way as si/kay/ni.
test('extractChildNameReference: catches the English equivalent ("I mean X") and rejects filler uses', () => {
  assert.equal(extractChildNameReference('I mean Alex Soriano'), 'alex soriano');
  assert.equal(extractChildNameReference('i meant Alex'), 'alex');
  assert.equal(extractChildNameReference('I mean can you help me'), null);
  assert.equal(extractChildNameReference('I mean, can you help me?'), null);
});

// ── unit — verifyNamedStudentReference ────────────────────────────────────

test('verifyNamedStudentReference: public user naming a student is always declined, real or fake name', async () => {
  for (const name of ['alez soriano', 'alex soriano', 'totally made up name xyzzy']) {
    const reply = await verifyNamedStudentReference({ user: null }, `my child ${name}`, []);
    assert.match(reply, PUBLIC_DECLINE_RE);
  }
});

test('verifyNamedStudentReference: public user with no name reference is unaffected (null)', async () => {
  const reply = await verifyNamedStudentReference({ user: null }, 'what programs does bee bright offer', []);
  assert.equal(reply, null);
});

test('verifyNamedStudentReference: parent naming their OWN real linked child is unaffected (null)', async () => {
  const origFind = Enrollment.find;
  Enrollment.find = () => mockFindQuery([
    { studentSnapshot: { firstName: 'Alex', lastName: 'Soriano' } },
  ]);
  try {
    const reply = await verifyNamedStudentReference(
      { user: { _id: 'parent1', role: 'parent' } },
      'my child alex soriano',
      []
    );
    assert.equal(reply, null);
  } finally {
    Enrollment.find = origFind;
  }
});

test('verifyNamedStudentReference: parent naming a DIFFERENT child (real but not theirs, or fake) is declined', async () => {
  const origFind = Enrollment.find;
  Enrollment.find = () => mockFindQuery([
    { studentSnapshot: { firstName: 'Alex', lastName: 'Soriano' } },
  ]);
  try {
    for (const name of ['maria cruz', 'alez soriano']) {
      const reply = await verifyNamedStudentReference(
        { user: { _id: 'parent1', role: 'parent' } },
        `my child ${name}`,
        []
      );
      assert.match(reply, NON_PUBLIC_DECLINE_RE, `name=${name}`);
    }
  } finally {
    Enrollment.find = origFind;
  }
});

test('verifyNamedStudentReference: tutor naming a student actually assigned to them is unaffected (null)', async () => {
  const origFind = Schedule.find;
  Schedule.find = () => mockFindQuery([
    { student: null, students: [{ firstName: 'Maria', lastName: 'Cruz' }] },
  ]);
  try {
    const reply = await verifyNamedStudentReference(
      { user: { _id: 'tutor1', role: 'tutor' } },
      'can you help my student maria cruz',
      []
    );
    assert.equal(reply, null);
  } finally {
    Schedule.find = origFind;
  }
});

test('verifyNamedStudentReference: tutor naming a student NOT assigned to them is declined', async () => {
  const origFind = Schedule.find;
  Schedule.find = () => mockFindQuery([
    { student: null, students: [{ firstName: 'Maria', lastName: 'Cruz' }] },
  ]);
  try {
    const reply = await verifyNamedStudentReference(
      { user: { _id: 'tutor1', role: 'tutor' } },
      'my student alex soriano',
      []
    );
    assert.match(reply, NON_PUBLIC_DECLINE_RE);
  } finally {
    Schedule.find = origFind;
  }
});

// Real bug (live-reported, regression): "can you give me my student list?" tripped the
// same guard that's supposed to protect one NAMED student's data — "my student" matched
// the relationship cue, and with nothing real following it, the capture grabbed "list" as
// if it were a name, which then (correctly, given a fake name) got declined — "I can't
// find or access that student's information", even though the question was never about
// one specific student at all. A tutor asking for their WHOLE roster, in any reasonable
// English/Tagalog/Taglish wording (not just this one exact phrase), must never be
// misread as a reference to a single unnamed student.
test('verifyNamedStudentReference: a tutor asking for their whole student list/roster — several real phrasings — is never misread as a named-student reference', async () => {
  const origFind = Schedule.find;
  // No roster stub needed — these must all resolve to null WITHOUT ever reaching the
  // roster-lookup branch at all, so a Schedule.find call here would itself be a bug.
  Schedule.find = () => { throw new Error('must not attempt a named-student roster lookup for a list request'); };
  try {
    const listPhrasings = [
      'can you give me my student list?',
      'what is my student roster',
      'give me the list of my students',
      'sino sino ang mga estudyante ko',
      'who are my students',
      "who's my students",
      'pwede ko ba makuha yung list ng student na naka assign saakin?',
      'show me the listahan ng mga estudyante ko',
      'can i see all my students',
    ];
    for (const message of listPhrasings) {
      const reply = await verifyNamedStudentReference({ user: { _id: 'tutor1', role: 'tutor' } }, message, []);
      assert.equal(reply, null, `should NOT be declined as a named-student reference: "${message}"`);
    }
  } finally {
    Schedule.find = origFind;
  }
});

test('verifyNamedStudentReference: a GENUINE named-student reference from a tutor is still correctly checked (no regression from the list-request fix)', async () => {
  const origFind = Schedule.find;
  Schedule.find = () => mockFindQuery([
    { student: null, students: [{ firstName: 'Maria', lastName: 'Cruz' }] },
  ]);
  try {
    const assigned = await verifyNamedStudentReference({ user: { _id: 'tutor1', role: 'tutor' } }, 'can you help my student maria cruz', []);
    assert.equal(assigned, null);

    const notAssigned = await verifyNamedStudentReference({ user: { _id: 'tutor1', role: 'tutor' } }, 'my student alex soriano', []);
    assert.match(notAssigned, NON_PUBLIC_DECLINE_RE);
  } finally {
    Schedule.find = origFind;
  }
});

test('verifyNamedStudentReference: admin and student roles are left alone (null), not this guard\'s concern', async () => {
  for (const role of ['admin', 'super_admin', 'student']) {
    const reply = await verifyNamedStudentReference(
      { user: { _id: 'u1', role } },
      'my child alez soriano',
      []
    );
    assert.equal(reply, null, `role=${role}`);
  }
});

// ── e2e — through the real chat()/ollamaChat() endpoints, Gemini never called ────

test('e2e: public + the exact reported typo is declined, Gemini never called', async () => {
  const origReply = geminiClient.generateChatbotReply;
  let llmCalls = 0;
  geminiClient.generateChatbotReply = async () => { llmCalls += 1; return 'should never be called'; };
  try {
    for (const handler of [chat, ollamaChat]) {
      llmCalls = 0;
      const out = await invoke(handler, { message: 'can you assist me with my child alez soriano', history: [] }, null);
      assert.equal(llmCalls, 0);
      assert.match(out.reply, ANY_DECLINE_RE);
    }
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('e2e: public + a two-step conversation (name turn 1, bare topic turn 2) is still declined on turn 2', async () => {
  const origReply = geminiClient.generateChatbotReply;
  let llmCalls = 0;
  geminiClient.generateChatbotReply = async () => { llmCalls += 1; return 'should never be called'; };
  try {
    const history = [
      { role: 'user', content: 'can you assist me with my child alez soriano' },
      { role: 'assistant', content: "I can't look up or confirm any specific student's information without being logged in." },
    ];
    const out = await invoke(chat, { message: 'what about the schedule?', history }, null);
    assert.equal(llmCalls, 0);
    assert.match(out.reply, ANY_DECLINE_RE);
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('e2e: the exact reported 3-turn bypass (Filipino "kay"/"ni" phrasing) is now declined at turn 2', async () => {
  const origReply = geminiClient.generateChatbotReply;
  let llmCalls = 0;
  geminiClient.generateChatbotReply = async () => { llmCalls += 1; return 'should never be called'; };
  try {
    const history = [];
    const turn1 = await invoke(chat, { message: 'pwede mo ba ako tulungan sa schedules?', history }, null);
    history.push({ role: 'user', content: 'pwede mo ba ako tulungan sa schedules?' });
    history.push({ role: 'assistant', content: turn1.reply });

    llmCalls = 0;
    const turn2 = await invoke(chat, { message: 'gusto ko kay alex soriano', history }, null);
    assert.equal(llmCalls, 0, 'turn 2 must be declined, not reach the LLM');
    assert.match(turn2.reply, ANY_DECLINE_RE);

    history.push({ role: 'user', content: 'gusto ko kay alex soriano' });
    history.push({ role: 'assistant', content: turn2.reply });

    llmCalls = 0;
    const turn3 = await invoke(chat, { message: 'pwede ko ba makita ang schedule ni alex?', history }, null);
    assert.equal(llmCalls, 0, 'turn 3 must also be declined, not reach the LLM');
    assert.match(turn3.reply, ANY_DECLINE_RE);
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('e2e: public + no name reference at all still reaches Gemini normally (unaffected)', async () => {
  const origReply = geminiClient.generateChatbotReply;
  geminiClient.generateChatbotReply = async () => 'A short LLM answer about Bee Bright.';
  try {
    const out = await invoke(ollamaChat, { message: 'my neighbor keeps talking about your academic tutorial classes', history: [] }, null);
    assert.match(out.reply, /llm answer/i);
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

// ── Absolute topic-based public gate (belt-and-suspenders, separate from name
// detection) — the owner explicitly asked for this as an INDEPENDENT layer: for a
// public user, ANY message whose topic is schedule/remarks/attendance/grades must
// always get the fixed login reply, regardless of whether a name was detected at all.
// Point 1 of their ask: confirm a no-name message like "paano makita ang remarks" was
// NOT already covered (it reached Gemini, which happened to decline only by its own
// judgment — not a guarantee). This section locks in the new, deterministic gate.

test('isRestrictedPublicTopicQuestion: matches all 4 restricted topics, with no name present', () => {
  for (const msg of [
    'paano makita ang remarks',
    "can I see my child's schedule?",
    'what is your attendance policy for missed sessions?',
    'where can I check my grades',
    'saan makikita ang iskedyul',
  ]) {
    assert.equal(isRestrictedPublicTopicQuestion(msg), true, `should match: ${msg}`);
  }
});

test('isRestrictedPublicTopicQuestion: does NOT match unrelated general questions', () => {
  for (const msg of [
    'how much is the academic tutorial program',
    'how do I enroll',
    'what payment methods do you accept',
    'where is bee bright located',
  ]) {
    assert.equal(isRestrictedPublicTopicQuestion(msg), false, `should NOT match: ${msg}`);
  }
});

test('e2e: public + a bare, NAMELESS restricted-topic question is declined, Gemini never called (the gap this gate closes)', async () => {
  const origReply = geminiClient.generateChatbotReply;
  let llmCalls = 0;
  geminiClient.generateChatbotReply = async () => { llmCalls += 1; return 'should never be called'; };
  try {
    for (const msg of [
      'paano makita ang remarks',
      "can I see my child's schedule?",
      'what is your attendance policy for missed sessions?',
      'where can I check my grades',
    ]) {
      for (const handler of [chat, ollamaChat]) {
        llmCalls = 0;
        const out = await invoke(handler, { message: msg, history: [] }, null);
        assert.equal(llmCalls, 0, `"${msg}" must never reach the LLM`);
        assert.match(out.reply, ANY_DECLINE_RE, `"${msg}"`);
      }
    }
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('e2e: an existing vetted FAQ topic (attendance policy) is now ALSO gated for public users — a deliberate, confirmed tradeoff', async () => {
  const origReply = geminiClient.generateChatbotReply;
  let llmCalls = 0;
  geminiClient.generateChatbotReply = async () => { llmCalls += 1; return 'should never be called'; };
  try {
    const out = await invoke(chat, { message: 'What is your attendance policy for missed sessions?', history: [] }, null);
    assert.equal(llmCalls, 0);
    assert.doesNotMatch(out.reply, /notify the center at least 24 hours/i, 'the old vetted FAQ answer must no longer be reachable for a public user');
    assert.match(out.reply, ANY_DECLINE_RE);
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

// ── Real bug (live-reported): a tutor's genuinely-assigned student "Ken Jen" (a real,
// two-word FIRST name, no last name given at all) was wrongly declined as
// not-found/not-assigned. Root cause: nameMatchesAnyPerson counted words in the
// CANDIDATE text and assumed 2+ words meant "first AND last name both given", which
// only holds when the person's own first name is a single word. ──────────────────────

test('nameMatchesAnyPerson: a candidate matching a real MULTI-WORD first name (no last name given) is accepted', () => {
  const people = [{ firstName: 'Ken Jen', lastName: 'Soriano' }];
  assert.equal(nameMatchesAnyPerson('ken jen', people), true);
});

test('nameMatchesAnyPerson: still correctly declines a typo in a single-word first name even with a matching last name (anti-typo protection preserved)', () => {
  const people = [{ firstName: 'Alex', lastName: 'Soriano' }];
  assert.equal(nameMatchesAnyPerson('alez soriano', people), false);
});

test('nameMatchesAnyPerson: a bare single-word first name is still accepted on its own', () => {
  const people = [{ firstName: 'Alex', lastName: 'Soriano' }];
  assert.equal(nameMatchesAnyPerson('alex', people), true);
});

test('nameMatchesAnyPerson: a correct full first+last match for a single-word first name still works', () => {
  const people = [{ firstName: 'Alex', lastName: 'Soriano' }];
  assert.equal(nameMatchesAnyPerson('alex soriano', people), true);
});

test('verifyNamedStudentReference: the exact reported phrasing ("kay ken jen gusto ko malaman...") correctly resolves the tutor\'s real, multi-word-first-name student', async () => {
  const origFind = Schedule.find;
  Schedule.find = () => mockFindQuery([
    { student: null, students: [{ _id: 'kenjen-1', firstName: 'Ken Jen', lastName: 'Soriano' }] },
  ]);
  try {
    const reply = await verifyNamedStudentReference(
      { user: { _id: 'tutor1', role: 'tutor' } },
      'pwede bang pa summarize yung schedule ko para kay ken jen gusto ko malaman if hanggang kailan mag e-end ang sessions ko sakanya',
      []
    );
    assert.equal(reply, null, 'a genuinely assigned student must not be declined');
  } finally {
    Schedule.find = origFind;
  }
});

// ── Real bug (live-reported): a message naming a NONEXISTENT student that ALSO scored
// high confidence on an unrelated generic classifier intent ("ano ang program ni rene
// bituin?" — contains "program", confidently classified as program_comparison) got
// answered with that generic reply instead of being declined — because
// tryClassifierShortcut used to run BEFORE verifyNamedStudentReference. ────────────────

async function withHighConfidenceClassifier(intent, fn) {
  delete require.cache[require.resolve('../utils/intentClassifierClient')];
  const intentClassifierClient = require('../utils/intentClassifierClient');
  intentClassifierClient.predictIntent = async () => ({ intent, confidence: 0.99 });

  delete require.cache[require.resolve('../controllers/aiController')];
  const fresh = require('../controllers/aiController');

  try {
    await fn(fresh);
  } finally {
    delete require.cache[require.resolve('../utils/intentClassifierClient')];
    delete require.cache[require.resolve('../controllers/aiController')];
  }
}

test('e2e ordering fix: a nonexistent named student is still declined even when the message ALSO scores high confidence on an unrelated classifier intent (chat)', async () => {
  await withHighConfidenceClassifier('program_comparison', async (fresh) => {
    const origFind = Schedule.find;
    Schedule.find = () => mockFindQuery([
      { student: null, students: [{ firstName: 'Maria', lastName: 'Cruz' }] },
    ]);
    try {
      const out = await invoke(fresh.chat, { message: 'ano ang program ni rene bituin?', history: [] }, { _id: 'tutor1', role: 'tutor' });
      assert.match(out.reply, NON_PUBLIC_DECLINE_RE, 'must decline, not answer with the generic program-comparison reply');
      assert.doesNotMatch(out.reply, /toddlers playgroup|academic tutorial|examination preparation/i);
    } finally {
      Schedule.find = origFind;
    }
  });
});

test('e2e ordering fix: same guarantee for ollamaChat', async () => {
  await withHighConfidenceClassifier('program_comparison', async (fresh) => {
    const origFind = Schedule.find;
    Schedule.find = () => mockFindQuery([
      { student: null, students: [{ firstName: 'Maria', lastName: 'Cruz' }] },
    ]);
    try {
      const out = await invoke(fresh.ollamaChat, { message: 'ano ang program ni rene bituin?', history: [] }, { _id: 'tutor1', role: 'tutor' });
      assert.match(out.reply, NON_PUBLIC_DECLINE_RE);
      assert.doesNotMatch(out.reply, /toddlers playgroup|academic tutorial|examination preparation/i);
    } finally {
      Schedule.find = origFind;
    }
  });
});

test('e2e ordering fix: a classifier-shortcut-eligible message with NO named-student reference at all is unaffected — still answered by the classifier shortcut', async () => {
  await withHighConfidenceClassifier('program_comparison', async (fresh) => {
    const out = await invoke(fresh.chat, { message: 'what programs do you offer compared to each other', history: [] }, { _id: 'tutor1', role: 'tutor' });
    assert.match(out.reply, /toddlers playgroup|academic tutorial|examination preparation/i);
  });
});

test('cleanup: close mongoose if a test opened it', async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
});
