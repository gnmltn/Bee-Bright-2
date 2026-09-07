/**
 * Toddlers Playgroup eligibility — children ages 2, 3 and 4 years old
 * (from the 2nd birthday until the day before the 5th).
 *
 * Regression guard for two bugs:
 *  1. inverted/inconsistent range check + two contradictory messages;
 *  2. `elapsedMs / (365.25 days)` age maths, which computed 1.9997 for a child
 *     on their exact 2nd birthday and so failed every `age >= 2` check.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkProgramEligibility,
  isEligibleForToddlers,
  computeAge,
  validateEnrollmentAge,
} = require('../utils/ageEligibility');

const TPG_MESSAGE = 'Toddlers Playgroup is for children ages 2 to 4 years old.';

/** YYYY-MM-DD for a birthdate this many years/months/days ago (local time). */
function birthdateAgo(years, months = 0, days = 0) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  d.setMonth(d.getMonth() - months);
  d.setDate(d.getDate() - days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
const ageAgo = (...args) => computeAge(birthdateAgo(...args));

// ── Age computation ────────────────────────────────────────────────────────
test('computeAge: "exactly N years old today" is always >= N', () => {
  for (const years of [2, 3, 4, 5, 10, 18]) {
    const age = ageAgo(years);
    assert.ok(age >= years, `exactly ${years}y computed ${age}, expected >= ${years}`);
    assert.ok(age < years + 0.01, `exactly ${years}y computed ${age}, expected just above ${years}`);
  }
});

test('computeAge: the day before a birthday is still under that age', () => {
  assert.ok(ageAgo(2, 0, -1) < 2, 'one day before the 2nd birthday is < 2');
  assert.ok(ageAgo(5, 0, -1) < 5, 'one day before the 5th birthday is < 5');
});

// ── Lower bound (the reported regression) ──────────────────────────────────
test('Toddlers Playgroup — lower bound', () => {
  assert.equal(isEligibleForToddlers(ageAgo(2)), true, 'exact 2nd birthday → eligible');
  assert.equal(isEligibleForToddlers(ageAgo(2, 0, 1)), true, '2y + 1 day → eligible');
  assert.equal(isEligibleForToddlers(ageAgo(2, 1)), true, '2y 1mo → eligible');
  assert.equal(isEligibleForToddlers(ageAgo(2, 6)), true, '2y 6mo → eligible');

  assert.equal(isEligibleForToddlers(ageAgo(2, 0, -1)), false, 'birthday tomorrow → not yet eligible');
  assert.equal(isEligibleForToddlers(ageAgo(2, 0, -5)), false, 'birthday in 5 days → not yet eligible');
  assert.equal(isEligibleForToddlers(ageAgo(1, 11)), false, '1y 11mo → not eligible');
});

// ── Upper bound: "ages 2 to 4" covers the whole 4th year ───────────────────
test('Toddlers Playgroup — upper bound', () => {
  assert.equal(isEligibleForToddlers(ageAgo(3)), true, 'exact 3rd birthday → eligible');
  assert.equal(isEligibleForToddlers(ageAgo(3, 6)), true, '3y 6mo → eligible');
  assert.equal(isEligibleForToddlers(ageAgo(4)), true, 'exact 4th birthday → eligible');
  assert.equal(isEligibleForToddlers(ageAgo(4, 1)), true, '4y 1mo → eligible');
  assert.equal(isEligibleForToddlers(ageAgo(4, 11)), true, '4y 11mo → eligible');

  assert.equal(isEligibleForToddlers(ageAgo(5)), false, 'exact 5th birthday → not eligible');
  assert.equal(isEligibleForToddlers(ageAgo(6)), false, '6y → not eligible');
});

test('Toddlers Playgroup — one consistent message for too-young AND too-old', () => {
  const tooYoung = checkProgramEligibility('TPG101', ageAgo(1, 6));
  const tooOld = checkProgramEligibility('TPG101', ageAgo(6));
  assert.equal(tooYoung.reason, TPG_MESSAGE);
  assert.equal(tooOld.reason, TPG_MESSAGE);
  // No stale "N yrs old and up" variant for the banded program.
  assert.doesNotMatch(tooYoung.reason, /and up/i);
  assert.doesNotMatch(tooOld.reason, /and up/i);
});

test('isEligibleForToddlers rejects a missing / invalid age', () => {
  assert.equal(isEligibleForToddlers(NaN), false);
  assert.equal(isEligibleForToddlers(0), false);
});

// ── The general enrollment gate must agree with the program gate ───────────
test('validateEnrollmentAge accepts a child on their exact 2nd birthday', () => {
  const res = validateEnrollmentAge(birthdateAgo(2));
  assert.equal(res.valid, true, res.reason || '');
});

test('validateEnrollmentAge boundaries', () => {
  assert.equal(validateEnrollmentAge(birthdateAgo(2, 0, -1)).valid, false, 'not yet 2 → blocked');
  assert.match(validateEnrollmentAge(birthdateAgo(2, 0, -1)).reason, /at least 2 years old/);
  assert.equal(validateEnrollmentAge(birthdateAgo(18)).valid, true, 'exactly 18 → allowed');
  assert.equal(validateEnrollmentAge(birthdateAgo(18, 11)).valid, true, '18y 11mo → allowed');
  assert.equal(validateEnrollmentAge(birthdateAgo(19)).valid, false, '19 → blocked');
  assert.match(validateEnrollmentAge(birthdateAgo(19)).reason, /up to 18 years old/);
  // Typo years are still caught as unrealistic.
  assert.match(validateEnrollmentAge('0111-11-01').reason, /not realistic/i);
});

test('Academic Tutorial / Exam Prep upper cap and lower bound', () => {
  assert.equal(checkProgramEligibility('ACT102', ageAgo(2)).eligible, true, 'exact 2 ACT → eligible');
  assert.equal(checkProgramEligibility('ACT102', ageAgo(18, 11)).eligible, true, '18y11m ACT → eligible');
  assert.equal(checkProgramEligibility('ACT102', ageAgo(19)).eligible, false, '19 ACT → not eligible');
  assert.match(checkProgramEligibility('ACT102', ageAgo(19)).reason, /up to 18 years old/);
  assert.match(checkProgramEligibility('ACT102', ageAgo(1)).reason, /2 years old and up/);

  assert.equal(checkProgramEligibility('EXP106', ageAgo(2, 6)).eligible, false, '2y6m EXP → not eligible');
  assert.equal(checkProgramEligibility('EXP106', ageAgo(3)).eligible, true, 'exact 3 EXP → eligible');
});
