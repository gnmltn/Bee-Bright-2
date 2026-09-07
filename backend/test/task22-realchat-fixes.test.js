/**
 * Task 22 — fixes from real public-chat transcripts.
 *   22a typo / Taglish-affix tolerance
 *   22b "pinagkaiba" comparison keyword
 *   22c confirmation-seeking follow-ups ("ganun ba", "yan kaya", "totoo ba")
 *   22d fallback message includes "programs"
 *   22e comparison intent returns differentiated content, not the plain list
 *
 * Includes NEGATIVE cases — loosening the matcher must not create false positives.
 */
process.env.OLLAMA_URL = 'http://127.0.0.1:59577';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const Escalation = require('../models/Escalation');
const K = require('../utils/keywordWeighting');
const { chat, isProgramComparisonQuestion } = require('../controllers/aiController');

AuditLog.create = async () => ({});
Escalation.create = async () => ({});

function ask(message, history = [], user = null) {
  return new Promise((resolve) => {
    const res = { status() { return res; }, json(p) { resolve(p.reply); return res; } };
    chat({ body: { message, history }, user, headers: {}, ip: '127.0.0.1' }, res);
  });
}

// ── 22a — typo / affix normalisation (unit) ───────────────────────────────

test('22a: fuzzyCanonical fixes the exact reported failures', () => {
  assert.equal(K.fuzzyCanonical('enrollement'), 'enrollment');
  assert.equal(K.fuzzyCanonical('malolocate'), 'locate');   // "ma" + "lo" redup + "locate"
  assert.equal(K.fuzzyCanonical('schedual'), 'schedule');
  assert.equal(K.fuzzyCanonical('payement'), 'payment');
});

test('22a: Taglish affix stripping', () => {
  assert.deepEqual(K.stripFilipinoAffixes('na-schedule'), ['schedule']);
  assert.ok(K.stripFilipinoAffixes('magbabayad').includes('bayad'));
  assert.ok(K.stripFilipinoAffixes('malolocate').includes('locate'));
});

test('22a NEGATIVE: real words and short words are left alone', () => {
  for (const w of ['enroll', 'schedule', 'payment', 'program', 'pandemic', 'academic',
    'apple', 'water', 'happy', 'the', 'ako', 'saan']) {
    assert.equal(K.fuzzyCanonical(w), null, w);
  }
  // a whole sentence of unrelated words: normalizeTypos must not rewrite most of it
  const out = K.normalizeTypos('the weather today is very nice and sunny outside');
  assert.equal(out.corrections.length, 0);
});

test('22a e2e: "enrollement" resolves the same as "enrollment"', async () => {
  const typo = await ask('okay how about sa enrollement?');
  const ok = await ask('okay how about sa enrollment?');
  assert.equal(typo, ok);
  assert.doesNotMatch(typo, /programa at presyo, enrollment, payments, login/); // not the clarify fallback
});

test('22a e2e: "saan malolocate ang beebright" resolves to location', async () => {
  const reply = await ask('pwede mo ba akong tulongan if saan malolocate ang beebright');
  assert.match(reply, /Barangay Pantal|Dagupan/i);
});

// ── 22b + 22e — comparison ───────────────────────────────────────────────

test('22b: "pinagkaiba" (and inflections) is recognised as a comparison question', () => {
  for (const m of [
    'ano ang pinagkaiba ng mga programs',
    'anong kaibahan ng academic tutorial at exam prep',
    'ano ang nagkakaiba ng bawat program',
  ]) {
    assert.equal(isProgramComparisonQuestion(m.toLowerCase()), true, m);
  }
  assert.equal(K.resolveDomainCategory('ano ang pinagkaiba ng mga programs', 'public')?.category, 'comparison');
});

test('22b NEGATIVE: a plain "what programs" question is not a comparison', () => {
  assert.equal(isProgramComparisonQuestion('what programs do you offer'), false);
  assert.equal(isProgramComparisonQuestion('magkano ang academic tutorial'), false);
});

test('22e e2e: comparison content differs from the plain "what programs" answer', async () => {
  const list = await ask('what programs do you have');
  const cmp1 = await ask('ano ang pagkakaiba ng mga programs');
  const cmp2 = await ask('ano ang pinagkaiba ng bawat programs');
  assert.notEqual(cmp1, list);
  assert.notEqual(cmp2, list);
  assert.match(cmp1, /socialization|one-on-one|test mastery/i); // actual differentiators
});

test('22e e2e: naming two programs answers just those two', async () => {
  const reply = await ask('difference between Academic Tutorial and Exam Prep');
  assert.match(reply, /Academic Tutorial/);
  assert.match(reply, /Examination Preparation/);
  assert.doesNotMatch(reply, /Toddlers Playgroup/);
});

// ── 22c — confirmation follow-ups ────────────────────────────────────────

test('22c: confirmation shapes are detected (pattern-based, not a literal list)', () => {
  for (const m of ['ganun ba?', 'ay ganun ba', 'yan kaya', 'totoo ba na dyan yan?',
    'totoo ba yun', 'is that true', 'so that\'s it', 'sigurado ka ba dyan']) {
    assert.equal(K.hasVagueFollowUpShape(m), true, m);
  }
});

test('22c NEGATIVE: a real question is not treated as a confirmation follow-up', () => {
  for (const m of ['how do i enroll my child', 'what programs do you offer',
    'magkano ang toddlers playgroup', 'where is bee bright located']) {
    assert.equal(K.isConfirmationFollowUp(m), false, m);
  }
});

test('22c e2e: confirmation follow-ups re-serve the previous answer, consistently', async () => {
  const payHist = [
    { role: 'user', content: 'what payment methods do you accept' },
    { role: 'assistant', content: 'We accept GCash, SeaBank, and BDO.' },
  ];
  for (const m of ['ganun ba?', 'yan kaya', 'ay ganun ba']) {
    const reply = await ask(m, payHist);
    assert.match(reply, /GCash/, `${m} should re-serve the payment answer`);
  }
  const locReply = await ask('totoo ba na dyan yan?', [
    { role: 'user', content: 'where is bee bright located' },
    { role: 'assistant', content: 'Barangay Pantal, Dagupan City.' },
  ]);
  assert.match(locReply, /Barangay Pantal|Dagupan/i);
});

// ── 22d — fallback mentions programs ─────────────────────────────────────

test('22d: the generic clarification reply lists programs/pricing', () => {
  // getClarificationReply is the "please clarify your topic" text
  const { chat: _c } = require('../controllers/aiController');
  void _c;
  // Exercised via a deliberately ambiguous message that falls to clarification.
  return ask('hmm ok').then((reply) => {
    // whatever the exact fallback, "programs" must be an offered topic somewhere in the
    // family of generic replies — assert on the clarification text via a direct trigger:
    return ask('i have a question').then((r2) => {
      const combined = `${reply} ${r2}`.toLowerCase();
      assert.ok(/program/.test(combined) || /programa/.test(combined),
        `generic replies should mention programs — got: ${combined.slice(0, 160)}`);
    });
  });
});

test('cleanup: close mongoose if a test opened it', async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
});
