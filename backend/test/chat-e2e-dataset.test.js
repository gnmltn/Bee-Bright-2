/**
 * Task 23a — live end-to-end tests through the actual chat() / ollamaChat() Express
 * handlers, NOT unit tests on the matcher in isolation.
 *
 * The Round 5-6 keyword work sat behind an unconditional `return` and never ran for
 * real users. These tests exercise the full request path so that "wired correctly but
 * unreachable" can't regress silently.
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59599'; // force phi unreachable — must not be needed

const test = require('node:test');
const assert = require('node:assert/strict');

const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const Escalation = require('../models/Escalation');
const AIResponseDatasets = require('../ai_training/aiResponseDatasets');
const { chat, ollamaChat } = require('../controllers/aiController');

// Keep every side-effecting write out of the tests.
AuditLog.create = async () => ({});
Escalation.create = async () => ({});

const STUDENT = { _id: new mongoose.Types.ObjectId(), role: 'student' };
STUDENT.id = String(STUDENT._id);

function invoke(handler, body, user) {
  return new Promise((resolve) => {
    const req = { body, user, headers: { 'user-agent': 'test' }, ip: '127.0.0.1' };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, ...payload }); return this; },
    };
    handler(req, res);
  });
}

// ── The exact Q&A entry the tests assert against ──────────────────────────
const S002 = AIResponseDatasets.studentQueries.find((q) => q.id === 'S002');

test('sanity: the dataset still contains the entry these tests rely on', () => {
  assert.ok(S002, 'studentQueries S002 (login page) must exist');
  assert.match(S002.expectedReply.en, /\/login/);
});

test('chat(): a dataset Q&A entry is actually returned (23a — matcher is reachable)', async () => {
  const out = await invoke(chat, { message: 'where is the login page', history: [] }, STUDENT);
  assert.equal(out.success, true);
  assert.equal(out.reply, S002.expectedReply.en);
});

test('chat(): Task 20 — filler ("can you pls help me") does not drown the topic word', async () => {
  const out = await invoke(
    chat,
    { message: 'can you pls help me where do i see announcements', history: [] },
    STUDENT,
  );
  assert.equal(out.success, true);
  assert.match(out.reply, /announcements section/i);
});

test('chat(): pure filler still resolves to no dataset match (no false positive)', async () => {
  const out = await invoke(chat, { message: 'hello po can you help me please', history: [] }, STUDENT);
  assert.equal(out.success, true);
  // Should be a greeting / generic reply, never a random dataset answer about login etc.
  assert.doesNotMatch(out.reply, /\/login/);
});

test('chat(): Task 21 — vague follow-up resolves against the prior concrete message', async () => {
  const history = [
    { role: 'user', content: 'where is the login page' },
    { role: 'assistant', content: S002.expectedReply.en },
  ];
  const out = await invoke(chat, { message: 'pakiulit nga dyan', history }, STUDENT);
  assert.equal(out.success, true);
  assert.equal(out.reply, S002.expectedReply.en); // same topic as turn 1
});

test('ollamaChat(): English deterministic path also reaches the dataset matcher (no phi)', async () => {
  const out = await invoke(ollamaChat, { message: 'where is the login page', history: [] }, STUDENT);
  assert.equal(out.success, true);
  assert.equal(out.reply, S002.expectedReply.en);
});

test('ollamaChat(): rejects an empty message without calling phi', async () => {
  const out = await invoke(ollamaChat, { message: '   ', history: [] }, STUDENT);
  assert.equal(out.status, 400);
});

// ── Task 23b — no stale program data in dataset replies ───────────────────

test('23b: the V001 dataset entry no longer lists the retired 6-program catalog', () => {
  const v001 = AIResponseDatasets.visitorQueries.find((q) => q.id === 'V001');
  for (const lang of ['en', 'fil', 'tgl']) {
    assert.doesNotMatch(v001.expectedReply[lang], /Pre-Kindergarten|Kindergarten Readiness|SPED/i, lang);
    assert.match(v001.expectedReply[lang], /Toddlers Playgroup/);
    assert.match(v001.expectedReply[lang], /Academic Tutorial/);
    assert.match(v001.expectedReply[lang], /Examination Preparation/);
  }
});

test('23b: no dataset entry anywhere references a retired program', () => {
  const all = [
    ...AIResponseDatasets.studentQueries,
    ...AIResponseDatasets.tutorQueries,
    ...AIResponseDatasets.adminQueries,
    ...AIResponseDatasets.visitorQueries,
    ...AIResponseDatasets.navigationQueries,
    ...AIResponseDatasets.contextAwareFollowUps,
  ];
  for (const item of all) {
    for (const lang of ['en', 'fil', 'tgl']) {
      const reply = item.expectedReply?.[lang] || '';
      assert.doesNotMatch(reply, /SPED Tutorial|Pre-Kindergarten Readiness|Kindergarten Readiness Program/i,
        `${item.id} (${lang})`);
    }
  }
  for (const rule of AIResponseDatasets.intentKeywordRules) {
    for (const lang of ['en', 'fil']) {
      assert.doesNotMatch(rule.replies?.[lang] || '', /SPED Tutorial|Pre-Kindergarten Readiness/i, rule.intent);
    }
  }
});
