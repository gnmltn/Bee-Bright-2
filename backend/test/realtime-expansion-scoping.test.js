/**
 * "bug (17).pdf" — real-time push expanded to Parent and Tutor dashboards. This file
 * covers SCOPING specifically (the part most likely to have a subtle bug, per the
 * request that drove this expansion): every emit call must reach exactly the
 * parent(s)/tutor(s) actually affected by that event, never a bystander.
 *
 * The Socket.io transport itself (utils/realtime.js's io instance) is never exercised
 * here — `io` stays null under `node --test` (initRealtime only runs from server.js), so
 * emitToAdmins/emitToParent(s)/emitToTutor(s) are safe no-ops UNLESS mocked. Same
 * require-time function-binding gotcha as elsewhere this session: the mock must be set
 * BEFORE requiring the controller under test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const mongoose = require('mongoose');
mongoose.startSession = async () => ({
  withTransaction: async (fn) => { await fn(); },
  endSession: async () => {},
});

const realtime = require('../utils/realtime');
const emitted = { admin: [], parent: {}, tutor: {} };
function resetEmitted() { emitted.admin = []; emitted.parent = {}; emitted.tutor = {}; }
realtime.emitToAdmins = (event, payload) => emitted.admin.push({ event, payload });
realtime.emitToParent = (id, event, payload) => { (emitted.parent[String(id)] ||= []).push({ event, payload }); };
realtime.emitToParents = (ids, event, payload) => { for (const id of ids || []) (emitted.parent[String(id)] ||= []).push({ event, payload }); };
realtime.emitToTutor = (id, event, payload) => { (emitted.tutor[String(id)] ||= []).push({ event, payload }); };
realtime.emitToTutors = (ids, event, payload) => { for (const id of ids || []) (emitted.tutor[String(id)] ||= []).push({ event, payload }); };

const User = require('../models/User');
const TutorUnavailability = require('../models/TutorUnavailability');
const Schedule = require('../models/Schedule');
const ScheduleSubstitutionLog = require('../models/ScheduleSubstitutionLog');
const Enrollment = require('../models/Enrollment');
const Announcement = require('../models/Announcement');
const Remark = require('../models/Remark');
const Payment = require('../models/Payment');
const emailService = require('../utils/emailService');
emailService.sendEmail = async () => ({ success: true });
emailService.sendAnnouncementEmail = async () => true;
const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const { assignSubstituteTutor } = require('../controllers/scheduleController');
const { createAnnouncement } = require('../controllers/announcementController');
const { reviewRemark, createOrSaveRemark, updateDraftRemark } = require('../controllers/remarkController');
const { verifyPayment } = require('../controllers/paymentController');
const { markRemainingBalancePaidOnsite } = require('../controllers/enrollmentController');

function mockQuery(result) {
  const q = {
    select: () => q, sort: () => q, populate: () => q, limit: () => q, session: () => q, lean: () => q,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch: (fn) => Promise.resolve(result).catch(fn),
  };
  return q;
}
function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

// ─── Schedule substitution: only the outgoing + incoming tutor, and only the actual
//     enrolled child's real parent — never an unrelated tutor or parent. ────────────

test('assignSubstituteTutor: schedule:changed reaches ONLY the outgoing+incoming tutor and the actual enrolled child\'s parent — never a bystander tutor/parent', async () => {
  resetEmitted();
  const schedule = {
    _id: 'sched-1', sessionType: 'one-on-one', date: new Date('2026-09-28T00:00:00.000Z'),
    startTime: '13:00', endTime: '14:00',
    subject: { _id: 'subj-1', name: 'Academic Tutorial', code: 'ACT102' },
    student: { _id: 'student-A', firstName: 'Ana', lastName: 'Cruz' }, students: [],
    tutor: { _id: 'tutor-outgoing', firstName: 'Jake', lastName: 'Soriano', email: 'jake@example.com' },
    tutors: ['tutor-outgoing'], originalTutor: null, substituteTutor: null,
    substitutionStatus: 'none', substitutionAttemptCount: 0,
  };
  schedule.save = async () => schedule;
  const origs = {
    scheduleFindById: Schedule.findById, scheduleFind: Schedule.find,
    userFindOne: User.findOne, userFindById: User.findById,
    tuExists: TutorUnavailability.exists, logCreate: ScheduleSubstitutionLog.create, logExists: ScheduleSubstitutionLog.exists,
    enrollmentFind: Enrollment.find,
  };
  Schedule.findById = () => mockQuery(schedule);
  Schedule.find = () => mockQuery([]);
  User.findOne = ({ _id }) => mockQuery({ _id, role: 'tutor', isActive: true, deletedAt: null, employmentType: 'full-time', availability: '' });
  User.findById = (id) => mockQuery({ _id: id, firstName: 'Incoming', lastName: 'Tutor', email: `${id}@example.com` });
  TutorUnavailability.exists = async () => false;
  ScheduleSubstitutionLog.create = async () => [{}];
  ScheduleSubstitutionLog.exists = async () => false;
  // Only student-A has an enrollment/parent on file — a "bystander" parent (unrelated-parent)
  // must never appear in emitted.parent, proving the resolution is scoped to THIS schedule's
  // actual student, not some broader query.
  Enrollment.find = () => mockQuery([{ student: 'student-A', parent: 'parent-of-A' }]);

  try {
    const res = mockRes();
    await assignSubstituteTutor({ params: { id: 'sched-1' }, user: { id: 'admin-1' }, body: { replacementTutorId: 'tutor-incoming' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));

    // Give the fire-and-forget emitScheduleChanged (inside processSubstitutionForSchedule)
    // a tick to resolve its Enrollment lookup before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(emitted.tutor['tutor-outgoing']?.some((e) => e.event === 'schedule:changed'), 'outgoing tutor notified');
    assert.ok(emitted.tutor['tutor-incoming']?.some((e) => e.event === 'schedule:changed'), 'incoming tutor notified');
    assert.equal(Object.keys(emitted.tutor).length, 2, 'no bystander tutor room was targeted');
    assert.ok(emitted.parent['parent-of-A']?.some((e) => e.event === 'schedule:changed'), 'the actual enrolled child\'s parent notified');
    assert.equal(Object.keys(emitted.parent).length, 1, 'no bystander parent room was targeted');
  } finally {
    Schedule.findById = origs.scheduleFindById; Schedule.find = origs.scheduleFind;
    User.findOne = origs.userFindOne; User.findById = origs.userFindById;
    TutorUnavailability.exists = origs.tuExists; ScheduleSubstitutionLog.create = origs.logCreate; ScheduleSubstitutionLog.exists = origs.logExists;
    Enrollment.find = origs.enrollmentFind;
  }
});

// ─── Announcements: admin broadcast reaches every resolved parent+tutor; a tutor-scoped
//     (targeted-student) announcement reaches ONLY that student's parent. ──────────────

test('createAnnouncement (admin): announcement:new reaches every resolved parent AND tutor, not a subset', async () => {
  resetEmitted();
  const origUserFind = User.find;
  const parents = [{ _id: 'parent-1', email: 'p1@example.com', firstName: 'P', lastName: 'One' }, { _id: 'parent-2', email: 'p2@example.com', firstName: 'P', lastName: 'Two' }];
  const tutors = [{ _id: 'tutor-1', email: 't1@example.com', firstName: 'T', lastName: 'One' }];
  User.find = ({ role }) => mockQuery(role === 'parent' ? parents : tutors);
  const origAnnCreate = Announcement.create;
  const origAnnFindById = Announcement.findById;
  const created = { _id: 'ann-1', title: 'Holiday', body: 'No classes', category: 'holiday' };
  Announcement.create = async () => created;
  Announcement.findById = () => ({ populate: async () => created });
  try {
    const res = mockRes();
    await createAnnouncement({ user: { id: 'admin-1', role: 'admin' }, body: { title: 'Holiday', body: 'No classes', category: 'holiday' } }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.deepEqual(Object.keys(emitted.parent).sort(), ['parent-1', 'parent-2']);
    assert.deepEqual(Object.keys(emitted.tutor).sort(), ['tutor-1']);
  } finally {
    User.find = origUserFind; Announcement.create = origAnnCreate; Announcement.findById = origAnnFindById;
  }
});

test('approveAnnouncement (tutor-authored, student-targeted): announcement:new reaches ONLY the targeted student\'s parent, not an unrelated parent', async () => {
  resetEmitted();
  const { approveAnnouncement } = require('../controllers/announcementController');
  const ann = {
    _id: '507f1f77bcf86cd799439201', status: 'pending', authorRole: 'tutor', author: 'tutor-1',
    title: 'Quiz Friday', body: 'Bring calculator', category: 'quiz',
    targetStudentIds: ['student-A'],
    save: async function () { return this; },
  };
  const origAnnFindById = Announcement.findById;
  Announcement.findById = () => mockQuery(ann);
  const origEnrollmentFind = Enrollment.find;
  // Enrollments exist for two DIFFERENT students system-wide; only the targeted one
  // (student-A) should ever produce an emit — student-B's parent must never appear.
  Enrollment.find = ({ student }) => mockQuery(
    (student.$in || []).map(String).includes('student-A')
      ? [{ student: 'student-A', parent: { _id: 'parent-of-A', firstName: 'A', lastName: 'Parent', email: 'a@example.com' } }]
      : []
  );
  try {
    const res = mockRes();
    await approveAnnouncement({ params: { id: '507f1f77bcf86cd799439201' }, user: { id: 'admin-1', role: 'admin' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.deepEqual(Object.keys(emitted.parent), ['parent-of-A']);
  } finally {
    Announcement.findById = origAnnFindById; Enrollment.find = origEnrollmentFind;
  }
});

// ─── Remarks: only the specific student's real parent, never a sibling's or an
//     unrelated family's parent. ──────────────────────────────────────────────────────

test('reviewRemark (approve): remark:published reaches ONLY that student\'s real parent, AND remark:reviewed reaches the submitting tutor', async () => {
  // "bug (18).pdf" Group AV — the submitting tutor's own emit was missing entirely
  // before this fix (only the parent-facing event existed), so their own Remark History
  // silently stayed on "Pending Admin Review" after an approve.
  resetEmitted();
  const remark = {
    _id: 'remark-1', status: 'pending_admin_review', student: 'student-A', tutor: 'tutor-1', correctionOf: null,
    save: async function () { return this; },
  };
  const origRemarkFindById = Remark.findById;
  Remark.findById = () => mockQuery(remark);
  const origEnrollmentFind = Enrollment.find;
  Enrollment.find = ({ student }) => mockQuery(
    (student.$in || []).map(String).includes('student-A') ? [{ student: 'student-A', parent: 'parent-of-A' }] : []
  );
  try {
    const res = mockRes();
    await reviewRemark({ params: { id: 'remark-1' }, user: { id: 'admin-1', role: 'admin' }, body: { decision: 'approve' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(Object.keys(emitted.parent), ['parent-of-A']);
    assert.deepEqual(Object.keys(emitted.tutor), ['tutor-1']);
    assert.equal(emitted.tutor['tutor-1'][0].event, 'remark:reviewed');
    assert.equal(emitted.tutor['tutor-1'][0].payload.status, 'published');
  } finally {
    Remark.findById = origRemarkFindById; Enrollment.find = origEnrollmentFind;
  }
});

test('reviewRemark (reject): remark:reviewed reaches the submitting tutor — this event was MISSING entirely before the fix (zero emit on reject)', async () => {
  resetEmitted();
  const remark = {
    _id: 'remark-2', status: 'pending_admin_review', student: 'student-A', tutor: 'tutor-1', correctionOf: null,
    save: async function () { return this; },
  };
  const origRemarkFindById = Remark.findById;
  Remark.findById = () => mockQuery(remark);
  try {
    const res = mockRes();
    await reviewRemark({ params: { id: 'remark-2' }, user: { id: 'admin-1', role: 'admin' }, body: { decision: 'reject', reason: 'Needs more detail' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.deepEqual(Object.keys(emitted.tutor), ['tutor-1']);
    assert.equal(emitted.tutor['tutor-1'][0].event, 'remark:reviewed');
    assert.equal(emitted.tutor['tutor-1'][0].payload.status, 'draft');
    assert.equal(Object.keys(emitted.parent).length, 0, 'a rejection is never parent-visible');
  } finally {
    Remark.findById = origRemarkFindById;
  }
});

// ─── Admin Remarks tab (Group AX): submitting a remark was never wired to admin at all. ──

test('createOrSaveRemark (publish): fires emitToAdmins(\'remark:new\', ...) — this was MISSING entirely before the fix (zero emit on submission)', async () => {
  resetEmitted();
  const origScheduleFind = Schedule.find;
  const origRemarkCreate = Remark.create;
  const origRemarkFindById = Remark.findById;
  Schedule.find = () => mockQuery([{ subject: { name: 'Academic Tutorial', code: 'ACT102' } }]);
  const created = { _id: 'remark-new-1', save: async function () { return this; } };
  Remark.create = async () => created;
  Remark.findById = () => mockQuery(created); // populateRemark() on the success response
  try {
    const res = mockRes();
    await createOrSaveRemark({
      user: { _id: 'tutor-1', role: 'tutor' },
      body: {
        studentId: 'student-A', programCode: 'ACT102', action: 'publish',
        date: '2026-09-29', activities: ['Reading'], remarkBullets: ['Doing well'], nextFocus: 'Keep going',
      },
    }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(emitted.admin.length, 1);
    assert.equal(emitted.admin[0].event, 'remark:new');
    assert.equal(Object.keys(emitted.parent).length, 0, 'not parent-visible until approved');
    assert.equal(Object.keys(emitted.tutor).length, 0, 'not a tutor-facing event');
  } finally {
    Schedule.find = origScheduleFind; Remark.create = origRemarkCreate; Remark.findById = origRemarkFindById;
  }
});

test('updateDraftRemark (publish): fires emitToAdmins(\'remark:new\', ...) — the "reopen a draft, then publish" path is a SEPARATE code path from createOrSaveRemark and needed its own emit', async () => {
  resetEmitted();
  const remark = {
    _id: 'remark-new-2', status: 'draft', tutor: 'tutor-1', templateType: 'academic_progress',
    toObject() { return { ...this }; },
    save: async function () { return this; },
  };
  const origRemarkFindOne = Remark.findOne;
  Remark.findOne = () => mockQuery(remark);
  try {
    const res = mockRes();
    await updateDraftRemark({
      params: { id: 'remark-new-2' },
      user: { _id: 'tutor-1', role: 'tutor' },
      body: { action: 'publish', date: '2026-09-29', activities: ['Reading'], remarkBullets: ['Doing well'], nextFocus: 'Keep going' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(emitted.admin.length, 1);
    assert.equal(emitted.admin[0].event, 'remark:new');
  } finally {
    Remark.findOne = origRemarkFindOne;
  }
});

// ─── Payments: only the specific enrollment's own parent. ──────────────────────────────

// ─── Escalations (Admin Requests tab): admin-only, no parent/tutor scoping needed. ──────

test('createEscalation: fires emitToAdmins(\'request:new\', ...) on every successful escalation, admin-scoped only', async () => {
  resetEmitted();
  const Escalation = require('../models/Escalation');
  const { createEscalation } = require('../utils/escalationService');
  const origCreate = Escalation.create;
  Escalation.create = async (doc) => ({ _id: 'esc-1', ...doc });
  try {
    const doc = await createEscalation({ source: 'handoff', category: 'human_requested', trigger: 'QA test' });
    assert.ok(doc, 'escalation was created');
    assert.equal(emitted.admin.length, 1);
    assert.equal(emitted.admin[0].event, 'request:new');
    assert.equal(emitted.admin[0].payload.escalationId, 'esc-1');
    assert.equal(Object.keys(emitted.parent).length, 0, 'never scoped to any parent');
    assert.equal(Object.keys(emitted.tutor).length, 0, 'never scoped to any tutor');
  } finally {
    Escalation.create = origCreate;
  }
});

test('verifyPayment (remaining balance, verify): payment:statusChanged reaches ONLY that enrollment\'s own parent', async () => {
  resetEmitted();
  const enrollment = { _id: 'enr-1', parent: 'parent-of-A', paymentStatus: 'partial', save: async function () { return this; } };
  const payment = { _id: 'pay-1', paymentType: 'remaining', enrollment, save: async function () { return this; } };
  const origPaymentFindById = Payment.findById;
  Payment.findById = () => mockQuery(payment);
  try {
    const res = mockRes();
    await verifyPayment({ params: { paymentId: 'pay-1' }, user: { id: 'admin-1' }, body: { verified: true } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.deepEqual(Object.keys(emitted.parent), ['parent-of-A']);
    assert.equal(emitted.parent['parent-of-A'][0].payload.outcome, 'proof_verified');
  } finally {
    Payment.findById = origPaymentFindById;
  }
});

// "Paid Onsite" (Group AI) previously had ZERO realtime wiring — the parent's Invoice tab
// never learned their remaining balance was marked paid until a manual refresh.
test('markRemainingBalancePaidOnsite: payment:statusChanged reaches ONLY that enrollment\'s own parent — this event was MISSING entirely before the fix', async () => {
  resetEmitted();
  const enrollment = {
    _id: 'enr-1', parent: 'parent-of-A', totalFee: 8000, paymentStatus: 'partial',
    save: async function () { return this; },
  };
  const downPayment = { status: 'verified', amountPaid: 4000, amountDue: 4000, amount: 4000 };
  const existingRemaining = { status: 'submitted', save: async function () { return this; } };
  const origEnrollmentFindById = Enrollment.findById;
  const origPaymentFindOne = Payment.findOne;
  const origUserFindById = User.findById;
  Enrollment.findById = () => mockQuery(enrollment);
  Payment.findOne = (query) => mockQuery(query.paymentType === 'remaining' ? existingRemaining : downPayment);
  User.findById = () => mockQuery({ email: 'parent-a@example.com', firstName: 'Parent', lastName: 'A' });
  try {
    const res = mockRes();
    await markRemainingBalancePaidOnsite({ params: { id: 'enr-1' }, user: { _id: 'admin-1' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.deepEqual(Object.keys(emitted.parent), ['parent-of-A']);
    assert.equal(emitted.parent['parent-of-A'][0].event, 'payment:statusChanged');
    assert.equal(emitted.parent['parent-of-A'][0].payload.outcome, 'paid_onsite');
  } finally {
    Enrollment.findById = origEnrollmentFindById;
    Payment.findOne = origPaymentFindOne;
    User.findById = origUserFindById;
  }
});
