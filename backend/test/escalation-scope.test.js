/**
 * Batch 19 — acts on the first of the two systemic items flagged at the end of Batch 18:
 * auto-escalation scope. Per the user's explicit direction:
 *
 * 1. The implicit "two consecutive unhelpful replies → auto-flag" handoff
 *    (applyRepeatedNoMatchHandoff) fired for ANY authenticated role, including admin —
 *    landing in admin's own Requests queue alongside genuine parent/tutor requests, with
 *    no user intent behind it at all. Removed entirely; the function is now a no-op that
 *    always returns the reply unchanged, for every role.
 *
 * 2. "Raise a concern" (handleExplicitHandoff) previously allowed any authenticated role
 *    to trigger it, including admin — which could flag admin's own account into its own
 *    Requests queue. Restricted to parent/tutor only, per the user's explicit scoping
 *    ("parent side at tutor side").
 *
 * Child-safety screening and tutor_wellbeing_check were independently confirmed to
 * already be admin-proof (gated to student/tutor respectively) and needed no change —
 * not re-tested here since nothing in those two paths was touched.
 *
 * See test/handoff.test.js for the fuller regression suite covering the guided
 * "raise a concern" flow itself (reason/explanation/confirm/cancel) — this file is
 * scoped to the Batch 19 role-gating change specifically.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Escalation = require('../models/Escalation');
const AuditLog = require('../models/AuditLog');
const { applyRepeatedNoMatchHandoff, handleExplicitHandoff } = require('../controllers/aiController');

function withStubs(fn) {
  const origEsc = Escalation.create;
  const origAudit = AuditLog.create;
  const escalations = [];
  Escalation.create = async (doc) => { const d = { _id: 'esc-x', ...doc }; escalations.push(d); return d; };
  AuditLog.create = async (e) => e;
  return Promise.resolve(fn({ escalations })).finally(() => {
    Escalation.create = origEsc;
    AuditLog.create = origAudit;
  });
}

test('applyRepeatedNoMatchHandoff: no-op for every role, even with two consecutive unhelpful replies', async () => {
  await withStubs(async ({ escalations }) => {
    const history = [
      { role: 'user', content: 'foo' },
      { role: 'assistant', content: 'Sorry, this information is not yet available in the system.' },
    ];
    const reply = 'I can guide you step by step. Which page are you on right now?';
    for (const role of ['admin', 'super_admin', 'parent', 'tutor', 'student']) {
      const req = { user: { _id: 'u1', role }, body: {}, headers: {} };
      const out = await applyRepeatedNoMatchHandoff(req, 'still confused', history, reply, 'english');
      assert.equal(out, reply, `role=${role} — reply must be returned completely unchanged`);
    }
    assert.equal(escalations.length, 0, 'no Escalation should ever be created by this function anymore');
  });
});

test('handleExplicitHandoff: admin and super_admin can no longer trigger "raise a concern" against themselves', async () => {
  await withStubs(async ({ escalations }) => {
    for (const role of ['admin', 'super_admin']) {
      const req = { user: { _id: 'a1', id: 'a1', role }, body: {}, headers: {} };
      const reply = await handleExplicitHandoff(req, 'I want to raise a concern', []);
      assert.equal(reply, null, `role=${role} should fall through to the normal pipeline`);
    }
    assert.equal(escalations.length, 0);
  });
});

test('handleExplicitHandoff: student is also blocked (user\'s scoping said parent/tutor only)', async () => {
  await withStubs(async ({ escalations }) => {
    const req = { user: { _id: 's1', id: 's1', role: 'student' }, body: {}, headers: {} };
    const reply = await handleExplicitHandoff(req, 'i have a concern about my grades', []);
    assert.equal(reply, null);
    assert.equal(escalations.length, 0);
  });
});

test('handleExplicitHandoff: parent and tutor are unaffected — still start the guided intake', async () => {
  await withStubs(async ({ escalations }) => {
    for (const role of ['parent', 'tutor']) {
      const req = { user: { _id: 'p1', id: 'p1', role }, body: {}, headers: {} };
      const reply = await handleExplicitHandoff(req, 'I want to raise a concern about my payment', []);
      assert.match(reply, /Reason:/i, `role=${role}`);
      assert.match(reply, /Explanation:/i, `role=${role}`);
    }
    assert.equal(escalations.length, 0, 'the trigger alone never creates a ticket');
  });
});

test('handleExplicitHandoff: unauthenticated still returns null (role gate runs after the existing auth check)', async () => {
  await withStubs(async ({ escalations }) => {
    const reply = await handleExplicitHandoff({ body: {}, headers: {} }, 'let me talk to a human', []);
    assert.equal(reply, null);
    assert.equal(escalations.length, 0);
  });
});
