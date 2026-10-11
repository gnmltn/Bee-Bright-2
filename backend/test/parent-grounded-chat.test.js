const test = require('node:test');
const assert = require('node:assert/strict');

const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const Schedule = require('../models/Schedule');
const Remark = require('../models/Remark');

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

// Batch 8 fix — a child who renewed/added a program has 2+ Enrollment records (one per
// program), all sharing the same name. Matching used to run against the flat list, so
// naming that child produced 2 "matches" and was wrongly reported as ambiguous.
test('resolveParentChild groups multi-enrollment children before matching', () => {
  const multi = [
    enrollment({ _id: 'ana-new', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' }, status: 'approved' }),
    enrollment({ _id: 'ana-old', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' }, status: 'completed' }),
    enrollment({ _id: 'ben-1', studentSnapshot: { firstName: 'Ben', lastName: 'Cruz' } }),
  ];
  // Naming the 2-enrollment child resolves to her most recent record, not false ambiguity.
  assert.equal(resolveParentChild('how is ana doing', multi).matched?._id, 'ana-new');
  // Still correctly ambiguous when two DISTINCT children are both named.
  assert.equal(resolveParentChild('how are ana and ben doing', multi).matched, null);
  // Still correctly ambiguous when no child is named at all.
  assert.equal(resolveParentChild('how is my child doing', multi).matched, null);
});

// Found via live testing: a parent with 2+ children sharing a last name (siblings) named
// a child by FULL name ("Alex Soriano") and got the generic "which child?" disambiguation
// instead of Alex specifically — the shared surname "Soriano" alone matched every one of
// the siblings under the old "first OR last" test, outvoting the one real full-name hit.
test('resolveParentChild resolves an exact full-name match even when siblings share a last name', () => {
  const siblings = [
    enrollment({ _id: 'alex', studentSnapshot: { firstName: 'Alex', lastName: 'Soriano' } }),
    enrollment({ _id: 'aviery', studentSnapshot: { firstName: 'Aviery', lastName: 'Soriano' } }),
    enrollment({ _id: 'jay', studentSnapshot: { firstName: 'Jay', lastName: 'Soriano' } }),
  ];
  assert.equal(resolveParentChild('what is the schedule of alex soriano', siblings).matched?._id, 'alex');
  assert.equal(resolveParentChild('ilan absent ni jay soriano sa klase?', siblings).matched?._id, 'jay');
  // First-name-only when unambiguous still works (no collision risk from first names here).
  assert.equal(resolveParentChild('kay alex may natitira pa bang babayaran?', siblings).matched?._id, 'alex');
  // The bare shared surname alone, with no first name at all, is still correctly ambiguous.
  assert.equal(resolveParentChild('kumusta ang mga soriano', siblings).matched, null);
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

// Grades were fully retired in favor of Student Remarks (2026-09-30) — once a named
// child resolves, buildParentGradesContext gives the honest "no numeric grades" framing,
// now backed by the real published Remark data when any exists (see the dedicated test
// below) instead of always just redirecting to a tab with no content.
test('grounded grades context: honest "does not use numeric grades" answer for the named child', async () => {
  const origEnr = Enrollment.find;
  const origRemark = Remark.find;
  stubModel(Enrollment, 'find', [
    enrollment({ _id: 'e1', student: 'stu-1', studentId: 'S-20260101-0007', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
  ]);
  stubModel(Remark, 'find', []);
  try {
    const ctx = await getGroundedChatContext(PARENT, "how is Ana doing in her subjects?");
    assert.match(ctx.contextText, /Ana Cruz/);
    assert.match(ctx.contextText, /does not use numeric grades/i);
    assert.match(ctx.fallbackReply, /does not use numeric grades/i);
    assert.match(ctx.fallbackReply, /Ana Cruz/);
    assert.match(ctx.fallbackReply, /Student Remarks/);
  } finally {
    restore(Enrollment, 'find', origEnr);
    restore(Remark, 'find', origRemark);
  }
});

test('grounded grades context: a published remark for the named child surfaces its real content, not just a redirect', async () => {
  const origEnr = Enrollment.find;
  const origRemark = Remark.find;
  stubModel(Enrollment, 'find', [
    enrollment({ _id: 'e1', student: 'stu-1', studentId: 'S-20260101-0007', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
  ]);
  stubModel(Remark, 'find', [
    {
      date: new Date('2026-10-01'),
      remarkBullets: ['Participated actively in class discussion', 'Completed all worksheets'],
      nextFocus: 'Practice long division',
      parentSupportSuggestion: '',
      status: 'published',
      isCurrentVersion: true,
    },
  ]);
  try {
    const ctx = await getGroundedChatContext(PARENT, "how is Ana doing in her subjects?");
    assert.match(ctx.contextText, /Ana Cruz/);
    assert.match(ctx.contextText, /Participated actively in class discussion/);
    assert.match(ctx.fallbackReply, /Participated actively in class discussion/);
    assert.match(ctx.fallbackReply, /Practice long division/);
  } finally {
    restore(Enrollment, 'find', origEnr);
    restore(Remark, 'find', origRemark);
  }
});

// Attendance had no dedicated grounding path for parents at all — a question like "ilan
// absent ni alex" fell through to a generic "check your dashboard" instruction instead
// of the real present/absent counts, even for the parent's own verified child.
test('grounded attendance context: real present/absent counts for the named child, not a generic instruction', async () => {
  const origEnr = Enrollment.find;
  const origSched = Schedule.find;
  stubModel(Enrollment, 'find', [
    enrollment({ _id: 'e1', student: 'stu-1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
  ]);
  stubModel(Schedule, 'find', [
    { date: new Date('2026-09-01'), attendanceStatus: 'present' },
    { date: new Date('2026-09-08'), attendanceStatus: 'absent' },
    { date: new Date('2026-09-15'), attendanceStatus: 'present' },
    { date: new Date('2026-09-22'), attendanceStatus: 'unmarked' },
  ]);
  try {
    const ctx = await getGroundedChatContext(PARENT, 'ilan absent ni ana cruz sa klase?');
    assert.equal(ctx.topic, 'attendance');
    assert.match(ctx.contextText, /Ana Cruz/);
    assert.match(ctx.contextText, /Absent: 1/);
    assert.match(ctx.contextText, /Present: 2/);
    assert.match(ctx.fallbackReply, /absent 1 time/i);
    assert.match(ctx.fallbackReply, /out of 4 past sessions/i);
  } finally {
    restore(Enrollment, 'find', origEnr);
    restore(Schedule, 'find', origSched);
  }
});

test('grounded attendance context: asks which child when none is named, like payments/schedule already do', async () => {
  const origEnr = Enrollment.find;
  stubModel(Enrollment, 'find', [
    enrollment({ _id: 'e1', student: 'stu-1', studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } }),
    enrollment({ _id: 'e2', student: 'stu-2', studentSnapshot: { firstName: 'Ben', lastName: 'Reyes' } }),
  ]);
  try {
    const ctx = await getGroundedChatContext(PARENT, 'how many absences does my child have');
    assert.match(ctx.fallbackReply, /whose attendance/i);
  } finally {
    restore(Enrollment, 'find', origEnr);
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
