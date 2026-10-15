/**
 * The chatbot's deterministic fallback (getSecurityReply/getLoginProcessReply in
 * aiController.js) and its Gemini system prompt (ai_training/bee_bright_system.txt)
 * both told users login includes a CAPTCHA challenge. CAPTCHA was fully removed from
 * the real login flow a while back (replaced by email OTP verification, account
 * lockout, a trusted-device bypass, and a per-IP rate limiter) — the chatbot was
 * simply never updated and kept giving incorrect security information. This locks in
 * the fix for the deterministic path, for both an anonymous visitor and a logged-in
 * user (the two contexts chat()/publicChat() serve — they are the SAME function,
 * branching internally on req.user).
 *
 * Note: this only covers the deterministic fallback, which is what actually answers
 * here since Gemini is never reached under `node --test` (no live GEMINI_API_KEY in
 * this environment). The system prompt file itself was also corrected so the
 * Gemini-first path gives accurate answers too, but verifying the LLM's own generated
 * wording needs a real API key and a live manual check — flagged, not something this
 * test can cover.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const AuditLog = require('../models/AuditLog');
const geminiClient = require('../utils/geminiClient');
const { chat, publicChat } = require('../controllers/aiController');

AuditLog.create = async () => ({});

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

const TUTOR = { _id: 'tutor-1', role: 'tutor' };

async function withGeminiDisabled(fn) {
  const origReply = geminiClient.generateChatbotReply;
  geminiClient.generateChatbotReply = async () => null; // forces the deterministic fallback
  try {
    await fn();
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
}

test('publicChat (anonymous visitor): "what security measures does Bee Bright have" never mentions CAPTCHA, and correctly describes OTP/lockout/rate-limit', async () => {
  await withGeminiDisabled(async () => {
    const out = await invoke(publicChat, { message: 'What security measures does Bee Bright have?', history: [] }, null);
    assert.doesNotMatch(out.reply, /captcha/i);
    assert.match(out.reply, /otp|verification code/i);
    assert.match(out.reply, /lock/i);
    assert.match(out.reply, /rate limit/i);
  });
});

test('chat (logged-in user): the same security question never mentions CAPTCHA either', async () => {
  await withGeminiDisabled(async () => {
    const out = await invoke(chat, { message: 'What security measures does Bee Bright have?', history: [] }, TUTOR);
    assert.doesNotMatch(out.reply, /captcha/i);
    assert.match(out.reply, /otp|verification code/i);
  });
});

test('publicChat: a direct "is there a captcha" question is answered accurately, not with a stale confirmation', async () => {
  await withGeminiDisabled(async () => {
    const out = await invoke(publicChat, { message: 'Is there a captcha when I log in?', history: [] }, null);
    assert.doesNotMatch(out.reply, /captcha challenge/i);
  });
});

test('publicChat: "how do I log in" no longer tells users to complete a CAPTCHA challenge', async () => {
  await withGeminiDisabled(async () => {
    const out = await invoke(publicChat, { message: 'How do I log in?', history: [] }, null);
    assert.doesNotMatch(out.reply, /captcha/i);
  });
});
