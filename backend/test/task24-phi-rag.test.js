/**
 * Task 24 — expand the chatbot's LLM fallback role via RAG (Option A).
 *
 *   24b  buildPhiReferenceContext() retrieves a small, topic-relevant slice of the
 *        STATIC knowledge base (aiResponseDatasets.js) as plain text.
 *   24b  ollamaChat() injects it into the LLM's system instruction as a distinctly-
 *        labelled [REFERENCE MATERIAL] block, separate from the [ACCOUNT DATA] block.
 *   24c  guardrails — the reference material is static only and can never carry another
 *        user's / another role's data; sanitize + audit logging unchanged.
 *
 * The LLM call itself is stubbed (geminiClient.generateChatbotReply) so these run with
 * no real Gemini call, no Ollama, and no Mongo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const Escalation = require('../models/Escalation');
const AIResponseDatasets = require('../ai_training/aiResponseDatasets');
const geminiClient = require('../utils/geminiClient');
const { ollamaChat, buildPhiReferenceContext, generateChatbotLlmReply } = require('../controllers/aiController');

AuditLog.create = async () => ({});
Escalation.create = async () => ({});

// Every English `expectedReply` string in the static dataset — the reference material
// must always be a subset of this (proves it never pulls dynamic / per-user data).
const STATIC_ANSWERS = (() => {
  const pools = [
    AIResponseDatasets.studentQueries,
    AIResponseDatasets.tutorQueries,
    AIResponseDatasets.adminQueries,
    AIResponseDatasets.visitorQueries,
    AIResponseDatasets.navigationQueries,
    AIResponseDatasets.contextAwareFollowUps,
  ];
  const set = new Set();
  for (const pool of pools) for (const item of pool) {
    if (item.expectedReply?.en) set.add(item.expectedReply.en.trim());
  }
  return set;
})();

function refAnswers(text) {
  return text.split('\n\n')
    .map((block) => block.replace(/^Q:[\s\S]*?\nA:\s*/, '').trim())
    .filter(Boolean);
}

// ── 24b — retrieval ──────────────────────────────────────────────────────

test('24b: a programs question retrieves the real 3-program reference entry', () => {
  const ref = buildPhiReferenceContext('what programs does bee bright offer', null);
  assert.match(ref, /Toddlers Playgroup/);
  assert.match(ref, /Academic Tutorial/);
  assert.match(ref, /Examination Preparation/);
  // never the retired catalogue
  assert.doesNotMatch(ref, /Pre-Kindergarten|Kindergarten Readiness|SPED/i);
});

test('24b: a location question retrieves the location entry, not the whole dataset', () => {
  const ref = buildPhiReferenceContext('saan matatagpuan ang bee bright center', null);
  assert.match(ref, /Teo-Tinay Building|Dagupan/i);
  assert.ok(ref.split('\n\n').length <= 4, 'capped at 4 entries');
});

// Real content gaps (live-reported): neither of these existed anywhere in the dataset
// (nor in bee_bright_system.txt) before, so a public visitor asking either of these
// genuinely answerable questions fell through to the generic low-confidence fallback
// instead of a real answer.

test('24b: an age-eligibility question (the exact reported "11 months old" phrasing) now retrieves a real answer, pulled from the real enforced age ranges', () => {
  const ref = buildPhiReferenceContext('tumatanggap ba kayo ng 11 months old', null);
  assert.match(ref, /2/, 'Toddlers Playgroup starts at age 2');
  assert.match(ref, /Toddlers Playgroup/i);
});

test('24b: an operating-hours question now retrieves the real 8am-5pm answer instead of "not explicitly listed"', () => {
  const ref = buildPhiReferenceContext("what are bee bright's operating hours", null);
  assert.match(ref, /8:00 ?AM/i);
  assert.match(ref, /5:00 ?PM/i);
});

test('24b: pure filler / empty retrieves nothing', () => {
  assert.equal(buildPhiReferenceContext('', null), '');
  assert.equal(buildPhiReferenceContext('   ', 'student'), '');
  assert.equal(buildPhiReferenceContext('hello po can you help me please', null), '');
  assert.equal(buildPhiReferenceContext('ok thanks', null), '');
});

test('24b: an off-topic question retrieves nothing (no dataset dump)', () => {
  assert.equal(buildPhiReferenceContext('what is the weather like today', null), '');
});

// ── 24c — reference material is static & role-safe ───────────────────────

