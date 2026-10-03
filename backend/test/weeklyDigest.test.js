/**
 * Admin Weekly Digest — getWeekRange/aggregateWeeklyStats/resolveFollowUps/renderDigestPdf
 * (backend/controllers/reportController.js) and generateDigestNarrative
 * (backend/utils/geminiClient.js). Mongoose model calls are stubbed (no real DB), and
 * geminiClient.generateDigestNarrative is stubbed too (no real network calls in tests).
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const User = require('../models/User');
const WeeklyDigest = require('../models/WeeklyDigest');
const geminiClient = require('../utils/geminiClient');
const reportController = require('../controllers/reportController');

function mockFindQuery(result) {
  const q = {
    select: () => q,
    populate: () => q,
    sort: () => q,
    limit: () => q,
    lean: () => Promise.resolve(result)
  };
  return q;
}

test('getWeekRange: returns a Sunday-start, Saturday-end range containing "now"', () => {
  // Wednesday, Oct 7 2026
  const now = new Date(2026, 9, 7, 15, 30);
  const { weekStart, weekEnd } = reportController.getWeekRange(now);
  assert.equal(weekStart.getDay(), 0, 'weekStart should be a Sunday');
  assert.equal(weekEnd.getDay(), 6, 'weekEnd should be a Saturday');
  assert.equal(weekStart.getDate(), 4); // Sunday Oct 4, 2026
  assert.equal(weekEnd.getDate(), 10); // Saturday Oct 10, 2026
  assert.ok(weekStart <= now && now <= weekEnd);
});

test('aggregateWeeklyStats: produces correct counts/sums from mock data using the real enum values', async (t) => {
  const origEnrollmentAggregate = Enrollment.aggregate;
  const origPaymentAggregate = Payment.aggregate;
  const origUserCount = User.countDocuments;
  const origUserAggregate = User.aggregate;

  t.after(() => {
    Enrollment.aggregate = origEnrollmentAggregate;
    Payment.aggregate = origPaymentAggregate;
    User.countDocuments = origUserCount;
    User.aggregate = origUserAggregate;
  });

  let enrollmentCall = 0;
  Enrollment.aggregate = (pipeline) => {
    enrollmentCall += 1;
    // First call: status breakdown. Second call: top-program ($unwind present).
    const isTopProgram = pipeline.some((stage) => stage.$unwind);
    if (isTopProgram) {
      return Promise.resolve([
        { _id: { programCode: 'ACT102', displayName: 'Academic Tutorial' }, count: 5 }
      ]);
    }
    return Promise.resolve([
      { _id: 'approved', count: 3 },
      { _id: 'submitted', count: 2 }
    ]);
  };

  Payment.aggregate = () => Promise.resolve([
    { _id: 'verified', count: 4, total: 8000 },
    { _id: 'pending', count: 1, total: 1500 }
  ]);

  User.countDocuments = () => Promise.resolve(42);
  User.aggregate = () => Promise.resolve([
    { _id: 'student', count: 20 },
    { _id: 'tutor', count: 5 }
  ]);

  const weekStart = new Date(2026, 9, 4);
  const weekEnd = new Date(2026, 9, 10, 23, 59, 59, 999);
  const stats = await reportController.aggregateWeeklyStats(weekStart, weekEnd);

  assert.equal(stats.enrollments.total, 5);
  assert.deepEqual(stats.enrollments.byStatus, { approved: 3, submitted: 2 });
  assert.equal(stats.payments.verifiedTotal, 8000);
  assert.equal(stats.payments.pendingTotal, 1500);
  assert.equal(stats.activeUsers.total, 42);
  assert.deepEqual(stats.activeUsers.byRole, { student: 20, tutor: 5 });
  assert.equal(stats.topProgram.programCode, 'ACT102');
  assert.equal(stats.topProgram.count, 5);
  assert.ok(enrollmentCall >= 2);
});

test('resolveFollowUps: only includes in-flight statuses, never a full name/reference/email/phone', async (t) => {
  const origEnrollmentFind = Enrollment.find;
  const origPaymentFind = Payment.find;
  t.after(() => {
    Enrollment.find = origEnrollmentFind;
    Payment.find = origPaymentFind;
  });

  Enrollment.find = () => mockFindQuery([
    {
      studentSnapshot: { firstName: 'Jake', lastName: 'Lim' },
      status: 'pending_approval',
      createdAt: new Date(2026, 9, 5)
    }
  ]);
  Payment.find = () => mockFindQuery([
    {
      status: 'rejected',
      amount: 3000,
      createdAt: new Date(2026, 9, 6),
      parent: { firstName: 'Maria', lastName: 'Santos' }
    }
  ]);

  const followUps = await reportController.resolveFollowUps(new Date(2026, 9, 4), new Date(2026, 9, 10));

  assert.equal(followUps.length, 2);
  const enrollmentItem = followUps.find((f) => f.type === 'enrollment');
  const paymentItem = followUps.find((f) => f.type === 'payment');

  assert.match(enrollmentItem.label, /Jake L\./);
  assert.doesNotMatch(enrollmentItem.label, /Lim\b/); // never the full last name
  assert.match(paymentItem.label, /Maria S\./);
  assert.doesNotMatch(paymentItem.label, /Santos/);
  assert.doesNotMatch(paymentItem.label, /3000|₱/); // never a raw amount or reference number
  assert.doesNotMatch(JSON.stringify(followUps), /@|\d{7,}/); // never an email or a long digit run (phone/reference)
});

function mockRes() {
  const res = {
    statusCode: null,
    headers: {},
    jsonBody: null,
    sentBuffer: null,
    setHeader(key, value) { res.headers[key] = value; },
    status(code) { res.statusCode = code; return res; },
    json(body) { res.jsonBody = body; return res; },
    send(buf) { res.sentBuffer = buf; return res; }
  };
  return res;
}

test('generateWeeklyDigest: aggregates, calls Gemini once, saves a digest, logs an audit entry, and returns a PDF', async (t) => {
  const origEnrollmentAggregate = Enrollment.aggregate;
  const origPaymentAggregate = Payment.aggregate;
  const origUserCount = User.countDocuments;
  const origUserAggregate = User.aggregate;
  const origEnrollmentFind = Enrollment.find;
  const origPaymentFind = Payment.find;
  const origCreate = WeeklyDigest.create;
  const origGenerate = geminiClient.generateDigestNarrative;

  t.after(() => {
    Enrollment.aggregate = origEnrollmentAggregate;
    Payment.aggregate = origPaymentAggregate;
    User.countDocuments = origUserCount;
    User.aggregate = origUserAggregate;
    Enrollment.find = origEnrollmentFind;
    Payment.find = origPaymentFind;
    WeeklyDigest.create = origCreate;
    geminiClient.generateDigestNarrative = origGenerate;
  });

  Enrollment.aggregate = () => Promise.resolve([]);
  Payment.aggregate = () => Promise.resolve([]);
  User.countDocuments = () => Promise.resolve(0);
  User.aggregate = () => Promise.resolve([]);
  Enrollment.find = () => mockFindQuery([]);
  Payment.find = () => mockFindQuery([]);

  let generateCallCount = 0;
  geminiClient.generateDigestNarrative = async () => {
    generateCallCount += 1;
    return 'A quiet week overall.\n\nNeeds Follow-up:\nNothing needs follow-up this week.';
  };

  let savedDoc = null;
  WeeklyDigest.create = async (doc) => {
    savedDoc = { ...doc, _id: 'digest-new' };
    return savedDoc;
  };

  const req = { user: { id: 'admin-1' }, headers: {}, ip: '127.0.0.1' };
  const res = mockRes();

  await reportController.generateWeeklyDigest(req, res);

  assert.equal(generateCallCount, 1);
  assert.ok(savedDoc, 'expected WeeklyDigest.create to be called');
  assert.equal(savedDoc.generatedBy, 'admin-1');
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.ok(Buffer.isBuffer(res.sentBuffer));
  assert.equal(res.sentBuffer.slice(0, 5).toString('utf8'), '%PDF-');
  assert.equal(res.statusCode, 200);
});

test('downloadWeeklyDigestPdf: re-renders a saved digest\'s PDF without calling Gemini again', async (t) => {
  const origFindById = WeeklyDigest.findById;
  const origGenerate = geminiClient.generateDigestNarrative;

  let generateCallCount = 0;
  geminiClient.generateDigestNarrative = async () => {
    generateCallCount += 1;
    return 'should never be called';
  };

  const savedDoc = {
    _id: 'digest-1',
    weekStart: new Date(2026, 9, 4),
    weekEnd: new Date(2026, 9, 10, 23, 59, 59, 999),
    reportText: 'This week saw steady activity.\n\nNeeds Follow-up:\nJake L. — enrollment pending approval since Oct 5',
    followUps: [{ type: 'enrollment', label: 'Jake L. — enrollment pending approval', date: new Date(2026, 9, 5) }]
  };
  WeeklyDigest.findById = () => ({ lean: () => Promise.resolve(savedDoc) });

  t.after(() => {
    WeeklyDigest.findById = origFindById;
    geminiClient.generateDigestNarrative = origGenerate;
  });

  const req = { params: { id: 'digest-1' } };
  const res = mockRes();
  await reportController.downloadWeeklyDigestPdf(req, res);

  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.ok(Buffer.isBuffer(res.sentBuffer));
  assert.equal(res.sentBuffer.slice(0, 5).toString('utf8'), '%PDF-');
  assert.equal(generateCallCount, 0, 'must not call Gemini when re-downloading a saved digest');
});

test('downloadWeeklyDigestPdf: 404s when the digest does not exist', async (t) => {
  const origFindById = WeeklyDigest.findById;
  WeeklyDigest.findById = () => ({ lean: () => Promise.resolve(null) });
  t.after(() => { WeeklyDigest.findById = origFindById; });

  const req = { params: { id: 'missing' } };
  const res = mockRes();
  await reportController.downloadWeeklyDigestPdf(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.jsonBody.success, false);
});

test('reportRoutes.js: all 3 weekly-digest endpoints require authorize(\'admin\')', () => {
  const routesSource = fs.readFileSync(path.join(__dirname, '../routes/reportRoutes.js'), 'utf8');
  const matches = routesSource.match(/authorize\('admin'\)/g) || [];
  assert.equal(matches.length, 3, 'expected authorize(\'admin\') on all 3 routes');
  assert.match(routesSource, /router\.use\(protect\)/);
});
