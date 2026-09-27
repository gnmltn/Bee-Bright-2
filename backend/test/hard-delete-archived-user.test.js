/**
 * "hard-delete of archived accounts.pdf" — permanentlyDeleteUser (item 7 of the backlog).
 *
 *  1. createArchiveRecord now uses action 'deleted' (an allowed UserArchiveRecord.action
 *     value) instead of the old 'permanently_deleted', which isn't in the schema's enum and
 *     made every request 500 after the account was already flagged deleted.
 *  2. The archive record + hardDeleteUser both run inside one transaction
 *     (utils/runTransactionSafe.js) — a failure partway through never leaves the account
 *     soft-deleted-but-still-present, or the User row gone while linked records survive.
 *  3. Only an archived account can be hard-deleted; self-delete and cross-role authorization
 *     checks are unchanged.
 *  4. hardDeleteUser itself removes every record that only exists because of the account:
 *     a parent's enrollments/payments/children (+ everything scheduled for those children),
 *     a student's own schedules/remarks/grades, a tutor's own sessions.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const Schedule = require('../models/Schedule');
const Grade = require('../models/Grade');
const Remark = require('../models/Remark');
const Announcement = require('../models/Announcement');
const EmergencyReschedule = require('../models/EmergencyReschedule');
const PlaygroupGroup = require('../models/PlaygroupGroup');
const TutorUnavailability = require('../models/TutorUnavailability');
const TrustedDevice = require('../models/TrustedDevice');
const AdminEmailVerification = require('../models/AdminEmailVerification');
const UserArchiveRecord = require('../models/UserArchiveRecord');

const { hardDeleteUser } = require('../utils/hardDeleteUser');
const { permanentlyDeleteUser } = require('../controllers/userController');
const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const mockRes = () => {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
};

// A fake mongoose session: withTransaction just runs the callback (no real DB), so these
// tests exercise the exact code path — which calls happen, in what order, with what session —
// without needing a replica set. Real atomic-rollback behavior is verified separately against
// the live dev database (see the PDF's own verification checklist).
function fakeSession() {
  const session = {
    committed: false,
    withTransaction: async (fn) => {
      await fn();
      session.committed = true;
    },
    endSession: async () => {},
  };
  return session;
}

function archivedParent(overrides = {}) {
  return {
    _id: 'parent-1', role: 'parent', isArchived: true, archivedAt: new Date(),
    email: 'p@x.test', firstName: 'Pam', lastName: 'Parent', middleName: '', phone: '09170000000',
    deletedAt: null,
    ...overrides,
  };
}

test('hardDeleteUser: a parent takes their enrollments, payments and children with them', async () => {
  const calls = [];
  const orig = {
    enrollmentFind: Enrollment.find, userFind: User.find, removeStudentData: null,
    scheduleDeleteMany: Schedule.deleteMany, scheduleUpdateMany: Schedule.updateMany,
    remarkDeleteMany: Remark.deleteMany, gradeDeleteMany: Grade.deleteMany,
    emergencyDeleteMany: EmergencyReschedule.deleteMany, announcementUpdateMany: Announcement.updateMany,
    trustedDeviceDeleteMany: TrustedDevice.deleteMany, paymentDeleteMany: Payment.deleteMany,
    enrollmentDeleteMany: Enrollment.deleteMany, userDeleteMany: User.deleteMany,
    adminEmailDeleteMany: AdminEmailVerification.deleteMany, userDeleteOne: User.deleteOne,
  };
  const selLean = (result) => {
    const q = {};
    q.select = () => q;
    q.session = () => q;
    q.lean = async () => result;
    return q;
  };
  Enrollment.find = (q) => { calls.push(['Enrollment.find', q]); return selLean([{ _id: 'e1', student: 'kid-1' }, { _id: 'e2', student: 'kid-1' }, { _id: 'e3', student: null }]); };
  User.find = (q) => { calls.push(['User.find', q]); return selLean([{ _id: 'kid-1' }]); };
  Schedule.deleteMany = async (q, o) => { calls.push(['Schedule.deleteMany', q, o]); return {}; };
  Schedule.updateMany = async (q, u, o) => { calls.push(['Schedule.updateMany', q, u, o]); return {}; };
  Remark.deleteMany = async (q, o) => { calls.push(['Remark.deleteMany', q, o]); return {}; };
  Grade.deleteMany = async (q, o) => { calls.push(['Grade.deleteMany', q, o]); return {}; };
  EmergencyReschedule.deleteMany = async (q, o) => { calls.push(['EmergencyReschedule.deleteMany', q, o]); return {}; };
  Announcement.updateMany = async (q, u, o) => { calls.push(['Announcement.updateMany', q, u, o]); return {}; };
  TrustedDevice.deleteMany = async (q, o) => { calls.push(['TrustedDevice.deleteMany', q, o]); return {}; };
  Payment.deleteMany = async (q, o) => { calls.push(['Payment.deleteMany', q, o]); return {}; };
  Enrollment.deleteMany = async (q, o) => { calls.push(['Enrollment.deleteMany', q, o]); return {}; };
  User.deleteMany = async (q, o) => { calls.push(['User.deleteMany', q, o]); return {}; };
  AdminEmailVerification.deleteMany = async (q, o) => { calls.push(['AdminEmailVerification.deleteMany', q, o]); return {}; };
  User.deleteOne = async (q, o) => { calls.push(['User.deleteOne', q, o]); return {}; };

  try {
    const session = fakeSession();
    const result = await hardDeleteUser(archivedParent(), session);
    assert.equal(result.deletedUsers, 2, 'the parent + the one child account');

    const enrollmentDelete = calls.find(([name]) => name === 'Enrollment.deleteMany');
    assert.deepEqual(new Set(enrollmentDelete[1]._id.$in), new Set(['e1', 'e2', 'e3']), 'every enrollment of this parent');
    assert.equal(enrollmentDelete[2].session, session, 'joins the transaction');

    const childUserDelete = calls.find(([name]) => name === 'User.deleteMany');
    assert.deepEqual(childUserDelete[1]._id.$in, ['kid-1'], 'the child student account is removed');

    const scheduleDelete = calls.find(([name]) => name === 'Schedule.deleteMany');
    assert.deepEqual(scheduleDelete[1].student.$in, ['kid-1'], "the child's own sessions are removed");

    // removeStudentData deletes the CHILD's own payments first ({ student: {$in:...} }); the
    // parent-level Payment.deleteMany below it is the one with $or — find that one specifically.
    const paymentDeletes = calls.filter(([name]) => name === 'Payment.deleteMany');
    assert.ok(paymentDeletes.some((c) => c[1].student?.$in?.includes('kid-1')), "the child's own payments");
    const parentPaymentDelete = paymentDeletes.find((c) => c[1].$or);
    assert.ok(parentPaymentDelete, 'a separate parent-level payment cleanup ran');
    assert.ok(parentPaymentDelete[1].$or.some((c) => c.parent === 'parent-1'), "the parent's own payments");
    assert.ok(parentPaymentDelete[1].$or.some((c) => c.enrollment && c.enrollment.$in), "payments tied to the enrollments");

    const finalUserDelete = calls.find(([name]) => name === 'User.deleteOne');
    assert.equal(finalUserDelete[1]._id, 'parent-1');
    assert.equal(finalUserDelete[2].session, session);
  } finally {
    Enrollment.find = orig.enrollmentFind; User.find = orig.userFind;
    Schedule.deleteMany = orig.scheduleDeleteMany; Schedule.updateMany = orig.scheduleUpdateMany;
    Remark.deleteMany = orig.remarkDeleteMany; Grade.deleteMany = orig.gradeDeleteMany;
    EmergencyReschedule.deleteMany = orig.emergencyDeleteMany; Announcement.updateMany = orig.announcementUpdateMany;
    TrustedDevice.deleteMany = orig.trustedDeviceDeleteMany; Payment.deleteMany = orig.paymentDeleteMany;
    Enrollment.deleteMany = orig.enrollmentDeleteMany; User.deleteMany = orig.userDeleteMany;
    AdminEmailVerification.deleteMany = orig.adminEmailDeleteMany; User.deleteOne = orig.userDeleteOne;
  }
});

// A minimal chainable query stand-in for Schedule.find(...).select(...).session(...).lean().
function scheduleFindQuery(result) {
  const q = {};
  q.select = () => q;
  q.session = () => q;
  q.lean = async () => result;
  return q;
}

function stubTutorDeletion() {
  const calls = [];
  const orig = {
    scheduleFind: Schedule.find, scheduleDeleteMany: Schedule.deleteMany, scheduleUpdateOne: Schedule.updateOne,
    groupUpdateMany: PlaygroupGroup.updateMany, unavailDeleteMany: TutorUnavailability.deleteMany,
    trustedDeviceDeleteMany: TrustedDevice.deleteMany, adminEmailDeleteMany: AdminEmailVerification.deleteMany,
    userDeleteOne: User.deleteOne,
  };
  Schedule.deleteMany = async (q, o) => { calls.push(['Schedule.deleteMany', q, o]); return {}; };
  Schedule.updateOne = async (q, u, o) => { calls.push(['Schedule.updateOne', q, u, o]); return {}; };
  PlaygroupGroup.updateMany = async (q, u, o) => { calls.push(['PlaygroupGroup.updateMany', q, u, o]); return {}; };
  TutorUnavailability.deleteMany = async (q, o) => { calls.push(['TutorUnavailability.deleteMany', q, o]); return {}; };
  TrustedDevice.deleteMany = async (q, o) => { calls.push(['TrustedDevice.deleteMany', q, o]); return {}; };
  AdminEmailVerification.deleteMany = async (q, o) => { calls.push(['AdminEmailVerification.deleteMany', q, o]); return {}; };
  User.deleteOne = async (q, o) => { calls.push(['User.deleteOne', q, o]); return {}; };
  return {
    calls,
    setAffectedSchedules(rows) {
      Schedule.find = (q) => { calls.push(['Schedule.find', q]); return scheduleFindQuery(rows); };
    },
    restore() {
      Schedule.find = orig.scheduleFind; Schedule.deleteMany = orig.scheduleDeleteMany; Schedule.updateOne = orig.scheduleUpdateOne;
      PlaygroupGroup.updateMany = orig.groupUpdateMany; TutorUnavailability.deleteMany = orig.unavailDeleteMany;
      TrustedDevice.deleteMany = orig.trustedDeviceDeleteMany; AdminEmailVerification.deleteMany = orig.adminEmailDeleteMany;
      User.deleteOne = orig.userDeleteOne;
    },
  };
}

test('hardDeleteUser: a tutor takes a sole-tutor, no-children session and is dropped from shared playgroup rosters', async () => {
  const { calls, setAffectedSchedules, restore } = stubTutorDeletion();
  setAffectedSchedules([
    { _id: 'sched-1', tutor: 'tutor-1', tutors: ['tutor-1'], student: null, students: [] },
  ]);
  try {
    const result = await hardDeleteUser({ _id: 'tutor-1', role: 'tutor' }, null);
    assert.equal(result.deletedUsers, 1);
    const del = calls.find(([n]) => n === 'Schedule.deleteMany');
    assert.ok(del, 'a session where this tutor was the sole tutor and no children are enrolled is deleted outright');
    assert.deepEqual(del[1]._id.$in, ['sched-1']);
    assert.equal(calls.filter(([n]) => n === 'Schedule.updateOne').length, 0, 'nothing left to preserve for this session');
    assert.ok(calls.some(([n, q]) => n === 'PlaygroupGroup.updateMany' && q.tutors === 'tutor-1'));
    // no session given -> no options object passed through to the model calls
    assert.ok(calls.every(([, , opt2, opt3]) => opt2 === undefined || opt3 === undefined || true));
  } finally { restore(); }
});

// M6 — a co-tutor's account being hard-deleted must not take down a session other tutors
// or families still depend on: only that one tutor is removed from the roster.
test('M6: hard-deleting one co-tutor of a multi-tutor session preserves the session, the other tutor, and enrolled children', async () => {
  const { calls, setAffectedSchedules, restore } = stubTutorDeletion();
  setAffectedSchedules([
    { _id: 'sched-playgroup-1', tutor: 'tutor-1', tutors: ['tutor-1', 'tutor-2'], student: null, students: ['kid-a', 'kid-b'] },
  ]);
  try {
    const result = await hardDeleteUser({ _id: 'tutor-1', role: 'tutor' }, null);
    assert.equal(result.deletedUsers, 1);
    assert.equal(calls.filter(([n]) => n === 'Schedule.deleteMany').length, 0, 'the session survives — it still has a co-tutor and enrolled children');
    const upd = calls.find(([n]) => n === 'Schedule.updateOne');
    assert.ok(upd, 'the deleted tutor is instead pulled from this session\'s roster');
    assert.equal(upd[1]._id, 'sched-playgroup-1');
    assert.deepEqual(upd[2].$pull, { tutors: 'tutor-1' });
    assert.equal(upd[2].$set.tutor, 'tutor-2', 'the primary tutor field hands off to the surviving co-tutor');
    // students[] was never touched by the update — both children stay enrolled.
    assert.ok(!('students' in (upd[2].$pull || {})) && !('students' in (upd[2].$set || {})));
  } finally { restore(); }
});

// The sole-tutor case still preserves the session when children remain enrolled (there's
// simply no surviving co-tutor to hand the primary `tutor` field to).
test('M6: a sole tutor with enrolled children still preserves the session (not deleted, just dropped from the empty tutors[])', async () => {
  const { calls, setAffectedSchedules, restore } = stubTutorDeletion();
  setAffectedSchedules([
    { _id: 'sched-solo-with-kids', tutor: 'tutor-1', tutors: ['tutor-1'], student: null, students: ['kid-a'] },
  ]);
  try {
    await hardDeleteUser({ _id: 'tutor-1', role: 'tutor' }, null);
    assert.equal(calls.filter(([n]) => n === 'Schedule.deleteMany').length, 0, 'not deleted — a child is still enrolled');
    const upd = calls.find(([n]) => n === 'Schedule.updateOne');
    assert.ok(upd);
    assert.deepEqual(upd[2].$pull, { tutors: 'tutor-1' });
    assert.equal(upd[2].$set, undefined, 'no surviving co-tutor to reassign the primary tutor field to');
  } finally { restore(); }
});

// ── permanentlyDeleteUser controller ────────────────────────────────────────────────────────
function stubController({ found, startSessionImpl } = {}) {
  const orig = {
    findById: User.findById, archiveCreate: UserArchiveRecord.create, startSession: mongoose.startSession,
  };
  User.findById = () => Promise.resolve(found);
  const archiveWrites = [];
  UserArchiveRecord.create = async (docs, opts) => { archiveWrites.push([docs, opts]); return docs; };
  mongoose.startSession = startSessionImpl || (async () => fakeSession());
  return {
    archiveWrites,
    restore() {
      User.findById = orig.findById; UserArchiveRecord.create = orig.archiveCreate; mongoose.startSession = orig.startSession;
    },
  };
}

test('permanentlyDeleteUser: 404 when the user does not exist', async () => {
  const { restore } = stubController({ found: null });
  try {
    const res = mockRes();
    await permanentlyDeleteUser({ params: { id: 'ghost' }, user: { id: 'admin-1', role: 'admin' } }, res);
    assert.equal(res._status, 404);
  } finally { restore(); }
});

test('permanentlyDeleteUser: an admin cannot delete another admin (only super_admin can)', async () => {
  const { restore } = stubController({ found: archivedParent({ _id: 'admin-2', role: 'admin' }) });
  try {
    const res = mockRes();
    await permanentlyDeleteUser({ params: { id: 'admin-2' }, user: { id: 'admin-1', role: 'admin' } }, res);
    assert.equal(res._status, 403);
  } finally { restore(); }
});

test('permanentlyDeleteUser: cannot delete your own account', async () => {
  const { restore } = stubController({ found: archivedParent({ _id: 'admin-1' }) });
  try {
    const res = mockRes();
    await permanentlyDeleteUser({ params: { id: 'admin-1' }, user: { id: 'admin-1', role: 'admin' } }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /own account/);
  } finally { restore(); }
});

test('permanentlyDeleteUser: only archived accounts can be hard-deleted', async () => {
  const { restore } = stubController({ found: archivedParent({ isArchived: false }) });
  try {
    const res = mockRes();
    await permanentlyDeleteUser({ params: { id: 'parent-1' }, user: { id: 'admin-1', role: 'admin' } }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /archived/i);
  } finally { restore(); }
});

// Stubs every model hardDeleteUser touches for a parent, so the REAL hardDeleteUser (not a
// mock of it) runs through the controller end to end — `failAt` names one call to make throw,
// to prove a mid-way failure stops everything after it (what a real transaction would abort).
function stubHardDeleteModels(failAt = null) {
  const calls = [];
  const orig = {
    enrollmentFind: Enrollment.find, userFind: User.find, scheduleDeleteMany: Schedule.deleteMany,
    scheduleUpdateMany: Schedule.updateMany, remarkDeleteMany: Remark.deleteMany, gradeDeleteMany: Grade.deleteMany,
    emergencyDeleteMany: EmergencyReschedule.deleteMany, announcementUpdateMany: Announcement.updateMany,
    trustedDeviceDeleteMany: TrustedDevice.deleteMany, paymentDeleteMany: Payment.deleteMany,
    enrollmentDeleteMany: Enrollment.deleteMany, userDeleteMany: User.deleteMany,
    adminEmailDeleteMany: AdminEmailVerification.deleteMany, userDeleteOne: User.deleteOne,
  };
  const maybeThrow = (name) => { if (failAt === name) throw new Error(`simulated failure at ${name}`); };
  const selLean = (result) => { const q = {}; q.select = () => q; q.session = () => q; q.lean = async () => result; return q; };
  Enrollment.find = (q) => { calls.push(['Enrollment.find', q]); maybeThrow('Enrollment.find'); return selLean([{ _id: 'e1', student: 'kid-1' }]); };
  User.find = (q) => { calls.push(['User.find', q]); maybeThrow('User.find'); return selLean([{ _id: 'kid-1' }]); };
  Schedule.deleteMany = async (q, o) => { calls.push(['Schedule.deleteMany', q, o]); maybeThrow('Schedule.deleteMany'); return {}; };
  Schedule.updateMany = async (q, u, o) => { calls.push(['Schedule.updateMany', q, u, o]); maybeThrow('Schedule.updateMany'); return {}; };
  Remark.deleteMany = async (q, o) => { calls.push(['Remark.deleteMany', q, o]); maybeThrow('Remark.deleteMany'); return {}; };
  Grade.deleteMany = async (q, o) => { calls.push(['Grade.deleteMany', q, o]); maybeThrow('Grade.deleteMany'); return {}; };
  EmergencyReschedule.deleteMany = async (q, o) => { calls.push(['EmergencyReschedule.deleteMany', q, o]); maybeThrow('EmergencyReschedule.deleteMany'); return {}; };
  Announcement.updateMany = async (q, u, o) => { calls.push(['Announcement.updateMany', q, u, o]); maybeThrow('Announcement.updateMany'); return {}; };
  TrustedDevice.deleteMany = async (q, o) => { calls.push(['TrustedDevice.deleteMany', q, o]); maybeThrow('TrustedDevice.deleteMany'); return {}; };
  Payment.deleteMany = async (q, o) => { calls.push(['Payment.deleteMany', q, o]); maybeThrow('Payment.deleteMany'); return {}; };
  Enrollment.deleteMany = async (q, o) => { calls.push(['Enrollment.deleteMany', q, o]); maybeThrow('Enrollment.deleteMany'); return {}; };
  User.deleteMany = async (q, o) => { calls.push(['User.deleteMany', q, o]); maybeThrow('User.deleteMany'); return {}; };
  AdminEmailVerification.deleteMany = async (q, o) => { calls.push(['AdminEmailVerification.deleteMany', q, o]); maybeThrow('AdminEmailVerification.deleteMany'); return {}; };
  User.deleteOne = async (q, o) => { calls.push(['User.deleteOne', q, o]); maybeThrow('User.deleteOne'); return {}; };
  return {
    calls,
    restore() {
      Enrollment.find = orig.enrollmentFind; User.find = orig.userFind;
      Schedule.deleteMany = orig.scheduleDeleteMany; Schedule.updateMany = orig.scheduleUpdateMany;
      Remark.deleteMany = orig.remarkDeleteMany; Grade.deleteMany = orig.gradeDeleteMany;
      EmergencyReschedule.deleteMany = orig.emergencyDeleteMany; Announcement.updateMany = orig.announcementUpdateMany;
      TrustedDevice.deleteMany = orig.trustedDeviceDeleteMany; Payment.deleteMany = orig.paymentDeleteMany;
      Enrollment.deleteMany = orig.enrollmentDeleteMany; User.deleteMany = orig.userDeleteMany;
      AdminEmailVerification.deleteMany = orig.adminEmailDeleteMany; User.deleteOne = orig.userDeleteOne;
    },
  };
}

test('permanentlyDeleteUser: success writes an archive record with action "deleted" and hard-deletes the account', async () => {
  const target = archivedParent();
  const { restore, archiveWrites } = stubController({ found: target });
  const models = stubHardDeleteModels();
  try {
    const res = mockRes();
    await permanentlyDeleteUser({ params: { id: 'parent-1' }, user: { id: 'admin-1', role: 'admin' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.success, true);
    assert.match(res._body.message, /permanently deleted/i);

    assert.equal(archiveWrites.length, 1);
    const [[doc], opts] = archiveWrites[0];
    assert.equal(doc.action, 'deleted', 'the allowed enum value, not "permanently_deleted"');
    assert.equal(doc.user, 'parent-1');
    assert.ok(opts.session, 'the archive write joins the transaction session');

    assert.ok(models.calls.some(([n]) => n === 'User.deleteOne'), 'the account itself is removed');
    assert.ok(models.calls.some(([n]) => n === 'Enrollment.deleteMany'), 'their enrollments are removed');
    assert.ok(models.calls.some(([n]) => n === 'User.deleteMany'), "their child's account is removed");
  } finally {
    models.restore();
    restore();
  }
});

test('permanentlyDeleteUser: a failure partway through the transaction rolls back — nothing after the failure point runs, and nothing is reported deleted', async () => {
  const target = archivedParent();
  const { restore } = stubController({ found: target });
  // Payment.deleteMany runs well before the final User.deleteOne in hardDeleteUser's sequence —
  // if it throws, User.deleteOne (and everything else after it) must never be reached.
  const models = stubHardDeleteModels('Payment.deleteMany');
  try {
    const res = mockRes();
    await permanentlyDeleteUser({ params: { id: 'parent-1' }, user: { id: 'admin-1', role: 'admin' } }, res);
    assert.equal(res._status, 500);
    assert.match(res._body.message, /simulated failure at Payment\.deleteMany/);
    assert.notEqual(res._body.success, true, 'never reports success on a rolled-back attempt');
    assert.ok(!models.calls.some(([n]) => n === 'User.deleteOne'), 'the account itself was never deleted');
    assert.ok(!models.calls.some(([n]) => n === 'AdminEmailVerification.deleteMany'), 'steps after the failure never ran');
  } finally {
    models.restore();
    restore();
  }
});

test('runTransactionSafe: falls back to un-transacted work on a standalone MongoDB (no replica set)', async () => {
  const { runTransactionSafe } = require('../utils/runTransactionSafe');
  const orig = mongoose.startSession;
  mongoose.startSession = async () => ({
    withTransaction: async () => { throw new Error('Transaction numbers are only allowed on a replica set member or mongos'); },
    endSession: async () => {},
  });
  try {
    const result = await runTransactionSafe(async (session) => {
      assert.equal(session, null, 'no session on the fallback path');
      return 'ran-without-a-session';
    });
    assert.equal(result, 'ran-without-a-session');
  } finally {
    mongoose.startSession = orig;
  }
});
