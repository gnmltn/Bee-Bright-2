/**
 * Admin_Schedule_and_MultiProgram_Days_Fixes.pdf #3 — confirms the actual amount
 * charged at enrollment time is genuinely the 50% down payment, not the full package
 * price, for every program mix. computeAmounts() (services/enrollmentService.js) is
 * the single place this math happens; enrollmentController.js's submitEnrollment
 * hardcodes paymentOption to 'down' regardless of what the client sends (never trusts
 * a client-supplied 'full'), so this function's own correctness is what the real
 * charge amount actually depends on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeAmounts } = require('../services/enrollmentService');

test('computeAmounts: a single Academic Tutorial package is charged exactly 50% down', () => {
  const { totalFee, amountDue } = computeAmounts([{ price: 2400 }], 'down');
  assert.equal(totalFee, 2400);
  assert.equal(amountDue, 1200);
});

test('computeAmounts: a single Toddlers Playgroup package is charged exactly 50% down', () => {
  const { totalFee, amountDue } = computeAmounts([{ price: 5280 }], 'down');
  assert.equal(totalFee, 5280);
  assert.equal(amountDue, 2640);
});

test('computeAmounts: a single Examination Preparation package is charged exactly 50% down', () => {
  const { totalFee, amountDue } = computeAmounts([{ price: 1850 }], 'down');
  assert.equal(totalFee, 1850);
  assert.equal(amountDue, 925);
});

test('computeAmounts: an odd total rounds the down payment UP to the nearest peso (never under-charges)', () => {
  const { totalFee, amountDue } = computeAmounts([{ price: 2401 }], 'down');
  assert.equal(totalFee, 2401);
  assert.equal(amountDue, 1201, 'Math.ceil(2401 * 0.5) = 1201, not 1200');
});

test('computeAmounts: a multi-program enrollment (Playgroup + Academic Tutorial + Exam Prep) is still charged exactly 50% of the combined total', () => {
  const { totalFee, amountDue } = computeAmounts(
    [{ price: 5280 }, { price: 2400 }, { price: 1850 }],
    'down'
  );
  assert.equal(totalFee, 9530);
  assert.equal(amountDue, 4765);
});

test('computeAmounts: "full" payment option is charged the entire price — confirms "down" is the branch actually doing the 50% split, not a default', () => {
  const { totalFee, amountDue } = computeAmounts([{ price: 2400 }], 'full');
  assert.equal(totalFee, 2400);
  assert.equal(amountDue, 2400);
});
