/**
 * Task 34 Batch 4 (owner-confirmed 2026-09-12): at_risk (tutor own-students + admin
 * system-wide, dual-scoping like student_notes/the count intents) and a NEW, separately-
 * named tutor_wellbeing_check intent that never assesses a child's emotional state —
 * only redirects to the human-reviewed raise-a-concern flow. student_distress /
 * distress_detection / student_discussion remain completely untouched and unmapped.
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59589';

const test = require('node:test');
const assert = require('node:assert/strict');

const AuditLog = require('../models/AuditLog');
const Schedule = require('../models/Schedule');
const {
  tryClassifierShortcut,
  CLASSIFIER_INTENT_HANDLERS,
  buildTutorAtRiskContext,
  getTutorScopeDenialReply,
  getAdminAtRiskStudentsReply,
  buildTutorWellbeingCheckContext,
  resolveGroundedContextForTopic,
} = require('../controllers/aiController');

AuditLog.create = async () => ({});

function stubFetch(intent, confidence) {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, intent, confidence }) });
  return () => { global.fetch = orig; };
}

// Schedule.find({$or:[{tutor:tutorId},{tutors:tutorId}]}) — different tutors, different rosters.
function stubScheduleByTutor(rosterByTutor) {
  const orig = Schedule.find;
  Schedule.find = (query) => {
    const tutorId = query?.$or?.[0]?.tutor;
    const rows = rosterByTutor[tutorId] || [];
    const chain = { populate() { return chain; }, lean() { return Promise.resolve(rows); } };
    return chain;
  };
  return () => { Schedule.find = orig; };
}

const tutorA = { _id: 'tutorA', role: 'tutor' };
const tutorB = { _id: 'tutorB', role: 'tutor' };
const admin = { _id: 'admin-1', role: 'admin' };
const student = { _id: 'stu-1', role: 'student' };

const alice = { _id: 'studentA1', firstName: 'Alice', lastName: 'Reyes' };
const bianca = { _id: 'studentB1', firstName: 'Bianca', lastName: 'Santos' };

// ── Route coverage ──────────────────────────────────────────────────────────────────
test('Batch 4: every wired intent is in the dispatch map, distress family stays out', () => {
  const wired = ['at_risk', 'at_risk_details', 'student_privacy', 'at_risk_other', 'at_risk_students', 'at_risk_system_wide', 'tutor_wellbeing_check'];
  for (const intent of wired) {
    assert.ok(CLASSIFIER_INTENT_HANDLERS[intent], `${intent} should be wired`);
  }
  for (const intent of ['student_distress', 'distress_detection', 'student_discussion', 'mark_attendance']) {
    assert.equal(CLASSIFIER_INTENT_HANDLERS[intent], undefined, `${intent} must stay unmapped`);
  }
});

// ── Tutor at_risk: grades were fully retired in favor of Student Remarks
// (2026-09-30) — there is no numeric data source left to flag anyone from, so
// buildTutorAtRiskContext now always gives the honest "no data" answer. These tests
// confirm that degradation is graceful (no crash, no leaked cross-tutor names) rather
// than testing threshold logic that no longer exists.
test('CRITICAL: buildTutorAtRiskContext never surfaces another tutor\'s student, even named explicitly', async () => {
  const restoreSched = stubScheduleByTutor({
    tutorA: [{ student: alice, students: [] }],
    tutorB: [{ student: bianca, students: [] }],
  });
  try {
    // Bianca isn't tutorA's student, so resolveNamedPerson can't resolve her — falls
    // through to the generic "no data" reply. The core invariant: Bianca's name never
    // appears in tutorA's reply.
    const ctx = await buildTutorAtRiskContext('tutorA', 'is Bianca Santos at risk?');
    assert.doesNotMatch(ctx.fallbackReply, /Bianca/);
    assert.match(ctx.fallbackReply, /no longer tracked|data-based way/i);
  } finally { restoreSched(); }
});

test('buildTutorAtRiskContext: own named student gets the honest "grades not tracked" answer', async () => {
  const restoreSched = stubScheduleByTutor({ tutorA: [{ student: alice, students: [] }] });
  try {
    const ctx = await buildTutorAtRiskContext('tutorA', 'is Alice Reyes at risk?');
    assert.match(ctx.fallbackReply, /Alice Reyes/);
    assert.match(ctx.fallbackReply, /no longer tracked|data-based way/i);
  } finally { restoreSched(); }
});

test('buildTutorAtRiskContext: no name given -> honest "no data" answer, no crash', async () => {
  const restoreSched = stubScheduleByTutor({ tutorA: [{ student: alice, students: [] }] });
  try {
    const ctx = await buildTutorAtRiskContext('tutorA', 'which of my students are at risk?');
    assert.match(ctx.fallbackReply, /no longer tracked|data-based way/i);
  } finally { restoreSched(); }
});

// ── Explicit denial: student_privacy / at_risk_other ────────────────────────────────
test('getTutorScopeDenialReply: static, no DB access, denies cross-tutor/system-wide access', () => {
  const reply = getTutorScopeDenialReply('english');
  assert.match(reply, /only view students assigned to you/i);
  assert.match(reply, /not another tutor|not a system-wide/i);
});

test('classifier shortcut: student_privacy and at_risk_other both reach the denial, not real data', async () => {
  for (const intent of ['student_privacy', 'at_risk_other']) {
    const fetchRestore = stubFetch(intent, 0.9);
    try {
      const out = await tryClassifierShortcut({ user: tutorA, body: {}, headers: {} }, 'can I see another tutor\'s at-risk students', []);
      assert.equal(out, getTutorScopeDenialReply('english'));
    } finally { fetchRestore(); }
  }
});

// ── Admin at_risk: grades retired 2026-09-30 — always the honest "no data" answer,
// role-gate (admin-only) still enforced ─────────────────────────────────────────────
test('getAdminAtRiskStudentsReply: admin gets the honest "no data" answer; non-admin/tutor denied', async () => {
  const adminReply = await getAdminAtRiskStudentsReply(admin, 'which students are at risk', 'english', { skipKeywordCheck: true });
  assert.match(adminReply, /no longer tracked|data-based way/i);

  const tutorReply = await getAdminAtRiskStudentsReply(tutorA, 'which students are at risk', 'english', { skipKeywordCheck: true });
  assert.match(tutorReply, /not yet available in the system/i);
});

test('classifier shortcut: at_risk_students / at_risk_system_wide reach the admin handler, super_admin works too', async () => {
  const superAdmin = { _id: 'sa-1', role: 'super_admin' };
  for (const intent of ['at_risk_students', 'at_risk_system_wide']) {
    const fetchRestore = stubFetch(intent, 0.9);
    try {
      const out = await tryClassifierShortcut({ user: superAdmin, body: {}, headers: {} }, 'show me at-risk students', []);
      assert.match(out, /no longer tracked|data-based way/i);
    } finally { fetchRestore(); }
  }
});

// ── Wellbeing check: never assesses, always redirects to a human ───────────────────
test('buildTutorWellbeingCheckContext: never fabricates an assessment, always redirects to raise-a-concern', async () => {
  const restoreSched = stubScheduleByTutor({ tutorA: [{ student: alice, students: [] }] });
  try {
    const ctx = await buildTutorWellbeingCheckContext('tutorA', 'is Alice Reyes okay emotionally?');
    assert.match(ctx.fallbackReply, /does not automatically track or assess/i);
    assert.match(ctx.fallbackReply, /raise a concern/i);
    assert.doesNotMatch(ctx.fallbackReply, /she (is|seems)|appears (fine|distressed|okay)/i); // no fabricated judgment
  } finally { restoreSched(); }
});

test('buildTutorWellbeingCheckContext: cross-tutor named student -> no leak, offers own roster instead', async () => {
  const restoreSched = stubScheduleByTutor({ tutorA: [{ student: alice, students: [] }] });
  try {
    const ctx = await buildTutorWellbeingCheckContext('tutorA', 'is Bianca Santos showing behavioral concerns?');
    assert.doesNotMatch(ctx.fallbackReply, /Bianca/);
    assert.match(ctx.fallbackReply, /Alice Reyes/);
  } finally { restoreSched(); }
});

test('classifier shortcut: tutor_wellbeing_check reaches the safe redirect, matches direct call', async () => {
  const restoreSched = stubScheduleByTutor({ tutorA: [{ student: alice, students: [] }] });
  const fetchRestore = stubFetch('tutor_wellbeing_check', 0.9);
  try {
    const message = 'is Alice Reyes doing okay emotionally lately?';
    const out = await tryClassifierShortcut({ user: tutorA, body: {}, headers: {} }, message, []);
    const direct = await resolveGroundedContextForTopic(tutorA, message, 'wellbeing_check');
    assert.equal(out, direct.fallbackReply);
  } finally { restoreSched(); fetchRestore(); }
});

// ── Guardrail: this classifier never touches Task 3's safety-screening intents ─────
test('guardrail: student_distress / distress_detection / student_discussion remain completely unmapped', async () => {
  for (const intent of ['student_distress', 'distress_detection', 'student_discussion', 'child_safety', 'safety_detection', 'crisis_support', 'crisis_hotline', 'student_safety']) {
    const fetchRestore = stubFetch(intent, 0.99);
    try {
      const out = await tryClassifierShortcut({ user: tutorA, body: {}, headers: {} }, 'something', []);
      assert.equal(out, null, `${intent} must never be routed by the general classifier`);
    } finally { fetchRestore(); }
  }
});

// ── Non-tutor / non-admin roles get null (pipeline unaffected) ─────────────────────
test('grounded_at_risk and grounded_wellbeing_check: non-tutor roles get null', async () => {
  for (const [intent, message] of [['at_risk', 'which students are at risk'], ['tutor_wellbeing_check', 'is my student okay']]) {
    const fetchRestore = stubFetch(intent, 0.9);
    try {
      const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, message, []);
      assert.equal(out, null);
    } finally { fetchRestore(); }
  }
});
