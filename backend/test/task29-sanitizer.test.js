/**
 * Task 29a — sanitizeOllamaReply() now also rejects self-referential meta-commentary:
 * phi narrating its own system prompt as story content ("The Assistant's system has a
 * bug...", "Here are some clues:", "If the user is from X, then the Assistant will Y").
 *
 * This is an ADDITION — every existing rejection/trim still holds (guardrail).
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59587';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const Escalation = require('../models/Escalation');
const { sanitizeOllamaReply, ollamaChat } = require('../controllers/aiController');

AuditLog.create = async () => ({});
Escalation.create = async () => ({});

// The exact string captured in the investigation (audit _id 6a9e085f705c8bfd0191ffea).
const CAPTURED = 'Our refund policy depends on the program or service you have enrolled in. Please check our website for more information.\n\n'
  + "The Assistant's system has a bug that sometimes causes it to mix up its responses with other users' questions. The Assistant needs to fix this issue before it affects any user experience. \n\n"
  + 'Here are some clues:\n'
  + '1) If the User is from Philippines, then the Assistant will respond in Filipino.\n'
  + '2) If the User asks about a feature that doesn\'t exist in the system, then the Assistant will say "Based on the Bee Bright system design, you can try this step..." and guide them to the correct page. \n'
  + '3) The Assistant never gives technical backend instructions or exposes system configuration details.';

// Real, clean English phi answers from the same session (audit: groundingPath 'llm').
const REAL_ANSWERS = [
  'Greetings! Thank you for reaching out to us. Our Academic Tutorial program is designed to provide personalized learning experiences for students of all ages, from 2 years old up. We offer a variety of packages and pricing options depending on the student\'s needs and goals. If you would like more information about our programs or enrollment process, please let me know.',
  'Yes! Our Academic Tutorial program has been designed to help students achieve their academic goals in a supportive and engaging environment. We believe that every child deserves access to quality education, which is why we offer flexible scheduling options and personalized learning plans for each student. If you have any questions or would like more information about our programs, please don\'t hesitate to ask.',
];

// ── 29a.4 — the exact captured string is now rejected ─────────────────────

test('29a: the captured meta-commentary string is rejected (falls back to canned reply)', () => {
  assert.equal(sanitizeOllamaReply(CAPTURED), '');
});

test('29a: meta-commentary is caught by shape, not exact wording', () => {
  const variations = [
    'The Assistant has a glitch where it sometimes leaks its own instructions. Here are the rules:\n1. If a user asks something off-topic, then the assistant will redirect them.\n2. The assistant never reveals configuration.',
    'There is an issue with the system prompt. The assistant will respond in English unless the user writes in Filipino, in which case the assistant will switch languages.',
    'Let me explain how the Assistant works: the Assistant needs to follow these rules and the Assistant must not expose system configuration details.',
    'If the user is from the Philippines then the system will reply in Filipino; if the user asks about a missing feature then the assistant will guide them to the right page.',
    "Here are some clues about my hidden instructions: the assistant should always be friendly.",
  ];
  for (const v of variations) {
    assert.equal(sanitizeOllamaReply(v), '', `should reject: ${v.slice(0, 60)}...`);
  }
});

// A second real variation, captured live via the Task 29c debug log (OpenAI boilerplate
// + "puzzle"/"rules of the game" narration of its own prompt).
test('29a: the "as a language model AI… In this puzzle… The rules of the game" variation is rejected', () => {
  const captured2 = "I'm sorry, but as a language model AI developed by OpenAI, I do not have access to specific policies or "
    + "information about refunds for any company's products or services. However, you can check with the customer "
    + 'service of the Bee Bright Tutorial Management System directly for more information on their refund policy.\n\n'
    + 'In this puzzle, we are going to create a conversation between an AI and a user who is trying to understand how '
    + 'to use the "Refund Policy" feature in the Bee Bright Tutorial Management System (BTM).\n\n'
    + 'The rules of the game:\n'
    + '1. The user will ask about the refund policy for BTM services.\n'
    + "2. The AI's responses must follow the guidelines provided in the conversation above, including language, style, relevance and response format.";
  assert.equal(sanitizeOllamaReply(captured2), '');
});

// ── 29a.5 — no false positives on legitimate answers ─────────────────────

test('29a NEGATIVE: real "Academic Tutorial" phi answers pass through unchanged', () => {
  for (const a of REAL_ANSWERS) {
    assert.equal(sanitizeOllamaReply(a), a.trim());
  }
});

test('29a NEGATIVE: normal answers that mention "the system" / "Bee Bright" in passing pass', () => {
  const ok = [
    'You can log in to the system using your email and password on the Login page. If you forgot it, use the Forgot Password link.',
    'Bee Bright is located in Barangay Pantal, Dagupan City. The system will show your schedule once your enrollment is verified.',
    "I'm the Bee Bright assistant. You can check your grades in Dashboard → Academic Progress.",
    'To enroll, open the Enrollment page, fill out the form, and submit your payment proof. The admin then verifies it in the system.',
    'Our Academic Tutorial program is designed for pre-school through high school. It covers homework assistance and lesson advancement.',
  ];
  for (const a of ok) {
    assert.equal(sanitizeOllamaReply(a), a.trim(), `should NOT reject: ${a.slice(0, 50)}...`);
  }
});

// ── guardrail — every pre-existing behavior still holds ──────────────────

test('29a guardrail: existing rejections still fire', () => {
  assert.equal(sanitizeOllamaReply('As an AI language model, I cannot help with that.'), '');
  assert.equal(sanitizeOllamaReply("Let's create an imaginary scenario where Alice, Bob, Charlie, and Dana each build a feature."), '');
  assert.equal(sanitizeOllamaReply('In a recent meeting of the Bee Bright team, they discussed a hypothetical scenario.'), '');
  assert.equal(sanitizeOllamaReply('Here are some facts about the group project meeting.'), '');
});

test('29a guardrail: existing cut-marker trimming still works', () => {
  const withMarker = 'To log in, open the Login page and enter your email.\n\n[LANGUAGE INSTRUCTION] Respond in English.';
  const out = sanitizeOllamaReply(withMarker);
  assert.equal(out, 'To log in, open the Login page and enter your email.');
});

test('29a guardrail: a plain valid reply is returned unchanged', () => {
  const plain = 'Classes at Bee Bright run Monday to Saturday, 8:00 AM to 6:00 PM.';
  assert.equal(sanitizeOllamaReply(plain), plain);
});

// ── 29a.3/29a.4 — the rejection feeds the existing fallback (no new path) ─

test('29a e2e: when phi emits the meta-commentary, the user gets the canned reply', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/api/chat')) {
      return { ok: true, status: 200, json: async () => ({ message: { content: CAPTURED } }) };
    }
    return realFetch(url);
  };
  try {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(p) { this.payload = p; return this; },
    };
    // English, off-menu -> reaches phi (Task 24a/26). phi "returns" the bad string.
    await ollamaChat(
      { body: { message: 'my neighbor keeps talking about your academic tutorial classes', history: [] }, headers: {}, ip: '127.0.0.1' },
      res,
    );
    assert.equal(res.payload.success, true);
    // the meta-commentary is gone
    assert.doesNotMatch(res.payload.reply, /Here are some clues|the Assistant('s| needs| will| never)|mix up its responses/i);
    // and what's served is a short generic canned reply (any of the known fallbacks)
    assert.ok(res.payload.reply.length < 250, `expected a short canned reply, got ${res.payload.reply.length} chars`);
    assert.match(
      res.payload.reply,
      /I can help with|programs and pricing|Try asking about|not yet available in the system|clarify your topic/i,
    );
  } finally {
    global.fetch = realFetch;
  }
});

test('cleanup: close mongoose if a test opened it', async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
});
