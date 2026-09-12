/**
 * Task 32 Part 4 — utils/intentClassifierClient.js. predictIntent() must never throw
 * and must resolve to null on any failure (service down, timeout, bad response), so a
 * down/slow Python microservice can never break or slow down the chatbot.
 */
process.env.INTENT_CLASSIFIER_TIMEOUT_MS = '50'; // keep the timeout test fast

const test = require('node:test');
const assert = require('node:assert/strict');

const { predictIntent, INTENT_CLASSIFIER_CONFIDENCE_THRESHOLD } = require('../utils/intentClassifierClient');

function stubFetch(impl) {
  const orig = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = orig; };
}

test('confidence threshold is a sane number (from the training notebook, not a guess)', () => {
  assert.ok(INTENT_CLASSIFIER_CONFIDENCE_THRESHOLD > 0 && INTENT_CLASSIFIER_CONFIDENCE_THRESHOLD < 1);
});

test('predictIntent: happy path returns {intent, confidence}', async () => {
  const restore = stubFetch(async (url, opts) => {
    assert.match(String(url), /\/predict-intent$/);
    const body = JSON.parse(opts.body);
    assert.equal(body.message, 'is my ticket resolved');
    return {
      ok: true,
      json: async () => ({ success: true, intent: 'resolved_ticket', confidence: 0.81 }),
    };
  });
  try {
    const result = await predictIntent('is my ticket resolved');
    assert.deepEqual(result, { intent: 'resolved_ticket', confidence: 0.81 });
  } finally { restore(); }
});

test('predictIntent: empty message never calls the service', async () => {
  let called = false;
  const restore = stubFetch(async () => { called = true; return { ok: true, json: async () => ({}) }; });
  try {
    assert.equal(await predictIntent(''), null);
    assert.equal(await predictIntent('   '), null);
    assert.equal(called, false);
  } finally { restore(); }
});

test('predictIntent: non-OK HTTP status -> null', async () => {
  const restore = stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  try {
    assert.equal(await predictIntent('hello'), null);
  } finally { restore(); }
});

test('predictIntent: malformed / unsuccessful body -> null', async () => {
  for (const body of [
    {},
    { success: false },
    { success: true, intent: 'x' }, // missing confidence
    { success: true, confidence: 0.9 }, // missing intent
    { success: true, intent: 5, confidence: 0.9 }, // wrong type
    null,
  ]) {
    const restore = stubFetch(async () => ({ ok: true, json: async () => body }));
    try {
      assert.equal(await predictIntent('hello'), null, JSON.stringify(body));
    } finally { restore(); }
  }
});

test('predictIntent: service unreachable (rejected fetch) -> null, never throws', async () => {
  const restore = stubFetch(async () => { throw new Error('ECONNREFUSED'); });
  try {
    await assert.doesNotReject(async () => {
      const result = await predictIntent('hello');
      assert.equal(result, null);
    });
  } finally { restore(); }
});

test('predictIntent: timeout (abort) -> null, never throws', async () => {
  const restore = stubFetch(async (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
    // never resolves on its own — only the abort signal settles this promise
  }));
  try {
    const result = await predictIntent('hello');
    assert.equal(result, null);
  } finally { restore(); }
});
