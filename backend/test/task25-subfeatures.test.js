/**
 * Task 25a — Academic Tutorial sub-feature clarification.
 *
 * "SPED Tutorial", "Pre-Kindergarten Readiness", "Homework Assistance", "Reading/Writing/
 * Numeracy", "Lesson Advancement" are SCOPE of the single Academic Tutorial program, not
 * separate priced programs. A public / parent user asking whether the service exists must
 * hear "yes — it's part of Academic Tutorial", never "we don't offer that" and never an
 * unqualified 3-program list.
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59583';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const Escalation = require('../models/Escalation');
const {
  chat,
  isAcademicSubFeatureQuestion,
  getAcademicSubFeatureReply,
  ACADEMIC_TUTORIAL_SUBFEATURES,
} = require('../controllers/aiController');

AuditLog.create = async () => ({});
Escalation.create = async () => ({});

// chat() runs getGroundedChatContext() for authenticated users, which touches Mongo.
test.before(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/beebright');
  }
});

const PARENT = { _id: new mongoose.Types.ObjectId(), role: 'parent' };

function ask(message, user = null) {
  return new Promise((resolve) => {
    const res = { status() { return res; }, json(p) { resolve(p.reply); return res; } };
    chat({ body: { message, history: [] }, user, headers: {}, ip: '127.0.0.1' }, res);
  });
}

const SUBFEATURE_QUESTIONS = [
  'May SPED tutorial ba kayo?',
  'Meron ba kayong homework assistance?',
  'May pre-kindergarten readiness ba kayo?',
  'do you offer special education tutoring',
  'is reading writing and numeracy enhancement available',
  'do you have pre-kinder readiness',
  'what about lesson advancement',
  'meron ba kayong homework help',
];

const NOT_SUBFEATURE = [
  'what programs do you offer',
  'how much is academic tutorial',
  'ano ang pagkakaiba ng mga programs',
  'how do i enroll my child',
  'where is bee bright located',
  'difference between sped tutorial and academic tutorial',
];

// ── unit ─────────────────────────────────────────────────────────────────

test('25a: sub-feature terms are recognised', () => {
  for (const q of SUBFEATURE_QUESTIONS) {
    assert.equal(isAcademicSubFeatureQuestion(q), true, q);
  }
});

test('25a NEGATIVE: plain program / pricing / comparison questions are not sub-feature questions', () => {
  for (const q of NOT_SUBFEATURE) {
    assert.equal(isAcademicSubFeatureQuestion(q), false, q);
  }
});

test('25a: the reply says it is part of Academic Tutorial and names the brochure scope', () => {
  const en = getAcademicSubFeatureReply('english');
  assert.match(en, /part of our Academic Tutorial/i);
  assert.match(en, /pre-school through high school/i);
  assert.match(en, /homework assistance/i);
  assert.match(en, /lesson advancement/i);
  assert.match(en, /SPED/);
  assert.doesNotMatch(en, /₱|PHP ?\d|\d{3,}/); // no invented price / figures
  for (const lang of ['filipino', 'taglish']) {
    assert.match(getAcademicSubFeatureReply(lang), /Academic Tutorial/);
  }
});

// ── e2e through chat() ───────────────────────────────────────────────────

test('25a e2e: public + parent get the sub-feature clarification, not a fee or a bare list', async () => {
  for (const user of [null, PARENT]) {
    for (const q of SUBFEATURE_QUESTIONS) {
      const reply = await ask(q, user);
      assert.match(reply, /part of our Academic Tutorial|bahagi iyon ng aming Academic Tutorial|part iyon ng aming Academic Tutorial/i,
        `${user ? 'parent' : 'public'}: ${q}`);
      assert.doesNotMatch(reply, /Program Fee:|₱3,500|SPED Tutorial\n/i, `${q} must not quote a per-program fee`);
    }
  }
});

test('25a e2e: a student asking for homework help still gets the tutoring-mode path, not this reply', async () => {
  const reply = await ask('can you help me with my math homework', { _id: 's1', role: 'student' });
  assert.doesNotMatch(reply, /part of our Academic Tutorial/i);
});

test('25a e2e: "what programs do you offer" is unchanged (still the program list)', async () => {
  const reply = await ask('what programs do you offer');
  assert.doesNotMatch(reply, /part of our Academic Tutorial/i);
});

// ── 25b — program replies no longer present sub-features as separate programs ──

test('25b: the sub-features are still documented (not deleted from existence)', () => {
  assert.ok(Array.isArray(ACADEMIC_TUTORIAL_SUBFEATURES) && ACADEMIC_TUTORIAL_SUBFEATURES.length === 5);
  assert.ok(ACADEMIC_TUTORIAL_SUBFEATURES.some((s) => /SPED/i.test(s)));
  assert.ok(ACADEMIC_TUTORIAL_SUBFEATURES.some((s) => /Pre-Kindergarten/i.test(s)));
});

test('25b e2e: no program reply lists a retired name as its own priced program', async () => {
  // A retired name presented as its own program == a bullet/heading for it, the
  // "…Program" proper noun, or a standalone "SPED Tutorial". Mentioning "pre-kindergarten
  // readiness" / "SPED (individualized) support" as Academic Tutorial scope is fine.
  const AS_OWN_PROGRAM = /(^|\n)[•\-*]?\s*(pre-?kindergarten|kindergarten readiness|sped)\b[^\n]*₱|Pre-Kindergarten Readiness Program|Kindergarten Readiness Program|\bSPED Tutorial\b/i;
  for (const q of [
    'what programs do you offer',
    'list all programs with prices',
    'summarize your programs',
    'what programs does bee bright have',
  ]) {
    const reply = await ask(q);
    assert.doesNotMatch(reply, AS_OWN_PROGRAM, q);
    assert.match(reply, /Toddlers Playgroup/i, q);
    assert.match(reply, /Academic Tutorial/i, q);
    assert.match(reply, /Examination Preparation/i, q);
  }
  // the individualized-support placement reply routes to Academic Tutorial, not "SPED Tutorial"
  const autism = await ask('do you have a program for autism');
  assert.doesNotMatch(autism, AS_OWN_PROGRAM);
  assert.match(autism, /Academic Tutorial/i);
});

test('25b e2e: "how much is SPED tutorial" defers to Academic Tutorial, no invented fee', async () => {
  const reply = await ask('how much is sped tutorial');
  assert.match(reply, /part of our Academic Tutorial/i);
  assert.doesNotMatch(reply, /₱3,500|PHP ?3500/);
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
});
