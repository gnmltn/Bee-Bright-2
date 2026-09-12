/**
 * Task 34 — Batch 3: tutor own-student-scoped + admin system-wide intents. The highest
 * scoping-complexity batch, so this file gives extra weight to the two failure modes the
 * brief calls out specifically: (a) a tutor's query must NEVER surface another tutor's
 * student's data, even when a student is named explicitly in the message, and (b) audit
 * logging must fire for classifier-routed admin oversight replies exactly as it does for
 * every other classifier route.
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59589';

const test = require('node:test');
const assert = require('node:assert/strict');

const AuditLog = require('../models/AuditLog');
const Schedule = require('../models/Schedule');
const Grade = require('../models/Grade');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const {
  tryClassifierShortcut,
  CLASSIFIER_INTENT_HANDLERS,
  buildTutorStudentNotesContext,
  getTutorCountReply,
  getStudentCountReply,
  getEnrollmentStatisticsReply,
  getAttendanceReply,
  getOutOfScopeMetricsReply,
} = require('../controllers/aiController');

// Default no-op — individual tests that need to assert on audit calls use
// captureAuditLog() instead, which swaps this out and restores it afterward.
AuditLog.create = async () => ({});

function stubFetch(intent, confidence) {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, intent, confidence }) });
  return () => { global.fetch = orig; };
}

function stubFind(model, rows) {
  const orig = model.find;
  const chain = {
    populate() { return chain; }, sort() { return chain; }, limit() { return chain; },
    select() { return chain; }, lean() { return Promise.resolve(rows); },
  };
  model.find = () => chain;
  return () => { model.find = orig; };
}

// getStudentCountReply/getTutorCountReply/getEnrollmentStatisticsReply use
// countDocuments(query), not find() — stub returns a fixed count for every call
// (sufficient to prove routing/structure; exact aggregate math isn't the concern here).
function stubCountDocuments(model, count) {
  const orig = model.countDocuments;
  model.countDocuments = () => Promise.resolve(count);
  return () => { model.countDocuments = orig; };
}

function captureAuditLog() {
  const orig = AuditLog.create;
  const calls = [];
  AuditLog.create = async (doc) => { calls.push(doc); return doc; };
  return { calls, restore: () => { AuditLog.create = orig; } };
}

const tutorA = { _id: 'tutorA', role: 'tutor' };
const tutorB = { _id: 'tutorB', role: 'tutor' };
const student = { _id: 'u-student-1', role: 'student' };
const parent = { _id: 'u-parent-1', role: 'parent' };
const admin = { _id: 'u-admin-1', role: 'admin' };
const superAdmin = { _id: 'u-sa-1', role: 'super_admin' };

const aliceReyes = { _id: 'studentA1', firstName: 'Alice', lastName: 'Reyes' };
const biancaSantos = { _id: 'studentB1', firstName: 'Bianca', lastName: 'Santos' };

// Schedule.find({$or:[{tutor:tutorId},{tutors:tutorId}]}) — respects the query so the
// two tutors genuinely see different student lists, not the same stubbed array.
function stubScheduleByTutor() {
  const orig = Schedule.find;
  Schedule.find = (query) => {
    const tutorId = query?.$or?.[0]?.tutor;
    const rows = tutorId === 'tutorA'
      ? [{ student: aliceReyes, students: [] }]
      : tutorId === 'tutorB'
        ? [{ student: biancaSantos, students: [] }]
        : [];
    const chain = { populate() { return chain; }, lean() { return Promise.resolve(rows); } };
    return chain;
  };
  return () => { Schedule.find = orig; };
}

// ── Route coverage ──────────────────────────────────────────────────────────────────
test('Batch 3: every wired intent from the task brief is in the dispatch map', () => {
  const batch3Wired = [
    'student_notes', 'notes_digest', 'student_remarks', 'student_progress',
    'attendance_history', 'student_attendance',
    'tutor_count', 'student_count', 'enrollment_count',
    'aggregate_analytics', 'analytics_bug', 'analytics_accuracy',
  ];
  for (const intent of batch3Wired) {
    assert.ok(CLASSIFIER_INTENT_HANDLERS[intent], `${intent} should be wired`);
  }
});

// ── The core anti-leakage guarantee ─────────────────────────────────────────────────
test('CRITICAL: a tutor asking by name about another tutor\'s student never gets that student\'s data', async () => {
  const restoreSched = stubScheduleByTutor();
  const fetchRestore = stubFetch('student_notes', 0.9);
  try {
    // tutorA asks about Bianca Santos, who is tutorB's student, not tutorA's.
    const out = await tryClassifierShortcut({ user: tutorA, body: {}, headers: {} }, 'give me notes on Bianca Santos', []);
    assert.doesNotMatch(out, /Bianca/);
    assert.match(out, /which student/i);
    assert.match(out, /Alice Reyes/); // only tutorA's real roster is offered
  } finally { restoreSched(); fetchRestore(); }
});

test('CRITICAL: the same check holds in reverse (tutorB asking about tutorA\'s student)', async () => {
  const restoreSched = stubScheduleByTutor();
  const fetchRestore = stubFetch('notes_digest', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: tutorB, body: {}, headers: {} }, 'notes on Alice Reyes please', []);
    assert.doesNotMatch(out, /Alice/);
    assert.match(out, /which student/i);
    assert.match(out, /Bianca Santos/);
  } finally { restoreSched(); fetchRestore(); }
});

test('route "grounded_student_notes": a tutor asking about their OWN student gets that student\'s real grade digest', async () => {
  const restoreSched = stubScheduleByTutor();
  const restoreGrade = stubFind(Grade, [
    { programCategory: 'Academic Tutorial', subjectItem: 'Reading', score: 91, maxScore: 100, period: 'Q1 2026', remarks: 'Great improvement' },
  ]);
  const fetchRestore = stubFetch('student_notes', 0.9);
  try {
    const message = 'give me notes on Alice Reyes';
    const out = await tryClassifierShortcut({ user: tutorA, body: {}, headers: {} }, message, []);
    assert.match(out, /Alice Reyes/);
    assert.match(out, /Reading/);
    assert.match(out, /91%/);
  } finally { restoreSched(); restoreGrade(); fetchRestore(); }
});

test('route "grounded_student_notes": non-tutor roles get null (grounded pipeline unaffected)', async () => {
  for (const user of [student, parent, admin]) {
    const fetchRestore = stubFetch('student_progress', 0.9);
    try {
      const out = await tryClassifierShortcut({ user, body: {}, headers: {} }, 'notes on Alice Reyes', []);
      assert.equal(out, null, `role ${user.role} should not reach the tutor notes digest`);
    } finally { fetchRestore(); }
  }
});

// ── route "tutor_attendance_static" (attendance_history, student_attendance) ───────
test('route "tutor_attendance_static": no DB access, matches getAttendanceReply exactly', async () => {
  for (const intent of ['attendance_history', 'student_attendance']) {
    const fetchRestore = stubFetch(intent, 0.9);
    try {
      const out = await tryClassifierShortcut({ user: tutorA, body: {}, headers: {} }, 'attendance history for my student', []);
      assert.equal(out, getAttendanceReply('english'));
    } finally { fetchRestore(); }
  }
});

// ── route "admin_count" (tutor_count, student_count, enrollment_count) ─────────────
test('route "admin_count": dispatches to the correct handler per predicted intent, matches direct call', async () => {
  const restoreCounts = stubCountDocuments(User, 2);
  const fetchRestore = stubFetch('tutor_count', 0.9);
  try {
    const message = 'how many tutors do we have';
    const out = await tryClassifierShortcut({ user: admin, body: {}, headers: {} }, message, []);
    const direct = await getTutorCountReply(admin, message, 'english', { skipKeywordCheck: true });
    assert.equal(out, direct);
    assert.match(out, /2 tutors/);
  } finally { restoreCounts(); fetchRestore(); }
});

test('route "admin_count": student_count and enrollment_count also dispatch correctly', async () => {
  const restoreEnr = stubCountDocuments(Enrollment, 5);
  let fetchRestore = stubFetch('student_count', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: admin, body: {}, headers: {} }, 'total enrolled students', []);
    assert.match(out, /enrolled student/i);
  } finally { fetchRestore(); }

  fetchRestore = stubFetch('enrollment_count', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: admin, body: {}, headers: {} }, 'enrollment statistics please', []);
    assert.match(out, /Enrollment Statistics/i);
  } finally { fetchRestore(); restoreEnr(); }
});

test('route "admin_count": non-admin roles are denied, same as the existing keyword-matcher path', async () => {
  const restoreCounts = stubCountDocuments(User, 99);
  try {
    for (const user of [tutorA, student, parent]) {
      const fetchRestore = stubFetch('tutor_count', 0.9);
      try {
        const out = await tryClassifierShortcut({ user, body: {}, headers: {} }, 'how many tutors', []);
        assert.doesNotMatch(String(out), /\d+ tutors/); // never a real number for a non-admin
      } finally { fetchRestore(); }
    }
  } finally { restoreCounts(); }
});

test('route "admin_count": super_admin works identically to admin', async () => {
  const restoreCounts = stubCountDocuments(User, 1);
  const fetchRestore = stubFetch('tutor_count', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: superAdmin, body: {}, headers: {} }, 'how many tutors do we have', []);
    assert.match(out, /1 tutor/i);
  } finally { restoreCounts(); fetchRestore(); }
});

test('route "admin_count": audit logging fires for the classifier-routed admin reply, same as any other classifier route', async () => {
  const restoreCounts = stubCountDocuments(User, 1);
  const { calls, restore } = captureAuditLog();
  const fetchRestore = stubFetch('tutor_count', 0.9);
  try {
    await tryClassifierShortcut({ user: admin, body: {}, headers: {} }, 'how many tutors do we have', []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].metadata.groundingPath, 'classifier');
  } finally { restoreCounts(); restore(); fetchRestore(); }
});

// ── route "out_of_scope_metrics" ────────────────────────────────────────────────────
test('route "out_of_scope_metrics": deliberate refusal, matches getOutOfScopeMetricsReply, works for every role', async () => {
  for (const [intent, user] of [['aggregate_analytics', admin], ['analytics_bug', tutorA], ['analytics_accuracy', student]]) {
    const fetchRestore = stubFetch(intent, 0.9);
    try {
      const out = await tryClassifierShortcut({ user, body: {}, headers: {} }, 'how accurate is the AI model', []);
      assert.equal(out, getOutOfScopeMetricsReply('english'));
    } finally { fetchRestore(); }
  }
});

// ── Guardrails: excluded intents stay unmapped ──────────────────────────────────────
// student_privacy/at_risk/at_risk_details/at_risk_other were all wired in Batch 4
// (owner-confirmed 2026-09-12) — see task34-batch4-at-risk-wellbeing.test.js. mark_attendance
// remains excluded (write action).
test('excluded: mark_attendance stays unmapped (write action)', () => {
  assert.equal(CLASSIFIER_INTENT_HANDLERS.mark_attendance, undefined, 'mark_attendance should not be wired (write action)');
});

test('excluded + flagged: distress/discussion intents stay on Task 3\'s dedicated path only', () => {
  for (const intent of ['student_distress', 'distress_detection', 'student_discussion', 'child_safety', 'safety_detection', 'crisis_support', 'crisis_hotline', 'student_safety']) {
    assert.equal(CLASSIFIER_INTENT_HANDLERS[intent], undefined, `${intent} must never be routed by the general classifier`);
  }
});

test('excluded: admin oversight intents owner-confirmed "none of these right now" stay unmapped', () => {
  // at_risk_students/at_risk_system_wide were wired in Batch 4 (owner-confirmed
  // dual-scoping) — see task34-batch4-at-risk-wellbeing.test.js. The rest are the 17
  // admin oversight intents the owner explicitly deprioritized (2026-09-12).
  const noHandlerYet = [
    'escalation_dashboard', 'notification_bell', 'requester_information', 'requester_name',
    'requester_email', 'escalation_status', 'remarks_oversight', 'ratings_oversight',
    'system_wide_remarks', 'audit_log', 'remarks_history',
    'tutor_performance', 'tutor_oversight', 'tutor_complaints',
    'complaint_management', 'tutor_ratings',
  ];
  for (const intent of noHandlerYet) {
    assert.equal(CLASSIFIER_INTENT_HANDLERS[intent], undefined, `${intent} should not be wired yet — no existing handler`);
  }
});

test('excluded: raise_concern still unmapped (unchanged from original Task 34 scope)', () => {
  assert.equal(CLASSIFIER_INTENT_HANDLERS.raise_concern, undefined);
});

// ── Fallback still holds ────────────────────────────────────────────────────────────
test('low confidence on a Batch 3 intent still falls through to null', async () => {
  const restoreSched = stubScheduleByTutor();
  const fetchRestore = stubFetch('student_notes', 0.1);
  try {
    const out = await tryClassifierShortcut({ user: tutorA, body: {}, headers: {} }, 'give me notes on Alice Reyes', []);
    assert.equal(out, null);
  } finally { restoreSched(); fetchRestore(); }
});
