/**
 * Task 34 — expand the Task 32 classifier shortcut with Batch 1 (static/informational
 * intents, audited per the task's own checklist: standalone, self-scoped or scoped by a
 * caller-supplied role string only, read-only, no reliance on earlier pipeline gating).
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59589';

const test = require('node:test');
const assert = require('node:assert/strict');

const AuditLog = require('../models/AuditLog');
const {
  tryClassifierShortcut,
  CLASSIFIER_INTENT_HANDLERS,
  getContextualDatasetResponse,
  getClassFormatReply,
  getAcademicSubFeatureReply,
} = require('../controllers/aiController');

AuditLog.create = async () => ({});

function stubFetch(intent, confidence) {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, intent, confidence }) });
  return () => { global.fetch = orig; };
}

const student = { _id: 'u-student-1', role: 'student' };
const parent = { _id: 'u-parent-1', role: 'parent' };
const tutor = { _id: 'u-tutor-1', role: 'tutor' };

// ── Route coverage: every Batch 1 intent is actually wired ─────────────────────────
test('Batch 1: every intent from the task brief is in the dispatch map', () => {
  const batch1 = [
    'programs_overview', 'program_comparison', 'academic_features', 'sped', 'homework_assistance',
    'payment_methods', 'gcash', 'seabank', 'bdo',
    'refund_policy', 'transfer_payment', 'payment_due',
    'playgroup_attendance', 'tutorial_attendance',
    'pre_enrollment_assessment',
    'location', 'hours', 'email',
    'track_enrollment', 'mobile_app', 'online_classes', 'onsite_only',
  ];
  for (const intent of batch1) {
    assert.ok(CLASSIFIER_INTENT_HANDLERS[intent], `${intent} should be wired`);
  }
});

// ── Each route, exercised end to end ────────────────────────────────────────────────
test('route "dataset": classifier-routed reply equals the dataset lookup used by the existing path', async () => {
  const q = 'What programs do you offer?';
  const restore = stubFetch('programs_overview', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, q, []);
    const expected = getContextualDatasetResponse(q, 'student', 'english', []);
    assert.ok(expected, 'sanity: the dataset really does answer this question');
    assert.equal(out, expected);
  } finally { restore(); }
});

test('route "dataset": role string is passed through (a tutor gets the tutor-scoped dataset pool)', async () => {
  const q = 'Can I get a refund?';
  const restore = stubFetch('refund_policy', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: tutor, body: {}, headers: {} }, q, []);
    const expected = getContextualDatasetResponse(q, 'tutor', 'english', []);
    assert.equal(out, expected);
  } finally { restore(); }
});

test('route "program_comparison": reaches getProgramComparisonReply, including a phrasing its own regex would miss', async () => {
  const restore = stubFetch('program_comparison', 0.9);
  try {
    // Deliberately awkward phrasing unlikely to trip isProgramComparisonQuestion on its own.
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'so uh which one is right for my kid', []);
    assert.match(out, /Toddlers Playgroup|Academic Tutorial|Examination Preparation/);
  } finally { restore(); }
});

test('route "class_format": online_classes AND onsite_only both reach the same static reply', async () => {
  for (const intent of ['online_classes', 'onsite_only']) {
    const restore = stubFetch(intent, 0.9);
    try {
      const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'hello', []);
      assert.equal(out, getClassFormatReply('english'));
    } finally { restore(); }
  }
});

test('route "academic_subfeature": fires for parent role, matches getAcademicSubFeatureReply', async () => {
  const restore = stubFetch('sped', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: parent, body: {}, headers: {} }, 'may sped ba kayo', []);
    assert.equal(out, getAcademicSubFeatureReply('english'));
  } finally { restore(); }
});

test('route "academic_subfeature": role gate is replicated exactly — student/tutor/admin get null (not the parent-only pitch)', async () => {
  for (const user of [student, tutor, { _id: 'a1', role: 'admin' }, { _id: 'sa1', role: 'super_admin' }]) {
    const restore = stubFetch('homework_assistance', 0.9);
    try {
      const out = await tryClassifierShortcut({ user, body: {}, headers: {} }, 'do you help with homework', []);
      assert.equal(out, null, `role ${user.role} should not get the academic-subfeature reply`);
    } finally { restore(); }
  }
});

// ── Guardrails: excluded intents must never route anywhere ─────────────────────────
test('excluded: raise_concern is never wired (Task 30 stays the only trigger path)', async () => {
  const restore = stubFetch('raise_concern', 0.95);
  try {
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'I want to raise a concern', []);
    assert.equal(out, null);
  } finally { restore(); }
});

test('excluded: safety/distress intents are never wired, even at high confidence', async () => {
  for (const intent of ['child_safety', 'safety_detection', 'crisis_support', 'crisis_hotline', 'student_distress', 'distress_detection']) {
    const restore = stubFetch(intent, 0.99);
    try {
      const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'something', []);
      assert.equal(out, null, `${intent} must not be routed by the general classifier`);
    } finally { restore(); }
  }
});

test('excluded: intents with no existing handler are still unmapped', async () => {
  // Batch 2 wired grades/progress/schedule/payment_status/materials/contact_tutor (see
  // task34-classifier-batch2.test.js). Batch 3 wired student_notes/tutor_count/etc (see
  // task34-classifier-batch3.test.js). Batch 4 wired at_risk/tutor_wellbeing_check (see
  // task34-batch4-at-risk-wellbeing.test.js). tutor_performance/audit_log are 2 of the
  // 17 admin oversight intents — owner-confirmed "none of these right now" (2026-09-12).
  for (const intent of ['tutor_performance', 'audit_log']) {
    assert.equal(CLASSIFIER_INTENT_HANDLERS[intent], undefined, `${intent} should not be wired yet`);
  }
});

// ── Fallback still holds ────────────────────────────────────────────────────────────
test('low confidence on a Batch 1 intent still falls through to null', async () => {
  const restore = stubFetch('programs_overview', 0.1);
  try {
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'what programs do you offer', []);
    assert.equal(out, null);
  } finally { restore(); }
});
