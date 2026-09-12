/**
 * Task 36 — parent -> child's tutor contact lookup. Fixes the gap Task 34 Batch 2
 * flagged: parent_contact was a correctly-trained/detected intent with no backend
 * function behind it, so it fell back to generic text. No dataset/classifier changes
 * here — same trained intent, new handler.
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59589';

const test = require('node:test');
const assert = require('node:assert/strict');

const AuditLog = require('../models/AuditLog');
const Enrollment = require('../models/Enrollment');
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const {
  tryClassifierShortcut,
  CLASSIFIER_INTENT_HANDLERS,
  buildParentTutorContactContext,
  resolveGroundedContextForTopic,
  getTutorContactReply,
  detectGroundedTopic,
  getGroundedChatContext,
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

function stubFindOne(model, doc) {
  const orig = model.findOne;
  const chain = {
    populate() { return chain; }, sort() { return chain; },
    select() { return chain; }, lean() { return Promise.resolve(doc); },
  };
  model.findOne = () => chain;
  return () => { model.findOne = orig; };
}

const parentA = { _id: 'parentA', role: 'parent' };
const parentB = { _id: 'parentB', role: 'parent' };
const student = { _id: 'student-1', role: 'student' };

function enrollment(overrides = {}) {
  return {
    _id: overrides._id || 'enr-1',
    parent: parentA._id,
    student: overrides.student || null,
    studentSnapshot: overrides.studentSnapshot || { firstName: 'Ana', lastName: 'Cruz' },
    status: overrides.status || 'approved',
    ...overrides,
  };
}

const tutorDoc = { firstName: 'Maria', lastName: 'Santos', email: 'maria@beebright.test', phone: '09171234567' };

// ── Single child: no disambiguation ─────────────────────────────────────────────────
test('single-child parent: gets tutor contact directly, no disambiguation prompt', async () => {
  const restoreEnr = stubFind(Enrollment, [enrollment({ student: 'stu-1' })]);
  const restoreSched = stubFindOne(Schedule, { tutor: 't1' });
  const restoreUser = stubFindOne(User, tutorDoc);
  try {
    const ctx = await buildParentTutorContactContext(parentA._id, "how do I contact my child's tutor");
    assert.match(ctx.fallbackReply, /Ana Cruz's tutor contact is Maria Santos/);
    assert.match(ctx.fallbackReply, /maria@beebright\.test/);
    assert.match(ctx.fallbackReply, /09171234567/);
    assert.doesNotMatch(ctx.fallbackReply, /which child|whose/i);
  } finally { restoreEnr(); restoreSched(); restoreUser(); }
});

// ── Multi-child: disambiguation reused from Task 1's pattern ───────────────────────
test('multi-child parent, no name given: "which child?" disambiguation, no tutor data leaked', async () => {
  const restoreEnr = stubFind(Enrollment, [
    enrollment({ _id: 'e1', student: 'stu-1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
    enrollment({ _id: 'e2', student: 'stu-2', studentSnapshot: { firstName: 'Ben', lastName: 'Cruz' } }),
  ]);
  try {
    const ctx = await buildParentTutorContactContext(parentA._id, "how do I contact my child's tutor");
    assert.match(ctx.fallbackReply, /Ana Cruz/);
    assert.match(ctx.fallbackReply, /Ben Cruz/);
    assert.match(ctx.fallbackReply, /whose|which/i);
    assert.doesNotMatch(ctx.contextText, /Maria Santos/); // no tutor data revealed pre-disambiguation
  } finally { restoreEnr(); }
});

test('multi-child parent, child named in the message: skips disambiguation, correct child\'s tutor', async () => {
  const restoreEnr = stubFind(Enrollment, [
    enrollment({ _id: 'e1', student: 'stu-1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
    enrollment({ _id: 'e2', student: 'stu-2', studentSnapshot: { firstName: 'Ben', lastName: 'Cruz' } }),
  ]);
  const restoreSched = stubFindOne(Schedule, { tutor: 't1' });
  const restoreUser = stubFindOne(User, tutorDoc);
  try {
    const ctx = await buildParentTutorContactContext(parentA._id, "how do I contact Ben's tutor");
    assert.match(ctx.fallbackReply, /Ben Cruz's tutor contact is Maria Santos/);
    assert.doesNotMatch(ctx.fallbackReply, /Ana Cruz/);
  } finally { restoreEnr(); restoreSched(); restoreUser(); }
});

// ── No assigned tutor yet ────────────────────────────────────────────────────────────
test('child with no assigned tutor yet: clear message, not a crash or empty reply', async () => {
  const restoreEnr = stubFind(Enrollment, [enrollment({ student: 'stu-1' })]);
  const restoreSched = stubFindOne(Schedule, null); // no Schedule row with a tutor yet
  try {
    const ctx = await buildParentTutorContactContext(parentA._id, 'tutor contact please');
    assert.ok(ctx.fallbackReply);
    assert.match(ctx.fallbackReply, /does not have an assigned tutor yet/i);
  } finally { restoreEnr(); restoreSched(); }
});

test('child not yet linked to a real student User at all: clear message, not a crash', async () => {
  const restoreEnr = stubFind(Enrollment, [enrollment({ student: null })]);
  try {
    const ctx = await buildParentTutorContactContext(parentA._id, 'tutor contact please');
    assert.match(ctx.fallbackReply, /does not have an assigned tutor yet/i);
  } finally { restoreEnr(); }
});

test('no enrollments at all: clear message, not a crash', async () => {
  const restoreEnr = stubFind(Enrollment, []);
  try {
    const ctx = await buildParentTutorContactContext(parentA._id, 'tutor contact please');
    assert.match(ctx.fallbackReply, /could not find any enrolled child/i);
  } finally { restoreEnr(); }
});

// ── Cross-parent scoping ────────────────────────────────────────────────────────────
test('cross-check: a different parent\'s query only ever reads their OWN Enrollment.parent, never another family\'s', async () => {
  const origFind = Enrollment.find;
  const queriedParentIds = [];
  Enrollment.find = (q) => {
    queriedParentIds.push(q.parent);
    const chain = {
      populate() { return chain; }, sort() { return chain; }, lean() { return Promise.resolve([]); },
    };
    return chain;
  };
  try {
    await buildParentTutorContactContext(parentA._id, 'tutor contact');
    await buildParentTutorContactContext(parentB._id, 'tutor contact');
    assert.deepEqual(queriedParentIds, [parentA._id, parentB._id]);
  } finally { Enrollment.find = origFind; }
});

// ── Wired through the classifier shortcut ───────────────────────────────────────────
test('classifier shortcut: parent_contact reaches buildParentTutorContactContext, matches direct call', async () => {
  const restoreEnr = stubFind(Enrollment, [enrollment({ student: 'stu-1' })]);
  const restoreSched = stubFindOne(Schedule, { tutor: 't1' });
  const restoreUser = stubFindOne(User, tutorDoc);
  const fetchRestore = stubFetch('parent_contact', 0.9);
  try {
    const message = "Can I contact my child's tutor?";
    const out = await tryClassifierShortcut({ user: parentA, body: {}, headers: {} }, message, []);
    const direct = await resolveGroundedContextForTopic(parentA, message, 'tutor_contact');
    assert.equal(out, direct.fallbackReply);
    assert.match(out, /Maria Santos/);
  } finally { restoreEnr(); restoreSched(); restoreUser(); fetchRestore(); }
});

test('CLASSIFIER_INTENT_HANDLERS.parent_contact now routes to the grounded lookup, not the old generic fallback', () => {
  assert.equal(CLASSIFIER_INTENT_HANDLERS.parent_contact, 'grounded_tutor_contact');
});

// ── Guardrail: student-facing contact_tutor path is untouched ──────────────────────
test('guardrail: contact_tutor (student-facing) is unchanged — still routes to getTutorContactReply', async () => {
  assert.equal(CLASSIFIER_INTENT_HANDLERS.contact_tutor, 'tutor_contact');
  const restoreSched = stubFindOne(Schedule, { tutor: 't1' });
  const restoreUser = stubFindOne(User, tutorDoc);
  const fetchRestore = stubFetch('contact_tutor', 0.9);
  try {
    const message = 'how can I contact my tutor';
    const out = await tryClassifierShortcut({ user: student, body: {}, headers: {} }, message, []);
    const direct = await getTutorContactReply(student, message, 'english', { skipKeywordCheck: true });
    assert.equal(out, direct);
  } finally { restoreSched(); restoreUser(); fetchRestore(); }
});

// ── Follow-up fix: deterministic (non-classifier) pipeline now also reaches this ───
test('detectGroundedTopic: parent + "contact ... tutor" phrasing -> topic "tutor_contact"', () => {
  assert.equal(detectGroundedTopic(parentA, "how do I contact my child's tutor"), 'tutor_contact');
  assert.equal(detectGroundedTopic(parentA, "Can I contact Carlo's tutor?"), 'tutor_contact');
  assert.equal(detectGroundedTopic(parentA, "What is my child's tutor's phone number?"), 'tutor_contact');
  assert.equal(detectGroundedTopic(parentA, "How do I reach my child's tutor?"), 'tutor_contact');
});

test('detectGroundedTopic: unaffected for non-tutor-contact parent phrasing and other roles', () => {
  assert.equal(detectGroundedTopic(parentA, 'what is my child\'s schedule'), 'schedule');
  assert.equal(detectGroundedTopic(parentA, 'how is my child doing in math'), 'grades');
  assert.equal(detectGroundedTopic(student, 'how can i contact my tutor'), null); // student path untouched
});

test('named-child phrasing now reaches the real answer via the deterministic pipeline (the priority-fix scenario)', async () => {
  const restoreEnr = stubFind(Enrollment, [
    enrollment({ _id: 'e1', student: 'stu-1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
    enrollment({ _id: 'e2', student: 'stu-2', studentSnapshot: { firstName: 'Ben', lastName: 'Cruz' } }),
  ]);
  const restoreSched = stubFindOne(Schedule, { tutor: 't1' });
  const restoreUser = stubFindOne(User, tutorDoc);
  try {
    // No classifier involved at all here — this goes through getGroundedChatContext,
    // exactly like the normal deterministic pipeline does before ever calling the classifier.
    const ctx = await getGroundedChatContext(parentA, "Can I contact Ben's tutor?");
    assert.ok(ctx, 'expected a grounded context, not null');
    assert.equal(ctx.topic, 'tutor_contact');
    assert.match(ctx.fallbackReply, /Ben Cruz's tutor contact is Maria Santos/);
  } finally { restoreEnr(); restoreSched(); restoreUser(); }
});
