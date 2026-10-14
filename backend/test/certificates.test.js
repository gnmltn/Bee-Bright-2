/**
 * Certificate feature. Model-stubbing pattern copied from test/remarks.test.js (a
 * small in-memory fake store for Certificate, since the controller calls
 * Certificate.create/findById/find and mutates docs via .save() across several
 * functions in the same request/test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const Certificate = require('../models/Certificate');
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const {
  CERTIFICATE_RETRACT_WINDOW_DAYS,
  uploadCertificate,
  listCertificateHistory,
  retractCertificate,
  replaceCertificate,
  getCertificateFile,
  downloadCertificatePdf,
  listMyCertificates,
} = require('../controllers/certificateController');

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
  res.setHeader = () => {};
  res.send = (buf) => { res._sentBuffer = buf; return res; };
  return res;
}

function matchesFilter(doc, filter) {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((sub) => matchesFilter(doc, sub));
    if (key === 'students' && value && value.$in) return undefined; // not used in these tests
    if (value && typeof value === 'object' && !Array.isArray(value)) return true; // $gte/$ne/$in etc. — not needed here
    return String(doc[key]) === String(value);
  });
}

function makeFakeCertificateStore() {
  const docs = [];
  let seq = 0;
  return {
    docs,
    async create(data) {
      const id = `cert-${++seq}`;
      const doc = {
        replacedAt: null,
        retractedAt: null,
        status: 'published',
        ...data,
        _id: id,
      };
      doc.save = async () => doc;
      docs.push(doc);
      return doc;
    },
    findById(id) {
      return mockQuery(docs.find((d) => String(d._id) === String(id)) || null);
    },
    find(filter) {
      // "students: studentId" (a single id, matching one entry in the array) is the
      // only array-membership query these tests need (listMyCertificates / getFile's
      // student-array checks use parentOwnsStudent/explicit .some() instead).
      const { students, status, ...rest } = filter || {};
      const results = docs.filter((d) => {
        if (students !== undefined && !Array.isArray(students)) {
          if (!d.students.some((s) => String(s) === String(students))) return false;
        }
        if (status !== undefined && d.status !== status) return false;
        return matchesFilter(d, rest);
      });
      return mockQuery(results);
    },
  };
}

const ADMIN = { id: 'admin-1', _id: 'admin-1', role: 'admin' };
const PARENT = { id: 'parent-1', _id: 'parent-1', role: 'parent' };
const OTHER_PARENT = { id: 'parent-2', _id: 'parent-2', role: 'parent' };
const STUDENT_A = 'student-a';
const STUDENT_B = 'student-b';

// A real, minimal valid 1x1 PNG — pdfkit's doc.image() needs genuine image bytes to
// render, not arbitrary text, for the image→PDF conversion tests.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;
const TINY_PNG_BUFFER = Buffer.from(TINY_PNG_BASE64, 'base64');
const TINY_PDF_DATA_URL = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 fake').toString('base64');

function stubModels({ existingStudentIds = [STUDENT_A, STUDENT_B], parentOwnsStudentIds = [STUDENT_A], fileBuffer = TINY_PNG_BUFFER } = {}) {
  const origCertificateCreate = Certificate.create;
  const origCertificateFindById = Certificate.findById;
  const origCertificateFind = Certificate.find;
  const origUserFind = User.find;
  const origEnrollmentExists = Enrollment.exists;
  const origEnrollmentFind = Enrollment.find;
  const origFsWriteFileSync = fs.writeFileSync;
  const origFsExistsSync = fs.existsSync;
  const origFsMkdirSync = fs.mkdirSync;
  const origFsCreateReadStream = fs.createReadStream;
  const origFsUnlinkSync = fs.unlinkSync;
  const origFsReadFileSync = fs.readFileSync;

  const store = makeFakeCertificateStore();
  Certificate.create = store.create;
  Certificate.findById = store.findById;
  Certificate.find = store.find;

  User.find = (query) => {
    const ids = (query?._id?.$in || []).map(String);
    return mockQuery(ids.filter((id) => existingStudentIds.includes(id)).map((id) => ({ _id: id })));
  };
  Enrollment.exists = async ({ parent, student }) =>
    String(parent) === String(PARENT.id) && parentOwnsStudentIds.includes(String(student));
  Enrollment.find = ({ student }) => {
    const ids = student?.$in || [];
    return mockQuery(ids.map((id) => ({ parent: PARENT.id })).filter(() => true));
  };

  fs.writeFileSync = () => {};
  fs.existsSync = () => true;
  fs.mkdirSync = () => {};
  fs.createReadStream = () => ({ pipe: (res) => res.end && res.end() });
  fs.unlinkSync = () => {};
  // IMPORTANT: readFileSync is also used internally by pdfkit itself (loading its
  // bundled Helvetica .afm font metrics) and by Node's own module loader — a blanket
  // override here hands pdfkit garbage bytes for its font file and crashes the
  // process natively (not a catchable JS error). Only intercept the ONE path the
  // controller actually reads the certificate file from; everything else (font
  // files, module resolution, ...) goes through the real readFileSync.
  fs.readFileSync = (filePath, ...rest) => {
    if (typeof filePath === 'string' && filePath.includes('private-uploads')) {
      return fileBuffer;
    }
    return origFsReadFileSync(filePath, ...rest);
  };

  return {
    store,
    restore() {
      Certificate.create = origCertificateCreate;
      Certificate.findById = origCertificateFindById;
      Certificate.find = origCertificateFind;
      User.find = origUserFind;
      Enrollment.exists = origEnrollmentExists;
      Enrollment.find = origEnrollmentFind;
      fs.writeFileSync = origFsWriteFileSync;
      fs.existsSync = origFsExistsSync;
      fs.mkdirSync = origFsMkdirSync;
      fs.createReadStream = origFsCreateReadStream;
      fs.unlinkSync = origFsUnlinkSync;
      fs.readFileSync = origFsReadFileSync;
    },
  };
}

// ── Upload ───────────────────────────────────────────────────────────────────

test('uploadCertificate: rejects with no students selected', async () => {
  const { restore } = stubModels();
  try {
    const res = mockRes();
    await uploadCertificate({ user: ADMIN, body: { studentIds: [], fileDataUrl: TINY_PNG_DATA_URL } }, res);
    assert.equal(res._status, 400);
  } finally { restore(); }
});

test('uploadCertificate: rejects with no file', async () => {
  const { restore } = stubModels();
  try {
    const res = mockRes();
    await uploadCertificate({ user: ADMIN, body: { studentIds: [STUDENT_A] } }, res);
    assert.equal(res._status, 400);
  } finally { restore(); }
});

test('uploadCertificate: rejects when a selected student does not exist', async () => {
  const { restore } = stubModels({ existingStudentIds: [STUDENT_A] });
  try {
    const res = mockRes();
    await uploadCertificate({ user: ADMIN, body: { studentIds: [STUDENT_A, 'ghost-student'], fileDataUrl: TINY_PNG_DATA_URL } }, res);
    assert.equal(res._status, 400);
  } finally { restore(); }
});

test('uploadCertificate: publishes a batch certificate to all selected students at once', async () => {
  const { restore, store } = stubModels();
  try {
    const res = mockRes();
    await uploadCertificate({ user: ADMIN, body: { studentIds: [STUDENT_A, STUDENT_B], fileDataUrl: TINY_PNG_DATA_URL, fileName: 'cert.png', message: 'Congrats!' } }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(store.docs.length, 1, 'one batch document, not one per student');
    assert.deepEqual(store.docs[0].students, [STUDENT_A, STUDENT_B]);
    assert.equal(store.docs[0].status, 'published');
    assert.ok(store.docs[0].publishedAt instanceof Date);
    assert.equal(store.docs[0].message, 'Congrats!');
  } finally { restore(); }
});

// ── History / canModify window ──────────────────────────────────────────────

test('listCertificateHistory: canModify is true for a published cert inside the 7-day window', async () => {
  const { restore, store } = stubModels();
  try {
    await store.create({ students: [STUDENT_A], file: {}, publishedAt: new Date(), status: 'published' });
    const res = mockRes();
    await listCertificateHistory({ user: ADMIN }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.history[0].canModify, true);
  } finally { restore(); }
});

test('listCertificateHistory: canModify is false once past the 7-day window', async () => {
  const { restore, store } = stubModels();
  try {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await store.create({ students: [STUDENT_A], file: {}, publishedAt: eightDaysAgo, status: 'published' });
    const res = mockRes();
    await listCertificateHistory({ user: ADMIN }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.history[0].canModify, false);
  } finally { restore(); }
});

test('listCertificateHistory: canModify is false for a retracted certificate even inside the window', async () => {
  const { restore, store } = stubModels();
  try {
    await store.create({ students: [STUDENT_A], file: {}, publishedAt: new Date(), status: 'retracted', retractedAt: new Date() });
    const res = mockRes();
    await listCertificateHistory({ user: ADMIN }, res);
    assert.equal(res._body.history[0].canModify, false);
  } finally { restore(); }
});

// ── Retract ──────────────────────────────────────────────────────────────────

test('retractCertificate: succeeds within the window and flips status', async () => {
  const { restore, store } = stubModels();
  try {
    const cert = await store.create({ students: [STUDENT_A], file: {}, publishedAt: new Date(), status: 'published' });
    const res = mockRes();
    await retractCertificate({ user: ADMIN, params: { id: cert._id } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(cert.status, 'retracted');
    assert.ok(cert.retractedAt instanceof Date);
  } finally { restore(); }
});

test(`retractCertificate: rejected once more than ${CERTIFICATE_RETRACT_WINDOW_DAYS} days have passed`, async () => {
  const { restore, store } = stubModels();
  try {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const cert = await store.create({ students: [STUDENT_A], file: {}, publishedAt: eightDaysAgo, status: 'published' });
    const res = mockRes();
    await retractCertificate({ user: ADMIN, params: { id: cert._id } }, res);
    assert.equal(res._status, 403, JSON.stringify(res._body));
    assert.equal(cert.status, 'published', 'must stay published once the window has closed');
  } finally { restore(); }
});

test('retractCertificate: rejects an already-retracted certificate', async () => {
  const { restore, store } = stubModels();
  try {
    const cert = await store.create({ students: [STUDENT_A], file: {}, publishedAt: new Date(), status: 'retracted', retractedAt: new Date() });
    const res = mockRes();
    await retractCertificate({ user: ADMIN, params: { id: cert._id } }, res);
    assert.equal(res._status, 400);
  } finally { restore(); }
});

// ── Replace ──────────────────────────────────────────────────────────────────

test('replaceCertificate: swaps the file within the window, keeps publishedAt unchanged', async () => {
  const { restore, store } = stubModels();
  try {
    const originalPublishedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const cert = await store.create({
      students: [STUDENT_A],
      file: { path: 'old.png', fileName: 'old.png', mimetype: 'image/png', size: 10, uploadedAt: new Date() },
      publishedAt: originalPublishedAt,
      status: 'published',
    });
    const res = mockRes();
    await replaceCertificate({ user: ADMIN, params: { id: cert._id }, body: { fileDataUrl: TINY_PNG_DATA_URL, fileName: 'new.png', message: 'Updated' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.notEqual(cert.file.path, 'old.png');
    assert.equal(cert.file.fileName, 'new.png');
    assert.equal(cert.message, 'Updated');
    assert.equal(cert.publishedAt.getTime(), originalPublishedAt.getTime(), 'publishedAt must not reset — the window cannot be extended by replacing');
    assert.ok(cert.replacedAt instanceof Date);
  } finally { restore(); }
});

test(`replaceCertificate: rejected once more than ${CERTIFICATE_RETRACT_WINDOW_DAYS} days have passed`, async () => {
  const { restore, store } = stubModels();
  try {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const cert = await store.create({ students: [STUDENT_A], file: { path: 'old.png' }, publishedAt: eightDaysAgo, status: 'published' });
    const res = mockRes();
    await replaceCertificate({ user: ADMIN, params: { id: cert._id }, body: { fileDataUrl: TINY_PNG_DATA_URL, fileName: 'new.png' } }, res);
    assert.equal(res._status, 403);
    assert.equal(cert.file.path, 'old.png');
  } finally { restore(); }
});

// ── Parent/student scoping — getCertificateFile ─────────────────────────────

test('getCertificateFile: admin can always view', async () => {
  const { restore, store } = stubModels();
  try {
    const cert = await store.create({ students: [STUDENT_A], file: { path: 'x.png', mimetype: 'image/png' }, publishedAt: new Date(), status: 'published' });
    const res = mockRes();
    await getCertificateFile({ user: ADMIN, params: { id: cert._id } }, res);
    assert.equal(res._status, 200);
  } finally { restore(); }
});

test('getCertificateFile: the owning parent can view a published certificate', async () => {
  const { restore, store } = stubModels({ parentOwnsStudentIds: [STUDENT_A] });
  try {
    const cert = await store.create({ students: [STUDENT_A], file: { path: 'x.png', mimetype: 'image/png' }, publishedAt: new Date(), status: 'published' });
    const res = mockRes();
    await getCertificateFile({ user: PARENT, params: { id: cert._id } }, res);
    assert.equal(res._status, 200);
  } finally { restore(); }
});

test('getCertificateFile: a parent who does not own any of the students is refused', async () => {
  const { restore, store } = stubModels({ parentOwnsStudentIds: [] });
  try {
    const cert = await store.create({ students: [STUDENT_A], file: { path: 'x.png', mimetype: 'image/png' }, publishedAt: new Date(), status: 'published' });
    const res = mockRes();
    await getCertificateFile({ user: PARENT, params: { id: cert._id } }, res);
    assert.equal(res._status, 403);
  } finally { restore(); }
});

test('getCertificateFile: the owning parent cannot view a RETRACTED certificate', async () => {
  const { restore, store } = stubModels({ parentOwnsStudentIds: [STUDENT_A] });
  try {
    const cert = await store.create({ students: [STUDENT_A], file: { path: 'x.png', mimetype: 'image/png' }, publishedAt: new Date(), status: 'retracted', retractedAt: new Date() });
    const res = mockRes();
    await getCertificateFile({ user: PARENT, params: { id: cert._id } }, res);
    assert.equal(res._status, 403);
  } finally { restore(); }
});

// ── Download always as PDF ──────────────────────────────────────────────────

test('downloadCertificatePdf: an already-PDF file is streamed as-is', async () => {
  const { restore, store } = stubModels();
  try {
    const cert = await store.create({ students: [STUDENT_A], file: { path: 'x.pdf', fileName: 'x.pdf', mimetype: 'application/pdf' }, publishedAt: new Date(), status: 'published' });
    const res = mockRes();
    await downloadCertificatePdf({ user: ADMIN, params: { id: cert._id } }, res);
    assert.equal(res._status, 200);
  } finally { restore(); }
});

test('downloadCertificatePdf: an image file is converted into a real PDF buffer', async () => {
  const { restore, store } = stubModels({ fileBuffer: TINY_PNG_BUFFER });
  try {
    const cert = await store.create({ students: [STUDENT_A], file: { path: 'x.png', fileName: 'x.png', mimetype: 'image/png' }, publishedAt: new Date(), status: 'published' });
    const res = mockRes();
    await downloadCertificatePdf({ user: ADMIN, params: { id: cert._id } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.ok(res._sentBuffer, 'a PDF buffer should have been sent');
    assert.equal(res._sentBuffer.slice(0, 4).toString(), '%PDF', 'the converted output must be a real PDF (starts with the %PDF magic bytes)');
  } finally { restore(); }
});

// ── Parent progress list ─────────────────────────────────────────────────────

test('listMyCertificates: a parent must name one of their own children', async () => {
  const { restore } = stubModels({ parentOwnsStudentIds: [] });
  try {
    const res = mockRes();
    await listMyCertificates({ user: PARENT, query: { studentId: STUDENT_A } }, res);
    assert.equal(res._status, 403);
  } finally { restore(); }
});

test('listMyCertificates: returns only PUBLISHED certificates for the named child', async () => {
  const { restore, store } = stubModels({ parentOwnsStudentIds: [STUDENT_A] });
  try {
    await store.create({ students: [STUDENT_A], file: { path: 'a.png' }, publishedAt: new Date(), status: 'published' });
    await store.create({ students: [STUDENT_A], file: { path: 'b.png' }, publishedAt: new Date(), status: 'retracted', retractedAt: new Date() });
    const res = mockRes();
    await listMyCertificates({ user: PARENT, query: { studentId: STUDENT_A } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.certificates.length, 1);
    assert.equal(res._body.certificates[0].file.path, 'a.png');
  } finally { restore(); }
});

test('cleanup: nothing to tear down (no live DB connection opened by this suite)', () => {
  assert.ok(true);
});
