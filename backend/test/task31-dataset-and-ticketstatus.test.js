/**
 * Dataset coverage additions (V004 fix, V006 refund, V011 payment due, V012 assessment,
 * V013 attendance) + Task 31 live support-request status lookup.
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59589';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const EscalationRealExport = require('../models/Escalation');
const D = require('../ai_training/aiResponseDatasets');
const {
  chat,
  isTicketStatusQuestion,
  getTicketStatusReply,
  findDatasetMatch,
} = require('../controllers/aiController');

AuditLog.create = async () => ({});

function ask(message, user = null) {
  return new Promise((resolve) => {
    const res = { status() { return res; }, json(p) { resolve(p.reply); return res; } };
    chat({ body: { message, history: [] }, user, headers: {}, ip: '127.0.0.1' }, res);
  });
}

// chainable Escalation.find(...).select(...).sort(...).limit(...).lean() stub
function stubEscalationFind(rows) {
  const chain = {
    _query: null,
    select() { return chain; },
    sort() { return chain; },
    limit() { return chain; },
    lean() { return Promise.resolve(rows); },
  };
  const orig = EscalationRealExport.find;
  EscalationRealExport.find = (q) => { chain._query = q; return chain; };
  return { chain, restore: () => { EscalationRealExport.find = orig; } };
}

// ── dataset entries ──────────────────────────────────────────────────────

test('new visitor entries exist with the right ids/topics and are trilingual', () => {
  const byId = Object.fromEntries(D.visitorQueries.map((v) => [v.id, v]));
  for (const id of ['V006', 'V011', 'V012', 'V013']) {
    assert.ok(byId[id], `${id} missing`);
    for (const lang of ['en', 'fil', 'tgl']) {
      assert.ok(byId[id].queries[lang] && byId[id].expectedReply[lang], `${id}.${lang}`);
    }
  }
  assert.equal(byId.V006.topic, 'refund_policy');
  assert.equal(byId.V011.topic, 'payment_due_date');
  assert.equal(byId.V012.topic, 'assessment');
  assert.equal(byId.V013.topic, 'attendance_policy');
});

test('new entries contain no invented amounts / counts / retired program names', () => {
  for (const id of ['V004', 'V006', 'V011', 'V012', 'V013']) {
    const e = D.visitorQueries.find((v) => v.id === id);
    for (const lang of ['en', 'fil', 'tgl']) {
      const t = e.expectedReply[lang];
      assert.doesNotMatch(t, /₱|PHP ?\d|\bpre-?kindergarten readiness\b|\bsped tutorial\b|\bkindergarten readiness program\b/i, `${id}.${lang}`);
      // "50%" and "2 absences" / "3rd" are real policy wording, not per-user data — allowed.
    }
  }
});

test('V006 states the real policy: non-refundable but transferable', () => {
  const v6 = D.visitorQueries.find((v) => v.id === 'V006').expectedReply.en;
  assert.match(v6, /non-refundable/i);
  assert.match(v6, /transfer/i);
});

test('V004 now gives the real contact channels', () => {
  const v4 = D.visitorQueries.find((v) => v.id === 'V004').expectedReply.en;
  assert.match(v4, /beebrightph@gmail\.com/);
  assert.match(v4, /Barangay Pantal/);
});

test('e2e: a public refund-policy question now hits V006 (was the clarification fallback)', async () => {
  const reply = await ask('what is your refund policy if we cancel');
  assert.match(reply, /non-refundable/i);
  assert.match(reply, /transfer/i);
  assert.doesNotMatch(reply, /clarify your topic/i);
});

test('findDatasetMatch resolves the new policy questions — for visitor AND student pools', () => {
  // visitorQueries are now merged into every role's search pool (role-agnostic public info)
  for (const role of ['visitor', 'student', 'tutor']) {
    assert.equal(findDatasetMatch('when is my payment due', role)?.id, 'V011', role);
    assert.equal(findDatasetMatch('what is the pre-enrollment assessment for', role)?.id, 'V012', role);
    assert.equal(findDatasetMatch('what is your attendance policy for missed sessions', role)?.id, 'V013', role);
    assert.equal(findDatasetMatch('what is your refund policy if we cancel', role)?.id, 'V006', role);
  }
});

test('e2e: an anonymous refund-policy question is answered from V006, not the login wall', async () => {
  // "refund policy" has no "my"/account phrasing, so it clears the Task 9 anon guard and
  // reaches the (now role-agnostic) visitor pool.
  const reply = await ask('do you give refunds if we back out');
  assert.doesNotMatch(reply, /please log in|clarify your topic/i);
});

// ── Task 31 — isTicketStatusQuestion ─────────────────────────────────────

test('31: isTicketStatusQuestion recognises support-request status questions', () => {
  for (const m of [
    "what's the status of my request",
    'any update on my ticket',
    'na-resolve na ba yung concern ko',
    'was my complaint resolved',
    'did anyone follow up on my request',
    'kumusta na yung request ko sa admin',
  ]) {
    assert.equal(isTicketStatusQuestion(m.toLowerCase()), true, m);
  }
});

test('31 NEGATIVE: payment/enrollment/grade status questions are not ticket-status', () => {
  for (const m of [
    'what is my payment status',
    'what is my enrollment status',
    'when will my grades be updated',
    'i want to file a complaint',
    'how do i submit a request',
  ]) {
    assert.equal(isTicketStatusQuestion(m.toLowerCase()), false, m);
  }
});

// ── Task 31 — getTicketStatusReply ──────────────────────────────────────

const USER = { _id: new mongoose.Types.ObjectId(), role: 'parent' };

test('31: not logged in => asks the user to log in, no DB hit', async () => {
  const r = await getTicketStatusReply(null, "what's the status of my request", 'english');
  assert.match(r, /log in/i);
});

test('31: no requests on record => says so and offers the handoff', async () => {
  const s = stubEscalationFind([]);
  try {
    const r = await getTicketStatusReply(USER, 'any update on my ticket', 'english');
    assert.match(r, /don't see any support request/i);
    assert.deepEqual(s.chain._query, { user: USER._id, source: 'handoff' }); // scoped to own handoff tickets
  } finally { s.restore(); }
});

test('31: one OPEN request => "still being reviewed, please be patient"', async () => {
  const s = stubEscalationFind([{ status: 'open', createdAt: new Date('2026-09-01'), resolutionNote: '' }]);
  try {
    const r = await getTicketStatusReply(USER, "what's the status of my request", 'english');
    assert.match(r, /still being reviewed/i);
    assert.match(r, /be patient/i);
    assert.match(r, /Sep 1, 2026/);
  } finally { s.restore(); }
});

test('31: one RESOLVED request => says resolved and surfaces the resolution note', async () => {
  const s = stubEscalationFind([{ status: 'resolved', createdAt: new Date('2026-08-20'), resolutionNote: 'Refund transfer arranged with admin.' }]);
  try {
    const r = await getTicketStatusReply(USER, 'na-resolve na ba yung concern ko', 'english');
    assert.match(r, /has been resolved/i);
    assert.match(r, /Refund transfer arranged with admin\./);
  } finally { s.restore(); }
});

test('31: multiple requests => summary of open vs resolved', async () => {
  const s = stubEscalationFind([
    { status: 'open', createdAt: new Date('2026-09-05'), resolutionNote: '' },
    { status: 'acknowledged', createdAt: new Date('2026-09-02'), resolutionNote: '' },
    { status: 'resolved', createdAt: new Date('2026-08-01'), resolutionNote: 'Done.' },
  ]);
  try {
    const r = await getTicketStatusReply(USER, 'any update on my requests', 'english');
    assert.match(r, /3 support requests/);
    assert.match(r, /2 still being reviewed/);
    assert.match(r, /1 resolved/);
    assert.match(r, /Sep 5, 2026/); // most recent open
  } finally { s.restore(); }
});

test('cleanup: close mongoose if opened', async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
});
