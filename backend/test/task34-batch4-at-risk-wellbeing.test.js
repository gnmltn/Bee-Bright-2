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
const Grade = require('../models/Grade');
const User = require('../models/User');
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

function stubFind(model, rows) {
  const orig = model.find;
  const chain = {
    populate() { return chain; }, sort() { return chain; }, limit() { return chain; },
    select() { return chain; }, lean() { return Promise.resolve(rows); },
  };
  model.find = () => chain;
  return () => { model.find = orig; };
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

// Grade.find({tutor, student}) — different (tutor,student) pairs, different grade sets.
function stubGradesByTutorStudent(gradesByKey) {
  const orig = Grade.find;
  Grade.find = (query) => {
    if (query && Object.keys(query).length === 0) {
      // getAdminAtRiskStudentsReply's Grade.find({}) — all grades, flattened.
      const all = Object.values(gradesByKey).flat();
      const chain = { select() { return chain; }, lean() { return Promise.resolve(all); } };
      return chain;
    }
    const key = `${query.tutor}:${query.student}`;
    const rows = gradesByKey[key] || [];
    const chain = { lean() { return Promise.resolve(rows); } };
    return chain;
  };
  return () => { Grade.find = orig; };
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

// ── Tutor at_risk: own-students-only, real cross-tutor leakage proof ───────────────
test('CRITICAL: buildTutorAtRiskContext never surfaces another tutor\'s student, even named explicitly', async () => {
  const restoreSched = stubScheduleByTutor({
    tutorA: [{ student: alice, students: [] }],
    tutorB: [{ student: bianca, students: [] }],
  });
  const restoreGrade = stubGradesByTutorStudent({
    'tutorA:studentA1': [{ score: 60, maxScore: 100 }],
    'tutorB:studentB1': [{ score: 40, maxScore: 100 }],
  });
  try {
    // Bianca isn't tutorA's student, so resolveNamedPerson can't resolve her — same as
    // "no name given" (this is the same collapsing behavior buildTutorStudentNotesContext
    // has). The core invariant: Bianca's 40% never appears, and only tutorA's own roster
    // (Alice) is ever surfaced — never a wrong-tutor's data.
    const ctx = await buildTutorAtRiskContext('tutorA', 'is Bianca Santos at risk?');
    assert.doesNotMatch(ctx.fallbackReply, /40%|Bianca/);
    assert.match(ctx.fallbackReply, /Alice Reyes/);
  } finally { restoreSched(); restoreGrade(); }
});

test('buildTutorAtRiskContext: own named student below threshold is correctly flagged', async () => {
  const restoreSched = stubScheduleByTutor({ tutorA: [{ student: alice, students: [] }] });
  const restoreGrade = stubGradesByTutorStudent({ 'tutorA:studentA1': [{ score: 60, maxScore: 100 }] });
  try {
    const ctx = await buildTutorAtRiskContext('tutorA', 'is Alice Reyes at risk?');
    assert.match(ctx.fallbackReply, /Alice Reyes.*60%.*below the 75% mark/);
  } finally { restoreSched(); restoreGrade(); }
});

test('buildTutorAtRiskContext: own named student above threshold is correctly NOT flagged', async () => {
  const restoreSched = stubScheduleByTutor({ tutorA: [{ student: alice, students: [] }] });
  const restoreGrade = stubGradesByTutorStudent({ 'tutorA:studentA1': [{ score: 90, maxScore: 100 }] });
  try {
    const ctx = await buildTutorAtRiskContext('tutorA', 'is Alice Reyes at risk?');
    assert.match(ctx.fallbackReply, /90%.*at or above/);
  } finally { restoreSched(); restoreGrade(); }
});

test('buildTutorAtRiskContext: no name given -> summarises only this tutor\'s own at-risk students', async () => {
  const restoreSched = stubScheduleByTutor({ tutorA: [{ student: alice, students: [] }] });
  const restoreGrade = stubGradesByTutorStudent({ 'tutorA:studentA1': [{ score: 50, maxScore: 100 }] });
  try {
    const ctx = await buildTutorAtRiskContext('tutorA', 'which of my students are at risk?');
    assert.match(ctx.fallbackReply, /Alice Reyes \(50%\)/);
  } finally { restoreSched(); restoreGrade(); }
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

// ── Admin at_risk: system-wide by design ────────────────────────────────────────────
test('getAdminAtRiskStudentsReply: admin gets a real system-wide list; non-admin denied', async () => {
  const restoreGrade = stubGradesByTutorStudent({
    'tutorA:studentA1': [{ student: 'studentA1', score: 60, maxScore: 100 }],
    'tutorB:studentB1': [{ student: 'studentB1', score: 90, maxScore: 100 }],
  });
  const restoreUsers = stubFind(User, [{ _id: 'studentA1', firstName: 'Alice', lastName: 'Reyes' }]);
  try {
    const adminReply = await getAdminAtRiskStudentsReply(admin, 'which students are at risk', 'english', { skipKeywordCheck: true });
    assert.match(adminReply, /Alice Reyes/);
    assert.doesNotMatch(adminReply, /Bianca/);

    const tutorReply = await getAdminAtRiskStudentsReply(tutorA, 'which students are at risk', 'english', { skipKeywordCheck: true });
    assert.doesNotMatch(tutorReply, /Alice Reyes/);
  } finally { restoreGrade(); restoreUsers(); }
});

test('classifier shortcut: at_risk_students / at_risk_system_wide reach the admin handler, super_admin works too', async () => {
  const restoreGrade = stubGradesByTutorStudent({});
  const superAdmin = { _id: 'sa-1', role: 'super_admin' };
  for (const intent of ['at_risk_students', 'at_risk_system_wide']) {
    const fetchRestore = stubFetch(intent, 0.9);
    try {
      const out = await tryClassifierShortcut({ user: superAdmin, body: {}, headers: {} }, 'show me at-risk students', []);
      assert.match(out, /No students are currently below/i);
    } finally { fetchRestore(); }
  }
  restoreGrade();
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
