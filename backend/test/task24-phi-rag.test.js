/**
 * Task 24 — expand phi's role via RAG (Option A).
 *
 *   24b  buildPhiReferenceContext() retrieves a small, topic-relevant slice of the
 *        STATIC knowledge base (aiResponseDatasets.js) as plain text.
 *   24b  ollamaChat() injects it into the phi system prompt as a distinctly-labelled
 *        [REFERENCE MATERIAL] block, separate from the [ACCOUNT DATA] block.
 *   24c  guardrails — the reference material is static only and can never carry another
 *        user's / another role's data; sanitize + audit logging unchanged.
 *
 * phi itself is stubbed (global.fetch) so these run with no Ollama and no Mongo.
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59581';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const Escalation = require('../models/Escalation');
const AIResponseDatasets = require('../ai_training/aiResponseDatasets');
const { ollamaChat, buildPhiReferenceContext, generatePhiReply } = require('../controllers/aiController');

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
  assert.match(ref, /Barangay Pantal|Dagupan/i);
  assert.ok(ref.split('\n\n').length <= 4, 'capped at 4 entries');
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

// ── 24b — injection into the phi prompt ─────────────────────────────────

function stubFetchCapturingPrompt() {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ message: { content: 'Here is a short helpful answer about Bee Bright.' } }),
    };
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

test('24b e2e: when phi is reached, the [REFERENCE MATERIAL] block is in its system prompt', async () => {
  const realFetch = global.fetch;
  const calls = stubFetchCapturingPrompt();
  try {
    // English declarative that mentions an on-topic word ("academic tutorial") but is
    // not a recognised question shape -> falls through every bypass handler, reaches phi
    // — and still has enough overlap for RAG retrieval. (English: Task 26 lets it through.)
    const msg = 'my neighbor keeps talking about your academic tutorial classes';
    const out = await invoke(ollamaChat, { message: msg, history: [] }, null);
    assert.equal(out.success, true);
    assert.equal(calls.length, 1, 'phi was actually called');

    const systemMsg = calls[0].messages.find((m) => m.role === 'system').content;
    const expectedRef = buildPhiReferenceContext(msg, null);
    assert.ok(expectedRef, 'this probe message is expected to yield reference material');
    assert.match(systemMsg, /\[REFERENCE MATERIAL — Bee Bright knowledge base\]/);
    for (const answer of refAnswers(expectedRef)) {
      assert.ok(systemMsg.includes(answer), 'each retrieved entry is in the prompt');
    }
  } finally {
    global.fetch = realFetch;
  }
});

test('24b e2e: an unreachable phi still yields a deterministic fallback (RAG does not break the path)', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const out = await invoke(
      ollamaChat,
      { message: 'my neighbor keeps talking about your academic tutorial classes', history: [] },
      null,
    );
    assert.equal(out.success, true);
    assert.ok(typeof out.reply === 'string' && out.reply.length > 0);
  } finally {
    global.fetch = realFetch;
  }
});

// ── 24a — phi is reached when the deterministic matcher genuinely has nothing ──

test('24a: an unanswerable question falls through to phi on BOTH routes', async () => {
  const realFetch = global.fetch;
  const calls = stubFetchCapturingPrompt();
  try {
    const { chat } = require('../controllers/aiController');
    for (const handler of [chat, ollamaChat]) {
      calls.length = 0;
      const out = await invoke(handler, { message: 'can my child bring a snack to class', history: [] }, null);
      assert.equal(out.success, true);
      assert.equal(calls.length, 1, 'phi was invoked as a last resort');
      assert.equal(out.reply, 'Here is a short helpful answer about Bee Bright.');
    }
  } finally {
    global.fetch = realFetch;
  }
});

test('24a: a question the matcher CAN answer never reaches phi (determinism wins)', async () => {
  const realFetch = global.fetch;
  const calls = stubFetchCapturingPrompt();
  try {
    const { chat } = require('../controllers/aiController');
    for (const msg of ['how do i enroll', 'where is bee bright located', 'what are your payment methods']) {
      for (const handler of [chat, ollamaChat]) {
        calls.length = 0;
        const out = await invoke(handler, { message: msg, history: [] }, null);
        assert.equal(calls.length, 0, `"${msg}" must be answered deterministically`);
        assert.ok(out.reply && out.reply.length > 0);
      }
    }
  } finally {
    global.fetch = realFetch;
  }
});

test('24a: phi prompt for an anonymous user carries NO [ACCOUNT DATA] block', async () => {
  const realFetch = global.fetch;
  const calls = stubFetchCapturingPrompt();
  try {
    const { chat } = require('../controllers/aiController');
    await invoke(chat, { message: 'can my child bring a snack to class', history: [] }, null);
    const systemMsg = calls[0].messages.find((m) => m.role === 'system').content;
    assert.doesNotMatch(systemMsg, /\[ACCOUNT DATA/);
  } finally {
    global.fetch = realFetch;
  }
});

// ── 24c — phi only ever sees the context it was handed (no data-boundary widening) ──

test('24c: generatePhiReply passes through the scoped grounded context verbatim, nothing more', async () => {
  const realFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ message: { content: 'ok' } }) };
  };
  try {
    // Simulates what getGroundedChatContext already produced for THIS parent — Ana only.
    const groundedContext = {
      topic: 'grades',
      contextText: 'Role: parent\nChild: Ana Cruz\nAcademic Tutorial — Phonics: 82/100 (82%), tutor Maria Santos',
    };
    await generatePhiReply({
      user: { _id: 'parent-1', role: 'parent' },
      resolvedMessage: 'can you explain how ana is doing',
      rawMessage: 'can you explain how ana is doing',
      groundedContext,
      effectiveLanguageProfile: 'english',
      history: [],
    });
    const systemMsg = captured.messages.find((m) => m.role === 'system').content;
    // the scoped block is present and labelled distinctly
    assert.match(systemMsg, /\[ACCOUNT DATA — specific to this signed-in user/);
    assert.ok(systemMsg.includes(groundedContext.contextText));
    // nothing about any other family leaked in
    assert.doesNotMatch(systemMsg, /Ben|Cruz Jr|another child|parent-2/i);
  } finally {
    global.fetch = realFetch;
  }
});

test('24c: no grounded context => no [ACCOUNT DATA] block at all', async () => {
  const realFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ message: { content: 'ok' } }) };
  };
  try {
    await generatePhiReply({
      user: { _id: 't1', role: 'tutor' },
      resolvedMessage: 'what is your refund policy',
      rawMessage: 'what is your refund policy',
      groundedContext: null,
      effectiveLanguageProfile: 'english',
      history: [],
    });
    const systemMsg = captured.messages.find((m) => m.role === 'system').content;
    assert.doesNotMatch(systemMsg, /\[ACCOUNT DATA/);
  } finally {
    global.fetch = realFetch;
  }
});

test('24c: an unreachable phi returns null (caller keeps its deterministic reply)', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const r = await generatePhiReply({
      user: null,
      resolvedMessage: 'hi',
      rawMessage: 'hi',
      groundedContext: null,
      effectiveLanguageProfile: 'english',
      history: [],
    });
    assert.equal(r, null);
  } finally {
    global.fetch = realFetch;
  }
});

test('cleanup: close mongoose if a test opened it', async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
});
