/**
 * Task 26 — restrict phi to English generation only.
 *
 * phi (small, English-centric) produces unreliable / grammatically broken Filipino and
 * Taglish. So: English still reaches phi (Task 24a/24b intact); Filipino and Taglish are
 * routed straight to the existing localized canned reply — phi is never called.
 *
 * phi is stubbed (global.fetch); `AuditLog.create` is spied so we can assert groundingPath.
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59585';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const Escalation = require('../models/Escalation');
const { chat, ollamaChat, generatePhiReply } = require('../controllers/aiController');

let auditPaths = [];
AuditLog.create = async (doc) => { auditPaths.push(doc?.metadata?.groundingPath); return {}; };
Escalation.create = async () => ({});

let fetchCalls = 0;
let lastPrompt = null;
function stubPhi() {
  fetchCalls = 0;
  lastPrompt = null;
  global.fetch = async (url, opts) => {
    fetchCalls += 1;
    try { lastPrompt = JSON.parse(opts.body); } catch (_) { /* ignore */ }
    return { ok: true, status: 200, json: async () => ({ message: { content: 'A short English phi answer about Bee Bright.' } }) };
  };
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

// Messages that (pre-Task-26) fell through every deterministic handler and reached phi.
const FILIPINO_OFF_MENU = 'ano kaya ang masasabi mo sa pag-aaral ng bata sa murang edad';
const TAGLISH_OFF_MENU = 'kwento mo naman kung bakit maganda mag-aral dito sa bee bright';
const ENGLISH_OFF_MENU = 'my neighbor keeps talking about your academic tutorial classes';

// ── unit — the single enforcement point ──────────────────────────────────

test('26: generatePhiReply returns null for filipino/taglish WITHOUT calling phi', async () => {
  const realFetch = global.fetch;
  stubPhi();
  try {
    for (const lang of ['filipino', 'taglish', 'spanish', undefined]) {
      const r = await generatePhiReply({
        user: null,
        resolvedMessage: 'anything',
        rawMessage: 'anything',
        groundedContext: null,
        effectiveLanguageProfile: lang,
        history: [],
      });
      assert.equal(r, null, `lang=${lang}`);
    }
    assert.equal(fetchCalls, 0, 'phi must not be contacted for non-English');

    // English still calls it
    const en = await generatePhiReply({
      user: null,
      resolvedMessage: 'what is your refund policy',
      rawMessage: 'what is your refund policy',
      groundedContext: null,
      effectiveLanguageProfile: 'english',
      history: [],
    });
    assert.equal(fetchCalls, 1);
    assert.match(en, /phi answer/i);
  } finally {
    global.fetch = realFetch;
  }
});

// ── Testing pt.1 — Filipino no longer reaches phi ────────────────────────

test('26: a Filipino off-menu question returns the localized canned reply, not phi', async () => {
  const realFetch = global.fetch;
  stubPhi();
  try {
    for (const handler of [chat, ollamaChat]) {
      auditPaths = [];
      const out = await invoke(handler, { message: FILIPINO_OFF_MENU, history: [] }, null);
      assert.equal(fetchCalls, 0, 'phi was NOT called for Filipino');
      // grammatically-normal canned Filipino (the existing localized fallback text)
      assert.match(out.reply, /Matutulungan kita|Gusto kong tiyaking tugma|Maaari kang magtanong|Pakilinaw/i);
      assert.doesNotMatch(out.reply, /phi answer/i);
      // Testing pt.4 — audit path is a deterministic/canned marker, never llm*
      assert.ok(auditPaths.every((p) => p !== 'llm' && p !== 'grounded-llm' && p !== 'llm-fallback'),
        `groundingPath should not be an llm* value, got ${JSON.stringify(auditPaths)}`);
    }
  } finally {
    global.fetch = realFetch;
  }
});

// ── Testing pt.3 — Taglish specifically is also routed away from phi ─────

test('26: a Taglish off-menu question is also kept away from phi', async () => {
  const realFetch = global.fetch;
  stubPhi();
  try {
    for (const handler of [chat, ollamaChat]) {
      auditPaths = [];
      const out = await invoke(handler, { message: TAGLISH_OFF_MENU, history: [] }, null);
      assert.equal(fetchCalls, 0, 'phi was NOT called for Taglish');
      assert.doesNotMatch(out.reply, /phi answer/i);
      assert.ok(auditPaths.every((p) => p !== 'llm' && p !== 'grounded-llm' && p !== 'llm-fallback'),
        `got ${JSON.stringify(auditPaths)}`);
    }
  } finally {
    global.fetch = realFetch;
  }
});

// ── Testing pt.2 — English still reaches phi, with RAG context ──────────

test('26: an English off-menu question still reaches phi and still gets RAG reference context', async () => {
  const realFetch = global.fetch;
  stubPhi();
  try {
    auditPaths = [];
    const out = await invoke(ollamaChat, { message: ENGLISH_OFF_MENU, history: [] }, null);
    assert.equal(fetchCalls, 1, 'phi WAS called for English');
    assert.match(out.reply, /phi answer/i);
    const systemMsg = lastPrompt.messages.find((m) => m.role === 'system').content;
    assert.match(systemMsg, /\[REFERENCE MATERIAL — Bee Bright knowledge base\]/);
    assert.match(systemMsg, /Academic Tutorial/);
    // Testing pt.4 — path recorded as an llm marker
    assert.ok(auditPaths.some((p) => p === 'llm' || p === 'grounded-llm'),
      `groundingPath should be an llm* value, got ${JSON.stringify(auditPaths)}`);
  } finally {
    global.fetch = realFetch;
  }
});

test('26: an unanswerable English question reaches phi on /api/ai/chat too (Task 24a path intact)', async () => {
  const realFetch = global.fetch;
  stubPhi();
  try {
    auditPaths = [];
    const out = await invoke(chat, { message: 'can my child bring a snack to class', history: [] }, null);
    assert.equal(fetchCalls, 1);
    assert.match(out.reply, /phi answer/i);
    assert.ok(auditPaths.some((p) => p === 'llm' || p === 'grounded-llm'), JSON.stringify(auditPaths));
  } finally {
    global.fetch = realFetch;
  }
});

test('cleanup: close mongoose if a test opened it', async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
});
