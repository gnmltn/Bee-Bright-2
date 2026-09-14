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
  correctPublishedRemark,
  listMyChildProgress,
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
  };
}

const TUTOR_A = { id: 'tutor-a', _id: 'tutor-a', role: 'tutor' };
const TUTOR_B = { id: 'tutor-b', _id: 'tutor-b', role: 'tutor' };
const ADMIN = { id: 'admin-1', _id: 'admin-1', role: 'admin' };
const PARENT = { id: 'parent-1', _id: 'parent-1', role: 'parent' };
const SUBJECT_ACT102 = { _id: 'subj-act102', name: 'Academic Tutorial', code: 'ACT102' };
const SUBJECT_TPG101 = { _id: 'subj-tpg101', name: 'Toddlers Playgroup', code: 'TPG101' };

const TINY_PNG_DATA_URL = 'data:image/png;base64,' + Buffer.from('fake-image-bytes').toString('base64');

function stubModels({ tutorHandles = true, subject = SUBJECT_ACT102, consents = [] } = {}) {
  const origScheduleExists = Schedule.exists;
  const origScheduleFindOne = Schedule.findOne;
  const origUserFindById = User.findById;
  const origEnrollmentExists = Enrollment.exists;
  const origRemarkCreate = Remark.create;
  const origRemarkFindById = Remark.findById;
  const origRemarkFindOne = Remark.findOne;
  const origRemarkFind = Remark.find;
  const origRemarkUpdateOne = Remark.updateOne;
  const origFsWriteFileSync = fs.writeFileSync;
  const origFsExistsSync = fs.existsSync;
  const origFsMkdirSync = fs.mkdirSync;
  const origFsCreateReadStream = fs.createReadStream;

  let capturedExistsQuery = null;
  const store = makeFakeRemarkStore();

  Schedule.exists = async (query) => { capturedExistsQuery = query; return tutorHandles; };
  Schedule.findOne = () => mockQuery(subject ? { subject } : null);
  User.findById = () => mockQuery({ consents });
  Enrollment.exists = async () => false; // overridden per-test when parent ownership matters
  Remark.create = store.create;
  Remark.findById = store.findById;
  Remark.findOne = store.findOne;
  Remark.find = store.find;
  Remark.updateOne = store.updateOne;
  fs.writeFileSync = () => {};
  fs.existsSync = () => true;
  fs.mkdirSync = () => {};
  fs.createReadStream = () => ({ pipe: () => {} });

  return {
    store,
    getCapturedExistsQuery: () => capturedExistsQuery,
    restore() {
      Schedule.exists = origScheduleExists;
      Schedule.findOne = origScheduleFindOne;
      User.findById = origUserFindById;
      Enrollment.exists = origEnrollmentExists;
      Remark.create = origRemarkCreate;
      Remark.findById = origRemarkFindById;
      Remark.findOne = origRemarkFindOne;
      Remark.find = origRemarkFind;
      Remark.updateOne = origRemarkUpdateOne;
      fs.writeFileSync = origFsWriteFileSync;
      fs.existsSync = origFsExistsSync;
      fs.mkdirSync = origFsMkdirSync;
      fs.createReadStream = origFsCreateReadStream;
    },
  };
}

function baseBody(overrides = {}) {
  return {
    studentId: 'student-1',
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
    await createOrSaveRemark({ user: TUTOR_A, body: baseBody({ ratings: { participationEngagement: 2, socialInteraction: 3, followingDirections: 2 } }) }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.errors.join(' '), /1-3 star rating/i);
  } finally { restore(); }
});

test('createOrSaveRemark: publishing with an attachment but no media consent is rejected', async () => {
  const { restore } = stubModels({ consents: [] });
  try {
    const res = mockRes();
    await createOrSaveRemark({ user: TUTOR_A, body: baseBody({ attachmentDataUrl: TINY_PNG_DATA_URL }) }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.errors.join(' '), /consent/i);
  } finally { restore(); }
});

test('createOrSaveRemark: publishing with an attachment and valid consent goes to Pending Admin Review, not Published', async () => {
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
  const { restore, getCapturedExistsQuery } = stubModels({ subject: SUBJECT_TPG101 });
  try {
    const res = mockRes();
    await createOrSaveRemark({
      user: TUTOR_A,
      body: baseBody({ action: 'draft', ratings: { participationEngagement: 2, socialInteraction: 2, followingDirections: 2, overallBehavior: 2 } }),
    }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    const q = JSON.stringify(getCapturedExistsQuery());
    assert.match(q, /tutors/, 'must check the group tutors[] field, not just the singular tutor');
    assert.match(q, /students/, 'must check the group students[] field, not just the singular student');
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
