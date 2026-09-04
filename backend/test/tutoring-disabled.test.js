// No TUTORING_ENABLED here → default OFF. Verifies the flag gate.
delete process.env.TUTORING_ENABLED;

const test = require('node:test');
const assert = require('node:assert/strict');

const AuditLog = require('../models/AuditLog');
const { TUTORING_ENABLED } = require('../utils/tutoringMode');
const { handleTutoringRequest } = require('../controllers/aiController');

test('TUTORING_ENABLED defaults to false', () => {
  assert.equal(TUTORING_ENABLED, false);
});

test('handleTutoringRequest: flag off → "not available yet", no LLM, audited as tutoring-disabled', async () => {
  const origAudit = AuditLog.create;
  const origFetch = global.fetch;
  const audits = [];
  let fetched = false;
  AuditLog.create = async (e) => { audits.push(e); return e; };
  global.fetch = async () => { fetched = true; return { ok: true, json: async () => ({}) }; };
  try {
    const req = { user: { _id: 's1', id: 's1', role: 'student' }, body: {}, headers: {} };
    const out = await handleTutoringRequest(req, 'help me understand fractions', []);
    assert.match(out, /Homework help isn't available in the assistant yet/i);
    assert.equal(fetched, false);
    assert.equal(audits.find((a) => a.action === 'AI Chat').metadata.groundingPath, 'tutoring-disabled');
  } finally {
    AuditLog.create = origAudit;
    global.fetch = origFetch;
  }
});
