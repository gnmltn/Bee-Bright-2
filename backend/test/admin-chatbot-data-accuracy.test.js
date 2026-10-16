/**
 * Real bugs (live-reported): the admin chatbot gave wrong/inconsistent answers for
 * enrolled-student counts, tutor lists, and revenue summaries, while the admin's own
 * dashboard (same session) showed different, correct numbers. Root causes, all in
 * aiController.js:
 *
 *  - buildAdminEnrollmentContext queried `status: 'active'`/`status: 'pending'`
 *    literally. 'active' is real but is the Enrollment model's own documented "legacy
 *    alias for approved" — the status every CURRENT approval actually writes is
 *    'approved', which this never matched. 'pending' isn't even a real enum value at
 *    all, so that count was always silently 0.
 *  - There was no 'tutors' grounded topic anywhere — "how many tutors" had nowhere
 *    real to go, so the chatbot (correctly, given it had nothing) said it had no
 *    access at all, even though the real tutor count was one query away.
 *  - There was no 'revenue' grounded topic either — Gemini was being asked to
 *    summarize revenue with ZERO real figures ever given to it, so whether it
 *    admitted that plainly or produced a vague non-answer was pure LLM-generation
 *    luck, not a real "has data" vs "has no data" toggle.
 *
 * Fixed by reusing the EXACT SAME queries dashboardController.js's getDashboardStats
 * (the real stat cards on the admin dashboard) and the existing deterministic
 * getRevenueSummaryReply already use — so the chatbot's numbers can never disagree
 * with the dashboard's, or with that already-live feature's own number, again.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const Payment = require('../models/Payment');
const { resolveGroundedContextForTopic, detectGroundedTopic, isRevenueQuestion, isAdminTutorListQuestion } = require('../controllers/aiController');

const ADMIN = { _id: 'admin-1', role: 'admin' };

function mockQuery(result) {
  const q = {
    select: () => q,
    sort: () => q,
    limit: () => q,
    populate: () => q,
    lean: () => Promise.resolve(result),
  };
  return q;
}

// ── Issue #6: enrolled-student count ────────────────────────────────────────────────

test('detectGroundedTopic: "ilan ang enrolled students" resolves to the enrollment topic for admin', () => {
  assert.equal(detectGroundedTopic(ADMIN, 'ilan ang enrolled students??'), 'enrollment');
});

test('buildAdminEnrollmentContext: counts BOTH legacy "active" AND current "approved" statuses — matching the real dashboard stat, not undercounting', async () => {
  const origCount = Enrollment.countDocuments;
  const origFind = Enrollment.find;
  const seenFilters = [];
  Enrollment.countDocuments = (filter) => { seenFilters.push(filter); return Promise.resolve(13); };
  Enrollment.find = () => mockQuery([{ student: { firstName: 'Jake', lastName: 'Porbile' }, status: 'approved', paymentStatus: 'verified' }]);
  try {
    const context = await resolveGroundedContextForTopic(ADMIN, 'ilan ang enrolled students??', 'enrollment', []);
    assert.match(context.fallbackReply, /13/, 'must reflect the real 13, matching the dashboard — not the old undercounted 3');
    // Confirm the ACTUAL query sent to Mongo includes 'approved', not just the legacy 'active'.
    const activeCountFilter = seenFilters.find((f) => f.status?.$in?.includes('approved'));
    assert.ok(activeCountFilter, 'the active-enrollment count must include status "approved"');
  } finally {
    Enrollment.countDocuments = origCount;
    Enrollment.find = origFind;
  }
});

test('buildAdminEnrollmentContext: the pending count no longer silently queries the non-existent "pending" status alone', async () => {
  const origCount = Enrollment.countDocuments;
  const origFind = Enrollment.find;
  const seenFilters = [];
  Enrollment.countDocuments = (filter) => { seenFilters.push(filter); return Promise.resolve(2); };
  Enrollment.find = () => mockQuery([]);
  try {
    await resolveGroundedContextForTopic(ADMIN, 'ilan ang pending enrollments', 'enrollment', []);
    const pendingFilter = seenFilters.find((f) => f.status?.$in?.includes('pending_approval'));
    assert.ok(pendingFilter, 'the pending count must include the REAL in-flight statuses (submitted/payment_under_verification/pending_approval), not just the fake "pending" value');
  } finally {
    Enrollment.countDocuments = origCount;
    Enrollment.find = origFind;
  }
});

// ── Issue #7: tutor list/count ──────────────────────────────────────────────────────

test('isAdminTutorListQuestion: matches "ilan naman ang tutors at sino sino sila?"', () => {
  assert.equal(isAdminTutorListQuestion('ilan naman ang tutors at sino sino sila'), true);
});

test('detectGroundedTopic: a tutor-list question resolves to the new tutors topic for admin', () => {
  assert.equal(detectGroundedTopic(ADMIN, 'ilan naman ang tutors at sino sino sila?'), 'tutors');
});

test('buildAdminTutorContext: reuses the EXACT SAME active-tutor filter as the real dashboard stat card, and returns real names (not "no access")', async () => {
  const origFind = User.find;
  const origCount = User.countDocuments;
  const seenFilters = [];
  User.countDocuments = (filter) => { seenFilters.push(filter); return Promise.resolve(3); };
  User.find = () => mockQuery([
    { firstName: 'Maria', lastName: 'Santos' },
    { firstName: 'Jose', lastName: 'Reyes' },
    { firstName: 'Ana', lastName: 'Cruz' },
  ]);
  try {
    const context = await resolveGroundedContextForTopic(ADMIN, 'ilan naman ang tutors at sino sino sila?', 'tutors', []);
    assert.match(context.fallbackReply, /3/);
    assert.match(context.fallbackReply, /Maria Santos/);
    assert.doesNotMatch(context.fallbackReply, /wala akong hawak|no access/i);
    // Matches dashboardController.js's getDashboardStats activeTutorsResult filter exactly.
    const filter = seenFilters[0];
    assert.deepEqual(filter, { role: 'tutor', isActive: true, isArchived: { $ne: true }, deletedAt: null });
  } finally {
    User.find = origFind;
    User.countDocuments = origCount;
  }
});

// ── Issue #5: revenue summary flakiness ─────────────────────────────────────────────

test('isRevenueQuestion: matches the reported Filipino phrasing', () => {
  assert.equal(isRevenueQuestion('pwede ba pa summarize yung revenue for this month october'), true);
  assert.equal(isRevenueQuestion('gusto ko malaman yung revenue ngayong buwan'), true);
});

test('detectGroundedTopic: a revenue question now resolves to a real grounded topic for admin, not null', () => {
  assert.equal(detectGroundedTopic(ADMIN, 'pwede pa summarize ng revenue'), 'revenue');
});

test('buildAdminRevenueContext: Gemini is given the REAL verified-payment total, so it never has to guess or apologize', async () => {
  const origAgg = Payment.aggregate;
  Payment.aggregate = () => Promise.resolve([{ total: 45000, count: 9 }]);
  try {
    const context = await resolveGroundedContextForTopic(ADMIN, 'gusto ko malaman yung revenue ngayong buwan', 'revenue', []);
    assert.ok(context.contextText.includes('45,000') || context.contextText.includes('45000'), 'the real total must be present in what Gemini is given, not just in the fallback');
    assert.match(context.fallbackReply, /9 verified payment/);
  } finally {
    Payment.aggregate = origAgg;
  }
});

test('buildAdminRevenueContext: zero verified payments still returns a real (zero) answer, not an empty/missing context', async () => {
  const origAgg = Payment.aggregate;
  Payment.aggregate = () => Promise.resolve([]);
  try {
    const context = await resolveGroundedContextForTopic(ADMIN, 'revenue summary please', 'revenue', []);
    assert.ok(context, 'must still return a real context, not null, even with zero payments this period');
    assert.match(context.fallbackReply, /0 verified payment/);
  } finally {
    Payment.aggregate = origAgg;
  }
});

// ── getGroundedChatContext resilience: a transient data-fetch failure must not take
// the whole chatbot response down with it (the exact shape of the reported flakiness —
// the frontend's own generic network-error text showing up, meaning the HTTP request
// itself failed, not that Gemini merely answered unhelpfully). ─────────────────────────

test('getGroundedChatContext: a thrown error from a context builder degrades to null instead of propagating and failing the whole request', async () => {
  const { getGroundedChatContext } = require('../controllers/aiController');
  const origAgg = Payment.aggregate;
  Payment.aggregate = () => { throw new Error('simulated transient Mongo error'); };
  try {
    const context = await getGroundedChatContext(ADMIN, 'revenue summary please', []);
    assert.equal(context, null, 'a grounding failure must resolve to null, not throw out of this function');
  } finally {
    Payment.aggregate = origAgg;
  }
});
