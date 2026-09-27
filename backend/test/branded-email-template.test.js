/**
 * "polishing prompt (1).pdf", Group H — every outgoing email now shares one branded HTML
 * frame (utils/emailService.js's buildBrandedEmailHtml/buildOtpEmailHtml) instead of each
 * email-sending function inlining its own ad-hoc markup.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBrandedEmailHtml, buildOtpEmailHtml } = require('../utils/emailService');

test('buildBrandedEmailHtml: always includes the logo header banner and "Tutorial Center" text', () => {
  const html = buildBrandedEmailHtml({ title: 'Hello', bodyHtml: '<p>World</p>' });
  assert.match(html, /🐝 Bee Bright/);
  assert.match(html, /Tutorial Center/);
  assert.match(html, /Hello/);
  assert.match(html, /World/);
});

test('buildBrandedEmailHtml: defaults to the brand orange accent', () => {
  const html = buildBrandedEmailHtml({ bodyHtml: '<p>x</p>' });
  assert.match(html, /#f59e0b/i);
});

test('buildBrandedEmailHtml: accent switches the whole palette (green for success, red for rejection)', () => {
  const green = buildBrandedEmailHtml({ bodyHtml: '<p>x</p>', accent: 'green' });
  assert.match(green, /#10b981/i);
  assert.doesNotMatch(green, /#f59e0b/i);

  const red = buildBrandedEmailHtml({ bodyHtml: '<p>x</p>', accent: 'red' });
  assert.match(red, /#374151/i);
});

test('buildBrandedEmailHtml: renders an optional CTA button only when both label and url are given', () => {
  const withCta = buildBrandedEmailHtml({ bodyHtml: '<p>x</p>', ctaLabel: 'Click me', ctaUrl: 'https://example.com' });
  assert.match(withCta, /Click me/);
  assert.match(withCta, /https:\/\/example\.com/);

  const withoutCta = buildBrandedEmailHtml({ bodyHtml: '<p>x</p>' });
  assert.doesNotMatch(withoutCta, /<a /);
});

test('buildOtpEmailHtml: renders the bordered OTP code box and expiry text', () => {
  const html = buildOtpEmailHtml({ title: 'Verify', introHtml: '<p>Hi</p>', otp: '123456', expiresMinutes: 10 });
  assert.match(html, /123456/);
  assert.match(html, /expires in <strong>10 minutes<\/strong>/);
  assert.match(html, /🐝 Bee Bright/);
});

test('buildOtpEmailHtml: unrecognized accent falls back to orange rather than throwing', () => {
  const html = buildOtpEmailHtml({ otp: '000000', expiresMinutes: 5, accent: 'not-a-real-color' });
  assert.match(html, /#f59e0b/i);
});
