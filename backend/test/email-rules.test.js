/**
 * Email validation rules (EnrollmentNotifs_OrphanedAccounts_EmailValidation.pdf item 3).
 * The SAME cases are asserted against the frontend copy in
 * frontend/src/test/emailRules.test.ts — keep both in sync.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { getEmailError, assertValidEmail } = require('../utils/emailRules');

const OK = [
  'maria@example.com',
  'maria.santos+enroll@example.co.ph',
  'first_last-1@sub.domain.com',
  "o'brien@example.com",
  '"john doe"@example.com',            // spaces allowed only when fully wrapped in quotes
  '"a(b)c[d]e<f>g;h:i,j"@example.com', // every restricted symbol, inside quotes
  '"back\\\\slash"@example.com',       // escaped backslash inside quotes
  '  padded@example.com  ',            // surrounding whitespace is trimmed, not an error
];

const BAD = [
  ['john doe@example.com', /spaces/i],
  ['ma(ria@example.com', /"\("/],
  ['ma)ria@example.com', /"\)"/],
  ['ma[ria@example.com', /"\["/],
  ['ma]ria@example.com', /"\]"/],
  ['ma<ria@example.com', /"<"/],
  ['ma>ria@example.com', /">"/],
  ['ma;ria@example.com', /semicolon/i],
  ['ma:ria@example.com', /colon/i],
  ['ma,ria@example.com', /comma/i],
  ['ma\\ria@example.com', /backslash/i],
  ['ma"ria@example.com', /double quote/i],          // stray quote, not fully wrapped
  ['"maria@example.com', /double quote/i],          // only opening quote
  ['"unescaped"quote"@example.com', /escaped/i],    // raw quote inside quotes
  ['a@b@example.com', /one @/i],                    // second @ outside quotes
  ['.maria@example.com', /period/i],
  ['maria.@example.com', /period/i],
  ['ma..ria@example.com', /period/i],
  ['maria@', /domain/i],
  ['maria@example', /domain/i],
  ['maria@-example.com', /domain/i],
  ['maria@exa mple.com', /domain/i],
  ['maria@example.c', /domain/i],
  ['@example.com', /before the @/i],
  ['mariaexample.com', /@/],
  ['', /required/i],
  ['   ', /required/i],
];

test('acceptable emails pass', () => {
  for (const e of OK) assert.equal(getEmailError(e), null, `${JSON.stringify(e)} should be valid`);
});

test('each restricted character / shape is rejected with a specific message', () => {
  for (const [email, pattern] of BAD) {
    const err = getEmailError(email);
    assert.ok(err, `${JSON.stringify(email)} should be rejected`);
    assert.match(err, pattern, `${JSON.stringify(email)} -> ${err}`);
  }
});

test('the same restricted symbols are fine when the local part is fully double-quoted', () => {
  for (const ch of [' ', '(', ')', '[', ']', '<', '>', ';', ':', ',']) {
    assert.equal(getEmailError(`"a${ch}b"@example.com`), null, `quoted ${JSON.stringify(ch)}`);
    assert.ok(getEmailError(`a${ch}b@example.com`), `unquoted ${JSON.stringify(ch)}`);
  }
});

test('assertValidEmail (express-validator adapter) throws the message', () => {
  assert.equal(assertValidEmail('ok@example.com'), true);
  assert.throws(() => assertValidEmail('bad email@example.com'), /spaces/i);
});

test('length limits', () => {
  assert.ok(getEmailError(`${'a'.repeat(65)}@example.com`));
  assert.equal(getEmailError(`${'a'.repeat(64)}@example.com`), null);
});
