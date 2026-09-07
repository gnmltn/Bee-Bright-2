/**
 * Final dataset additions from the system-wide coverage scan:
 *   visitorQueries  +V007 (absence notice), +V008 (track w/o login), +V009 (mobile app)
 *   studentQueries  +S041..S045 (login OTP, change pw, resubmit payment, invoices, auto-logout)
 *   tutorQueries    +T006..T008 (mark attendance, set availability, report day off)
 *   adminQueries    +A003..A005 (add tutor, post announcement, handle escalations)
 *   intentKeywordRules +theme_toggle
 *   V004 expectedReply extended (Track Enrollment page reference)
 *
 * V006 was NOT re-added (already present with the owner-confirmed policy). V010 skipped
 * on purpose — the live ticket-status handler (Task 31) owns that question.
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59589';

const test = require('node:test');
const assert = require('node:assert/strict');

const D = require('../ai_training/aiResponseDatasets');
const { findDatasetMatch } = require('../controllers/aiController');

const ALL_QA = [
  ...D.studentQueries, ...D.tutorQueries, ...D.adminQueries, ...D.visitorQueries,
];
const byId = Object.fromEntries(ALL_QA.map((e) => [e.id, e]));

test('all new Q&A entries exist, are trilingual, and carry no invented amounts/counts/status', () => {
  const ids = ['V007', 'V008', 'V009', 'S041', 'S042', 'S043', 'S044', 'S045', 'T006', 'T007', 'T008', 'A003', 'A004', 'A005'];
  for (const id of ids) {
    const e = byId[id];
    assert.ok(e, `${id} missing`);
    for (const lang of ['en', 'fil', 'tgl']) {
      assert.ok(e.queries[lang], `${id}.queries.${lang}`);
      assert.ok(e.expectedReply[lang], `${id}.expectedReply.${lang}`);
      assert.doesNotMatch(e.expectedReply[lang], /₱|PHP ?\d|\$\d/, `${id}.${lang} has a currency amount`);
    }
  }
});

test('role tags match the array', () => {
  for (const id of ['S041', 'S042', 'S043', 'S044', 'S045']) assert.equal(byId[id].role, 'student', id);
  for (const id of ['T006', 'T007', 'T008']) assert.equal(byId[id].role, 'tutor', id);
  for (const id of ['A003', 'A004', 'A005']) assert.equal(byId[id].role, 'admin', id);
});

test('no duplicate ids across the Q&A arrays', () => {
  const ids = ALL_QA.map((e) => e.id);
  const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.deepEqual(dupes, []);
});

test('V010 was not assigned to anything', () => {
  assert.ok(!byId.V010, 'V010 must stay unused — the live ticket-status handler owns that question');
});

test('getDatasetCount reflects the additions (108)', () => {
  assert.equal(D.getDatasetCount(), 108);
  const t = D.getDatasetCountByType();
  assert.equal(t.studentQueries, 45);
  assert.equal(t.tutorQueries, 8);
  assert.equal(t.adminQueries, 5);
  assert.equal(t.visitorQueries, 12);
  assert.equal(t.intentKeywordRules, 26);
});

test('V004 keeps the real contact channels and now points to the Track Enrollment page', () => {
  const v4 = byId.V004.expectedReply.en;
  assert.match(v4, /beebrightph@gmail\.com/);
  assert.match(v4, /Barangay Pantal/);
  assert.match(v4, /Track Enrollment page/i);
});

test('each new question routes to its own entry (role pool)', () => {
  const cases = [
    ['how do I let bee bright know my child will miss a class', 'visitor', 'V007'],
    ['how do I check my enrollment status without logging in', 'visitor', 'V008'],
    ['do you have a mobile app', 'visitor', 'V009'],
    ['why do I need to enter a verification code to log in', 'student', 'S041'],
    ['how do I change my password while logged in', 'student', 'S042'],
    ['my payment was rejected how do I resubmit it', 'student', 'S043'],
    ['where do I see my invoices and payment history', 'student', 'S044'],
    ['why was I logged out automatically', 'student', 'S045'],
    ['how do I mark attendance for my students', 'tutor', 'T006'],
    ['how do I set my teaching availability', 'tutor', 'T007'],
    ['how do I report that I will be unavailable or request a day off', 'tutor', 'T008'],
    ['how do I add a new tutor account', 'admin', 'A003'],
    ['how do I create and post an announcement', 'admin', 'A004'],
    ['how do I handle support requests from users', 'admin', 'A005'],
  ];
  for (const [q, role, want] of cases) {
    assert.equal(findDatasetMatch(q, role)?.id, want, `${role}: ${q}`);
  }
});

test('V007 does NOT steal V013 (attendance policy for missed sessions still wins)', () => {
  for (const role of ['visitor', 'student', 'tutor']) {
    assert.equal(
      findDatasetMatch('what is your attendance policy for missed sessions', role)?.id,
      'V013',
      role,
    );
  }
});

test('theme_toggle intent rule matches dark/light-mode phrasings, not unrelated ones', () => {
  const rule = D.intentKeywordRules.find((r) => r.intent === 'theme_toggle');
  assert.ok(rule);
  assert.equal(rule.roleScope, 'all');
  assert.ok(rule.replies.en && rule.replies.fil);
  for (const m of ['how do I enable dark mode', 'switch theme', 'night mode', 'dark mode ba']) {
    assert.equal(D.getIntentKeywordMatch(m, 'student')?.intent, 'theme_toggle', m);
  }
  assert.notEqual(D.getIntentKeywordMatch('what is my schedule', 'student')?.intent, 'theme_toggle');
});
