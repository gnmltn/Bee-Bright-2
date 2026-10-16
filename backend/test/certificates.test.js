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
      // Emulate Mongoose's real single-nested-subdocument behavior for `file`:
      // assigning a whole new object to `doc.file` does NOT swap in a distinct object
      // instance — it merges the new fields into the SAME underlying subdocument. This
      // aliasing is exactly what caused the real Replace bug (certificateController.js:
      // `const oldFile = certificate.file` captured a live reference, not a copy, which
      // silently changed when `certificate.file = newFile` ran right after). A plain
      // `doc.file = {...}` property would NOT reproduce this — it needs this accessor.
      let fileSubdoc = { ...(data.file || {}) };
      Object.defineProperty(doc, 'file', {
        get() { return fileSubdoc; },
        set(newValue) { Object.assign(fileSubdoc, newValue); },
        enumerable: true,
      });
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

// ── Watermarking integration (saveCertificateFile → applyCertificateWatermark) ──────
// Confirms the actual end-to-end upload/replace flow — not just the watermark utility
// in isolation (see certificateWatermark.test.js for that) — really writes watermarked
// bytes to disk, for both image and PDF uploads, and that the existing realtime
// notification still fires correctly once watermarking is in the critical path.

test('uploadCertificate: the bytes actually written to disk are watermarked, not the original upload (image)', async () => {
  const { restore } = stubModels();
  const originalWrite = fs.writeFileSync;
  let capturedBuffer = null;
  fs.writeFileSync = (_filePath, buf) => { capturedBuffer = buf; };
  try {
    const res = mockRes();
    await uploadCertificate({ user: ADMIN, body: { studentIds: [STUDENT_A], fileDataUrl: TINY_PNG_DATA_URL, fileName: 'cert.png' } }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.ok(capturedBuffer, 'a file must have been written');
    assert.notEqual(
      capturedBuffer.toString('base64'),
      TINY_PNG_BASE64,
      'the stored file must be the watermarked output, never the original unwatermarked upload'
    );
    // Genuinely a different, larger, still-valid PNG (the watermark SVG overlay adds
    // real bytes) — not just a coincidental re-encode.
    assert.ok(capturedBuffer.length > TINY_PNG_BUFFER.length);
  } finally {
    fs.writeFileSync = originalWrite;
    restore();
  }
});

test('replaceCertificate: the replacement file is ALSO watermarked, same as a fresh upload', async () => {
  const { restore, store } = stubModels();
  try {
    const existing = await store.create({
      students: [STUDENT_A],
      file: { path: 'old.png', fileName: 'old.png', mimetype: 'image/png', size: 10, uploadedAt: new Date() },
      publishedAt: new Date(),
      status: 'published',
    });

    const originalWrite = fs.writeFileSync;
    let capturedBuffer = null;
    fs.writeFileSync = (_filePath, buf) => { capturedBuffer = buf; };
    try {
      const res = mockRes();
      await replaceCertificate({ params: { id: existing._id }, user: ADMIN, body: { fileDataUrl: TINY_PNG_DATA_URL, fileName: 'new.png' } }, res);
      assert.equal(res._status, 200, JSON.stringify(res._body));
      assert.ok(capturedBuffer, 'a replacement file must have been written');
      assert.notEqual(capturedBuffer.toString('base64'), TINY_PNG_BASE64, 'Replace must also store the watermarked bytes, never the raw re-upload');
    } finally {
      fs.writeFileSync = originalWrite;
    }
  } finally { restore(); }
});

test('uploadCertificate: a real PDF upload is watermarked before being written to disk', async () => {
  const { PDFDocument } = require('pdf-lib');
  const blankDoc = await PDFDocument.create();
  blankDoc.addPage([400, 300]);
  const blankPdfBuf = Buffer.from(await blankDoc.save());
  const pdfDataUrl = `data:application/pdf;base64,${blankPdfBuf.toString('base64')}`;

  const { restore } = stubModels();
  const originalWrite = fs.writeFileSync;
  let capturedBuffer = null;
  fs.writeFileSync = (_filePath, buf) => { capturedBuffer = buf; };
  try {
    const res = mockRes();
    await uploadCertificate({ user: ADMIN, body: { studentIds: [STUDENT_A], fileDataUrl: pdfDataUrl, fileName: 'cert.pdf' } }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.ok(capturedBuffer, 'a file must have been written');

    const zlib = require('zlib');
    const text = capturedBuffer.toString('latin1');
    const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let m, inflatedAll = '';
    while ((m = re.exec(text))) {
      try { inflatedAll += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { /* not flate */ }
    }
    const watermarkHex = Buffer.from('OFFICIAL COPY OF BEE BRIGHT', 'ascii').toString('hex').toUpperCase();
    assert.ok(inflatedAll.includes(watermarkHex), 'the stored PDF must actually contain the drawn watermark text');
  } finally {
    fs.writeFileSync = originalWrite;
    restore();
  }
});

test('uploadCertificate: an invalid/corrupt PDF that cannot be watermarked is rejected with a clear error, nothing written', async () => {
  const corruptPdfDataUrl = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 not a real pdf structure').toString('base64');
  const { restore } = stubModels();
  const originalWrite = fs.writeFileSync;
  let writeCalled = false;
  fs.writeFileSync = () => { writeCalled = true; };
  try {
    const res = mockRes();
    await uploadCertificate({ user: ADMIN, body: { studentIds: [STUDENT_A], fileDataUrl: corruptPdfDataUrl, fileName: 'bad.pdf' } }, res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.equal(writeCalled, false, 'a file that fails watermarking must never be written to disk');
  } finally {
    fs.writeFileSync = originalWrite;
    restore();
  }
});

test('uploadCertificate: still correctly emits certificate:published to the right parents after watermarking succeeds', async () => {
  delete require.cache[require.resolve('../utils/realtime')];
  const realtime = require('../utils/realtime');
  const emitted = [];
  realtime.emitToParents = (parentIds, event, payload) => emitted.push({ parentIds, event, payload });

  delete require.cache[require.resolve('../controllers/certificateController')];
  const { uploadCertificate: uploadCertificateFresh } = require('../controllers/certificateController');

  const { restore } = stubModels({ existingStudentIds: [STUDENT_A], parentOwnsStudentIds: [STUDENT_A] });
  try {
    const res = mockRes();
    await uploadCertificateFresh({ user: ADMIN, body: { studentIds: [STUDENT_A], fileDataUrl: TINY_PNG_DATA_URL, fileName: 'cert.png' } }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));

    // The emit is fire-and-forget (resolveParentIdsForStudents().then(emit)) — give its
    // microtask a tick to run before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(emitted.length, 1, 'exactly one realtime notification for this publish');
    assert.equal(emitted[0].event, 'certificate:published');
    assert.deepEqual(emitted[0].parentIds, [PARENT.id]);
    assert.deepEqual(emitted[0].payload.studentIds, [STUDENT_A]);
  } finally {
    restore();
    delete require.cache[require.resolve('../utils/realtime')];
    delete require.cache[require.resolve('../controllers/certificateController')];
  }
});

// ── Real-disk Replace regression (live bug) ─────────────────────────────────────────
// Real bug (live-reported): after using "Replace" on a published certificate, viewing
// it afterward — admin side AND parent side — showed "Could not open this certificate."
// Root cause: `const oldFile = certificate.file;` in replaceCertificate just took a
// REFERENCE to the Mongoose single-nested `file` subdocument, not a copy. The very next
// line, `certificate.file = newFile;`, mutates THAT SAME subdocument instance in place,
// so `oldFile.path` silently became the NEW path too. `deleteCertificateFileBestEffort
// (oldFile)` then deleted the just-written REPLACEMENT file instead of the real old one
// — the DB record was left pointing at a path that no longer existed on disk, while the
// genuinely old file was never cleaned up (orphaned). Confirmed against a real MongoDB
// connection with real Document instances (a plain mock .save() can't reproduce
// Mongoose's own subdocument aliasing behavior) before fixing.
//
// The gap in the EARLIER watermarking-feature testing that let this ship: every test
// above stubs `fs.unlinkSync = () => {}` (a no-op) and `fs.existsSync = () => true`
// (always true) via stubModels() — so the delete step always "succeeded" and a missing
// file could never be observed, no matter which path got deleted. These tests use the
// REAL filesystem instead (no fs stubbing at all), against this feature's own real
// private-uploads/certificates directory, and clean up every file they create.
const path = require('path');
const PRIVATE_UPLOADS_DIR = path.join(__dirname, '..', 'private-uploads', 'certificates');

// getCertificateFile's success path does `fs.createReadStream(filePath).pipe(res)`,
// which needs a REAL writable stream (not the plain mockRes() object above) to pipe
// into, and resolves before the piped data has necessarily finished flowing — so
// callers await `res.finished` to know the stream genuinely completed before asserting.
function mockStreamRes() {
  const { Writable } = require('stream');
  const res = new Writable({ write(chunk, enc, cb) { cb(); } });
  res._status = 200;
  let resolveFinished;
  res.finished = new Promise((resolve) => { resolveFinished = resolve; });
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; resolveFinished(); return res; }; // error paths never reach .pipe()
  res.setHeader = () => {};
  res.on('finish', resolveFinished);
  res.on('error', resolveFinished);
  return res;
}

function stubModelsOnly({ existingStudentIds = [STUDENT_A] } = {}) {
  const origCreate = Certificate.create;
  const origFindById = Certificate.findById;
  const origUserFind = User.find;
  const store = makeFakeCertificateStore();
  Certificate.create = store.create;
  Certificate.findById = store.findById;
  User.find = (query) => {
    const ids = (query?._id?.$in || []).map(String);
    return mockQuery(ids.filter((id) => existingStudentIds.includes(id)).map((id) => ({ _id: id })));
  };
  return {
    store,
    restore() {
      Certificate.create = origCreate;
      Certificate.findById = origFindById;
      User.find = origUserFind;
    },
  };
}

test('replaceCertificate (REAL disk I/O): the OLD file is deleted, the NEW file is the one left on disk, and it is still viewable afterward', async () => {
  const { restore } = stubModelsOnly();
  const writtenPaths = [];
  const origWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (filePath, buf) => { writtenPaths.push(filePath); origWriteFileSync(filePath, buf); };
  try {
    const uploadRes = mockRes();
    await uploadCertificate({ user: ADMIN, body: { studentIds: [STUDENT_A], fileDataUrl: TINY_PNG_DATA_URL, fileName: 'first.png' } }, uploadRes);
    assert.equal(uploadRes._status, 201, JSON.stringify(uploadRes._body));
    const certId = uploadRes._body.certificate._id;
    const firstDiskPath = path.join(PRIVATE_UPLOADS_DIR, uploadRes._body.certificate.file.path);
    assert.ok(fs.existsSync(firstDiskPath), 'the first uploaded (watermarked) file must really exist on disk');

    const replaceRes = mockRes();
    await replaceCertificate({ user: ADMIN, params: { id: certId }, body: { fileDataUrl: TINY_PNG_DATA_URL, fileName: 'second.png' } }, replaceRes);
    assert.equal(replaceRes._status, 200, JSON.stringify(replaceRes._body));
    const secondDiskPath = path.join(PRIVATE_UPLOADS_DIR, replaceRes._body.certificate.file.path);

    assert.ok(!fs.existsSync(firstDiskPath), 'the OLD file must be deleted after Replace');
    assert.ok(fs.existsSync(secondDiskPath), 'the NEW (replacement) file must still exist on disk — this is what the bug deleted instead');

    // The exact real-world symptom: View must succeed, not 404, after a Replace.
    const viewRes = mockStreamRes();
    await getCertificateFile({ user: ADMIN, params: { id: certId } }, viewRes);
    await viewRes.finished;
    assert.equal(viewRes._status, 200, 'viewing the certificate after Replace must succeed, not "Could not open this certificate"');
  } finally {
    fs.writeFileSync = origWriteFileSync;
    for (const p of writtenPaths) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best effort */ } }
    restore();
  }
});

