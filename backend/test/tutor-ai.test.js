const test = require('node:test');
const assert = require('node:assert/strict');

const Schedule = require('../models/Schedule');
const AuditLog = require('../models/AuditLog');
const {
  detectStudentNotesIntent,
  detectLessonPrepIntent,
} = require('../utils/tutorAi');
const {
  detectGroundedTopic,
  buildTutorStudentNotesContext,
  handleLessonPrepRequest,
} = require('../controllers/aiController');

function stubFind(model, rows) {
  const chain = {
    populate() { return chain; },
    sort() { return chain; },
    select() { return chain; },
    lean() { return Promise.resolve(rows); },
  };
  model.find = () => chain;
}

function withStubs({ scheduleRows = [] }, fn) {
  const oS = Schedule.find;
  const oA = AuditLog.create;
  const audits = [];
  stubFind(Schedule, scheduleRows);
  AuditLog.create = async (e) => { audits.push(e); return e; };
  return Promise.resolve(fn({ audits })).finally(() => {
    Schedule.find = oS; AuditLog.create = oA;
  });
}

const TUTOR = { _id: 't1', id: 't1', role: 'tutor' };

test('intent detectors: notes vs lesson-prep vs neither', () => {
  assert.equal(detectStudentNotesIntent('how is Ana doing'), true);
  assert.equal(detectStudentNotesIntent('summarise my remarks on Ben'), true);
  assert.equal(detectStudentNotesIntent('catch me up on Ana'), true);
  assert.equal(detectLessonPrepIntent('generate practice problems for Ana'), true);
  assert.equal(detectLessonPrepIntent('help me plan a lesson'), true);
  assert.equal(detectStudentNotesIntent('what is my schedule today'), false);
  assert.equal(detectLessonPrepIntent('how do I upload materials'), false);
});

test('detectGroundedTopic routes tutor note requests to student_notes', () => {
  assert.equal(detectGroundedTopic(TUTOR, 'summarise my remarks on Ana'), 'student_notes');
  assert.equal(detectGroundedTopic(TUTOR, 'how is Ben progressing'), 'student_notes');
  // unchanged for other roles
  assert.equal(detectGroundedTopic({ _id: 's', role: 'student' }, 'how is Ben doing'), null);
});

// Batch 12 — chat_intents.json (the 9-intent local classifier detectGroundedTopic falls
// back to) has no "remarks" category at all, so every Remarks-tab question used to get
// force-matched to whichever of its 9 intents shared the most keywords — confidently wrong
// ("Tutors do not manage enrollment records directly...", "Bee Bright is located in
// Barangay Pantal...") instead of falling through to the real Remarks-tab handling. None of
// these are caught by detectStudentNotesIntent above (they're not "tell me about a
// student" digest requests), so without this guard they used to reach the classifier
// shortcut and come back as 'payments'/'enrollment'/'schedule'.
test('detectGroundedTopic: remarks-tab questions never get force-matched to payments/enrollment/schedule', () => {
  const remarksQuestions = [
    'Para saan ang remarks tab?',
    'what is the remarks tab for?',
    'are remarks the same as grades?',
    'how do i select a student for a new remark?',
    'how do i filter remark history by student?',
    'do remarks show a pass or fail result?',
    'how do i find a remark i already submitted?',
  ];
  for (const q of remarksQuestions) {
    assert.equal(detectGroundedTopic(TUTOR, q), null, q);
  }
});

test('detectGroundedTopic guardrail: non-remarks classifier shortcut still fires normally', () => {
  assert.equal(detectGroundedTopic(TUTOR, 'what is my enrollment status'), 'enrollment');
  assert.equal(detectGroundedTopic(TUTOR, 'is the payment verified?'), 'payments');
});

test('buildTutorStudentNotesContext: no assigned students', async () => {
  await withStubs({ scheduleRows: [] }, async () => {
    const ctx = await buildTutorStudentNotesContext('t1', 'how is Ana doing');
    assert.match(ctx.fallbackReply, /find any students assigned/i);
  });
});

test('buildTutorStudentNotesContext: unnamed student → disambiguation list', async () => {
  await withStubs({
    scheduleRows: [
      { student: { _id: 'a', firstName: 'Ana', lastName: 'Cruz' }, students: [] },
      { student: { _id: 'b', firstName: 'Ben', lastName: 'Dizon' }, students: [] },
    ],
  }, async () => {
    const ctx = await buildTutorStudentNotesContext('t1', 'summarise my notes on my student');
    assert.match(ctx.fallbackReply, /Which student\?/);
    assert.match(ctx.fallbackReply, /Ana Cruz/);
    assert.match(ctx.fallbackReply, /Ben Dizon/);
  });
});

// Grades were fully retired in favor of Student Remarks (2026-09-30) — this digest used
// to summarise Grade.remarks (grouped by subject, with a trend line); once a named
// student resolves, it now always gives the honest "nothing to summarise this way"
// answer instead of querying a model that's gone.
test('buildTutorStudentNotesContext: named student → honest "grades not tracked" answer', async () => {
  await withStubs({
    scheduleRows: [{ student: { _id: 'a', firstName: 'Ana', lastName: 'Cruz' }, students: [] }],
  }, async () => {
    const ctx = await buildTutorStudentNotesContext('t1', 'how is Ana Cruz doing');
    assert.match(ctx.fallbackReply, /Ana Cruz/);
    assert.match(ctx.fallbackReply, /Remark History/i);
  });
});

test('handleLessonPrepRequest: tutor + lesson-prep intent → held reply + audit', async () => {
  await withStubs({}, async ({ audits }) => {
    const req = { user: { _id: 't1', role: 'tutor' }, body: {}, headers: {} };
    const out = await handleLessonPrepRequest(req, 'generate a worksheet of practice problems for Ana');
    assert.match(out, /available in the assistant yet/i);
    assert.match(out, /summarise/i);
    const a = audits.find((x) => x.action === 'AI Chat');
    assert.match(a.metadata.groundingPath, /lesson-prep-(disabled|held)/);
  });
});

test('handleLessonPrepRequest: non-tutor → null', async () => {
  await withStubs({}, async () => {
    const out = await handleLessonPrepRequest({ user: { role: 'student' }, body: {}, headers: {} }, 'make me a lesson plan');
    assert.equal(out, null);
  });
});

// ⚠️ Scoping rule (Round 5): a tutor may only see remarks for students assigned to them.
test('buildTutorStudentNotesContext: a student NOT assigned to this tutor is never offered', async () => {
  const oS = Schedule.find;
  // This tutor is assigned only to Ana.
  const chain = { populate() { return chain; }, sort() { return chain; }, lean() { return Promise.resolve([{ student: { _id: 'ana', firstName: 'Ana', lastName: 'Cruz' }, students: [] }]); } };
  Schedule.find = () => chain;
  try {
    // Tutor asks about "Ben", who belongs to another tutor.
    const ctx = await buildTutorStudentNotesContext('t1', 'summarize my remarks on Ben');
    assert.match(ctx.fallbackReply, /Which student\?/);
    assert.match(ctx.fallbackReply, /Ana Cruz/);
    assert.doesNotMatch(ctx.fallbackReply, /Ben/);
  } finally {
    Schedule.find = oS;
  }
});
