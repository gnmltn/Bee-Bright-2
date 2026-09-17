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
const {
  createOrSaveRemark,
  updateDraftRemark,
  deleteDraftRemark,
  correctPublishedRemark,
  listMyChildProgress,
  listPendingReview,
  reviewRemark,
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
const ADMIN = { id: 'admin-1', _id: 'admin-1', role: 'admin' };
const PARENT = { id: 'parent-1', _id: 'parent-1', role: 'parent' };
const SUBJECT_ACT102 = { _id: 'subj-act102', name: 'Academic Tutorial', code: 'ACT102' };
const SUBJECT_TPG101 = { _id: 'subj-tpg101', name: 'Toddlers Playgroup', code: 'TPG101' };

const TINY_PNG_DATA_URL = 'data:image/png;base64,' + Buffer.from('fake-image-bytes').toString('base64');

// `schedules` lets a test simulate a tutor assigned to a student across MULTIPLE
// programs at once (Spec v3) — defaults to a single schedule in `subject`'s program
// when not given explicitly. Pass `schedules: []` (or `tutorHandles: false`) to
// simulate "not assigned to this student in any program."
function stubModels({ tutorHandles = true, subject = SUBJECT_ACT102, schedules, consents = [] } = {}) {
  const origScheduleExists = Schedule.exists;
  const origScheduleFind = Schedule.find;
  const origUserFindById = User.findById;
  const origEnrollmentExists = Enrollment.exists;
  const origRemarkCreate = Remark.create;
  const origRemarkFindById = Remark.findById;
  const origRemarkFindOne = Remark.findOne;
  const origRemarkFind = Remark.find;
  const origRemarkUpdateOne = Remark.updateOne;
  const origRemarkDeleteOne = Remark.deleteOne;
  const origFsWriteFileSync = fs.writeFileSync;
  const origFsExistsSync = fs.existsSync;
  const origFsMkdirSync = fs.mkdirSync;
  const origFsCreateReadStream = fs.createReadStream;
  const origFsUnlinkSync = fs.unlinkSync;

  let capturedExistsQuery = null;
  let capturedFindQuery = null;
  const store = makeFakeRemarkStore();
  const scheduleDocs = schedules !== undefined
    ? schedules
    : (tutorHandles && subject ? [{ subject }] : []);

  Schedule.exists = async (query) => { capturedExistsQuery = query; return tutorHandles; };
  Schedule.find = (query) => { capturedFindQuery = query; return mockQuery(scheduleDocs); };
  User.findById = () => mockQuery({ consents });
  Enrollment.exists = async () => false; // overridden per-test when parent ownership matters
  Remark.create = store.create;
  Remark.findById = store.findById;
  Remark.findOne = store.findOne;
  Remark.find = store.find;
  Remark.updateOne = store.updateOne;
  Remark.deleteOne = store.deleteOne;
  fs.writeFileSync = () => {};
  fs.existsSync = () => true;
  fs.mkdirSync = () => {};
  fs.createReadStream = () => ({ pipe: () => {} });
  fs.unlinkSync = () => {};

  return {
    store,
    getCapturedExistsQuery: () => capturedExistsQuery,
    getCapturedFindQuery: () => capturedFindQuery,
    restore() {
      Schedule.exists = origScheduleExists;
      Schedule.find = origScheduleFind;
      User.findById = origUserFindById;
      Enrollment.exists = origEnrollmentExists;
      Remark.create = origRemarkCreate;
      Remark.findById = origRemarkFindById;
      Remark.findOne = origRemarkFindOne;
      Remark.find = origRemarkFind;
      Remark.updateOne = origRemarkUpdateOne;
      Remark.deleteOne = origRemarkDeleteOne;
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

test('createOrSaveRemark: publishing with no attachment goes straight to Published', async () => {
  const { restore } = stubModels();
  try {
    const res = mockRes();
    await createOrSaveRemark({ user: TUTOR_A, body: baseBody() }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(res._body.remark.status, 'published');
    assert.ok(res._body.remark.publishedAt);
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

test('correctPublishedRemark: a correction with a new attachment goes to Pending Admin Review and does not flip isCurrentVersion until approved', async () => {
  const { restore, store } = stubModels({ consents: [{ name: 'media_consent', version: '1.0', acceptedAt: new Date() }] });
  try {
    const original = await store.create({
      student: 'student-1', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress',
      status: 'published', isCurrentVersion: true, publishedAt: new Date(),
      date: new Date(), activities: ['Reading'], remarkBullets: ['Good progress.'], nextFocus: 'Keep going.',
    });

    const res = mockRes();
    await correctPublishedRemark({
      user: TUTOR_A,
      params: { id: original._id },
      body: { correctionReason: 'Fixed a typo and added the worksheet photo.', attachmentDataUrl: TINY_PNG_DATA_URL },
    }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(res._body.remark.status, 'pending_admin_review');
    assert.equal(res._body.remark.isCurrentVersion, false, 'not current until admin approves');

    const refreshedOriginal = store.docs.find((d) => d._id === original._id);
    assert.equal(refreshedOriginal.isCurrentVersion, true, 'original stays current until the correction is approved');

    // Now approve it — this is the moment the version actually flips (spec D.3/F.6).
    const correctionId = res._body.remark._id;
    const approveRes = mockRes();
    await reviewRemark({ user: ADMIN, params: { id: correctionId }, body: { decision: 'approve' } }, approveRes);
    assert.equal(approveRes._status, 200, JSON.stringify(approveRes._body));
    assert.equal(approveRes._body.remark.isCurrentVersion, true);
    assert.equal(store.docs.find((d) => d._id === original._id).isCurrentVersion, false, 'original flips to not-current only on approval');
  } finally { restore(); }
});

test('correctPublishedRemark: a correction with a new attachment succeeds even with NO consent on record', async () => {
  const { restore, store } = stubModels({ consents: [] });
  try {
    const original = await store.create({
      student: 'student-1', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress',
      status: 'published', isCurrentVersion: true, publishedAt: new Date(),
      date: new Date(), activities: ['Reading'], remarkBullets: ['Good progress.'], nextFocus: 'Keep going.',
    });

    const res = mockRes();
    await correctPublishedRemark({
      user: TUTOR_A,
      params: { id: original._id },
      body: { correctionReason: 'Added the worksheet photo.', attachmentDataUrl: TINY_PNG_DATA_URL },
    }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body), 'a tutor must never be blocked from correcting-with-an-attachment for missing consent');
    assert.equal(res._body.remark.status, 'pending_admin_review');
    assert.ok(res._body.remark.attachment?.path);
  } finally { restore(); }
});

test('correctPublishedRemark: a correction with no attachment change publishes immediately and flips isCurrentVersion', async () => {
  const { restore, store } = stubModels();
  try {
    const original = await store.create({
      student: 'student-1', tutor: TUTOR_A.id, programCode: 'ACT102', templateType: 'academic_progress',
      status: 'published', isCurrentVersion: true, publishedAt: new Date(),
      date: new Date(), activities: ['Reading'], remarkBullets: ['Good progress.'], nextFocus: 'Keep going.',
    });

    const res = mockRes();
    await correctPublishedRemark({
      user: TUTOR_A,
      params: { id: original._id },
      body: { correctionReason: 'Fixed a typo.', nextFocus: 'Keep going with fluency drills.' },
    }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(res._body.remark.status, 'published');
    assert.equal(res._body.remark.isCurrentVersion, true);
    assert.equal(store.docs.find((d) => d._id === original._id).isCurrentVersion, false);
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

test('deleteDraftRemark: rejects deleting a published remark (must use correction, not delete)', async () => {
  const { restore, store } = stubModels();
  try {
    const published = await store.create({ student: 'student-1', tutor: TUTOR_A.id, status: 'published', isCurrentVersion: true });
    const res = mockRes();
    await deleteDraftRemark({ user: TUTOR_A, params: { id: published._id } }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.message, /must be corrected, not deleted/i);
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