test('replaceCertificate (REAL disk I/O, PDF): same Replace-then-View regression check for a PDF certificate', async () => {
  const { PDFDocument } = require('pdf-lib');
  const blankDoc = await PDFDocument.create();
  blankDoc.addPage([300, 200]);
  const pdfDataUrl = `data:application/pdf;base64,${Buffer.from(await blankDoc.save()).toString('base64')}`;

  const { restore } = stubModelsOnly();
  const writtenPaths = [];
  const origWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (filePath, buf) => { writtenPaths.push(filePath); origWriteFileSync(filePath, buf); };
  try {
    const uploadRes = mockRes();
    await uploadCertificate({ user: ADMIN, body: { studentIds: [STUDENT_A], fileDataUrl: pdfDataUrl, fileName: 'first.pdf' } }, uploadRes);
    assert.equal(uploadRes._status, 201, JSON.stringify(uploadRes._body));
    const certId = uploadRes._body.certificate._id;
    const firstDiskPath = path.join(PRIVATE_UPLOADS_DIR, uploadRes._body.certificate.file.path);

    const replaceRes = mockRes();
    await replaceCertificate({ user: ADMIN, params: { id: certId }, body: { fileDataUrl: pdfDataUrl, fileName: 'second.pdf' } }, replaceRes);
    assert.equal(replaceRes._status, 200, JSON.stringify(replaceRes._body));
    const secondDiskPath = path.join(PRIVATE_UPLOADS_DIR, replaceRes._body.certificate.file.path);

    assert.ok(!fs.existsSync(firstDiskPath), 'the OLD PDF must be deleted after Replace');
    assert.ok(fs.existsSync(secondDiskPath), 'the NEW (replacement) PDF must still exist on disk');

    const bytesOnDisk = fs.readFileSync(secondDiskPath);
    const loaded = await PDFDocument.load(bytesOnDisk);
    assert.equal(loaded.getPageCount(), 1, 'the file left on disk must be a valid, loadable PDF');
  } finally {
    fs.writeFileSync = origWriteFileSync;
    for (const p of writtenPaths) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best effort */ } }
    restore();
  }
});

test('cleanup: nothing to tear down (no live DB connection opened by this suite)', () => {
  assert.ok(true);
});
