/**
 * Fixes_and_Features PDF items 4, 7 and 10 — remaining-balance maths (Total Unpaid /
 * Pending Payments / parent Payments badge), the tutor "My Students" schedule summary,
 * and the sidebar red count badges.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Schedule = require('../models/Schedule');
const Remark = require('../models/Remark');
const Announcement = require('../models/Announcement');
const { computeRemainingBalance } = require('../utils/remainingBalance');
const { getPendingBalances } = require('../controllers/paymentController');
const { summarizeSchedulePattern } = require('../controllers/scheduleController');
const { getBadges, markSectionSeen } = require('../controllers/notificationController');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

// ── computeRemainingBalance ──────────────────────────────────────────────────

test('computeRemainingBalance: nothing owed until the down payment is verified', () => {
  assert.equal(computeRemainingBalance({ status: 'submitted', totalFee: 2400 }, []).owed, false);
  assert.equal(computeRemainingBalance({ status: 'payment_under_verification', totalFee: 2400 }, [{ status: 'submitted', paymentType: 'down', amount: 1200 }]).remaining, 0);
});

test('computeRemainingBalance: verified 50% down leaves the other 50% owed', () => {
  const r = computeRemainingBalance({ status: 'approved', totalFee: 2400 }, [{ status: 'verified', paymentType: 'down', amountPaid: 1200 }]);
  assert.deepEqual(r, { remaining: 1200, owed: true, underReview: false });
});

test('computeRemainingBalance: a submitted remaining payment is under review, not "owed"', () => {
  const r = computeRemainingBalance({ status: 'approved', totalFee: 2400 }, [
    { status: 'verified', paymentType: 'down', amountPaid: 1200 },
    { status: 'submitted', paymentType: 'remaining', amount: 1200 },
  ]);
  assert.equal(r.owed, false);
  assert.equal(r.underReview, true);
  assert.equal(r.remaining, 1200);
});

test('computeRemainingBalance: fully paid, rejected and cancelled enrollments owe nothing', () => {
  const full = [{ status: 'verified', paymentType: 'down', amountPaid: 1200 }, { status: 'verified', paymentType: 'remaining', amountPaid: 1200 }];
  assert.equal(computeRemainingBalance({ status: 'approved', totalFee: 2400 }, full).remaining, 0);
  const down = [{ status: 'verified', paymentType: 'down', amountPaid: 1200 }];
  assert.equal(computeRemainingBalance({ status: 'rejected', totalFee: 2400 }, down).remaining, 0);
  assert.equal(computeRemainingBalance({ status: 'cancelled', totalFee: 2400 }, down).remaining, 0);
});

// ── getPendingBalances (admin Payments: Total Unpaid + Pending Payments) ─────

test('getPendingBalances: one row per parent, summing the remaining 50% across their enrollments, plus a grand total', async () => {
  const origEFind = Enrollment.find;
  const origPFind = Payment.find;
  const maria = { _id: 'p1', firstName: 'Maria', lastName: 'Cruz', email: 'maria@example.com' };
  const jose = { _id: 'p2', firstName: 'Jose', lastName: 'Lim', email: 'jose@example.com' };
  const enrollments = [
    { _id: 'e1', parent: maria, status: 'approved', totalFee: 2400, studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' } },
    { _id: 'e2', parent: maria, status: 'approved', totalFee: 4000, studentSnapshot: { firstName: 'Ben', lastName: 'Cruz' } },
    { _id: 'e3', parent: jose, status: 'approved', totalFee: 3000, studentSnapshot: { firstName: 'Cy', lastName: 'Lim' } },
    { _id: 'e4', parent: jose, status: 'approved', totalFee: 2000, studentSnapshot: { firstName: 'Di', lastName: 'Lim' } },
  ];
  const payments = [
    { enrollment: 'e1', status: 'verified', paymentType: 'down', amountPaid: 1200 },
    { enrollment: 'e2', status: 'verified', paymentType: 'down', amountPaid: 2000 },
    { enrollment: 'e3', status: 'verified', paymentType: 'down', amountPaid: 1500 },
    { enrollment: 'e4', status: 'verified', paymentType: 'down', amountPaid: 1000 },
    { enrollment: 'e4', status: 'verified', paymentType: 'remaining', amountPaid: 1000 },
  ];
  Enrollment.find = () => ({ populate: () => ({ select: () => ({ lean: async () => enrollments }) }) });
  Payment.find = () => ({ select: () => ({ lean: async () => payments }) });
  try {
    const res = mockRes();
    await getPendingBalances({ user: { role: 'admin' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.totalUnpaid, 1200 + 2000 + 1500);
    assert.equal(res._body.count, 2, 'Di is fully paid so Jose only owes for Cy');
    const [first, second] = res._body.items;
    assert.equal(first.parentName, 'Maria Cruz');
    assert.equal(first.parentEmail, 'maria@example.com');
    assert.equal(first.remaining, 3200);
    assert.deepEqual(first.children.sort(), ['Ana Cruz', 'Ben Cruz']);
    assert.equal(second.remaining, 1500);
  } finally { Enrollment.find = origEFind; Payment.find = origPFind; }
});

// ── summarizeSchedulePattern (tutor My Students card) ────────────────────────

test('summarizeSchedulePattern: groups weekdays that share a time range', () => {
  // 2024-01-01 is a Monday.
  const s = (date, startTime, endTime) => ({ date: new Date(`${date}T00:00:00Z`), startTime, endTime });
  assert.equal(
    summarizeSchedulePattern([s('2024-01-01', '09:00', '10:00'), s('2024-01-02', '09:00', '10:00'), s('2024-01-03', '09:00', '10:00'), s('2024-01-08', '09:00', '10:00')]),
    'Mon/Tue/Wed, 9:00–10:00 AM'
  );
  assert.equal(
    summarizeSchedulePattern([s('2024-01-01', '09:00', '10:00'), s('2024-01-05', '14:00', '15:00')]),
    'Mon, 9:00–10:00 AM • Fri, 2:00–3:00 PM'
  );
  assert.equal(summarizeSchedulePattern([s('2024-01-01', '11:30', '13:00')]), 'Mon, 11:30 AM–1:00 PM');
  assert.equal(summarizeSchedulePattern([]), '');
});

// ── Sidebar badges ───────────────────────────────────────────────────────────

function userDoc(role, navSeen = {}) {
  return { _id: 'u1', role, navSeen: new Map(Object.entries(navSeen)) };
}

test('getBadges (admin): action counts are state, "users" is new-since-seen and baselines to zero on first call', async () => {
  const origs = {
    uFindById: User.findById, uUpdateOne: User.updateOne, uCount: User.countDocuments,
    eCount: Enrollment.countDocuments, pCount: Payment.countDocuments, rCount: Remark.countDocuments, aCount: Announcement.countDocuments,
  };
  const updates = [];
  const captured = {};
  User.findById = () => ({ select: async () => userDoc('admin') });
  User.updateOne = async (_f, u) => { updates.push(u); };
  User.countDocuments = async (f) => { captured.users = f; return 0; };
  Enrollment.countDocuments = async (f) => { captured.enrollments = f; return f.status === 'pending_approval' ? 1 : 2; };
  Payment.countDocuments = async (f) => { captured.payments = f; return 2; };
  Remark.countDocuments = async (f) => { captured.remarks = f; return 4; };
  Announcement.countDocuments = async (f) => { captured.announcements = f; return 1; };
  try {
    const res = mockRes();
    await getBadges({ user: { _id: 'u1' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.deepEqual(res._body.badges, { users: 0, enrollments: 3, paymentReview: 2, pendingApproval: 1, payments: 2, remarks: 4, announcements: 1 });
    assert.deepEqual(captured.enrollments, { status: 'pending_approval' }, 'last enrollment count query is the Pending Approval tab');
    assert.deepEqual(captured.payments, { status: 'submitted' });
    assert.deepEqual(captured.remarks, { status: 'pending_admin_review' });
    assert.deepEqual(captured.announcements, { status: 'pending' });
    assert.ok(updates[0].$set['navSeen.users'] instanceof Date, 'first call records a baseline so old accounts do not light up');
  } finally {
    User.findById = origs.uFindById; User.updateOne = origs.uUpdateOne; User.countDocuments = origs.uCount;
    Enrollment.countDocuments = origs.eCount; Payment.countDocuments = origs.pCount; Remark.countDocuments = origs.rCount; Announcement.countDocuments = origs.aCount;
  }
});

test('getBadges (parent): schedule / progress / announcements are scoped to the parent\'s children; Payments counts enrollments still owing the remaining 50%', async () => {
  const origs = {
    uFindById: User.findById, uUpdateOne: User.updateOne, eDistinct: Enrollment.distinct, eFind: Enrollment.find,
    sFind: Schedule.find, rCount: Remark.countDocuments, aCount: Announcement.countDocuments, pFind: Payment.find,
  };
  const seen = new Date('2026-09-01T00:00:00Z');
  const captured = {};
  User.findById = () => ({ select: async () => userDoc('parent', { schedule: seen, progress: seen, announcements: seen }) });
  User.updateOne = async () => {};
  Enrollment.distinct = async () => ['kid-1', 'kid-2'];
  Schedule.find = (f) => { captured.schedule = f; return { select: () => ({ lean: async () => [{ createdAt: new Date('2026-09-10'), updatedAt: new Date('2026-09-10') }] }) }; };
  Remark.countDocuments = async (f) => { captured.remarks = f; return 2; };
  Announcement.countDocuments = async (f) => { captured.announcements = f; return 3; };
  Enrollment.find = () => ({ populate: () => ({ select: () => ({ lean: async () => [
    { _id: 'e1', parent: { _id: 'u1' }, status: 'approved', totalFee: 2400 },
    { _id: 'e2', parent: { _id: 'u1' }, status: 'approved', totalFee: 2400 },
  ] }) }) });
  Payment.find = () => ({ select: () => ({ lean: async () => [
    { enrollment: 'e1', status: 'verified', paymentType: 'down', amountPaid: 1200 },
    { enrollment: 'e2', status: 'verified', paymentType: 'down', amountPaid: 1200 },
    { enrollment: 'e2', status: 'verified', paymentType: 'remaining', amountPaid: 1200 },
  ] }) });
  try {
    const res = mockRes();
    await getBadges({ user: { _id: 'u1' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.deepEqual(res._body.badges, { schedule: 1, progress: 2, announcements: 3, payments: 1 });
    assert.deepEqual(captured.schedule.$or, [{ student: { $in: ['kid-1', 'kid-2'] } }, { students: { $in: ['kid-1', 'kid-2'] } }]);
    assert.equal(captured.remarks.status, 'published');
    assert.equal(captured.remarks.isCurrentVersion, true);
    assert.deepEqual(captured.remarks.student, { $in: ['kid-1', 'kid-2'] });
  } finally {
    User.findById = origs.uFindById; User.updateOne = origs.uUpdateOne; Enrollment.distinct = origs.eDistinct; Enrollment.find = origs.eFind;
    Schedule.find = origs.sFind; Remark.countDocuments = origs.rCount; Announcement.countDocuments = origs.aCount; Payment.find = origs.pFind;
  }
});

test('getBadges (parent): a schedule that only changed because the tutor marked attendance is not a "new schedule"', async () => {
  const origs = { uFindById: User.findById, uUpdateOne: User.updateOne, eDistinct: Enrollment.distinct, sFind: Schedule.find, rCount: Remark.countDocuments, aCount: Announcement.countDocuments, eFind: Enrollment.find };
  const seen = new Date('2026-09-01T00:00:00Z');
  User.findById = () => ({ select: async () => userDoc('parent', { schedule: seen, progress: seen, announcements: seen }) });
  User.updateOne = async () => {};
  Enrollment.distinct = async () => ['kid-1'];
  Enrollment.find = () => ({ populate: () => ({ select: () => ({ lean: async () => [] }) }) });
  Remark.countDocuments = async () => 0;
  Announcement.countDocuments = async () => 0;
  const marked = new Date('2026-09-10T10:00:00Z');
  Schedule.find = () => ({ select: () => ({ lean: async () => [
    // created before the user last looked, only touched now because attendance was marked
    { createdAt: new Date('2026-08-20'), updatedAt: marked, attendanceMarkedAt: marked },
    // created before, then genuinely rescheduled later
    { createdAt: new Date('2026-08-20'), updatedAt: new Date('2026-09-12T10:00:00Z'), attendanceMarkedAt: marked },
  ] }) });
  try {
    const res = mockRes();
    await getBadges({ user: { _id: 'u1' } }, res);
    assert.equal(res._body.badges.schedule, 1);
  } finally {
    User.findById = origs.uFindById; User.updateOne = origs.uUpdateOne; Enrollment.distinct = origs.eDistinct; Schedule.find = origs.sFind;
    Remark.countDocuments = origs.rCount; Announcement.countDocuments = origs.aCount; Enrollment.find = origs.eFind;
  }
});

test('getBadges (tutor): new students, schedule changes, unmarked past sessions; only REAL assessments count', async () => {
  const origs = {
    uFindById: User.findById, uUpdateOne: User.updateOne, sFind: Schedule.find, sCount: Schedule.countDocuments,
    aCount: Announcement.countDocuments, eCount: Enrollment.countDocuments,
  };
  const seen = new Date('2026-09-01T00:00:00Z');
  const captured = {};
  User.findById = () => ({ select: async () => userDoc('tutor', { students: seen, assessments: seen, schedule: seen, announcements: seen }) });
  User.updateOne = async () => {};
  // Schedule.find is used for: schedule changes (updatedAt), newly created, earlier, and all assigned.
  Schedule.find = (f) => ({
    select: () => ({
      lean: async () => {
        if (f.updatedAt) return [{ createdAt: new Date('2026-09-10'), updatedAt: new Date('2026-09-10') }, { createdAt: new Date('2026-09-11'), updatedAt: new Date('2026-09-11') }];
        if (f.createdAt?.$gt) return [{ student: 'new-kid' }, { student: 'old-kid' }];
        if (f.createdAt?.$lte) return [{ student: 'old-kid' }];
        return [{ student: 'new-kid' }, { student: 'old-kid' }];
      },
    }),
  });
  Schedule.countDocuments = async (f) => { captured.unmarked = f; return 2; };
  Announcement.countDocuments = async () => 1;
  Enrollment.countDocuments = async (f) => { captured.assessment = f; return 1; };
  try {
    const res = mockRes();
    await getBadges({ user: { _id: 'u1' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.deepEqual(res._body.badges, { students: 1, assessments: 1, schedule: 2, attendance: 2, announcements: 1 });
    assert.equal(captured.unmarked.attendanceStatus, 'unmarked');
    assert.equal(captured.assessment['preEnrollmentAssessment.applicable'], true, 'skipped assessments must not count');
    assert.deepEqual(captured.assessment.student, { $in: ['new-kid', 'old-kid'] });
  } finally {
    User.findById = origs.uFindById; User.updateOne = origs.uUpdateOne; Schedule.find = origs.sFind; Schedule.countDocuments = origs.sCount;
    Announcement.countDocuments = origs.aCount; Enrollment.countDocuments = origs.eCount;
  }
});

test('getBadges (parent): counts are scoped to the SELECTED child - switching child never carries over another child balance or seen state', async () => {
  const origs = {
    uFindById: User.findById, uUpdateOne: User.updateOne, eDistinct: Enrollment.distinct, eFind: Enrollment.find,
    sFind: Schedule.find, rCount: Remark.countDocuments, aCount: Announcement.countDocuments, pFind: Payment.find,
  };
  const seenLegacy = new Date('2026-09-01T00:00:00Z');
  const seenLeo = new Date('2026-09-20T00:00:00Z');
  const cap = {};
  User.findById = () => ({ select: async () => userDoc('parent', { schedule: seenLegacy, progress: seenLegacy, announcements: seenLegacy, 'schedule@BB-LEO': seenLeo }) });
  User.updateOne = async (_f, u) => { cap.baseline = u; };
  Enrollment.distinct = async (_field, f) => { cap.distinctFilter = f; return f.$or[0].permanentStudentId === 'BB-LEO' ? ['leo-user'] : ['jake-user']; };
  Schedule.find = (f) => { cap.scheduleFilter = f; return { select: () => ({ lean: async () => [] }) }; };
  Remark.countDocuments = async () => 0;
  Announcement.countDocuments = async () => 0;
  // Only Leo has an unpaid balance; the Enrollment.find filter must be limited to the chosen child.
  Enrollment.find = (f) => {
    cap.balanceFilter = f;
    const leoOnly = f.$or?.[0]?.permanentStudentId === 'BB-LEO';
    return { populate: () => ({ select: () => ({ lean: async () => (leoOnly ? [{ _id: 'e-leo', parent: { _id: 'u1' }, status: 'approved', totalFee: 2400 }] : []) }) }) };
  };
  Payment.find = () => ({ select: () => ({ lean: async () => [{ enrollment: 'e-leo', status: 'verified', paymentType: 'down', amountPaid: 1200 }] }) });
  try {
    const leo = mockRes();
    await getBadges({ user: { _id: 'u1' }, query: { childKey: 'BB-LEO' } }, leo);
    assert.equal(leo._body.badges.payments, 1, 'Leo owes the remaining 50%');
    assert.deepEqual(cap.distinctFilter.$or, [{ permanentStudentId: 'BB-LEO' }]);
    assert.deepEqual(cap.scheduleFilter.$or[0], { student: { $in: ['leo-user'] } });

    const jake = mockRes();
    await getBadges({ user: { _id: 'u1' }, query: { childKey: 'BB-JAKE' } }, jake);
    assert.equal(jake._body.badges.payments, 0, "Jake is fully paid - Leo's badge must not carry over");
    assert.deepEqual(cap.scheduleFilter.$or[0], { student: { $in: ['jake-user'] } });
    assert.equal(cap.baseline, undefined, 'the older per-section seen value is the fallback, so no baseline write is needed');
  } finally {
    User.findById = origs.uFindById; User.updateOne = origs.uUpdateOne; Enrollment.distinct = origs.eDistinct; Enrollment.find = origs.eFind;
    Schedule.find = origs.sFind; Remark.countDocuments = origs.rCount; Announcement.countDocuments = origs.aCount; Payment.find = origs.pFind;
  }
});

test('markSectionSeen (parent): clears only the selected child new badge; a hostile childKey is ignored', async () => {
  const origUpdate = User.updateOne;
  const calls = [];
  User.updateOne = async (f, u) => { calls.push(u); };
  try {
    await markSectionSeen({ user: { _id: 'u1', role: 'parent' }, body: { section: 'schedule', childKey: 'BB-LEO' } }, mockRes());
    assert.ok(calls[0].$set['navSeen.schedule@BB-LEO'] instanceof Date);
    await markSectionSeen({ user: { _id: 'u1', role: 'parent' }, body: { section: 'schedule', childKey: 'a.b$c' } }, mockRes());
    assert.ok(calls[1].$set['navSeen.schedule'] instanceof Date, 'unsafe key falls back to the section-level key');
  } finally { User.updateOne = origUpdate; }
});

test('markSectionSeen: only sections that carry a "new" badge for the caller\'s role can be marked', async () => {
  const origUpdate = User.updateOne;
  const calls = [];
  User.updateOne = async (f, u) => { calls.push(u); };
  try {
    const ok = mockRes();
    await markSectionSeen({ user: { _id: 'u1', role: 'parent' }, body: { section: 'schedule' } }, ok);
    assert.equal(ok._status, 200);
    assert.ok(calls[0].$set['navSeen.schedule'] instanceof Date);

    const bad = mockRes();
    await markSectionSeen({ user: { _id: 'u1', role: 'parent' }, body: { section: 'payments' } }, bad);
    assert.equal(bad._status, 400, 'Payments is an action count, not a "new" badge');

    const wrongRole = mockRes();
    await markSectionSeen({ user: { _id: 'u1', role: 'admin' }, body: { section: 'schedule' } }, wrongRole);
    assert.equal(wrongRole._status, 400);
    assert.equal(calls.length, 1);
  } finally { User.updateOne = origUpdate; }
});
