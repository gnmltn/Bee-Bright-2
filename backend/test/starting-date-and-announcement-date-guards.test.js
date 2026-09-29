/**
 * "bug (15).pdf" Group AT — there are no classes on Sunday, so the shared Step7Schedule.tsx
 * "Preferred Start Date" picker (Main Enrollment wizard, Add Child, Renew/Add Program, Admin
 * Walk-in — all four already shared this one component) now rejects Sunday client-side. This
 * file covers the matching server-side guards in enrollmentController.js's submitEnrollment
 * and adminWalkInEnroll, which stop a hand-crafted request the same way their existing
 * past-date guards already did.
 *
 * Group AU — the Create/Edit Announcement date field (Tutor + Admin, same shared handler in
 * announcementController.js) now rejects a date before today, both client-side (`min`) and
 * server-side (isScheduledDateInPast), so a forward-looking announcement can't be posted for
 * a date that's already gone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const emailService = require('../utils/emailService');
emailService.sendEmail = async () => ({ success: true });
emailService.logEmailError = () => {};
emailService.sendAnnouncementEmail = async () => true;
const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Pricing = require('../models/Pricing');
const EnrollmentCounter = require('../models/EnrollmentCounter');
const AssessmentTemplate = require('../models/AssessmentTemplate');
const Announcement = require('../models/Announcement');
const { submitEnrollment, adminWalkInEnroll } = require('../controllers/enrollmentController');
const { createAnnouncement, updateAnnouncement } = require('../controllers/announcementController');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}
function mockQuery(result) {
  const q = {
    select: () => q, sort: () => q, populate: () => q, lean: () => q,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch: (fn) => Promise.resolve(result).catch(fn),
  };
  return q;
}

// Next/most recent date (YYYY-MM-DD, local) that falls on the given day-of-week (0=Sun).
function nextDow(dow, { fromToday = true } = {}) {
  const d = new Date();
  while (d.getDay() !== dow) d.setDate(d.getDate() + (fromToday ? 1 : -1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const nextSunday = nextDow(0);
const nextMonday = nextDow(1);

// ─── Group AT: Sunday guard on the shared Preferred Start Date ────────────────────────────

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
    eFindOne: Enrollment.findOne, eSave: Enrollment.prototype.save, pSave: Payment.prototype.save,
    pricingFind: Pricing.find, counter: EnrollmentCounter.findOneAndUpdate,
    uFindByIdAndUpdate: User.findByIdAndUpdate, templateFind: AssessmentTemplate.find,
  };
  Pricing.find = () => ({ lean: async () => [PRICING_ROW] });
  EnrollmentCounter.findOneAndUpdate = async () => ({ seq: 7 });
  User.findByIdAndUpdate = async () => ({});
  AssessmentTemplate.find = () => ({ sort: () => ({ lean: async () => [] }) });
  const saved = {};
  Enrollment.prototype.save = async function () { saved.enrollment = this; return this; };
  Payment.prototype.save = async function () { saved.payment = this; return this; };
  return {
    saved,
    restore() {
      Enrollment.findOne = orig.eFindOne; Enrollment.prototype.save = orig.eSave; Payment.prototype.save = orig.pSave;
      Pricing.find = orig.pricingFind; EnrollmentCounter.findOneAndUpdate = orig.counter;
      User.findByIdAndUpdate = orig.uFindByIdAndUpdate; AssessmentTemplate.find = orig.templateFind;
    },
  };
}

test('submitEnrollment: a hand-crafted request with a Sunday preferredStartDate is rejected (400)', async () => {
  const { restore } = stubEnrollmentFlow();
  try {
    const res = mockRes();
    await submitEnrollment({ user: PARENT, body: baseBody({ preferredStartDate: nextSunday }) }, res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.match(res._body.message, /Sunday/i);
  } finally { restore(); }
});

test('submitEnrollment: a non-Sunday preferredStartDate still enrolls successfully (guard is not overly broad)', async () => {
  const { saved, restore } = stubEnrollmentFlow();
  try {
    const res = mockRes();
    await submitEnrollment({ user: PARENT, body: baseBody({ preferredStartDate: nextMonday }) }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
    assert.equal(new Date(saved.enrollment.preferredStartDate).toISOString().slice(0, 10), nextMonday);
  } finally { restore(); }
});

function stubWalkIn() {
  const orig = {
    userFindOne: User.findOne, userFindById: User.findById, userFindByIdAndUpdate: User.findByIdAndUpdate,
    pricingFind: Pricing.find, counter: EnrollmentCounter.findOneAndUpdate,
    eSave: Enrollment.prototype.save, pSave: Payment.prototype.save,
  };
  const parent = { _id: 'parent-1', role: 'parent', firstName: 'Maria', lastName: 'Cruz', email: 'maria@example.com' };
  User.findOne = async () => parent;
  User.findById = () => ({ select: () => ({ lean: async () => parent }) });
  User.findByIdAndUpdate = async () => ({});
  Pricing.find = () => ({ lean: async () => [PRICING_ROW] });
  EnrollmentCounter.findOneAndUpdate = async () => ({ seq: 1 });
  const saved = {};
  Enrollment.prototype.save = async function () { saved.enrollment = this; return this; };
  Payment.prototype.save = async function () { saved.payment = this; return this; };
  return {
    saved,
    restore() {
      User.findOne = orig.userFindOne; User.findById = orig.userFindById; User.findByIdAndUpdate = orig.userFindByIdAndUpdate;
      Pricing.find = orig.pricingFind; EnrollmentCounter.findOneAndUpdate = orig.counter;
      Enrollment.prototype.save = orig.eSave; Payment.prototype.save = orig.pSave;
    },
  };
}

test('adminWalkInEnroll: a hand-crafted request with a Sunday preferredStartDate is rejected (400)', async () => {
  const { restore } = stubWalkIn();
  try {
    const res = mockRes();
    await adminWalkInEnroll({
      user: { _id: 'admin-1', role: 'admin' },
      body: { parentId: 'parent-1', packages: [{ programCode: 'ACT102', packageSlug: 'premier-elementary' }],
        studentFirstName: 'Ana', studentLastName: 'Cruz', birthdate: '2018-01-01',
        consentVersion: '1.0', consentItems: [{ name: 'participation_agreement', accepted: true, version: '1.0' }],
        amountPaid: 1200, preferredStartDate: nextSunday },
    }, res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.match(res._body.message, /Sunday/i);
  } finally { restore(); }
});

// ─── Group AU: past-date guard on the shared Announcement scheduledDate ───────────────────

test('createAnnouncement (admin): a scheduledDate before today is rejected (400), never silently accepted', async () => {
  const origCreate = Announcement.create;
  Announcement.create = async () => { throw new Error('should not reach Announcement.create'); };
  try {
    const res = mockRes();
    await createAnnouncement({ user: { id: 'admin-1', role: 'admin' }, body: { title: 'Holiday', body: 'No classes', category: 'holiday', scheduledDate: '2020-01-01' } }, res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.match(res._body.message, /past/i);
  } finally { Announcement.create = origCreate; }
});

test('createAnnouncement (admin): today and future scheduledDate values are accepted', async () => {
  const orig = { create: Announcement.create, findById: Announcement.findById, userFind: User.find };
  User.find = () => mockQuery([]);
  const created = { _id: 'ann-2', title: 'Holiday', body: 'No classes', category: 'holiday' };
  Announcement.create = async () => created;
  Announcement.findById = () => ({ populate: async () => created });
  try {
    const res = mockRes();
    await createAnnouncement({ user: { id: 'admin-1', role: 'admin' }, body: { title: 'Holiday', body: 'No classes', category: 'holiday', scheduledDate: nextMonday } }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));
  } finally { Announcement.create = orig.create; Announcement.findById = orig.findById; User.find = orig.userFind; }
});

test('updateAnnouncement: editing an announcement to a past scheduledDate is rejected (400)', async () => {
  const orig = { annFindById: Announcement.findById };
  const ann = {
    _id: 'ann-3', authorRole: 'admin', author: 'admin-1',
    save: async function () { return this; },
  };
  Announcement.findById = async () => ann;
  try {
    const res = mockRes();
    await updateAnnouncement({
      params: { id: '507f1f77bcf86cd799439201' },
      user: { id: 'admin-1', role: 'admin' },
      body: { title: 'Holiday', body: 'No classes', category: 'holiday', scheduledDate: '2020-01-01' },
    }, res);
    assert.equal(res._status, 400, JSON.stringify(res._body));
    assert.match(res._body.message, /past/i);
  } finally { Announcement.findById = orig.annFindById; }
});
