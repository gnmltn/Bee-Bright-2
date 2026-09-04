const test = require('node:test');
const assert = require('node:assert/strict');

const AuditLog = require('../models/AuditLog');
const { logAiInteraction, deriveDataCategories } = require('../utils/aiAuditService');

// Capture what auditService would persist without touching a database.
function captureAuditCreate(fn) {
  const original = AuditLog.create;
  const calls = [];
  AuditLog.create = async (entry) => { calls.push(entry); return entry; };
  return Promise.resolve(fn(calls)).finally(() => { AuditLog.create = original; });
}

test('deriveDataCategories: grounded topic drives the primary classification', () => {
  assert.deepEqual(deriveDataCategories({ topic: 'grades' }, 'ok').sort(), ['grade', 'personal']);
  assert.deepEqual(deriveDataCategories({ topic: 'payments' }, 'ok').sort(), ['payment', 'personal']);
  assert.deepEqual(deriveDataCategories({ topic: 'schedule' }, 'ok'), ['personal']);
  assert.deepEqual(deriveDataCategories({ topic: 'enrollment' }, 'ok'), ['personal']);
});

test('deriveDataCategories: reply keyword backstop for non-grounded replies', () => {
  assert.ok(deriveDataCategories(null, 'Your latest payment BB202601 is verified for ₱2,500').includes('payment'));
  assert.ok(deriveDataCategories(null, 'You have 4 recorded grades, average about 78%').includes('grade'));
  assert.deepEqual(deriveDataCategories(null, 'Announcements are in the Announcements section of your dashboard.'), []);
});

test('logAiInteraction: authenticated request records userId, role, path and capped query', async () => {
  await captureAuditCreate(async (calls) => {
    const req = {
      user: { id: 'u-1', _id: 'u-1', role: 'parent' },
      body: { message: 'x'.repeat(2500) },
      headers: { 'user-agent': 'jest' },
      ip: '10.0.0.1',
    };
    await logAiInteraction({
      req,
      message: 'x'.repeat(2500),
      reply: 'Ana Cruz has 3 recorded grades, average about 80%.',
      groundedContext: { topic: 'grades' },
      groundingPath: 'grounded',
      language: 'english',
    });

    assert.equal(calls.length, 1);
    const e = calls[0];
    assert.equal(e.module, 'AI Assistant');
    assert.equal(e.action, 'AI Chat');
    assert.equal(e.status, 'SUCCESS');
    assert.equal(e.userId, 'u-1');
    assert.equal(e.userIdentifier, undefined);
    assert.equal(e.metadata.role, 'parent');
    assert.equal(e.metadata.groundingPath, 'grounded');
    assert.equal(e.metadata.groundedTopic, 'grades');
    assert.deepEqual(e.metadata.dataCategories.sort(), ['grade', 'personal']);
    assert.equal(e.metadata.query.length, 2000);
    assert.equal(e.metadata.queryTruncated, true);
    assert.equal(e.ipAddress, '10.0.0.1');
  });
});

test('logAiInteraction: public/unauthenticated request logs as anonymous', async () => {
  await captureAuditCreate(async (calls) => {
    const req = { body: { message: 'what programs do you offer' }, headers: {} };
    await logAiInteraction({
      req,
      message: 'what programs do you offer',
      reply: 'Bee Bright offers Toddlers Playgroup, Pre-K, ...',
      groundingPath: 'deterministic',
      language: 'english',
    });
    const e = calls[0];
    assert.equal(e.userId, undefined);
    assert.equal(e.userIdentifier, 'anonymous');
    assert.equal(e.metadata.role, 'public');
    assert.deepEqual(e.metadata.dataCategories, []);
  });
});

test('logAiInteraction: session id is used as the anon marker when provided', async () => {
  await captureAuditCreate(async (calls) => {
    const req = { body: { message: 'hi', sessionId: 'sess-abc-123' }, headers: {} };
    await logAiInteraction({ req, message: 'hi', reply: 'Hello.', groundingPath: 'deterministic' });
    assert.equal(calls[0].userIdentifier, 'session:sess-abc-123');
    assert.equal(calls[0].metadata.sessionId, 'sess-abc-123');
  });
});

test('logAiInteraction: FAILED status is recorded on error branches', async () => {
  await captureAuditCreate(async (calls) => {
    const req = { user: { id: 'u-2', role: 'student' }, body: { message: 'boom' }, headers: {} };
    await logAiInteraction({ req, message: 'boom', reply: null, groundingPath: 'error', status: 'FAILED' });
    assert.equal(calls[0].status, 'FAILED');
    assert.equal(calls[0].metadata.replyPreview, '');
  });
});
