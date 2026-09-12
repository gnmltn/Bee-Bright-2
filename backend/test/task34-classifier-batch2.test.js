/**
 * Task 34 — Batch 2: account-scoped, read-only intents (grades/progress, schedule,
 * enrollment status, payment status, materials, contact_tutor — plus their parent_*
 * counterparts). Same audit standard as Batch 1: every route below reaches a handler
 * that already scopes itself strictly to req.user's own account (or, for a parent,
 * their own linked children), is read-only, and does not rely on any earlier pipeline
 * gating for its safety — only for deciding whether to fire at all.
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59589';

const test = require('node:test');
const assert = require('node:assert/strict');

const AuditLog = require('../models/AuditLog');
const Grade = require('../models/Grade');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const {
  tryClassifierShortcut,
  CLASSIFIER_INTENT_HANDLERS,
  getStudentGradesReply,
  getTutorContactReply,
  getMaterialsReplyByRole,
  resolveGroundedContextForTopic,
} = require('../controllers/aiController');

AuditLog.create = async () => ({});

function stubFetch(intent, confidence) {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, intent, confidence }) });
  return () => { global.fetch = orig; };
}

// Mirrors the chainable Mongoose .find(...) API (see test/parent-grounded-chat.test.js).
function stubFind(model, rows) {
  const orig = model.find;
  const chain = {
    populate() { return chain; }, sort() { return chain; }, limit() { return chain; },
    select() { return chain; }, lean() { return Promise.resolve(rows); },
  };
  model.find = () => chain;
  return () => { model.find = orig; };
}

// Mirrors the chainable Mongoose .findOne(...) API.
function stubFindOne(model, doc) {
  const orig = model.findOne;
  const chain = {
    populate() { return chain; }, sort() { return chain; },
    select() { return chain; }, lean() { return Promise.resolve(doc); },
  };
  model.findOne = () => chain;
  return () => { model.findOne = orig; };
}

const student = { _id: 'u-student-1', role: 'student' };
const parent = { _id: 'u-parent-1', role: 'parent' };
const tutor = { _id: 'u-tutor-1', role: 'tutor' };
const admin = { _id: 'u-admin-1', role: 'admin' };

function enrollment(overrides = {}) {
  return {
    _id: overrides._id || 'enr-1',
    enrollmentId: 'BB-20260101-0001',
    parent: parent._id,
    student: overrides.student || null,
    studentId: overrides.studentId || null,
    studentSnapshot: overrides.studentSnapshot || { firstName: 'Ana', lastName: 'Cruz' },
    status: overrides.status || 'approved',
    paymentStatus: overrides.paymentStatus || 'verified',
    packages: overrides.packages || [{ displayName: 'Academic Tutorial' }],
    selectedSubjects: [],
    totalFee: 2500,
    preferredStartDate: null,
    rejectionReason: null,
    ...overrides,
  };
}

// ── Route coverage: every Batch 2 intent from the task brief is wired ──────────────
test('Batch 2: every intent from the task brief is in the dispatch map', () => {
  const batch2 = [
    'grades', 'progress', 'parent_progress',
    'schedule', 'parent_schedule',
    'enrollment_status', 'parent_enrollment',
    'payment_status', 'parent_payment',
    'materials', 'soft_copy', 'tutor_materials',
    'contact_tutor', 'parent_contact',
  ];
  for (const intent of batch2) {
    assert.ok(CLASSIFIER_INTENT_HANDLERS[intent], `${intent} should be wired`);
  }
});

// ── The regex-miss cases the classifier is supposed to add value on ────────────────
test('getStudentGradesReply: the keyword regex misses this real phrasing (documents the gap)', async () => {
  const restore = stubFind(Grade, []);
  try {
    const reply = await getStudentGradesReply(student, 'Nasaan ang grades ko?', 'english');
    assert.equal(reply, null);
  } finally { restore(); }
});

test('getTutorContactReply: the keyword regex misses this real phrasing (documents the gap)', async () => {
  const reply = await getTutorContactReply(student, 'Paano ko mako-contact ang tutor ko?', 'english');
  assert.equal(reply, null);
});

test('route "grades": classifier shortcut reaches getStudentGradesReply for a phrasing the regex misses', async () => {
  const restore = stubFind(Grade, []);
  const fetchRestore = stubFetch('grades', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'Nasaan ang grades ko?', []);
    // Filipino phrasing -> Filipino reply (language auto-detected); same underlying "no
    // grades yet" branch as the English-language test above.
    assert.match(out, /wala pang naitalang grades/i);
  } finally { restore(); fetchRestore(); }
});

test('route "tutor_contact": classifier shortcut reaches the handler for a phrasing the regex misses', async () => {
  const restoreSched = stubFindOne(Schedule, { tutor: 't1' });
  const restoreUser = stubFindOne(User, { firstName: 'Maria', lastName: 'Santos', email: 'maria@beebright.test' });
  const fetchRestore = stubFetch('contact_tutor', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'Paano ko mako-contact ang tutor ko?', []);
    assert.match(out, /Maria Santos/);
  } finally { restoreSched(); restoreUser(); fetchRestore(); }
});

// ── route "grades" (grades, progress) ───────────────────────────────────────────────
test('route "grades": classifier-routed reply equals getStudentGradesReply for a student', async () => {
  const restore = stubFind(Grade, [
    { programCategory: 'Academic Tutorial', subjectItem: 'Phonics', score: 90, maxScore: 100 },
  ]);
  const fetchRestore = stubFetch('grades', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'what are my grades', []);
    assert.match(out, /1 recorded grade/);
    assert.match(out, /90%/);
  } finally { restore(); fetchRestore(); }
});

test('route "grades": "progress" intent reaches the same handler', async () => {
  const restore = stubFind(Grade, []);
  const fetchRestore = stubFetch('progress', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'how am i progressing', []);
    assert.match(out, /no grades recorded yet/i);
  } finally { restore(); fetchRestore(); }
});

test('route "grades": non-student role never sees real grade data — same generic text getStudentGradesReply gives directly', async () => {
  const restore = stubFind(Grade, [{ programCategory: 'X', subjectItem: 'Y', score: 100, maxScore: 100 }]);
  const fetchRestore = stubFetch('grades', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: parent, body: {}, headers: {} }, 'what are my grades', []);
    const direct = await getStudentGradesReply(parent, 'what are my grades', 'english', { skipKeywordCheck: true });
    assert.equal(out, direct);
    assert.doesNotMatch(out, /100%/); // never leaks the stubbed grade
  } finally { restore(); fetchRestore(); }
});

// ── route "grounded_grades" (parent_progress) ───────────────────────────────────────
test('route "grounded_grades": parent_progress reaches the parent\'s own child grades, matches resolveGroundedContextForTopic directly', async () => {
  const restoreEnr = stubFind(Enrollment, [
    enrollment({ _id: 'e1', student: 'stu-1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
  ]);
  const restoreGrade = stubFind(Grade, [
    { programCategory: 'Academic Tutorial', subjectItem: 'Phonics', score: 82, maxScore: 100, period: 'Q1', tutor: {} },
  ]);
  const fetchRestore = stubFetch('parent_progress', 0.9);
  try {
    const message = "how is Ana doing in her subjects?";
    const out = await tryClassifierShortcut({ user: parent, body: {}, headers: {} }, message, []);
    const direct = await resolveGroundedContextForTopic(parent, message, 'grades');
    assert.equal(out, direct.fallbackReply);
    assert.match(out, /Ana Cruz/);
  } finally { restoreEnr(); restoreGrade(); fetchRestore(); }
});

test('route "grounded_grades": no children linked -> safe "not found" reply, never a crash', async () => {
  const restoreEnr = stubFind(Enrollment, []);
  const fetchRestore = stubFetch('parent_progress', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: parent, body: {}, headers: {} }, "how's my child doing", []);
    assert.match(out, /could not find any enrolled child/i);
  } finally { restoreEnr(); fetchRestore(); }
});

// ── route "grounded_schedule" (schedule, parent_schedule) ──────────────────────────
test('route "grounded_schedule": student role reaches their own upcoming schedule', async () => {
  const restore = stubFind(Schedule, [
    { date: new Date('2026-09-20'), startTime: '10:00', subject: { name: 'Math' }, tutor: { firstName: 'Maria', lastName: 'Santos' } },
  ]);
  const fetchRestore = stubFetch('schedule', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'what is my schedule', []);
    assert.match(out, /next class/i);
  } finally { restore(); fetchRestore(); }
});

test('route "grounded_schedule": parent_schedule reaches the named child\'s schedule', async () => {
  const restoreEnr = stubFind(Enrollment, [
    enrollment({ _id: 'e1', student: 'stu-1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
  ]);
  const restoreSched = stubFind(Schedule, [
    { date: new Date('2026-09-20'), startTime: '10:00', subject: { name: 'Math' }, tutor: { firstName: 'Maria', lastName: 'Santos' } },
  ]);
  const fetchRestore = stubFetch('parent_schedule', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: parent, body: {}, headers: {} }, "when is Ana's next session?", []);
    assert.match(out, /Ana Cruz/);
  } finally { restoreEnr(); restoreSched(); fetchRestore(); }
});

// ── route "grounded_enrollment" (enrollment_status, parent_enrollment) ─────────────
test('route "grounded_enrollment": student role reaches their own enrollment status', async () => {
  const restore = stubFindOne(Enrollment, enrollment({ student: 'stu-1', status: 'approved', paymentStatus: 'verified', selectedSubjects: [] }));
  const fetchRestore = stubFetch('enrollment_status', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'am i enrolled', []);
    assert.match(out, /Approved/);
  } finally { restore(); fetchRestore(); }
});

test('route "grounded_enrollment": parent_enrollment reaches the parent\'s own children only, matches direct call', async () => {
  const restore = stubFind(Enrollment, [
    enrollment({ _id: 'e1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' }, status: 'approved', paymentStatus: 'verified' }),
    enrollment({ _id: 'e2', studentSnapshot: { firstName: 'Ben', lastName: 'Cruz' }, status: 'submitted', paymentStatus: 'pending' }),
  ]);
  const fetchRestore = stubFetch('parent_enrollment', 0.9);
  try {
    const message = 'is my child enrolled';
    const out = await tryClassifierShortcut({ user: parent, body: {}, headers: {} }, message, []);
    const direct = await resolveGroundedContextForTopic(parent, message, 'enrollment');
    assert.equal(out, direct.fallbackReply);
    assert.match(out, /Ana Cruz/);
    assert.match(out, /Ben Cruz/);
  } finally { restore(); fetchRestore(); }
});

// ── route "grounded_payments" (payment_status, parent_payment) ─────────────────────
test('route "grounded_payments": student role reaches their own payment status', async () => {
  const restoreEnr = stubFindOne(Enrollment, enrollment({ student: 'stu-1', status: 'approved', paymentStatus: 'verified' }));
  const restorePay = stubFindOne(Payment, { referenceNumber: 'BB1', status: 'verified', amount: 2500 });
  const fetchRestore = stubFetch('payment_status', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'has my payment been confirmed', []);
    assert.match(out, /Verified/);
  } finally { restoreEnr(); restorePay(); fetchRestore(); }
});

test('route "grounded_payments": parent_payment scopes payments to the parent\'s own enrollment id only', async () => {
  const restoreEnr = stubFind(Enrollment, [enrollment({ _id: 'e1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } })]);
  const origPayFind = Payment.find;
  const queriedEnrollmentIds = [];
  Payment.find = (q) => {
    queriedEnrollmentIds.push(q && q.enrollment);
    const chain = {
      sort() { return chain; }, select() { return chain; },
      lean() { return Promise.resolve([{ referenceNumber: 'BB1', status: 'verified', amountDue: 2500 }]); },
    };
    return chain;
  };
  const fetchRestore = stubFetch('parent_payment', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: parent, body: {}, headers: {} }, "has my child's payment been confirmed", []);
    assert.deepEqual(queriedEnrollmentIds, ['e1']);
    assert.match(out, /Ana Cruz/);
  } finally { restoreEnr(); Payment.find = origPayFind; fetchRestore(); }
});

// ── route "materials_by_role" (materials, soft_copy, tutor_materials) ──────────────
test('route "materials_by_role": no DB access, matches getMaterialsReplyByRole exactly for every role', async () => {
  for (const [intent, user] of [['materials', student], ['soft_copy', tutor], ['tutor_materials', parent]]) {
    const fetchRestore = stubFetch(intent, 0.9);
    try {
      const out = await tryClassifierShortcut({ user, body: {}, headers: {} }, 'where are my materials', []);
      assert.equal(out, getMaterialsReplyByRole(user, 'english'));
    } finally { fetchRestore(); }
  }
});

// ── route "tutor_contact" (contact_tutor, parent_contact) ──────────────────────────
test('route "tutor_contact": student reaches their own assigned tutor\'s contact', async () => {
  const restoreSched = stubFindOne(Schedule, { tutor: 't1' });
  const restoreUser = stubFindOne(User, { firstName: 'Maria', lastName: 'Santos', email: 'maria@beebright.test' });
  const fetchRestore = stubFetch('contact_tutor', 0.9);
  try {
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'how can i contact my tutor', []);
    assert.match(out, /Maria Santos/);
    assert.match(out, /maria@beebright\.test/);
  } finally { restoreSched(); restoreUser(); fetchRestore(); }
});

// Task 36 built the real parent -> child's-tutor lookup this test originally documented
// as missing (see test/task36-parent-tutor-contact.test.js for full coverage) — parent_contact
// now routes to 'grounded_tutor_contact', not this file's 'tutor_contact' route.
test('route "tutor_contact": parent_contact no longer maps here — see Task 36\'s own grounded lookup instead', () => {
  assert.equal(CLASSIFIER_INTENT_HANDLERS.parent_contact, 'grounded_tutor_contact');
  assert.notEqual(CLASSIFIER_INTENT_HANDLERS.parent_contact, 'tutor_contact');
});

// ── Guardrails: excluded / not-yet-batched intents stay unmapped ───────────────────
test('excluded: raise_concern, safety/distress intents remain unmapped after Batch 2', async () => {
  for (const intent of ['raise_concern', 'child_safety', 'safety_detection', 'crisis_support', 'crisis_hotline', 'student_distress', 'distress_detection']) {
    assert.equal(CLASSIFIER_INTENT_HANDLERS[intent], undefined, `${intent} must stay unmapped`);
  }
});

test('excluded: intents with no existing handler are still unmapped', async () => {
  // Batch 3 wired student_notes/tutor_count/student_count, Batch 4 wired at_risk/
  // at_risk_students/tutor_wellbeing_check (see task34-batch4-at-risk-wellbeing.test.js
  // for the full audit). own_schedule/view_schedule (tutor's own schedule) remain
  // unmapped — not in any batch's candidate list.
  for (const intent of ['own_schedule', 'view_schedule']) {
    assert.equal(CLASSIFIER_INTENT_HANDLERS[intent], undefined, `${intent} should not be wired yet`);
  }
});

// ── Fallback still holds ────────────────────────────────────────────────────────────
test('low confidence on a Batch 2 intent still falls through to null', async () => {
  const restore = stubFind(Grade, [{ programCategory: 'X', subjectItem: 'Y', score: 100, maxScore: 100 }]);
  const fetchRestore = stubFetch('grades', 0.1);
  try {
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, 'what are my grades', []);
    assert.equal(out, null);
  } finally { restore(); fetchRestore(); }
});

test('unauthenticated request never reaches a Batch 2 handler', async () => {
  const fetchRestore = stubFetch('payment_status', 0.95);
  try {
    const out = await tryClassifierShortcut({ user: null, body: {}, headers: {} }, 'has my payment been confirmed', []);
    assert.equal(out, null);
  } finally { fetchRestore(); }
});
