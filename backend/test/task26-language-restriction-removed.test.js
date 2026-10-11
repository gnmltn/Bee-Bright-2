/**
 * Task 26 originally restricted the chatbot's LLM fallback to English generation only,
 * because the old local phi model (small, English-centric) produced unreliable,
 * grammatically broken Filipino/Taglish — Filipino and Taglish were routed straight to
 * the existing localized canned reply, the LLM was never called for them.
 *
 * That restriction is REMOVED now that the chatbot calls Gemini, which handles
 * Filipino/Taglish well. English/Filipino/Taglish all now reach generateChatbotLlmReply
 * the same way. The deterministic pipeline (including applyConversationContext's
 * follow-up detection) still runs FIRST for every language and still wins whenever it
 * can actually answer — the LLM is only reached when that pipeline's reply was
 * unhelpful, same as before, just no longer gated by language.
 *
 * The LLM call is stubbed (geminiClient.generateChatbotReply); `AuditLog.create` is
 * spied so we can assert groundingPath.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const Escalation = require('../models/Escalation');
const geminiClient = require('../utils/geminiClient');
const { chat, ollamaChat, generateChatbotLlmReply } = require('../controllers/aiController');

let auditPaths = [];
AuditLog.create = async (doc) => { auditPaths.push(doc?.metadata?.groundingPath); return {}; };
Escalation.create = async () => ({});

let llmCalls = 0;
let lastPrompt = null;
function stubGemini() {
  llmCalls = 0;
  lastPrompt = null;
  geminiClient.generateChatbotReply = async ({ systemInstruction, contents }) => {
    llmCalls += 1;
    lastPrompt = { systemInstruction, contents };
    return 'A short LLM answer about Bee Bright.';
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

// Messages that fall through every deterministic handler and reach the LLM. Verified
// directly against the real (unstubbed) pipeline before relying on them here — several
// older off-menu probes now get caught by broadened deterministic/RAG keyword coverage
// from later batches and no longer reach the LLM at all, which would silently make a
// "reaches the LLM" test pass for the wrong reason (or fail outright, as the original
// TAGLISH_OFF_MENU did here).
const FILIPINO_OFF_MENU = 'ano kaya ang masasabi mo sa pag-aaral ng bata sa murang edad';
const TAGLISH_OFF_MENU = 'feeling ko medyo kulang yung explanation mo kanina pero okay lang';
const ENGLISH_OFF_MENU = 'my neighbor keeps talking about your academic tutorial classes';

// ── unit — the restriction is gone ────────────────────────────────────────

test('generateChatbotLlmReply no longer returns null purely based on language — filipino/taglish reach the LLM too', async () => {
  const origReply = geminiClient.generateChatbotReply;
  stubGemini();
  try {
    for (const lang of ['english', 'filipino', 'taglish']) {
      llmCalls = 0;
      const r = await generateChatbotLlmReply({
        user: null,
        resolvedMessage: 'anything off-menu',
        rawMessage: 'anything off-menu',
        groundedContext: null,
        effectiveLanguageProfile: lang,
        history: [],
      });
      assert.equal(llmCalls, 1, `lang=${lang} should call the LLM`);
      assert.match(r, /llm answer/i, `lang=${lang}`);
    }
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('the system instruction distinguishes Taglish from pure Filipino (not collapsed into one label)', async () => {
  const origReply = geminiClient.generateChatbotReply;
  let filipinoPrompt = null;
  let taglishPrompt = null;
  geminiClient.generateChatbotReply = async ({ systemInstruction }) => {
    if (!filipinoPrompt) filipinoPrompt = systemInstruction;
    else taglishPrompt = systemInstruction;
    return 'ok';
  };
  try {
    await generateChatbotLlmReply({
      user: null, resolvedMessage: 'x', rawMessage: 'x', groundedContext: null,
      effectiveLanguageProfile: 'filipino', history: [],
    });
    await generateChatbotLlmReply({
      user: null, resolvedMessage: 'x', rawMessage: 'x', groundedContext: null,
      effectiveLanguageProfile: 'taglish', history: [],
    });
    // The static base prompt (bee_bright_system.txt) now legitimately mentions "Taglish"
    // in its general LANGUAGE RULES for every request — check only the dynamic,
    // per-request [LANGUAGE INSTRUCTION]/[STYLE INSTRUCTION] blocks this function builds,
    // not the whole prompt.
    const filipinoDynamicBlock = filipinoPrompt.match(/\[LANGUAGE INSTRUCTION\][\s\S]*?\[RELEVANCE INSTRUCTION\]/)[0];
    const taglishDynamicBlock = taglishPrompt.match(/\[LANGUAGE INSTRUCTION\][\s\S]*?\[RELEVANCE INSTRUCTION\]/)[0];
    assert.match(filipinoDynamicBlock, /Respond to the user in Filipino/i);
    assert.doesNotMatch(filipinoDynamicBlock, /Taglish/i);
    assert.match(taglishDynamicBlock, /Taglish/i);
    assert.notEqual(filipinoDynamicBlock, taglishDynamicBlock, 'Filipino and Taglish must get distinct dynamic instructions');
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

// ── e2e — Filipino and Taglish off-menu questions now reach the LLM ──────

test('a Filipino off-menu question now reaches the LLM (groundingPath is llm*)', async () => {
  const origReply = geminiClient.generateChatbotReply;
  stubGemini();
  try {
    for (const handler of [chat, ollamaChat]) {
      llmCalls = 0;
      auditPaths = [];
      const out = await invoke(handler, { message: FILIPINO_OFF_MENU, history: [] }, null);
      assert.equal(llmCalls, 1, 'the LLM WAS called for Filipino');
      assert.match(out.reply, /llm answer/i);
      assert.ok(auditPaths.some((p) => p === 'llm' || p === 'grounded-llm'),
        `groundingPath should be an llm* value, got ${JSON.stringify(auditPaths)}`);
    }
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('a Taglish off-menu question now reaches the LLM (groundingPath is llm*)', async () => {
  const origReply = geminiClient.generateChatbotReply;
  stubGemini();
  try {
    for (const handler of [chat, ollamaChat]) {
      llmCalls = 0;
      auditPaths = [];
      const out = await invoke(handler, { message: TAGLISH_OFF_MENU, history: [] }, null);
      assert.equal(llmCalls, 1, 'the LLM WAS called for Taglish');
      assert.match(out.reply, /llm answer/i);
      assert.ok(auditPaths.some((p) => p === 'llm' || p === 'grounded-llm'),
        `groundingPath should be an llm* value, got ${JSON.stringify(auditPaths)}`);
    }
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('an English off-menu question still reaches the LLM and still gets RAG reference context (regression)', async () => {
  const origReply = geminiClient.generateChatbotReply;
  stubGemini();
  try {
    auditPaths = [];
    const out = await invoke(ollamaChat, { message: ENGLISH_OFF_MENU, history: [] }, null);
    assert.equal(llmCalls, 1, 'the LLM WAS called for English');
    assert.match(out.reply, /llm answer/i);
    const systemMsg = lastPrompt.systemInstruction;
    assert.match(systemMsg, /\[REFERENCE MATERIAL — Bee Bright knowledge base\]/);
    assert.match(systemMsg, /Academic Tutorial/);
    assert.ok(auditPaths.some((p) => p === 'llm' || p === 'grounded-llm'),
      `groundingPath should be an llm* value, got ${JSON.stringify(auditPaths)}`);
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

// ── Gemini-first restructuring: every language reaches Gemini first now, even a
// question the deterministic pipeline could answer confidently ──

test('Gemini-first: a Filipino question the deterministic pipeline COULD answer still reaches Gemini first', async () => {
  const origReply = geminiClient.generateChatbotReply;
  stubGemini();
  try {
    llmCalls = 0;
    const out = await invoke(chat, { message: 'paano mag-enroll?', history: [] }, null);
    assert.equal(llmCalls, 1, 'Gemini must be tried first, even for a deterministically-answerable question');
    assert.match(out.reply, /llm answer/i);
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('Gemini-first: when Gemini fails, that same Filipino question falls back to the deterministic pipeline', async () => {
  const origReply = geminiClient.generateChatbotReply;
  geminiClient.generateChatbotReply = async () => null; // simulates a 429 or any other failure
  try {
    const out = await invoke(chat, { message: 'paano mag-enroll?', history: [] }, null);
    assert.doesNotMatch(out.reply, /llm answer/i);
    assert.ok(out.reply && out.reply.length > 0, 'the deterministic fallback must still answer');
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('an unanswerable English question reaches the LLM on /api/ai/chat too (Task 24a path intact)', async () => {
  const origReply = geminiClient.generateChatbotReply;
  stubGemini();
  try {
    auditPaths = [];
    const out = await invoke(chat, { message: 'can my child bring a snack to class', history: [] }, null);
    assert.equal(llmCalls, 1);
    assert.match(out.reply, /llm answer/i);
    assert.ok(auditPaths.some((p) => p === 'llm' || p === 'grounded-llm'), JSON.stringify(auditPaths));
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

// ── the "ganun ba?" confirmation follow-up still resolves deterministically first ──

test('"ganun ba?" is resolved by applyConversationContext to the real prior question, then sent to Gemini WITH history (not short-circuited to a canned answer)', async () => {
  const origReply = geminiClient.generateChatbotReply;
  const calls = [];
  geminiClient.generateChatbotReply = async ({ systemInstruction, contents }) => {
    calls.push({ systemInstruction, contents });
    return 'A short LLM answer about Bee Bright.';
  };
  try {
    const history = [];
    const out1 = await invoke(chat, { message: 'paano mag-enroll?', history }, null);
    assert.equal(calls.length, 1);

    history.push({ role: 'user', content: 'paano mag-enroll?' });
    history.push({ role: 'assistant', content: out1.reply });

    const out2 = await invoke(chat, { message: 'ganun ba?', history }, null);
    assert.equal(calls.length, 2, 'the follow-up must still reach Gemini (not short-circuit to a canned reply)');

    // The LAST turn in what Gemini received must be the RESOLVED question ("paano
    // mag-enroll?"), not the contentless literal "ganun ba?" — applyConversationContext
    // still does this resolution, it just now feeds Gemini instead of a canned answer.
    const secondCallContents = calls[1].contents;
    const lastTurn = secondCallContents[secondCallContents.length - 1];
    assert.equal(lastTurn.role, 'user');
    assert.equal(lastTurn.parts[0].text, 'paano mag-enroll?');

    // The prior turns (real conversation history) are also present, giving Gemini full
    // context, not just the resolved question in isolation.
    assert.ok(secondCallContents.some((c) => c.role === 'model' && c.parts[0].text === out1.reply),
      'the prior assistant turn should be in the history Gemini receives');
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('cleanup: close mongoose if a test opened it', async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
});