test('24c: retrieved reference material is always a verbatim subset of the static KB', () => {
  const probes = [
    ['how is my child doing in class', 'parent'],
    ['show me my grades', 'student'],
    ['how do i summarise my student remarks', 'tutor'],
    ['how many students are enrolled', 'admin'],
    ['how do i enroll my child', 'parent'],
    ['where do i see announcements', 'student'],
  ];
  for (const [msg, role] of probes) {
    const ref = buildPhiReferenceContext(msg, role);
    if (!ref) continue;
    for (const answer of refAnswers(ref)) {
      assert.ok(
        STATIC_ANSWERS.has(answer),
        `[${role}] "${msg}" produced a non-static reference line: ${answer.slice(0, 80)}`,
      );
    }
  }
});

test('24c: reference material never contains account-data markers', () => {
  const ref = buildPhiReferenceContext('how is my child doing', 'parent');
  assert.doesNotMatch(ref, /\[ACCOUNT DATA\]|Role: parent\n|Linked child enrollments|Enrollment status:/i);
});

// ── 24b — injection into the LLM's system instruction ─────────────────────

function stubGeminiCapturingPrompt() {
  const calls = [];
  geminiClient.generateChatbotReply = async ({ systemInstruction, contents }) => {
    calls.push({ systemInstruction, contents });
    return 'Here is a short helpful answer about Bee Bright.';
  };
  return calls;
}

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

