/**
 * scripts/try-phi.js — manual harness for the Task 24 phi RAG fallback.
 *
 *   node scripts/try-phi.js "what is your refund policy if we cancel"
 *   node scripts/try-phi.js --role parent "how is my child doing"
 *
 * It runs your message through the real chat() handler (same code path as
 * POST /api/ai/chat), tells you whether phi was actually called, what RAG
 * reference material was handed to it, and how long it took. Audit-log and
 * escalation writes are stubbed; everything else is real, so Ollama + MongoDB
 * must be running.
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

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'phi:latest';

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

// ── spy on the one fetch() the controller makes to Ollama ─────────────────
let phiCalled = false;
let phiPrompt = null;
let phiMs = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('/api/chat')) {
    phiCalled = true;
    try { phiPrompt = JSON.parse(opts.body); } catch (_) { /* ignore */ }
    const t = Date.now();
    const res = await realFetch(url, opts);
    phiMs = Date.now() - t;
    return res;
  }
  return realFetch(url, opts);
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
  // reachability check
  try {
    const r = await realFetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const tags = await r.json();
    const names = (tags.models || []).map((m) => m.name);
    console.log(`Ollama: up at ${OLLAMA_URL}  · models: ${names.join(', ') || '(none)'}`);
    if (!names.some((n) => n === OLLAMA_MODEL || n.split(':')[0] === OLLAMA_MODEL.split(':')[0])) {
      console.log(`  ⚠  OLLAMA_MODEL="${OLLAMA_MODEL}" is not pulled — run:  ollama pull ${OLLAMA_MODEL}`);
    }
  } catch (_) {
    console.log(`Ollama: NOT reachable at ${OLLAMA_URL} — the chatbot will fall back to deterministic replies.`);
  }

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/beebright');

  console.log(`\n> ${message}${user ? `   (as ${user.role})` : '   (public)'}`);
  console.log(`  RAG reference this message would get:\n${
    (buildPhiReferenceContext(message, user?.role) || '(none — topic not in the knowledge base)')
      .split('\n').map((l) => `    ${l}`).join('\n')}`);

  const t0 = Date.now();
  const out = await invoke({ message, history: [] }, user);
  const totalMs = Date.now() - t0;

  console.log(`\n  phi called: ${phiCalled ? `yes (${phiMs} ms)` : 'no — a deterministic handler answered'}`);
  if (phiCalled && phiPrompt) {
    const sys = phiPrompt.messages.find((m) => m.role === 'system')?.content || '';
    console.log(`  [REFERENCE MATERIAL] in phi's prompt: ${/\[REFERENCE MATERIAL/.test(sys) ? 'yes' : 'no'}`);
    console.log(`  [ACCOUNT DATA] in phi's prompt:       ${/\[ACCOUNT DATA/.test(sys) ? 'yes' : 'no'}`);
  }
  console.log(`  total: ${totalMs} ms\n`);
  console.log('  reply:');
  console.log(String(out.reply || `(HTTP ${out.status}) ${out.message}`).split('\n').map((l) => `    ${l}`).join('\n'));

  await mongoose.disconnect();
  global.fetch = realFetch;
})().catch((e) => { console.error(e); process.exit(1); });
