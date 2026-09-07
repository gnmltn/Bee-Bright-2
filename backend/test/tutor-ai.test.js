const test = require('node:test');
const assert = require('node:assert/strict');

const Schedule = require('../models/Schedule');
const Grade = require('../models/Grade');
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

function withStubs({ scheduleRows = [], gradeRows = [] }, fn) {
  const oS = Schedule.find;
  const oG = Grade.find;
  const oA = AuditLog.create;
  const audits = [];
  stubFind(Schedule, scheduleRows);
  stubFind(Grade, gradeRows);
  AuditLog.create = async (e) => { audits.push(e); return e; };
  return Promise.resolve(fn({ audits })).finally(() => {
    Schedule.find = oS; Grade.find = oG; AuditLog.create = oA;
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

test('buildTutorStudentNotesContext: named student → digest of real remarks, grouped + trend', async () => {
  await withStubs({
    scheduleRows: [{ student: { _id: 'a', firstName: 'Ana', lastName: 'Cruz' }, students: [] }],
    gradeRows: [
      { programCategory: 'Academic Tutorial', subjectItem: 'Math', score: 85, maxScore: 100, period: 'Q1', remarks: 'Good grasp of addition' },
      { programCategory: 'Academic Tutorial', subjectItem: 'Math', score: 60, maxScore: 100, period: 'Q2', remarks: 'Struggling with regrouping' },
      { programCategory: 'Academic Tutorial', subjectItem: 'English', score: 90, maxScore: 100, period: 'Q1', remarks: '' },
    ],
  }, async () => {
    const ctx = await buildTutorStudentNotesContext('t1', 'how is Ana Cruz doing');
    assert.match(ctx.fallbackReply, /Notes on Ana Cruz/);
    assert.match(ctx.fallbackReply, /Math — average 73%, trending down \(85% → 60%\)/);
    assert.match(ctx.fallbackReply, /Q1: "Good grasp of addition"/);
    assert.match(ctx.fallbackReply, /Q2: "Struggling with regrouping"/);
    assert.match(ctx.fallbackReply, /English — average 90%.*\n {2}• \(no written remarks\)/);
  });
});

test('buildTutorStudentNotesContext: named student, no grades recorded', async () => {
  await withStubs({
    scheduleRows: [{ student: { _id: 'a', firstName: 'Ana', lastName: 'Cruz' }, students: [] }],
    gradeRows: [],
  }, async () => {
    const ctx = await buildTutorStudentNotesContext('t1', 'how is Ana doing');
    assert.match(ctx.fallbackReply, /haven't recorded any grades for Ana Cruz/i);
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
test('buildTutorStudentNotesContext: a student NOT assigned to this tutor is never queried', async () => {
  const oS = Schedule.find;
  const oG = Grade.find;
  let gradeQuery = null;
  // This tutor is assigned only to Ana.
  const chain = { populate() { return chain; }, sort() { return chain; }, lean() { return Promise.resolve([{ student: { _id: 'ana', firstName: 'Ana', lastName: 'Cruz' }, students: [] }]); } };
  Schedule.find = () => chain;
  Grade.find = (q) => { gradeQuery = q; return { populate() { return this; }, sort() { return this; }, lean() { return Promise.resolve([]); } }; };
  try {
    // Tutor asks about "Ben", who belongs to another tutor.
    const ctx = await buildTutorStudentNotesContext('t1', 'summarize my remarks on Ben');
    // Ben was not matched → the digest never issues a Grade query for him.
    assert.equal(gradeQuery, null);
    assert.match(ctx.fallbackReply, /Which student\?/);
    assert.match(ctx.fallbackReply, /Ana Cruz/);
    assert.doesNotMatch(ctx.fallbackReply, /Ben/);
  } finally {
    Schedule.find = oS;
    Grade.find = oG;
  }
});
