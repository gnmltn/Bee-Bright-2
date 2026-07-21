const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEnvironment } = require('../config/env');

test('loadEnvironment reads backend .env values', () => {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_SECURE;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;

  const result = loadEnvironment();

  assert.equal(result.error, undefined);
  assert.equal(process.env.SMTP_HOST, 'smtp.gmail.com');
  assert.equal(process.env.SMTP_USER, 'gaealatina@gmail.com');
  assert.equal(process.env.SMTP_SECURE, 'false');
});
