/**
 * Item E (2nd report, "Unable to send email right now") — root cause: getEmailConfig() used to
 * infer `service: 'gmail'` whenever SMTP_HOST merely CONTAINED "gmail" (e.g. smtp.gmail.com).
 * nodemailer's "gmail" service shorthand dials its own fixed host/port (465, secure) and
 * silently ignores SMTP_PORT/SMTP_SECURE — so the .env's deliberately-configured port 587/
 * STARTTLS was overridden into port 465, and every send failed with a connect timeout there.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = ['SMTP_HOST', 'EMAIL_HOST', 'SMTP_SERVICE', 'EMAIL_SERVICE', 'SMTP_PORT', 'EMAIL_PORT', 'SMTP_SECURE', 'EMAIL_SECURE', 'SMTP_USER', 'EMAIL_USER', 'SMTP_PASS', 'EMAIL_PASS'];

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// getEmailConfig/getTransporter cache a transporter keyed by a fingerprint of the resolved
// config, so each test uses distinct fake credentials to avoid reusing another test's cache.
test('getEmailConfig: an explicit SMTP_HOST containing "gmail" no longer implies the gmail service shorthand', () => {
  const { getEmailConfig } = require('../utils/emailService');
  const config = withEnv({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_USER: 'a@gmail.com', SMTP_PASS: 'x' }, getEmailConfig);
  assert.equal(config.service, '', 'no service inferred from the host string');
  assert.equal(config.host, 'smtp.gmail.com');
  assert.equal(config.port, 587);
  assert.equal(config.secure, false);
});

test('getEmailConfig: SMTP_SERVICE, when explicitly set, is still honored', () => {
  const { getEmailConfig } = require('../utils/emailService');
  const config = withEnv({ SMTP_SERVICE: 'gmail', SMTP_USER: 'b@gmail.com', SMTP_PASS: 'x' }, getEmailConfig);
  assert.equal(config.service, 'gmail');
});

test('getTransporter: an explicit host+port creates a host/port transport, not the gmail shorthand (which would silently dial 465)', () => {
  const nodemailer = require('nodemailer');
  const origCreateTransport = nodemailer.createTransport;
  const calls = [];
  nodemailer.createTransport = (options) => { calls.push(options); return { verify: async () => true, sendMail: async () => ({}) }; };
  try {
    const { getTransporter } = require('../utils/emailService');
    withEnv({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_USER: 'c@gmail.com', SMTP_PASS: 'x' }, getTransporter);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].service, undefined, 'no service shorthand used');
    assert.equal(calls[0].host, 'smtp.gmail.com');
    assert.equal(calls[0].port, 587);
    assert.equal(calls[0].secure, false);
  } finally {
    nodemailer.createTransport = origCreateTransport;
  }
});

test('getEmailErrorMessage: a wrapped connect timeout (ESOCKET, "connect ETIMEDOUT ...") gets a clear, specific message', () => {
  const { getEmailErrorMessage, isSmtpConnectionError } = require('../utils/emailService');
  const error = { code: 'ESOCKET', command: 'CONN', message: 'connect ETIMEDOUT 64.233.189.109:465' };
  assert.equal(isSmtpConnectionError(error), true);
  assert.match(getEmailErrorMessage(error), /reach the email server/i);
});

test('getEmailErrorMessage: an auth failure still gets its own specific message', () => {
  const { getEmailErrorMessage } = require('../utils/emailService');
  assert.match(getEmailErrorMessage({ code: 'EAUTH', responseCode: 535, message: 'Invalid login' }), /authentication failed/i);
});
