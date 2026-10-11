/**
 * scripts/try-phi.js — manual harness for the chatbot's Gemini LLM fallback.
 *
 *   node scripts/try-phi.js "what is your refund policy if we cancel"
 *   node scripts/try-phi.js --role parent "how is my child doing"
 *
 * It runs your message through the real chat() handler (same code path as
 * POST /api/ai/chat), tells you whether Gemini was actually called, what RAG
 * reference material was handed to it, and how long it took. Audit-log and
 * escalation writes are stubbed; everything else is real, so GEMINI_API_KEY
 * (in .env) must be a real key and MongoDB must be running.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const Escalation = require('../models/Escalation');
AuditLog.create = async () => ({});
Escalation.create = async () => ({});

const {
  chat,
  buildPhiReferenceContext,
} = require('../controllers/aiController');
const geminiClient = require('../utils/geminiClient');

// ── parse args ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let role = null;
const parts = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--role') { role = argv[i + 1]; i += 1; } else parts.push(argv[i]);
}
const message = parts.join(' ').trim();
if (!message) {
  console.error('usage: node scripts/try-phi.js [--role parent|student|tutor|admin] "your question"');
  process.exit(1);
}
const user = role ? { _id: new mongoose.Types.ObjectId(), role } : null;

// ── spy on the one call the controller makes to Gemini (real network call, not stubbed) ──
let llmCalled = false;
let llmPrompt = null;
let llmMs = 0;
const realGenerateChatbotReply = geminiClient.generateChatbotReply;
geminiClient.generateChatbotReply = async ({ systemInstruction, contents }) => {
  llmCalled = true;
  llmPrompt = { systemInstruction, contents };
  const t = Date.now();
  const res = await realGenerateChatbotReply({ systemInstruction, contents });
  llmMs = Date.now() - t;
  return res;
};

function invoke(body, u) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(p) { resolve({ status: this.statusCode, ...p }); return this; },
    };
    chat({ body, user: u, headers: { 'user-agent': 'try-phi' }, ip: '127.0.0.1' }, res);
  });
}

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith('replace-with')) {
    console.log('GEMINI_API_KEY is not configured (still a placeholder in .env) — the chatbot will fall back to deterministic replies.');
  } else {
    console.log(`Gemini: configured (model ${process.env.GEMINI_CHATBOT_MODEL || 'gemini-2.5-flash'})`);
  }

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/beebright');

  console.log(`\n> ${message}${user ? `   (as ${user.role})` : '   (public)'}`);
  console.log(`  RAG reference this message would get:\n${
    (buildPhiReferenceContext(message, user?.role) || '(none — topic not in the knowledge base)')
      .split('\n').map((l) => `    ${l}`).join('\n')}`);

  const t0 = Date.now();
  const out = await invoke({ message, history: [] }, user);
  const totalMs = Date.now() - t0;

  console.log(`\n  Gemini called: ${llmCalled ? `yes (${llmMs} ms)` : 'no — a deterministic handler answered'}`);
  if (llmCalled && llmPrompt) {
    const sys = llmPrompt.systemInstruction || '';
    console.log(`  [REFERENCE MATERIAL] in the prompt: ${/\[REFERENCE MATERIAL/.test(sys) ? 'yes' : 'no'}`);
    console.log(`  [ACCOUNT DATA] in the prompt:       ${/\[ACCOUNT DATA/.test(sys) ? 'yes' : 'no'}`);
  }
  console.log(`  total: ${totalMs} ms\n`);
  console.log('  reply:');
  console.log(String(out.reply || `(HTTP ${out.status}) ${out.message}`).split('\n').map((l) => `    ${l}`).join('\n'));

  await mongoose.disconnect();
  geminiClient.generateChatbotReply = realGenerateChatbotReply;
})().catch((e) => { console.error(e); process.exit(1); });
