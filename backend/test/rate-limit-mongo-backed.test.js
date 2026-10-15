/**
 * Security audit fix #5 — middleware/rateLimit.js used to store counters in an
 * in-process Map: counts reset on every restart, and would silently multiply the
 * effective limit across more than one process, plus it never evicted old entries
 * (unbounded memory growth). It's now backed by the RateLimitAttempt Mongoose model
 * instead — these tests mock that model's static methods the same way every other
 * controller test in this suite mocks its own models (this suite never opens a real
 * DB connection), and exercise the real exported limiter middleware end to end.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const RateLimitAttempt = require('../models/RateLimitAttempt');
const { userLoginLimiter, adminLoginLimiter } = require('../middleware/rateLimit');

function mockReq(ip = '203.0.113.5') {
  return { ip, socket: {}, connection: {} };
}

function mockRes() {
  const res = { _status: null, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

async function run(limiter, req) {
  const res = mockRes();
  let nextCalled = false;
  await limiter(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('userLoginLimiter: within the limit calls next(), never touches res', async () => {
  const origFOU = RateLimitAttempt.findOneAndUpdate;
  RateLimitAttempt.findOneAndUpdate = async (filter) => {
    // Fast path: an active window with room left.
    if (filter.resetAt) return { count: 3 };
    throw new Error('unexpected reinit path for this test');
  };
  try {
    const { res, nextCalled } = await run(userLoginLimiter, mockReq());
    assert.equal(nextCalled, true);
    assert.equal(res._status, null, 'should never touch the response when under the limit');
  } finally {
    RateLimitAttempt.findOneAndUpdate = origFOU;
  }
});

test('userLoginLimiter: exceeding the limit returns 429 and does NOT call next()', async () => {
  const origFOU = RateLimitAttempt.findOneAndUpdate;
  RateLimitAttempt.findOneAndUpdate = async (filter) => {
    if (filter.resetAt) return { count: 11 }; // userLoginLimiter's max is 10
    throw new Error('unexpected reinit path for this test');
  };
  try {
    const { res, nextCalled } = await run(userLoginLimiter, mockReq());
    assert.equal(nextCalled, false);
    assert.equal(res._status, 429);
    assert.match(res._body.message, /too many login attempts/i);
  } finally {
    RateLimitAttempt.findOneAndUpdate = origFOU;
  }
});

test('adminLoginLimiter: a different IP has its own independent counter (keyed by IP)', async () => {
  const seenFilters = [];
  const origFOU = RateLimitAttempt.findOneAndUpdate;
  RateLimitAttempt.findOneAndUpdate = async (filter) => {
    seenFilters.push(filter.key);
    return { count: 1 };
  };
  try {
    await run(adminLoginLimiter, mockReq('198.51.100.1'));
    await run(adminLoginLimiter, mockReq('198.51.100.2'));
    assert.equal(seenFilters[0], 'admin-login:198.51.100.1');
    assert.equal(seenFilters[1], 'admin-login:198.51.100.2');
    assert.notEqual(seenFilters[0], seenFilters[1]);
  } finally {
    RateLimitAttempt.findOneAndUpdate = origFOU;
  }
});

test('userLoginLimiter: an EXPIRED window resets the count instead of continuing to accumulate', async () => {
  const origFOU = RateLimitAttempt.findOneAndUpdate;
  let call = 0;
  RateLimitAttempt.findOneAndUpdate = async (filter, update) => {
    call += 1;
    if (call === 1) {
      // Fast path (resetAt > now) finds nothing — the old window already expired.
      assert.ok(filter.resetAt && filter.resetAt.$gt, 'fast path should filter on an active window');
      return null;
    }
    // Reinit path (resetAt <= now) — starts a fresh window at count 1.
    assert.ok(filter.resetAt && filter.resetAt.$lte, 'reinit path should only replace an expired window');
    assert.equal(update.$set.count, 1, 'an expired window must restart at 1, not keep accumulating');
    return { count: update.$set.count };
  };
  try {
    const { res, nextCalled } = await run(userLoginLimiter, mockReq());
    assert.equal(nextCalled, true);
    assert.equal(res._status, null);
    assert.equal(call, 2);
  } finally {
    RateLimitAttempt.findOneAndUpdate = origFOU;
  }
});

test('userLoginLimiter: a brand-new key races a duplicate-key error on create() and still counts correctly', async () => {
  const origFOU = RateLimitAttempt.findOneAndUpdate;
  const origCreate = RateLimitAttempt.create;
  let fouCall = 0;
  RateLimitAttempt.findOneAndUpdate = async (filter) => {
    fouCall += 1;
    if (fouCall <= 2) return null; // neither an active nor an expired window exists yet
    return { count: 2 }; // the fallback $inc after losing the create() race
  };
  RateLimitAttempt.create = async () => {
    const err = new Error('E11000 duplicate key');
    err.code = 11000;
    throw err;
  };
  try {
    const { res, nextCalled } = await run(userLoginLimiter, mockReq());
    assert.equal(nextCalled, true, 'losing the create race must not fail the request');
    assert.equal(res._status, null);
  } finally {
    RateLimitAttempt.findOneAndUpdate = origFOU;
    RateLimitAttempt.create = origCreate;
  }
});

test('userLoginLimiter: a database error FAILS OPEN (calls next(), never 500s the request)', async () => {
  const origFOU = RateLimitAttempt.findOneAndUpdate;
  RateLimitAttempt.findOneAndUpdate = async () => { throw new Error('Mongo is unreachable'); };
  try {
    const { res, nextCalled } = await run(userLoginLimiter, mockReq());
    assert.equal(nextCalled, true, 'a DB hiccup must not itself lock out legitimate users');
    assert.equal(res._status, null);
  } finally {
    RateLimitAttempt.findOneAndUpdate = origFOU;
  }
});