test('24b e2e: when Gemini is reached, the [REFERENCE MATERIAL] block is in its system instruction', async () => {
  const origReply = geminiClient.generateChatbotReply;
  const calls = stubGeminiCapturingPrompt();
  try {
    // English declarative that mentions an on-topic word ("academic tutorial") but is
    // not a recognised question shape -> falls through every bypass handler, reaches the
    // LLM — and still has enough overlap for RAG retrieval. (English: Task 26 lets it through.)
    const msg = 'my neighbor keeps talking about your academic tutorial classes';
    const out = await invoke(ollamaChat, { message: msg, history: [] }, null);
    assert.equal(out.success, true);
    assert.equal(calls.length, 1, 'Gemini was actually called');

    const systemMsg = calls[0].systemInstruction;
    const expectedRef = buildPhiReferenceContext(msg, null);
    assert.ok(expectedRef, 'this probe message is expected to yield reference material');
    assert.match(systemMsg, /\[REFERENCE MATERIAL — Bee Bright knowledge base\]/);
    for (const answer of refAnswers(expectedRef)) {
      assert.ok(systemMsg.includes(answer), 'each retrieved entry is in the prompt');
    }
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('24b e2e: an unreachable Gemini still yields a deterministic fallback (RAG does not break the path)', async () => {
  const origReply = geminiClient.generateChatbotReply;
  geminiClient.generateChatbotReply = async () => null;
  try {
    const out = await invoke(
      ollamaChat,
      { message: 'my neighbor keeps talking about your academic tutorial classes', history: [] },
      null,
    );
    assert.equal(out.success, true);
    assert.ok(typeof out.reply === 'string' && out.reply.length > 0);
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

// ── 24a — the LLM is reached when the deterministic matcher genuinely has nothing ──

test('24a: an unanswerable question falls through to the LLM on BOTH routes', async () => {
  const origReply = geminiClient.generateChatbotReply;
  const calls = stubGeminiCapturingPrompt();
  try {
    const { chat } = require('../controllers/aiController');
    for (const handler of [chat, ollamaChat]) {
      calls.length = 0;
      const out = await invoke(handler, { message: 'can my child bring a snack to class', history: [] }, null);
      assert.equal(out.success, true);
      assert.equal(calls.length, 1, 'Gemini was invoked as a last resort');
      assert.equal(out.reply, 'Here is a short helpful answer about Bee Bright.');
    }
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

// Gemini-first restructuring (superseding "determinism wins first"): every question,
// even one the deterministic matcher could answer confidently, now reaches Gemini
// FIRST — the deterministic/keyword pipeline is only reached as a fallback when Gemini
// itself can't answer (most commonly a 429 rate-limit). This was a deliberate owner
// decision (accepting the cost/quota tradeoff) to fix cases where the deterministic
// matcher was answering confidently but WRONG for some role/topic combinations.
test('Gemini-first: a question the deterministic matcher COULD answer still reaches Gemini first', async () => {
  const origReply = geminiClient.generateChatbotReply;
  const calls = stubGeminiCapturingPrompt();
  try {
    const { chat } = require('../controllers/aiController');
    for (const msg of ['how do i enroll', 'where is bee bright located', 'what are your payment methods']) {
      for (const handler of [chat, ollamaChat]) {
        calls.length = 0;
        const out = await invoke(handler, { message: msg, history: [] }, null);
        assert.equal(calls.length, 1, `"${msg}" must reach Gemini first`);
        assert.equal(out.reply, 'Here is a short helpful answer about Bee Bright.');
      }
    }
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('Gemini-first: when Gemini fails (e.g. rate-limited), the SAME question falls back to the deterministic pipeline', async () => {
  const origReply = geminiClient.generateChatbotReply;
  geminiClient.generateChatbotReply = async () => null; // simulates a 429 or any other failure
  try {
    const { chat } = require('../controllers/aiController');
    for (const handler of [chat, ollamaChat]) {
      const out = await invoke(handler, { message: 'how do i enroll', history: [] }, null);
      assert.ok(out.reply && out.reply.length > 0, 'the deterministic fallback must still answer');
      assert.notEqual(out.reply, 'Here is a short helpful answer about Bee Bright.');
    }
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('24a: LLM prompt for an anonymous user carries NO [ACCOUNT DATA] block', async () => {
  const origReply = geminiClient.generateChatbotReply;
  const calls = stubGeminiCapturingPrompt();
  try {
    const { chat } = require('../controllers/aiController');
    await invoke(chat, { message: 'can my child bring a snack to class', history: [] }, null);
    const systemMsg = calls[0].systemInstruction;
    assert.doesNotMatch(systemMsg, /\[ACCOUNT DATA/);
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

// ── 24c — the LLM only ever sees the context it was handed (no data-boundary widening) ──

test('24c: generateChatbotLlmReply passes through the scoped grounded context verbatim, nothing more', async () => {
  const origReply = geminiClient.generateChatbotReply;
  let captured = null;
  geminiClient.generateChatbotReply = async ({ systemInstruction, contents }) => {
    captured = { systemInstruction, contents };
    return 'ok';
  };
  try {
    // Simulates what getGroundedChatContext already produced for THIS parent — Ana only.
    const groundedContext = {
      topic: 'grades',
      contextText: 'Role: parent\nChild: Ana Cruz\nAcademic Tutorial — Phonics: 82/100 (82%), tutor Maria Santos',
    };
    await generateChatbotLlmReply({
      user: { _id: 'parent-1', role: 'parent' },
      resolvedMessage: 'can you explain how ana is doing',
      rawMessage: 'can you explain how ana is doing',
      groundedContext,
      effectiveLanguageProfile: 'english',
      history: [],
    });
    const systemMsg = captured.systemInstruction;
    // the scoped block is present and labelled distinctly
    assert.match(systemMsg, /\[ACCOUNT DATA — specific to this signed-in user/);
    assert.ok(systemMsg.includes(groundedContext.contextText));
    // nothing about any other family leaked in
    assert.doesNotMatch(systemMsg, /Ben|Cruz Jr|another child|parent-2/i);
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('24c: no grounded context => no [ACCOUNT DATA] block at all', async () => {
  const origReply = geminiClient.generateChatbotReply;
  let captured = null;
  geminiClient.generateChatbotReply = async ({ systemInstruction, contents }) => {
    captured = { systemInstruction, contents };
    return 'ok';
  };
  try {
    await generateChatbotLlmReply({
      user: { _id: 't1', role: 'tutor' },
      resolvedMessage: 'what is your refund policy',
      rawMessage: 'what is your refund policy',
      groundedContext: null,
      effectiveLanguageProfile: 'english',
      history: [],
    });
    const systemMsg = captured.systemInstruction;
    assert.doesNotMatch(systemMsg, /\[ACCOUNT DATA/);
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('24c: an unreachable Gemini returns null (caller keeps its deterministic reply)', async () => {
  const origReply = geminiClient.generateChatbotReply;
  geminiClient.generateChatbotReply = async () => null;
  try {
    const r = await generateChatbotLlmReply({
      user: null,
      resolvedMessage: 'hi',
      rawMessage: 'hi',
      groundedContext: null,
      effectiveLanguageProfile: 'english',
      history: [],
    });
    assert.equal(r, null);
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('cleanup: close mongoose if a test opened it', async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
});
