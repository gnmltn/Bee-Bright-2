const test = require('node:test');
const assert = require('node:assert/strict');

const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const Schedule = require('../models/Schedule');
const Grade = require('../models/Grade');

const {
  detectGroundedTopic,
  getGroundedChatContext,
  getRoleSpecificContext,
  isParentChildProgressQuestion,
  resolveParentChild,
  childDisplayName,
} = require('../controllers/aiController');

// ── Lightweight query-builder stub ──────────────────────────────────────────
// Mirrors the chainable Mongoose API used by the parent grounding helpers:
// Model.find(...).populate(...).sort(...).limit(...).lean()  → Promise<rows>
function stubModel(model, method, rows) {
  const chain = {
    populate() { return chain; },
    sort() { return chain; },
    limit() { return chain; },
    select() { return chain; },
    lean() { return Promise.resolve(rows); },
    then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
  };
  model[method] = () => chain;
}

function restore(model, method, original) {
  model[method] = original;
}

const PARENT = { _id: 'parent-1', role: 'parent' };

function enrollment(overrides = {}) {
  return {
    _id: overrides._id || 'enr-1',
    enrollmentId: 'BB-20260101-0001',
    parent: PARENT._id,
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

test('getRoleSpecificContext returns a parent-specific block', () => {
  const ctx = getRoleSpecificContext('parent');
  assert.match(ctx, /parent or guardian/i);
  assert.match(ctx, /which child/i);
  assert.doesNotMatch(ctx, /assisting a Bee Bright user\.$/); // not the generic fallthrough
});

test('isParentChildProgressQuestion catches grade/progress phrasing', () => {
  assert.equal(isParentChildProgressQuestion('how is my child doing in math'), true);
  assert.equal(isParentChildProgressQuestion("what are ana's grades"), true);
  assert.equal(isParentChildProgressQuestion('is my son passing'), true);
  assert.equal(isParentChildProgressQuestion('kumusta ang anak ko sa klase'), true);
  assert.equal(isParentChildProgressQuestion('when is the next class'), false);
  assert.equal(isParentChildProgressQuestion('how do i pay tuition'), false);
});

test('detectGroundedTopic routes parent questions; leaves other roles unchanged', () => {
  assert.equal(detectGroundedTopic(PARENT, 'how is my child doing in Math?'), 'grades');
  assert.equal(detectGroundedTopic(PARENT, "when is my child's next class?"), 'schedule');
  assert.equal(detectGroundedTopic(PARENT, 'is the payment verified?'), 'payments');
  assert.equal(detectGroundedTopic(PARENT, 'what is my child enrollment status'), 'enrollment');

  // Generic centre-hours question must NOT be grounded, even for a parent.
  assert.equal(detectGroundedTopic(PARENT, 'what are your class hours'), null);

  // A student asking about grades is still not a grounded topic (unchanged behaviour).
  assert.equal(detectGroundedTopic({ _id: 's1', role: 'student' }, 'how are my grades'), null);
});

test('resolveParentChild matches a named child and disambiguates otherwise', () => {
  const kids = [
    enrollment({ _id: 'e1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
    enrollment({ _id: 'e2', studentSnapshot: { firstName: 'Ben', lastName: 'Cruz' } }),
  ];
  assert.equal(resolveParentChild("how is ana's math", kids).matched?._id, 'e1');
  assert.equal(resolveParentChild('how is Ben doing', kids).matched?._id, 'e2');
  assert.equal(resolveParentChild('how is my child doing', kids).matched, null); // ambiguous
});

test('childDisplayName falls back gracefully', () => {
  assert.equal(childDisplayName(enrollment()), 'Ana Cruz');
  assert.equal(childDisplayName({ studentSnapshot: {} }), 'your child');
});

test('grounded grades context: asks which child when none is named', async () => {
  const origFind = Enrollment.find;
  stubModel(Enrollment, 'find', [
    enrollment({ _id: 'e1', student: 'stu-1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
    enrollment({ _id: 'e2', student: 'stu-2', studentSnapshot: { firstName: 'Ben', lastName: 'Cruz' } }),
  ]);
  try {
    const ctx = await getGroundedChatContext(PARENT, 'how is my child doing?');
    assert.ok(ctx, 'expected a grounded context');
    assert.match(ctx.fallbackReply, /which|whose/i);
    assert.match(ctx.fallbackReply, /Ana Cruz/);
    assert.match(ctx.fallbackReply, /Ben Cruz/);
    assert.doesNotMatch(ctx.contextText, /\d+\/\d+ \(\d+%\)/); // no grade detail leaked
  } finally {
    restore(Enrollment, 'find', origFind);
  }
});

test('grounded grades context: full detail for the named child', async () => {
  const origEnr = Enrollment.find;
  const origGrade = Grade.find;
  stubModel(Enrollment, 'find', [
    enrollment({ _id: 'e1', student: 'stu-1', studentId: 'S-20260101-0007', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
  ]);
  stubModel(Grade, 'find', [
    { programCategory: 'Academic Tutorial', subjectItem: 'Phonics', score: 82, maxScore: 100, period: 'Q1 2026', remarks: 'Good progress', tutor: { firstName: 'Maria', lastName: 'Santos' } },
    { programCategory: 'Academic Tutorial', subjectItem: 'Numbers', score: 60, maxScore: 100, period: 'Q1 2026', remarks: '', tutor: { firstName: 'Maria', lastName: 'Santos' } },
  ]);
  try {
    const ctx = await getGroundedChatContext(PARENT, "how is Ana doing in her subjects?");
    assert.match(ctx.contextText, /Phonics: 82\/100 \(82%\)/);
    assert.match(ctx.contextText, /Numbers: 60\/100 \(60%\)/);
    assert.match(ctx.contextText, /Maria Santos/);
    assert.match(ctx.fallbackReply, /Below the 75% mark: Numbers/);
  } finally {
    restore(Enrollment, 'find', origEnr);
    restore(Grade, 'find', origGrade);
  }
});

test('grounded schedule context: still confirms which child even with only one on record', async () => {
  const origFind = Enrollment.find;
  stubModel(Enrollment, 'find', [
    enrollment({ _id: 'e1', student: 'stu-1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
  ]);
  try {
    const ctx = await getGroundedChatContext(PARENT, "when is my child's next class?");
    assert.match(ctx.fallbackReply, /tell me your child's name/i);
  } finally {
    restore(Enrollment, 'find', origFind);
  }
});

test('grounded schedule context: no synthetic student yet → not-scheduled message', async () => {
  const origFind = Enrollment.find;
  stubModel(Enrollment, 'find', [
    enrollment({ _id: 'e1', student: null, status: 'pending_approval', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
  ]);
  try {
    const ctx = await getGroundedChatContext(PARENT, "when is Ana's next class?");
    assert.match(ctx.fallbackReply, /not scheduled yet|after the enrollment is approved/i);
  } finally {
    restore(Enrollment, 'find', origFind);
  }
});

test('grounded enrollment context: per-child breakdown when no child named', async () => {
  const origFind = Enrollment.find;
  stubModel(Enrollment, 'find', [
    enrollment({ _id: 'e1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' }, status: 'approved', paymentStatus: 'verified' }),
    enrollment({ _id: 'e2', studentSnapshot: { firstName: 'Ben', lastName: 'Cruz' }, status: 'submitted', paymentStatus: 'pending' }),
  ]);
  try {
    const ctx = await getGroundedChatContext(PARENT, 'what is my child enrollment status');
    assert.match(ctx.fallbackReply, /Ana Cruz: enrollment Approved/);
    assert.match(ctx.fallbackReply, /Ben Cruz: enrollment Submitted/);
  } finally {
    restore(Enrollment, 'find', origFind);
  }
});

test('grounded payment context reads payments for the parent\'s own enrollments only', async () => {
  const origEnr = Enrollment.find;
  const origPay = Payment.find;
  let queriedEnrollmentIds = [];
  stubModel(Enrollment, 'find', [enrollment({ _id: 'e1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } })]);
  Payment.find = (q) => {
    queriedEnrollmentIds.push(q && q.enrollment);
    const chain = {
      sort() { return chain; }, select() { return chain; },
      lean() { return Promise.resolve([{ referenceNumber: 'BB202601000001', status: 'verified', paymentType: 'full', paymentMethod: 'gcash', amountDue: 2500, amountPaid: 2500 }]); },
    };
    return chain;
  };
  try {
    const ctx = await getGroundedChatContext(PARENT, 'is my payment verified?');
    assert.deepEqual(queriedEnrollmentIds, ['e1']); // scoped to the parent's own enrollment
    assert.match(ctx.fallbackReply, /Ana Cruz: payment Verified/);
  } finally {
    restore(Enrollment, 'find', origEnr);
    restore(Payment, 'find', origPay);
  }
});
