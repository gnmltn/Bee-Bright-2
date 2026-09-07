const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const {
  getStudentCountReply,
  getTutorCountReply,
  getEnrollmentStatusReply,
  getPaymentMethodsReply,
} = require('../controllers/aiController');

function stubCount(model, impl) {
  const orig = model.countDocuments;
  model.countDocuments = impl;
  return () => { model.countDocuments = orig; };
}

const ADMIN = { _id: 'a1', role: 'admin' };

// ── Task 15 — counts ──────────────────────────────────────────────────────

test('getStudentCountReply: counts approved + active enrollments (matches dashboard)', async () => {
  let seenFilter = null;
  const restore = stubCount(Enrollment, async (filter) => { seenFilter = filter; return 7; });
  try {
    const reply = await getStudentCountReply(ADMIN, 'how many students do we have', 'english');
    assert.match(reply, /\b7 enrolled students\b/);
    // The count query must be the same one the admin dashboard uses.
    assert.deepEqual(seenFilter, { status: { $in: ['approved', 'active'] } });
  } finally { restore(); }
});

test('getStudentCountReply: regression — reply number equals a live countDocuments result', async () => {
  const LIVE = 42;
  const restore = stubCount(Enrollment, async () => LIVE);
  try {
    const expected = await Enrollment.countDocuments({ status: { $in: ['approved', 'active'] } });
    const reply = await getStudentCountReply(ADMIN, 'total number of students', 'english');
    assert.match(reply, new RegExp(`\\b${expected}\\b`));
  } finally { restore(); }
});

test('getStudentCountReply: not for non-admins', async () => {
  const restore = stubCount(Enrollment, async () => 5);
  try {
    for (const role of ['student', 'parent', 'tutor']) {
      const reply = await getStudentCountReply({ _id: 'x', role }, 'how many students do we have', 'english');
      assert.match(reply, /not yet available in the system/i);
    }
    assert.equal(await getStudentCountReply(ADMIN, 'what is the weather', 'english'), null);
  } finally { restore(); }
});

test('getTutorCountReply: regression — reply number equals a live User.countDocuments', async () => {
  const LIVE = 9;
  const restore = stubCount(User, async () => LIVE);
  try {
    const expected = await User.countDocuments({ role: 'tutor', isArchived: { $ne: true } });
    const reply = await getTutorCountReply(ADMIN, 'how many tutors do we have', 'english');
    assert.match(reply, new RegExp(`\\b${expected} tutors\\b`));
  } finally { restore(); }
});

test('getEnrollmentStatusReply: "currently enrolled" counts approved + active, not just active', async () => {
  let seenFilter = null;
  const restore = stubCount(Enrollment, async (filter) => { seenFilter = filter; return 3; });
  try {
    const reply = await getEnrollmentStatusReply(ADMIN, 'how many students are currently enrolled', 'english');
    assert.match(reply, /\b3 currently active enrollments\b/);
    assert.deepEqual(seenFilter, { status: { $in: ['approved', 'active'] } });
  } finally { restore(); }
});

// ── Task 13 — payment methods ─────────────────────────────────────────────

test('getPaymentMethodsReply: lists GCash / SeaBank / BDO, no blockchain', () => {
  const reply = getPaymentMethodsReply('english', 'what payment methods are available');
  assert.match(reply, /GCash/);
  assert.match(reply, /SeaBank/);
  assert.match(reply, /BDO/);
  assert.doesNotMatch(reply, /blockchain|metamask|ganache|crypto/i);
});

test('getPaymentMethodsReply: asking about crypto → "no longer accepted"', () => {
  const reply = getPaymentMethodsReply('english', 'can i pay with blockchain or metamask');
  assert.match(reply, /no longer accepted/i);
  assert.match(reply, /GCash/);
});

test('getPaymentMethodsReply: Filipino + Taglish also drop blockchain', () => {
  for (const lang of ['filipino', 'taglish']) {
    const reply = getPaymentMethodsReply(lang, 'anong payment methods');
    assert.match(reply, /GCash/);
    assert.match(reply, /SeaBank/);
    assert.match(reply, /BDO/);
    assert.doesNotMatch(reply, /blockchain|metamask/i);
  }
});
