/**
 * Student Remarks feature (v2 — admin approval gate for attachments).
 * Model-stubbing pattern established earlier this session (one-on-one-monthly-schedules,
 * playgroup-group-scheduling, schedule-auto-adjust). Remark itself is stubbed via a
 * small in-memory fake store (not a mockQuery-per-call), since remarkController.js calls
 * Remark.create/findById/findOne/find/updateOne across many functions and several tests
 * need documents to actually persist mutations (`.save()`) between calls in the same test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const Schedule = require('../models/Schedule');
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Remark = require('../models/Remark');
const AuditLog = require('../models/AuditLog');
const {
  createOrSaveRemark,
  updateDraftRemark,
  deleteDraftRemark,
  listMyChildProgress,
  listPendingReview,
  reviewRemark,
  listReviewHistory,
  getRemarkAttachment,
} = require('../controllers/remarkController');

function mockQuery(result) {
  const q = {
    select: () => q,
    sort: () => q,
    populate: () => q,
    limit: () => q,
    lean: () => Promise.resolve(result),
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

function matchesFilter(doc, filter) {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((sub) => matchesFilter(doc, sub));
    if (value && typeof value === 'object' && !Array.isArray(value)) return true; // $gte/$regex etc. — not needed here
    return String(doc[key]) === String(value);
  });
}

function makeFakeRemarkStore() {
  const docs = [];
  let seq = 0;
  return {
    docs,
    async create(data) {
      const id = `remark-${++seq}`;
      const doc = {
        status: 'draft',
        isCurrentVersion: true,
        publishedAt: null,
        rootRemarkId: null,
        correctionOf: null,
        correctionReason: '',
        reviewedBy: null,
        reviewedAt: null,
        rejectionReason: '',
        attachment: undefined,
        ...data,
        _id: id,
      };
      doc.save = async () => doc;
      doc.toObject = () => ({ ...doc });
      docs.push(doc);
      return doc;
    },
    findById(id) {
      return mockQuery(docs.find((d) => String(d._id) === String(id)) || null);
    },
    findOne(filter) {
      return mockQuery(docs.find((d) => matchesFilter(d, filter)) || null);
    },
    find(filter) {
      return mockQuery(docs.filter((d) => matchesFilter(d, filter)));
    },
    async updateOne(filter, update) {
      const doc = docs.find((d) => matchesFilter(d, filter));
      if (doc) Object.assign(doc, update);
      return { acknowledged: true };
    },
    async deleteOne(filter) {
      const idx = docs.findIndex((d) => matchesFilter(d, filter));
      if (idx === -1) return { acknowledged: true, deletedCount: 0 };
      docs.splice(idx, 1);
      return { acknowledged: true, deletedCount: 1 };
    },
  };
}

const TUTOR_A = { id: 'tutor-a', _id: 'tutor-a', role: 'tutor' };
const TUTOR_B = { id: 'tutor-b', _id: 'tutor-b', role: 'tutor' };
const ADMIN = { id: 'admin-1', _id: 'admin-1', role: 'admin', firstName: 'Ada', lastName: 'Minoza' };
const ADMIN_2 = { id: 'admin-2', _id: 'admin-2', role: 'admin', firstName: 'Beni', lastName: 'Cruz' };
const PARENT = { id: 'parent-1', _id: 'parent-1', role: 'parent' };
const SUBJECT_ACT102 = { _id: 'subj-act102', name: 'Academic Tutorial', code: 'ACT102' };
const SUBJECT_TPG101 = { _id: 'subj-tpg101', name: 'Toddlers Playgroup', code: 'TPG101' };

const TINY_PNG_DATA_URL = 'data:image/png;base64,' + Buffer.from('fake-image-bytes').toString('base64');

// AuditLog is a separate collection from Remark — `logAudit()` (utils/auditService.js)
// calls `AuditLog.create` directly, so stubbing the model here also captures every
// real logAudit() call made inside remarkController (Review Remark, Create Remark,
// etc.) exactly like production, rather than needing tests to fabricate log entries.
function matchesAuditFilter(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key.includes('.')) {
      const [outer, inner] = key.split('.');
      return doc[outer]?.[inner] === value;
    }
    return String(doc[key]) === String(value);
  });
}

function makeFakeAuditLogStore() {
  const docs = [];
  let seq = 0;
  return {
    docs,
    async create(data) {
      const id = `audit-${++seq}`;
      // Spaced fake timestamps so "newest first" sort is deterministic even when
      // several entries are created within the same test, same millisecond.
      const doc = { createdAt: new Date(2026, 0, 1, 0, 0, seq), ...data, _id: id };
      docs.push(doc);
      return doc;
    },
    countDocuments: async (filter) => docs.filter((d) => matchesAuditFilter(d, filter)).length,
    find(filter) {
      let results = docs.filter((d) => matchesAuditFilter(d, filter));
      const q = {
        sort(spec) {
          const [key, dir] = Object.entries(spec)[0];
          results = [...results].sort((a, b) => (dir === -1 ? b[key] - a[key] : a[key] - b[key]));
          return q;
        },
        skip(n) { results = results.slice(n); return q; },
        limit(n) { results = results.slice(0, n); return q; },
        lean() { return Promise.resolve(results.map((d) => ({ ...d }))); },
      };
      return q;
    },
  };
}

// `schedules` lets a test simulate a tutor assigned to a student across MULTIPLE
// programs at once (Spec v3) — defaults to a single schedule in `subject`'s program
// when not given explicitly. Pass `schedules: []` (or `tutorHandles: false`) to
// simulate "not assigned to this student in any program."
function stubModels({ tutorHandles = true, subject = SUBJECT_ACT102, schedules, consents = [], auditUserDirectory } = {}) {
  const origScheduleExists = Schedule.exists;
  const origScheduleFind = Schedule.find;
  const origUserFindById = User.findById;
  const origUserFind = User.find;
  const origEnrollmentExists = Enrollment.exists;
  const origRemarkCreate = Remark.create;
  const origRemarkFindById = Remark.findById;
  const origRemarkFindOne = Remark.findOne;
  const origRemarkFind = Remark.find;
  const origRemarkUpdateOne = Remark.updateOne;
  const origRemarkDeleteOne = Remark.deleteOne;
  const origAuditLogCreate = AuditLog.create;
  const origAuditLogFind = AuditLog.find;
  const origAuditLogCountDocuments = AuditLog.countDocuments;
  const origFsWriteFileSync = fs.writeFileSync;
  const origFsExistsSync = fs.existsSync;
  const origFsMkdirSync = fs.mkdirSync;
  const origFsCreateReadStream = fs.createReadStream;
  const origFsUnlinkSync = fs.unlinkSync;

  let capturedExistsQuery = null;
  let capturedFindQuery = null;
  const store = makeFakeRemarkStore();
  const userDirectory = auditUserDirectory || {
    [ADMIN.id]: { firstName: ADMIN.firstName, lastName: ADMIN.lastName },
    [ADMIN_2.id]: { firstName: ADMIN_2.firstName, lastName: ADMIN_2.lastName },
  };
  const auditStore = makeFakeAuditLogStore();
  const scheduleDocs = schedules !== undefined
    ? schedules
    : (tutorHandles && subject ? [{ subject }] : []);

  Schedule.exists = async (query) => { capturedExistsQuery = query; return tutorHandles; };
  Schedule.find = (query) => { capturedFindQuery = query; return mockQuery(scheduleDocs); };
  User.findById = () => mockQuery({ consents });
  // listReviewHistory batch-looks-up admins by id — resolve from the same directory
  // the fake AuditLog store uses, so a "deleted admin account" test can simply leave an
  // id out of the directory instead of needing a second lookup mechanism.
  User.find = (query) => {
    const ids = (query?._id?.$in || []).map(String);
    const users = ids.filter((id) => userDirectory[id]).map((id) => ({ _id: id, ...userDirectory[id] }));
    return mockQuery(users);
  };
  Enrollment.exists = async () => false; // overridden per-test when parent ownership matters
  Remark.create = store.create;
  Remark.findById = store.findById;
  Remark.findOne = store.findOne;
  Remark.find = store.find;
  Remark.updateOne = store.updateOne;
  Remark.deleteOne = store.deleteOne;
  AuditLog.create = auditStore.create;
  AuditLog.find = auditStore.find;
  AuditLog.countDocuments = auditStore.countDocuments;
  fs.writeFileSync = () => {};
  fs.existsSync = () => true;
  fs.mkdirSync = () => {};
  fs.createReadStream = () => ({ pipe: () => {} });
  fs.unlinkSync = () => {};

  return {
    store,
    auditStore,
    getCapturedExistsQuery: () => capturedExistsQuery,
    getCapturedFindQuery: () => capturedFindQuery,
    restore() {
      Schedule.exists = origScheduleExists;
      Schedule.find = origScheduleFind;
      User.findById = origUserFindById;
      User.find = origUserFind;
      Enrollment.exists = origEnrollmentExists;
      Remark.create = origRemarkCreate;
      Remark.findById = origRemarkFindById;
      Remark.findOne = origRemarkFindOne;
      Remark.find = origRemarkFind;
      Remark.updateOne = origRemarkUpdateOne;
      Remark.deleteOne = origRemarkDeleteOne;
      AuditLog.create = origAuditLogCreate;
      AuditLog.find = origAuditLogFind;
      AuditLog.countDocuments = origAuditLogCountDocuments;
      fs.writeFileSync = origFsWriteFileSync;
      fs.existsSync = origFsExistsSync;
      fs.mkdirSync = origFsMkdirSync;
      fs.createReadStream = origFsCreateReadStream;
      fs.unlinkSync = origFsUnlinkSync;
    },
  };
}

function baseBody(overrides = {}) {
  return {
    studentId: 'student-1',
    programCode: 'ACT102',
    action: 'publish',
    date: '2026-09-14',
    activities: ['Reading practice'],
    remarkBullets: ['The student showed improvement in reading fluency.'],
    nextFocus: 'Continue phonics review.',
    ...overrides,
  };
}

test('createOrSaveRemark: Save Draft needs only minimal validation (missing bullets/nextFocus is fine)', async () => {
  const { restore } = stubModels();
  try {
    const res = mockRes();
    await createOrSaveRemark({ user: TUTOR_A, body: baseBody({ action: 'draft', activities: [], remarkBullets: [], nextFocus: '' }) }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(res._body.remark.status, 'draft');
  } finally { restore(); }
});

test('createOrSaveRemark: Publish enforces all required fields', async () => {
  const { restore } = stubModels();
  try {
    const res = mockRes();
    await createOrSaveRemark({ user: TUTOR_A, body: baseBody({ activities: [], remarkBullets: [], nextFocus: '' }) }, res);
    assert.equal(res._status, 400);
    assert.ok(res._body.errors.length >= 3);
    assert.equal(res._body.remark.status, 'draft', 'validation failure keeps the record as Draft, never publishes');
  } finally { restore(); }
});

test('createOrSaveRemark: Toddler template requires all four 1-3 star ratings to publish', async () => {
  const { restore } = stubModels({ subject: SUBJECT_TPG101 });
  try {
    const res = mockRes();
    await createOrSaveRemark({ user: TUTOR_A, body: baseBody({ programCode: 'TPG101', ratings: { participationEngagement: 2, socialInteraction: 3, followingDirections: 2 } }) }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.errors.join(' '), /1-3 star rating/i);
  } finally { restore(); }
});

// Spec v3.1 (2026-09-17): media consent is no longer a tutor-facing blocker anywhere —
// not at upload, not at publish. A remark with an attachment always routes to Pending
// Admin Review on Publish (the pre-existing Option A gate), regardless of whether the
// student's guardian has consent on record. Consent becomes admin-facing information
// at review time instead (see listPendingReview tests below).
test('createOrSaveRemark: publishing with an attachment goes to Pending Admin Review regardless of consent — consent ON record', async () => {
  const { restore } = stubModels({ consents: [{ name: 'media_consent', version: '1.0', acceptedAt: new Date() }] });
  try {
    const res = mockRes();
    await createOrSaveRemark({ user: TUTOR_A, body: baseBody({ attachmentDataUrl: TINY_PNG_DATA_URL }) }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(res._body.remark.status, 'pending_admin_review');
    assert.equal(res._body.remark.publishedAt, null);
    assert.ok(res._body.remark.attachment);
  } finally { restore(); }
});

test('createOrSaveRemark: publishing with an attachment goes to Pending Admin Review regardless of consent — consent NOT on record', async () => {
  const { restore } = stubModels({ consents: [] });
  try {
    const res = mockRes();
    await createOrSaveRemark({ user: TUTOR_A, body: baseBody({ attachmentDataUrl: TINY_PNG_DATA_URL }) }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body), 'the tutor must never be blocked from publishing for missing consent');
    assert.equal(res._body.remark.status, 'pending_admin_review');
    assert.equal(res._body.remark.publishedAt, null);
    assert.ok(res._body.remark.attachment);
  } finally { restore(); }
});

// Invoice_Display_DownPaymentBug_Receipt_RemarksPolicy.pdf F (2026-09-24) replaces
// the attachment-triggered Option A gate entirely: every remark, with or without an
// attachment, now goes to Pending Admin Review before publishing.
test('createOrSaveRemark: publishing with no attachment still goes to Pending Admin Review (policy change)', async () => {
  const { restore } = stubModels();
  try {
    const res = mockRes();
    await createOrSaveRemark({ user: TUTOR_A, body: baseBody() }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(res._body.remark.status, 'pending_admin_review');
    assert.equal(res._body.remark.publishedAt, null);
  } finally { restore(); }
});

test('createOrSaveRemark: assignment check is group-aware (covers Playgroup tutors[]/students[])', async () => {
  const { restore, getCapturedFindQuery } = stubModels({ subject: SUBJECT_TPG101 });
  try {
    const res = mockRes();
    await createOrSaveRemark({
      user: TUTOR_A,
      body: baseBody({ programCode: 'TPG101', action: 'draft', ratings: { participationEngagement: 2, socialInteraction: 2, followingDirections: 2, overallBehavior: 2 } }),
    }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    const q = JSON.stringify(getCapturedFindQuery());
    assert.match(q, /tutors/, 'must check the group tutors[] field, not just the singular tutor');
    assert.match(q, /students/, 'must check the group students[] field, not just the singular student');
  } finally { restore(); }
});

test('createOrSaveRemark: a tutor cannot write a remark for a program they do not actually teach this student in (tutor-student-PROGRAM level check, Spec v3)', async () => {
  // Tutor is assigned to this student, but only in ACT102 — not in EXP106.
  const { restore } = stubModels({ schedules: [{ subject: SUBJECT_ACT102 }] });
  try {
    const res = mockRes();
    await createOrSaveRemark({ user: TUTOR_A, body: baseBody({ programCode: 'EXP106', action: 'draft' }) }, res);
    assert.equal(res._status, 403, JSON.stringify(res._body));
    assert.match(res._body.message, /not assigned to teach this student in that program/i);
  } finally { restore(); }
});

test('createOrSaveRemark: a tutor CAN write a remark for a program when they teach this student in that specific program, even alongside another program', async () => {
  // Tutor teaches this student in both ACT102 and EXP106 (two separate Schedule docs) —
  // requesting EXP106 must succeed even though ACT102 is also present.
  const { restore } = stubModels({ schedules: [{ subject: SUBJECT_ACT102 }, { subject: { _id: 'subj-exp106', name: 'Examination Preparedness', code: 'EXP106' } }] });
  try {
    const res = mockRes();
    await createOrSaveRemark({ user: TUTOR_A, body: baseBody({ programCode: 'EXP106', action: 'draft' }) }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(res._body.remark.programCode, 'EXP106');
  } finally { restore(); }
});

test('reviewRemark: admin approve moves Pending Admin Review to Published', async () => {
  const { restore, store } = stubModels();
  try {
    const remark = await store.create({ student: 'student-1', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress', status: 'pending_admin_review' });
    const res = mockRes();
    await reviewRemark({ user: ADMIN, params: { id: remark._id }, body: { decision: 'approve' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.remark.status, 'published');
    assert.ok(res._body.remark.publishedAt);
    assert.equal(res._body.remark.isCurrentVersion, true);
  } finally { restore(); }
});

test('reviewRemark: admin reject returns the remark to Draft with a reason, requires a reason', async () => {
  const { restore, store } = stubModels();
  try {
    const remark = await store.create({ student: 'student-1', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress', status: 'pending_admin_review' });

    const noReasonRes = mockRes();
    await reviewRemark({ user: ADMIN, params: { id: remark._id }, body: { decision: 'reject' } }, noReasonRes);
    assert.equal(noReasonRes._status, 400);

    const res = mockRes();
    await reviewRemark({ user: ADMIN, params: { id: remark._id }, body: { decision: 'reject', reason: 'Attachment is unrelated to the session.' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.remark.status, 'draft');
    assert.equal(res._body.remark.publishedAt, null);
    assert.equal(res._body.remark.rejectionReason, 'Attachment is unrelated to the session.');
  } finally { restore(); }
});

// ─── listReviewHistory: past approve/reject decisions (reads the AuditLog trail) ────

test('listReviewHistory: lists approve and reject decisions newest first, with admin/student/tutor/program filled in from the remark', async () => {
  const { restore, store } = stubModels();
  try {
    const remarkA = await store.create({ student: 'student-1', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress', status: 'pending_admin_review' });
    const remarkB = await store.create({ student: 'student-2', tutor: TUTOR_B.id, programCode: 'TPG101', templateType: 'toddler_observation', status: 'pending_admin_review' });

    await reviewRemark({ user: ADMIN, params: { id: remarkA._id }, body: { decision: 'approve' } }, mockRes());
    await reviewRemark({ user: ADMIN_2, params: { id: remarkB._id }, body: { decision: 'reject', reason: 'Blurry photo.' } }, mockRes());

    const res = mockRes();
    await listReviewHistory({ query: {} }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.history.length, 2);
    assert.equal(res._body.total, 2);

    // Newest decision (the rejection) first.
    const [first, second] = res._body.history;
    assert.equal(first.decision, 'reject');
    assert.equal(first.reason, 'Blurry photo.');
    assert.equal(first.admin.firstName, ADMIN_2.firstName);
    assert.equal(first.programCode, 'TPG101');
    assert.ok(first.reviewedAt);

    assert.equal(second.decision, 'approve');
    assert.equal(second.admin.firstName, ADMIN.firstName);
    assert.equal(second.programCode, 'ACT102');
  } finally { restore(); }
});

test('listReviewHistory: filters by decision type', async () => {
  const { restore, store } = stubModels();
  try {
    const remarkA = await store.create({ student: 'student-1', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress', status: 'pending_admin_review' });
    const remarkB = await store.create({ student: 'student-2', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress', status: 'pending_admin_review' });
    await reviewRemark({ user: ADMIN, params: { id: remarkA._id }, body: { decision: 'approve' } }, mockRes());
    await reviewRemark({ user: ADMIN, params: { id: remarkB._id }, body: { decision: 'reject', reason: 'Not clear.' } }, mockRes());

    const approvedRes = mockRes();
    await listReviewHistory({ query: { decision: 'approve' } }, approvedRes);
    assert.equal(approvedRes._body.history.length, 1);
    assert.equal(approvedRes._body.history[0].decision, 'approve');

    const rejectedRes = mockRes();
    await listReviewHistory({ query: { decision: 'reject' } }, rejectedRes);
    assert.equal(rejectedRes._body.history.length, 1);
    assert.equal(rejectedRes._body.history[0].decision, 'reject');
  } finally { restore(); }
});

test('listReviewHistory: paginates with a default page size of 20 and reports total/totalPages', async () => {
  const { restore, store } = stubModels();
  try {
    for (let i = 0; i < 25; i++) {
      const r = await store.create({ student: `student-${i}`, tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress', status: 'pending_admin_review' });
      await reviewRemark({ user: ADMIN, params: { id: r._id }, body: { decision: 'approve' } }, mockRes());
    }

    const page1 = mockRes();
    await listReviewHistory({ query: {} }, page1);
    assert.equal(page1._body.history.length, 20, 'default page size is 20');
    assert.equal(page1._body.total, 25);
    assert.equal(page1._body.totalPages, 2);
    assert.equal(page1._body.page, 1);

    const page2 = mockRes();
    await listReviewHistory({ query: { page: '2' } }, page2);
    assert.equal(page2._body.history.length, 5);
    assert.equal(page2._body.page, 2);
  } finally { restore(); }
});

test('listReviewHistory: flags remarkDeleted when the underlying remark was later deleted (e.g. a rejected draft the tutor deleted)', async () => {
  const { restore, store } = stubModels();
  try {
    const remark = await store.create({ student: 'student-1', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress', status: 'pending_admin_review' });
    await reviewRemark({ user: ADMIN, params: { id: remark._id }, body: { decision: 'reject', reason: 'Needs revision.' } }, mockRes());

    // The rejection put it back in Draft, which the tutor is allowed to delete.
    await store.deleteOne({ _id: remark._id });

    const res = mockRes();
    await listReviewHistory({ query: {} }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.history.length, 1);
    const entry = res._body.history[0];
    assert.equal(entry.remarkDeleted, true, 'must be flagged rather than silently showing blank fields');
    assert.equal(entry.decision, 'reject');
    assert.equal(entry.reason, 'Needs revision.', 'the decision reason survives even though the remark itself is gone');
    assert.ok(entry.admin, 'admin identity survives too');
    assert.equal(entry.student, null);
    assert.equal(entry.tutor, null);
    assert.equal(entry.programCode, null);
  } finally { restore(); }
});

test('listReviewHistory: flags adminDeleted when the reviewing admin account no longer exists', async () => {
  // Directory intentionally leaves ADMIN out — simulates the admin's account having
  // since been deleted, while the raw userId is still sitting on the audit entry.
  const { restore, store } = stubModels({ auditUserDirectory: { [ADMIN_2.id]: { firstName: ADMIN_2.firstName, lastName: ADMIN_2.lastName } } });
  try {
    const remark = await store.create({ student: 'student-1', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress', status: 'pending_admin_review' });
    await reviewRemark({ user: ADMIN, params: { id: remark._id }, body: { decision: 'approve' } }, mockRes());

    const res = mockRes();
    await listReviewHistory({ query: {} }, res);
    const entry = res._body.history[0];
    assert.equal(entry.adminDeleted, true, 'must be flagged rather than silently showing a blank reviewer');
    assert.equal(entry.admin, null);
    assert.equal(entry.decision, 'approve', 'decision/reason/remark data survives even without the admin identity resolving');
  } finally { restore(); }
});

test('listMyChildProgress: parent sees only Published + current remarks for their own linked child', async () => {
  const { restore, store } = stubModels();
  const origEnrollmentExists = Enrollment.exists;
  Enrollment.exists = async (q) => q.parent === PARENT.id && q.student === 'child-a';
  try {
    await store.create({ student: 'child-a', tutor: TUTOR_A.id, status: 'draft' });
    await store.create({ student: 'child-a', tutor: TUTOR_A.id, status: 'pending_admin_review' });
    await store.create({ student: 'child-a', tutor: TUTOR_A.id, status: 'published', isCurrentVersion: false });
    const currentOne = await store.create({ student: 'child-a', tutor: TUTOR_A.id, status: 'published', isCurrentVersion: true });
    await store.create({ student: 'child-b', tutor: TUTOR_A.id, status: 'published', isCurrentVersion: true });

    const res = mockRes();
    await listMyChildProgress({ user: PARENT, query: { studentId: 'child-a' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.remarks.length, 1);
    assert.equal(res._body.remarks[0]._id, currentOne._id);
  } finally { restore(); Enrollment.exists = origEnrollmentExists; }
});

test('getRemarkAttachment: rejects a caller who is neither the assigned tutor, the student, the parent, nor admin', async () => {
  const { restore, store } = stubModels();
  const origEnrollmentExists = Enrollment.exists;
  Enrollment.exists = async () => false;
  try {
    const remark = await store.create({
      student: 'student-1', tutor: TUTOR_A.id, status: 'published',
      attachment: { path: 'remark-1.png', fileName: 'worksheet.png', mimetype: 'image/png' },
    });
    const res = mockRes();
    await getRemarkAttachment({ user: TUTOR_B, params: { id: remark._id } }, res);
    assert.equal(res._status, 403);
  } finally { restore(); Enrollment.exists = origEnrollmentExists; }
});

// ─── Save Draft persistence regression coverage ────────────────────────────────
// Bug report: "fill in fields, Save Draft, reopen via Continue editing -> form is
// blank." Rigorous live testing (real HTTP + real DB + a full browser E2E run) could
// not reproduce this against the current code — these tests lock in that every field
// really does round-trip through both draft-save paths, so a future regression here
// gets caught immediately rather than requiring another full investigation.

test('createOrSaveRemark: Save Draft persists every entered field exactly (create path)', async () => {
  const { restore, store } = stubModels();
  try {
    const res = mockRes();
    await createOrSaveRemark({
      user: TUTOR_A,
      body: baseBody({
        action: 'draft',
        activities: ['Reading comprehension worksheet', 'Times tables drill'],
        remarkBullets: ['The student showed improvement in reading fluency.'],
        nextFocus: 'Continue phonics review.',
        parentSupportSuggestion: 'Practice flashcards 10 minutes nightly.',
      }),
    }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    const saved = res._body.remark;
    assert.deepEqual(saved.activities, ['Reading comprehension worksheet', 'Times tables drill']);
    assert.deepEqual(saved.remarkBullets, ['The student showed improvement in reading fluency.']);
    assert.equal(saved.nextFocus, 'Continue phonics review.');
    assert.equal(saved.parentSupportSuggestion, 'Practice flashcards 10 minutes nightly.');

    // What "Continue editing" actually reads (listMyRemarks returns the whole doc,
    // no field selection) — confirm the persisted doc itself carries the same values.
    const persisted = store.docs.find((d) => d._id === saved._id);
    assert.deepEqual(persisted.activities, saved.activities);
    assert.deepEqual(persisted.remarkBullets, saved.remarkBullets);
    assert.equal(persisted.nextFocus, saved.nextFocus);
  } finally { restore(); }
});

test('updateDraftRemark: Save Draft persists every entered field exactly (re-save path)', async () => {
  const { restore, store } = stubModels();
  try {
    const draft = await store.create({
      student: 'student-1', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress',
      status: 'draft', activities: [], remarkBullets: [], nextFocus: '',
    });
    const res = mockRes();
    await updateDraftRemark({
      user: TUTOR_A,
      params: { id: draft._id },
      body: {
        action: 'draft',
        date: '2026-09-14',
        activities: ['Reading comprehension worksheet'],
        remarkBullets: ['Needs more practice with carrying in addition.'],
        nextFocus: 'Continue phonics review and start double-digit addition.',
      },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.deepEqual(res._body.remark.activities, ['Reading comprehension worksheet']);
    assert.deepEqual(res._body.remark.remarkBullets, ['Needs more practice with carrying in addition.']);
    assert.equal(res._body.remark.nextFocus, 'Continue phonics review and start double-digit addition.');

    const persisted = store.docs.find((d) => d._id === draft._id);
    assert.deepEqual(persisted.activities, ['Reading comprehension worksheet']);
    assert.equal(persisted.nextFocus, 'Continue phonics review and start double-digit addition.');
  } finally { restore(); }
});

// Bug report #2 (same day): "Activities and Tutor remark bullets specifically come back
// empty after Save Draft + Continue Editing, across all three templates" — also not
// reproducible live (browser E2E with multiple chips, all 3 templates, a full page
// reload, and a second edit-resave cycle all round-tripped correctly), but these three
// templates share these two fields and hadn't each been exercised with MULTIPLE items
// in the permanent suite before, so lock that in per template.
for (const { subject, programCode } of [
  { subject: SUBJECT_TPG101, programCode: 'TPG101' },
  { subject: SUBJECT_ACT102, programCode: 'ACT102' },
  { subject: { _id: 'subj-exp106', name: 'Examination Preparation', code: 'EXP106' }, programCode: 'EXP106' },
]) {
  test(`createOrSaveRemark: multi-item Activities/remarkBullets persist for ${programCode}`, async () => {
    const { restore } = stubModels({ subject });
    try {
      const res = mockRes();
      await createOrSaveRemark({
        user: TUTOR_A,
        body: baseBody({
          programCode,
          action: 'draft',
          activities: ['Activity one', 'Activity two', 'Activity three'],
          remarkBullets: ['Bullet one', 'Bullet two'],
        }),
      }, res);
      assert.equal(res._status, 201, JSON.stringify(res._body));
      assert.deepEqual(res._body.remark.activities, ['Activity one', 'Activity two', 'Activity three']);
      assert.deepEqual(res._body.remark.remarkBullets, ['Bullet one', 'Bullet two']);
    } finally { restore(); }
  });
}

// ─── Attachments on a DRAFT ───────────────────────────────────────────────────
// Both draft paths used to `return` before any attachment handling, so a file chosen
// on a brand-new remark (or added to an existing draft) was silently dropped and only
// ever stored when publishing. Attachments must be storable from the very first save.

const CONSENT_OK = [{ name: 'media_consent', version: '1.0', acceptedAt: new Date() }];

test('createOrSaveRemark: Save Draft stores an attachment on a brand-new remark — consent ON record', async () => {
  const { restore } = stubModels({ consents: CONSENT_OK });
  try {
    const res = mockRes();
    await createOrSaveRemark({
      user: TUTOR_A,
      body: baseBody({ action: 'draft', attachmentDataUrl: TINY_PNG_DATA_URL, attachmentFileName: 'worksheet.png' }),
    }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(res._body.remark.status, 'draft', 'an attachment must not push a draft into review on its own');
    assert.ok(res._body.remark.attachment?.path, 'the draft must carry a stored attachment path');
    assert.equal(res._body.remark.attachment.fileName, 'worksheet.png');
  } finally { restore(); }
});

test('createOrSaveRemark: Save Draft stores an attachment on a brand-new remark even with NO consent on record', async () => {
  const { restore } = stubModels({ consents: [] });
  try {
    const res = mockRes();
    await createOrSaveRemark({
      user: TUTOR_A,
      body: baseBody({ action: 'draft', attachmentDataUrl: TINY_PNG_DATA_URL, attachmentFileName: 'worksheet.png' }),
    }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body), 'a tutor must never be blocked from attaching a file for missing consent');
    assert.equal(res._body.remark.status, 'draft');
    assert.ok(res._body.remark.attachment?.path, 'the draft must carry a stored attachment path');
    assert.equal(res._body.remark.attachment.fileName, 'worksheet.png');
  } finally { restore(); }
});

test('updateDraftRemark: Save Draft stores a newly chosen attachment on an existing draft', async () => {
  const { restore, store } = stubModels({ consents: CONSENT_OK });
  try {
    const draft = await store.create({
      student: 'student-1', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress', status: 'draft',
    });
    const res = mockRes();
    await updateDraftRemark({
      user: TUTOR_A,
      params: { id: draft._id },
      body: { action: 'draft', attachmentDataUrl: TINY_PNG_DATA_URL, attachmentFileName: 'worksheet.png' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.remark.status, 'draft');
    assert.ok(res._body.remark.attachment?.path);
    assert.equal(res._body.remark.attachment.fileName, 'worksheet.png');
  } finally { restore(); }
});

test('updateDraftRemark: stores a newly chosen attachment on an existing draft even with NO consent on record', async () => {
  const { restore, store } = stubModels({ consents: [] });
  try {
    const draft = await store.create({
      student: 'student-1', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress', status: 'draft',
    });
    const res = mockRes();
    await updateDraftRemark({
      user: TUTOR_A,
      params: { id: draft._id },
      body: { action: 'draft', attachmentDataUrl: TINY_PNG_DATA_URL, attachmentFileName: 'worksheet.png' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body), 'a tutor must never be blocked from attaching a file for missing consent');
    assert.equal(res._body.remark.status, 'draft');
    assert.ok(res._body.remark.attachment?.path);
    assert.equal(res._body.remark.attachment.fileName, 'worksheet.png');
  } finally { restore(); }
});

test('updateDraftRemark: re-saving a draft without choosing a new file keeps the existing attachment', async () => {
  const { restore, store } = stubModels({ consents: CONSENT_OK });
  try {
    const draft = await store.create({
      student: 'student-1', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress', status: 'draft',
      attachment: { path: 'remark-existing.png', fileName: 'already-there.png', mimetype: 'image/png', size: 123 },
    });
    const res = mockRes();
    await updateDraftRemark({
      user: TUTOR_A,
      params: { id: draft._id },
      body: { action: 'draft', nextFocus: 'Edited text, no new file.' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.remark.attachment?.fileName, 'already-there.png', 'the stored attachment must survive a plain re-save');
  } finally { restore(); }
});

// ─── listPendingReview: consent surfaced to the admin (Spec v3.1) ─────────────
// Consent is no longer checked anywhere on the tutor side — it becomes information the
// admin sees here, together with the attachment itself, to decide Approve or Reject.

test('listPendingReview: includes studentHasMediaConsent per remark, and never leaks the raw consents array', async () => {
  const { restore, store } = stubModels();
  try {
    await store.create({
      student: { _id: 'student-1', firstName: 'Ana', lastName: 'Cruz', consents: [{ name: 'media_consent', version: '1.0', acceptedAt: new Date() }] },
      tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress', status: 'pending_admin_review',
    });
    await store.create({
      student: { _id: 'student-2', firstName: 'Ben', lastName: 'Dizon', consents: [] },
      tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress', status: 'pending_admin_review',
    });

    const res = mockRes();
    await listPendingReview({ user: ADMIN }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));

    const withConsent = res._body.remarks.find((r) => r.student._id === 'student-1');
    const withoutConsent = res._body.remarks.find((r) => r.student._id === 'student-2');
    assert.equal(withConsent.studentHasMediaConsent, true);
    assert.equal(withoutConsent.studentHasMediaConsent, false);
    assert.equal(withConsent.student.consents, undefined, 'the raw consents array must not be sent to the client');
    assert.equal(withoutConsent.student.consents, undefined);
  } finally { restore(); }
});

// ─── deleteDraftRemark (Cancel -> Delete Draft feature) ────────────────────────

test('deleteDraftRemark: tutor can permanently delete their own draft', async () => {
  const { restore, store } = stubModels();
  try {
    const draft = await store.create({ student: 'student-1', tutor: TUTOR_A.id, status: 'draft' });
    const res = mockRes();
    await deleteDraftRemark({ user: TUTOR_A, params: { id: draft._id } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(store.docs.find((d) => d._id === draft._id), undefined, 'the draft must be gone from the store');
  } finally { restore(); }
});

test('deleteDraftRemark: rejects deleting a published remark (Published is immutable)', async () => {
  const { restore, store } = stubModels();
  try {
    const published = await store.create({ student: 'student-1', tutor: TUTOR_A.id, status: 'published', isCurrentVersion: true });
    const res = mockRes();
    await deleteDraftRemark({ user: TUTOR_A, params: { id: published._id } }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /cannot be deleted/i);
    assert.ok(store.docs.find((d) => d._id === published._id), 'the published remark must NOT be deleted');
  } finally { restore(); }
});

test('deleteDraftRemark: rejects a tutor deleting a DIFFERENT tutor\'s draft', async () => {
  const { restore, store } = stubModels();
  try {
    const draft = await store.create({ student: 'student-1', tutor: TUTOR_A.id, status: 'draft' });
    const res = mockRes();
    await deleteDraftRemark({ user: TUTOR_B, params: { id: draft._id } }, res);
    assert.equal(res._status, 404);
    assert.ok(store.docs.find((d) => d._id === draft._id), 'another tutor\'s draft must survive untouched');
  } finally { restore(); }
});

test('deleteDraftRemark: rejects a non-tutor caller', async () => {
  const { restore, store } = stubModels();
  try {
    const draft = await store.create({ student: 'student-1', tutor: TUTOR_A.id, status: 'draft' });
    const res = mockRes();
    await deleteDraftRemark({ user: ADMIN, params: { id: draft._id } }, res);
    assert.equal(res._status, 403);
    assert.ok(store.docs.find((d) => d._id === draft._id));
  } finally { restore(); }
});
