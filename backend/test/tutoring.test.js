// Tutoring mode is gated by TUTORING_ENABLED, read once at module load — set it before require.
process.env.TUTORING_ENABLED = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const Enrollment = require('../models/Enrollment');
const AuditLog = require('../models/AuditLog');
const { detectTutoringIntent, buildTutoringSystemPrompt } = require('../utils/tutoringMode');
const { handleTutoringRequest } = require('../controllers/aiController');

function withStubs(enrollmentRow, fetchImpl, fn) {
  const origFind = Enrollment.findOne;
  const origAudit = AuditLog.create;
  const origFetch = global.fetch;
  const audits = [];
  let fetchCalls = 0;

  Enrollment.findOne = () => {
    const chain = {
      populate() { return chain; },
      sort() { return chain; },
      lean() { return Promise.resolve(enrollmentRow); },
    };
    return chain;
  };
  AuditLog.create = async (e) => { audits.push(e); return e; };
  global.fetch = async (...args) => {
    fetchCalls += 1;
    return fetchImpl(...args);
  };

  return Promise.resolve(fn({ audits, getFetchCalls: () => fetchCalls })).finally(() => {
    Enrollment.findOne = origFind;
    AuditLog.create = origAudit;
    global.fetch = origFetch;
  });
}

const okLlm = async () => ({ ok: true, json: async () => ({ message: { content: 'Fractions are parts of a whole. Example: 1/2 + 1/2 = 1. Now you try: 1/4 + 1/4 = ? Show your work.' } }) });
const failLlm = async () => { throw new Error('connection refused'); };

const studentReq = (over = {}) => ({
  user: { _id: 'stu-1', id: 'stu-1', role: 'student', ...over },
  body: {},
  headers: {},
});

test('detectTutoringIntent: fires on learning requests, not on navigation', () => {
  for (const m of [
    'help me understand fractions',
    'explain photosynthesis',
    'can you teach me about the water cycle',
    'i don\'t understand long division',
    'give me some practice problems for multiplication',
    'ipaliwanag mo ang past tense',
    'tulungan mo ako mag-aral ng science',
  ]) {
    assert.equal(detectTutoringIntent(m), true, `intent: ${m}`);
  }
  for (const m of [
    'how do i log in',
    'where are my grades',
    'how do i enroll',
    'help me pay my tuition',
    'when is my next class',
    'how do i reset my password',
  ]) {
    assert.equal(detectTutoringIntent(m), false, `not intent: ${m}`);
  }
});

test('buildTutoringSystemPrompt: scope, age, guided style, integrity rule', () => {
  const p = buildTutoringSystemPrompt({ subjects: ['Math', 'Science'], programs: ['Academic Tutorial'], age: 9.4, languageProfile: 'english' });
  assert.match(p, /Math, Science/);
  assert.match(p, /Academic Tutorial/);
  assert.match(p, /about 9 years old/);
  assert.match(p, /GUIDED STYLE/);
  assert.match(p, /do not complete graded work/i);
  assert.match(p, /outside their enrolled subjects/i);
});

test('handleTutoringRequest: non-student → null', async () => {
  await withStubs(null, okLlm, async () => {
    const out = await handleTutoringRequest({ user: { role: 'parent' }, body: {}, headers: {} }, 'explain fractions', []);
    assert.equal(out, null);
  });
});

test('handleTutoringRequest: student, non-tutoring message → null', async () => {
  await withStubs(null, okLlm, async () => {
    const out = await handleTutoringRequest(studentReq(), 'where do i see my schedule', []);
    assert.equal(out, null);
  });
});

test('handleTutoringRequest: enrolled student, tutoring intent → guided LLM reply + audit', async () => {
  const enrollment = {
    status: 'active',
    selectedSubjects: [{ name: 'Math' }, { name: 'English' }],
    packages: [{ displayName: 'Academic Tutorial' }],
    studentSnapshot: { computedAge: 9 },
  };
  await withStubs(enrollment, okLlm, async ({ audits, getFetchCalls }) => {
    const out = await handleTutoringRequest(studentReq(), 'help me understand adding fractions', []);
    assert.match(out, /Fractions are parts of a whole/);
    assert.equal(getFetchCalls(), 1);
    const aiAudit = audits.find((a) => a.action === 'AI Chat');
    assert.equal(aiAudit.metadata.groundingPath, 'tutoring');
  });
});

test('handleTutoringRequest: no active enrollment → refusal, LLM not called', async () => {
  await withStubs(null, okLlm, async ({ audits, getFetchCalls }) => {
    const out = await handleTutoringRequest(studentReq(), 'explain the water cycle', []);
    assert.match(out, /active Bee Bright enrollment/i);
    assert.equal(getFetchCalls(), 0);
    assert.equal(audits.find((a) => a.action === 'AI Chat').metadata.groundingPath, 'tutoring-no-enrollment');
  });
});

test('handleTutoringRequest: LLM failure → safe fallback', async () => {
  const enrollment = { status: 'active', selectedSubjects: [{ name: 'Math' }], packages: [], studentSnapshot: {} };
  await withStubs(enrollment, failLlm, async () => {
    const out = await handleTutoringRequest(studentReq(), 'teach me how to solve for x', []);
    assert.match(out, /having trouble|ask your tutor/i);
  });
});
