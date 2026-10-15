/**
 * Security audit fix #8 — saveProofFromDataUrl/saveRequirementFromDataUrl (enrollmentController.js)
 * previously only checked the CLIENT-DECLARED `data:image/png;base64,...` prefix, never the
 * actual bytes. A file that lies about its own type (e.g. a non-image renamed/relabeled as a
 * PNG) would previously have been written to disk and served back as-is. Both functions now
 * run the decoded bytes through the same magic-byte sniffing already used elsewhere in this
 * app (detectChildPhotoMime) before accepting the upload.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const emailService = require('../utils/emailService');
emailService.sendEmail = async () => ({ success: true });
emailService.logEmailError = () => {};

const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Pricing = require('../models/Pricing');
const EnrollmentCounter = require('../models/EnrollmentCounter');
const AssessmentTemplate = require('../models/AssessmentTemplate');
const { submitPaymentProof, submitEnrollment } = require('../controllers/enrollmentController');

// A real, minimal valid 1x1 PNG (genuine magic bytes) vs. a file that merely CLAIMS to be
// one — plain ASCII text, which is what a renamed/relabeled non-image upload looks like.
const REAL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const REAL_PNG_DATA_URL = `data:image/png;base64,${REAL_PNG_BASE64}`;
const SPOOFED_PNG_DATA_URL = 'data:image/png;base64,' + Buffer.from('this is definitely not a png, just text pretending to be one').toString('base64');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

// ── saveProofFromDataUrl, exercised via submitPaymentProof ─────────────────────────

function makeEnrollment(overrides = {}) {
  const doc = {
    _id: 'enr-1',
    enrollmentId: 'BB-20260904-0001',
    parent: 'parent-1',
    status: 'approved',
    paymentStatus: 'pending',
    totalFee: 4000,
    packages: [{ price: 4000 }],
    statusHistory: [],
    studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' },
    ...overrides,
  };
  doc.save = async () => doc;
  return doc;
}

function stubFsAndUser() {
  const fs = require('fs');
  const orig = { write: fs.writeFileSync, exists: fs.existsSync, mkdir: fs.mkdirSync, userFindById: User.findById };
  const written = [];
  fs.writeFileSync = (p) => { written.push(p); };
  fs.existsSync = () => true;
  fs.mkdirSync = () => {};
  User.findById = () => ({ select: () => ({ lean: async () => ({ _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' }) }) });
  return { written, restore: () => { fs.writeFileSync = orig.write; fs.existsSync = orig.exists; fs.mkdirSync = orig.mkdir; User.findById = orig.userFindById; } };
}

test('submitPaymentProof: a genuinely valid PNG still succeeds', async () => {
  const enrollment = makeEnrollment();
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  const origPaymentSave = Payment.prototype.save;
  Enrollment.findOne = async () => enrollment;
  Payment.findOne = () => ({ sort: () => Promise.resolve(null) });
  Payment.prototype.save = async function () { return this; };
  const { written, restore } = stubFsAndUser();
  try {
    const res = mockRes();
    await submitPaymentProof({
      params: { enrollmentId: 'BB-20260904-0001' },
      user: { _id: 'parent-1', role: 'parent' },
      body: { proofDataUrl: REAL_PNG_DATA_URL, paymentMethod: 'gcash' },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(written.length, 1, 'the real PNG should have been written to disk');
  } finally {
    Enrollment.findOne = origEnrollmentFindOne;
    Payment.findOne = origPaymentFindOne;
    Payment.prototype.save = origPaymentSave;
    restore();
  }
});

test('submitPaymentProof: a file that only CLAIMS to be a PNG (spoofed declared type) is now rejected — previously this would have been accepted', async () => {
  const enrollment = makeEnrollment();
  const origEnrollmentFindOne = Enrollment.findOne;
  const origPaymentFindOne = Payment.findOne;
  const origPaymentSave = Payment.prototype.save;
  Enrollment.findOne = async () => enrollment;
  // No existing Payment record (same as the valid-PNG test above) triggers the
  // self-heal branch, which creates+saves a Payment BEFORE the proof is even looked
  // at — stub save so that pre-existing step doesn't fail on an unrelated mocking
  // detail, keeping this test isolated to the new content-sniffing check below it.
  Payment.findOne = () => ({ sort: () => Promise.resolve(null) });
  Payment.prototype.save = async function () { return this; };
  const { written, restore } = stubFsAndUser();
  try {
    const res = mockRes();
    await submitPaymentProof({
      params: { enrollmentId: 'BB-20260904-0001' },
      user: { _id: 'parent-1', role: 'parent' },
      body: { proofDataUrl: SPOOFED_PNG_DATA_URL, paymentMethod: 'gcash' },
    }, res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.match(res._body.message, /does not match its declared file type/i);
    assert.equal(written.length, 0, 'a spoofed file must never be written to disk');
  } finally {
    Enrollment.findOne = origEnrollmentFindOne;
    Payment.findOne = origPaymentFindOne;
    Payment.prototype.save = origPaymentSave;
    restore();
  }
});

// ── saveRequirementFromDataUrl, exercised via submitEnrollment's studentPhoto field ────

const PARENT_ID = '507f1f77bcf86cd799439011';
const PARENT = { _id: PARENT_ID, role: 'parent', firstName: 'Maria', lastName: 'Soriano', email: 'maria@example.com', enrollmentDraft: false };
const PRICING_ROW = { programCode: 'ACT102', packageSlug: 'premier-elementary', displayName: 'Academic Tutorial - Premier', priceFull: 2400, sessionCount: 12 };

function baseBody(overrides = {}) {
  return {
    packages: [{ programCode: 'ACT102', packageSlug: 'premier-elementary' }],
    studentFirstName: 'Leo', studentLastName: 'Soriano', birthdate: '2018-03-04',
    paymentMethod: 'gcash',
    consentVersion: '1.0', consentItems: [{ name: 'participation_agreement', accepted: true, version: '1.0' }],
    assessment: { applicable: false, skipReason: 'Not applicable' },
    ...overrides,
  };
}

function stubEnrollmentFlow() {
  const orig = {
    eSave: Enrollment.prototype.save, pSave: Payment.prototype.save,
    pricingFind: Pricing.find, counter: EnrollmentCounter.findOneAndUpdate,
    uFindByIdAndUpdate: User.findByIdAndUpdate, templateFind: AssessmentTemplate.find,
  };
  const written = [];
  const fs = require('fs');
  const origWrite = fs.writeFileSync;
  const origExists = fs.existsSync;
  const origMkdir = fs.mkdirSync;
  fs.writeFileSync = (p) => { written.push(p); };
  fs.existsSync = () => true;
  fs.mkdirSync = () => {};
  Pricing.find = () => ({ lean: async () => [PRICING_ROW] });
  EnrollmentCounter.findOneAndUpdate = async () => ({ seq: 9 });
  User.findByIdAndUpdate = async () => ({});
  AssessmentTemplate.find = () => ({ sort: () => ({ lean: async () => [] }) });
  Enrollment.prototype.save = async function () { return this; };
  Payment.prototype.save = async function () { return this; };
  return {
    written,
    restore() {
      Enrollment.prototype.save = orig.eSave; Payment.prototype.save = orig.pSave;
      Pricing.find = orig.pricingFind; EnrollmentCounter.findOneAndUpdate = orig.counter;
      User.findByIdAndUpdate = orig.uFindByIdAndUpdate; AssessmentTemplate.find = orig.templateFind;
      fs.writeFileSync = origWrite; fs.existsSync = origExists; fs.mkdirSync = origMkdir;
    },
  };
}

test('submitEnrollment: a genuinely valid student-photo PNG still succeeds', async () => {
  const { written, restore } = stubEnrollmentFlow();
  try {
    const res = mockRes();
    await submitEnrollment({
      user: PARENT,
      body: baseBody({ requirementDocuments: { studentPhoto: { dataUrl: REAL_PNG_DATA_URL, fileName: 'leo.png' } } }),
    }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(written.length, 1, 'the real student-photo PNG should have been written to disk');
  } finally { restore(); }
});

test('submitEnrollment: a student-photo file that only CLAIMS to be a PNG is rejected before the enrollment is created', async () => {
  const { written, restore } = stubEnrollmentFlow();
  try {
    const res = mockRes();
    await submitEnrollment({
      user: PARENT,
      body: baseBody({ requirementDocuments: { studentPhoto: { dataUrl: SPOOFED_PNG_DATA_URL, fileName: 'leo.png' } } }),
    }, res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.match(res._body.message, /does not match its declared file type/i);
    assert.equal(written.length, 0, 'a spoofed student photo must never be written to disk, and the enrollment must not be created');
  } finally { restore(); }
});
