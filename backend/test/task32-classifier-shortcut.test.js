/**
 * Task 32 Part 4 — wiring the trained intent classifier into aiController.js as an
 * additional signal alongside the existing keyword matcher (never a replacement).
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59589';

const test = require('node:test');
const assert = require('node:assert/strict');

const AuditLog = require('../models/AuditLog');
const Escalation = require('../models/Escalation');
const {
  tryClassifierShortcut,
  CLASSIFIER_INTENT_HANDLERS,
  isTicketStatusQuestion,
  getTicketStatusReply,
} = require('../controllers/aiController');

AuditLog.create = async () => ({});

function stubFetch(impl) {
  const orig = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = orig; };
}

function predictionResponse(intent, confidence) {
  return async () => ({ ok: true, json: async () => ({ success: true, intent, confidence }) });
}

function stubEscalationFind(rows) {
  const orig = Escalation.find;
  const chain = {
    select() { return chain; },
    sort() { return chain; },
    limit() { return chain; },
    lean() { return Promise.resolve(rows); },
  };
  Escalation.find = () => chain;
  return () => { Escalation.find = orig; };
}

const user = { _id: 'u-parent-1', role: 'student' };

// ── The regex-miss case the classifier is supposed to add value on ─────────────────
test('getTicketStatusReply: the keyword regex misses this real phrasing (documents the gap)', () => {
  assert.equal(isTicketStatusQuestion('is my submitted issue still waiting?'), false);
});

test('getTicketStatusReply: default behavior (no opts) is unchanged for a non-matching message', async () => {
  const restore = stubEscalationFind([]);
  try {
    const reply = await getTicketStatusReply(user, 'Is my submitted issue still waiting?', 'english');
    assert.equal(reply, null);
  } finally { restore(); }
});

test('getTicketStatusReply: skipKeywordCheck reaches the same scoped handler for that phrasing', async () => {
  const restore = stubEscalationFind([]);
  try {
    const reply = await getTicketStatusReply(user, 'Is my submitted issue still waiting?', 'english', { skipKeywordCheck: true });
    assert.match(reply, /don'?t see any support request/i);
  } finally { restore(); }
});

// ── tryClassifierShortcut ───────────────────────────────────────────────────────────
test('tryClassifierShortcut: unauthenticated -> null, service never called', async () => {
  let called = false;
  const restore = stubFetch(async () => { called = true; return { ok: true, json: async () => ({}) }; });
  try {
    const out = await tryClassifierShortcut({ user: null }, 'is my ticket resolved', []);
    assert.equal(out, null);
    assert.equal(called, false);
  } finally { restore(); }
});

test('tryClassifierShortcut: classifier unreachable -> null (falls through, pipeline unaffected)', async () => {
  const restore = stubFetch(async () => { throw new Error('ECONNREFUSED'); });
  try {
    const req = { user, body: {}, headers: {} };
    const out = await tryClassifierShortcut(req, 'is my ticket resolved', []);
    assert.equal(out, null);
  } finally { restore(); }
});

test('tryClassifierShortcut: confidence below threshold -> null', async () => {
  const restore = stubFetch(predictionResponse('resolved_ticket', 0.10));
  try {
    const req = { user, body: {}, headers: {} };
    const out = await tryClassifierShortcut(req, 'is my ticket resolved', []);
    assert.equal(out, null);
  } finally { restore(); }
});

test('tryClassifierShortcut: confident but unmapped intent -> null (only a curated subset is wired)', async () => {
  // tutor_performance is one of the 17 admin oversight intents — owner-confirmed "none
  // of these right now" (Task 34 Batch 4, 2026-09-12) — see task34-batch4-at-risk-wellbeing.test.js.
  assert.equal(CLASSIFIER_INTENT_HANDLERS.tutor_performance, undefined, 'sanity: "tutor_performance" is deliberately not wired');
  const restore = stubFetch(predictionResponse('tutor_performance', 0.95));
  try {
    const req = { user, body: {}, headers: {} };
    const out = await tryClassifierShortcut(req, 'how is this tutor performing', []);
    assert.equal(out, null);
  } finally { restore(); }
});

test('tryClassifierShortcut: raise_concern is NOT wired (Task 30\'s explicit-confirmation gate stays intact)', () => {
  assert.equal(CLASSIFIER_INTENT_HANDLERS.raise_concern, undefined);
});

test('tryClassifierShortcut: confident + mapped ticket-status intent -> calls the real, scoped handler', async () => {
  const fetchRestore = stubFetch(predictionResponse('pending_ticket', 0.81));
  const escRestore = stubEscalationFind([
    { _id: 'e1', trigger: 'billing', status: 'open', resolutionNote: '', createdAt: new Date(), handledAt: null },
  ]);
  try {
    const req = { user, body: {}, headers: {} };
    const out = await tryClassifierShortcut(req, 'Is my submitted issue still waiting?', []);
    assert.match(out, /still being reviewed/i);
  } finally { fetchRestore(); escRestore(); }
});

test('tryClassifierShortcut: mapped intent but no escalations for this user -> the real "none found" reply, not a fabricated one', async () => {
  const fetchRestore = stubFetch(predictionResponse('ticket_status', 0.9));
  const escRestore = stubEscalationFind([]);
  try {
    const req = { user, body: {}, headers: {} };
    const out = await tryClassifierShortcut(req, 'any news on my request', []);
    assert.match(out, /don'?t see any support request/i);
  } finally { fetchRestore(); escRestore(); }
});
