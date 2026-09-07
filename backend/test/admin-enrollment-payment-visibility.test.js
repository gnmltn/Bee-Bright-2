/**
 * Regression: the admin Payments / pending views ran `splitValidAndInvalidPayments`
 * which PERMANENTLY DELETED any payment without a complete-named `student`. Wizard /
 * "add child" payments have `parent` + `enrollment` and `student: null`, so every
 * time an admin opened the Payments tab, those payment records were destroyed — and
 * the Enrollment Details modal then showed "No payment records yet."
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { splitValidAndInvalidPayments } = require('../controllers/paymentController');

test('a wizard/parent payment (student null, has enrollment + parent) is kept, not deleted', () => {
  const wizardPayment = {
    _id: 'p1',
    student: null,
    parent: { _id: 'u1', firstName: 'Maria', lastName: 'Santos' },
    enrollment: { _id: 'e1', enrollmentId: 'BB-20260907-0001' },
    status: 'submitted',
    proofUrl: '/uploads/payments/proof-e1.jpg',
  };
  const { valid, invalidIds } = splitValidAndInvalidPayments([wizardPayment]);
  assert.equal(valid.length, 1);
  assert.deepEqual(invalidIds, []);
});

test('a payment linked only to an enrollment is still kept', () => {
  const { valid, invalidIds } = splitValidAndInvalidPayments([
    { _id: 'p2', student: null, parent: null, enrollment: { _id: 'e2' }, status: 'pending' },
  ]);
  assert.equal(valid.length, 1);
  assert.deepEqual(invalidIds, []);
});

test('a legacy payment with a complete-named student is still kept', () => {
  const { valid, invalidIds } = splitValidAndInvalidPayments([
    { _id: 'p3', student: { firstName: 'Ben', lastName: 'Cruz' }, parent: null, enrollment: null },
  ]);
  assert.equal(valid.length, 1);
  assert.deepEqual(invalidIds, []);
});

test('only a truly orphaned payment (no student, no parent, no enrollment) is a cleanup candidate', () => {
  const { valid, invalidIds } = splitValidAndInvalidPayments([
    { _id: 'orphan', student: null, parent: null, enrollment: null },
    { _id: 'incomplete-student', student: { firstName: '', lastName: '' }, parent: null, enrollment: null },
  ]);
  assert.equal(valid.length, 0);
  assert.deepEqual(invalidIds.sort(), ['incomplete-student', 'orphan']);
});
