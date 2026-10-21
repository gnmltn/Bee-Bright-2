/**
 * Real bug (live-reported, PDF batch): "sino sino ang mga estudyante ko?" / "who are my
 * students?" either returned a bare comma-separated name list (the legacy `tutor_students`
 * static dataset intent — no program/ID/schedule at all) or, for one phrasing, an
 * UNGROUNDED Gemini reply that fabricated plausible-looking names AND internal placeholder
 * emails ("child.xxx@students.beebright.internal" — a real internal field that no code
 * path here actually surfaces to anyone; Gemini invented the whole thing because nothing
 * grounded was given to answer from). The panelist specified an exact required block
 * format, one block per assigned student:
 *
 *   Name: Rene Bituin
 *   Program: Academic Tutorial – Premier (Pre-School / Elementary)
 *   Student ID: BB-20261015-0007
 *   Schedule: Fri/Sat, 3:00–4:00 PM
 *
 * Fixed with a new tutor-only grounded topic (my_students) that reuses getTutorStudents
 * (the SAME roster "who are my assigned students"/the Remarks tab already agree on), real
 * Enrollment package data for the Program/Student ID lines, and this tutor's own real
 * Schedule rows with each student for the Schedule line — never Gemini improvisation.
 *
 * Also covers the shadowing bug found while wiring this: the question also matches the
 * static `tutor_students` dataset entry AND isPersonInfoQuery's "sino ang X" pattern —
 * either would otherwise swallow the real grounded reply before it's ever consulted.
 * getResolvedReply now gives my_students priority, the same way renew_program/
 * student_notes already do for their own shadowing conflicts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Schedule = require('../models/Schedule');
const Enrollment = require('../models/Enrollment');
const geminiClient = require('../utils/geminiClient');

const {
  isTutorStudentListQuestion,
  buildTutorStudentListContext,
  formatStudentScheduleLabel,
  detectGroundedTopic,
  getResolvedReply,
  generateChatbotLlmReply,
} = require('../controllers/aiController');

const TUTOR = { _id: 'tutor-1', role: 'tutor' };

const mockQuery = (result) => {
  const q = {
    select: () => q,
    sort: () => q,
    limit: () => q,
    populate: () => q,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
};

const RENE = { _id: 'student-rene', firstName: 'Rene', lastName: 'Bituin' };

function stubModels({ scheduleRows = [], enrollments = [] } = {}) {
  const orig = { scheduleFind: Schedule.find, enrollmentFind: Enrollment.find };
  Schedule.find = () => mockQuery(scheduleRows);
  Enrollment.find = () => mockQuery(enrollments);
  return () => {
    Schedule.find = orig.scheduleFind;
    Enrollment.find = orig.enrollmentFind;
  };
}

test('isTutorStudentListQuestion: matches every reported phrasing, never an attendance question', () => {
  assert.equal(isTutorStudentListQuestion('sino sino ang mga estudyante ko?'), true);
  assert.equal(isTutorStudentListQuestion('who are my students?'), true);
  assert.equal(isTutorStudentListQuestion('hello pwede ko ba makuha yung list ng student na naka assign saakin?'), true);
  assert.equal(isTutorStudentListQuestion('what is leo\'s attendance'), false);
});

test('detectGroundedTopic: all three reported phrasings resolve to my_students for a tutor', () => {
  assert.equal(detectGroundedTopic(TUTOR, 'sino sino ang mga estudyante ko?'), 'my_students');
  assert.equal(detectGroundedTopic(TUTOR, 'who are my students?'), 'my_students');
  assert.equal(detectGroundedTopic(TUTOR, 'hello pwede ko ba makuha yung list ng student na naka assign saakin?'), 'my_students');
});

// Regression: "can you give me my student list?" and similar natural phrasings were
// wrongly declined by the UNRELATED named-student access guard (see
// named-student-access-guard.test.js for that fix) rather than even reaching topic
// detection — these confirm the broader intent recognition itself also covers them.
test('isTutorStudentListQuestion / detectGroundedTopic: several differently-worded "give me my list" phrasings all route to the real list', () => {
  const phrasings = [
    'can you give me my student list?',
    'what is my student roster',
    'give me the list of my students',
    "who's my students",
    'can i see all my students',
    'show me the listahan ng mga estudyante ko',
  ];
  for (const message of phrasings) {
    assert.equal(isTutorStudentListQuestion(message.toLowerCase()), true, `should match: "${message}"`);
    assert.equal(detectGroundedTopic(TUTOR, message), 'my_students', `should route to my_students: "${message}"`);
  }
});

test('formatStudentScheduleLabel: distinct weekdays (Sun..Sat order) + time range, from real session dates', () => {
  // 2026-10-23 is a Friday, 2026-10-24 is a Saturday (UTC).
  const sessions = [
    { date: '2026-10-23', startTime: '15:00', endTime: '16:00' },
    { date: '2026-10-24', startTime: '15:00', endTime: '16:00' },
  ];
  assert.equal(formatStudentScheduleLabel(sessions), 'Fri/Sat, 3:00 PM–4:00 PM');
  assert.equal(formatStudentScheduleLabel([]), 'Not yet scheduled');
});

test('buildTutorStudentListContext: renders the exact required per-student block format, with no internal placeholder email anywhere', async () => {
  const restore = stubModels({
    scheduleRows: [
      { _id: 's1', tutor: 'tutor-1', tutors: [], student: RENE, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-23', startTime: '15:00', endTime: '16:00' },
      { _id: 's2', tutor: 'tutor-1', tutors: [], student: RENE, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-24', startTime: '15:00', endTime: '16:00' },
    ],
    enrollments: [
      { _id: 'enr-1', student: RENE._id, permanentStudentId: 'BB-20261015-0007', packages: [{ programCode: 'ACT102', displayName: 'Academic Tutorial – Premier (Pre-School / Elementary)' }] },
    ],
  });
  try {
    const result = await buildTutorStudentListContext('tutor-1');
    assert.match(result.fallbackReply, /Name: Rene Bituin/);
    assert.match(result.fallbackReply, /Program: Academic Tutorial – Premier \(Pre-School \/ Elementary\)/);
    assert.match(result.fallbackReply, /Student ID: BB-20261015-0007/);
    assert.match(result.fallbackReply, /Schedule: Fri\/Sat, 3:00 PM–4:00 PM/);
    assert.doesNotMatch(result.fallbackReply, /@students\.beebright\.internal/);
    assert.doesNotMatch(result.fallbackReply, /@/); // no email of any kind, ever
    // Required block order: Name, Program, Student ID, then Schedule.
    const order = ['Name:', 'Program:', 'Student ID:', 'Schedule:'].map((k) => result.fallbackReply.indexOf(k));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  } finally {
    restore();
  }
});

test('buildTutorStudentListContext: lists EVERY assigned student, however many there are, one block each', async () => {
  const MARIA = { _id: 'student-maria', firstName: 'Maria', lastName: 'Cruz' };
  const ALEX = { _id: 'student-alex', firstName: 'Alex', lastName: 'Soriano' };
  const restore = stubModels({
    scheduleRows: [
      { _id: 's1', tutor: 'tutor-1', tutors: [], student: RENE, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-23', startTime: '15:00', endTime: '16:00' },
      { _id: 's2', tutor: 'tutor-1', tutors: [], student: MARIA, students: [], subject: { code: 'EXP106', name: 'Examination Preparation' }, date: '2026-10-26', startTime: '08:00', endTime: '09:00' },
      { _id: 's3', tutor: 'tutor-1', tutors: [], student: null, students: [ALEX], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: '2026-10-27', startTime: '08:00', endTime: '10:00' },
    ],
    enrollments: [
      { _id: 'e1', student: RENE._id, permanentStudentId: 'BB-1', packages: [{ programCode: 'ACT102', displayName: 'Academic Tutorial' }] },
      { _id: 'e2', student: MARIA._id, permanentStudentId: 'BB-2', packages: [{ programCode: 'EXP106', displayName: 'Exam Prep' }] },
      { _id: 'e3', student: ALEX._id, permanentStudentId: 'BB-3', packages: [{ programCode: 'TPG101', displayName: 'Toddlers Playgroup' }] },
    ],
  });
  try {
    const result = await buildTutorStudentListContext('tutor-1');
    assert.match(result.fallbackReply, /Rene Bituin/);
    assert.match(result.fallbackReply, /Maria Cruz/);
    assert.match(result.fallbackReply, /Alex Soriano/);
    assert.equal((result.fallbackReply.match(/Name:/g) || []).length, 3);
  } finally {
    restore();
  }
});

test('buildTutorStudentListContext: a tutor with no assigned students gets an honest reply, not a crash', async () => {
  const restore = stubModels({ scheduleRows: [] });
  try {
    const result = await buildTutorStudentListContext('tutor-1');
    assert.match(result.fallbackReply, /could not find any students assigned/i);
  } finally {
    restore();
  }
});

test('getResolvedReply: the real my_students grounded reply takes priority over the static flat-name-list dataset reply', async () => {
  const restore = stubModels({
    scheduleRows: [
      { _id: 's1', tutor: 'tutor-1', tutors: [], student: RENE, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-23', startTime: '15:00', endTime: '16:00' },
    ],
    enrollments: [
      { _id: 'enr-1', student: RENE._id, permanentStudentId: 'BB-20261015-0007', packages: [{ programCode: 'ACT102', displayName: 'Academic Tutorial – Premier (Pre-School / Elementary)' }] },
    ],
  });
  try {
    const groundedContext = await buildTutorStudentListContext('tutor-1');
    const reply = await getResolvedReply(
      TUTOR,
      'sino sino ang mga estudyante ko?',
      null,
      { ...groundedContext, topic: 'my_students' },
      'english',
      []
    );
    assert.match(reply, /Student ID: BB-20261015-0007/);
    assert.doesNotMatch(reply, /@students\.beebright\.internal/);
  } finally {
    restore();
  }
});

// ── Follow-up fix: Gemini kept rephrasing the real data into prose ("Si Leo Soriano na
//    may programang Toddlers Playgroup.") across 3 consecutive live attempts, dropping
//    Student ID and Schedule entirely and reducing Program to a bare category name every
//    time, no matter the system prompt. These tests check the LITERAL output structure —
//    field labels, line order, blank-line spacing, and a full repeated block (not a
//    combined line) for a student in two programs — not just that names appear somewhere.

test('buildTutorStudentListContext: the EXACT literal block structure for one student, one program — field labels, order, no extra text', async () => {
  const restore = stubModels({
    scheduleRows: [
      { _id: 's1', tutor: 'tutor-1', tutors: [], student: RENE, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-23', startTime: '15:00', endTime: '16:00' },
      { _id: 's2', tutor: 'tutor-1', tutors: [], student: RENE, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-24', startTime: '15:00', endTime: '16:00' },
    ],
    enrollments: [
      { _id: 'enr-1', student: RENE._id, permanentStudentId: 'BB-20261015-0007', packages: [{ programCode: 'ACT102', displayName: 'Academic Tutorial – Premier (Pre-School / Elementary)' }] },
    ],
  });
  try {
    const result = await buildTutorStudentListContext('tutor-1');
    assert.equal(
      result.fallbackReply,
      'Name: Rene Bituin\n'
      + 'Program: Academic Tutorial – Premier (Pre-School / Elementary)\n'
      + 'Student ID: BB-20261015-0007\n'
      + 'Schedule: Fri/Sat, 3:00 PM–4:00 PM'
    );
  } finally {
    restore();
  }
});

test('buildTutorStudentListContext: exactly one blank line separates two students\' blocks', async () => {
  const MARIA = { _id: 'student-maria', firstName: 'Maria', lastName: 'Cruz' };
  const restore = stubModels({
    scheduleRows: [
      { _id: 's1', tutor: 'tutor-1', tutors: [], student: RENE, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-23', startTime: '15:00', endTime: '16:00' },
      { _id: 's2', tutor: 'tutor-1', tutors: [], student: MARIA, students: [], subject: { code: 'EXP106', name: 'Examination Preparation' }, date: '2026-10-26', startTime: '08:00', endTime: '09:00' },
    ],
    enrollments: [
      { _id: 'e1', student: RENE._id, permanentStudentId: 'BB-1', packages: [{ programCode: 'ACT102', displayName: 'Academic Tutorial' }] },
      { _id: 'e2', student: MARIA._id, permanentStudentId: 'BB-2', packages: [{ programCode: 'EXP106', displayName: 'Exam Prep' }] },
    ],
  });
  try {
    const result = await buildTutorStudentListContext('tutor-1');
    assert.equal(
      result.fallbackReply,
      'Name: Rene Bituin\nProgram: Academic Tutorial\nStudent ID: BB-1\nSchedule: Fri, 3:00 PM–4:00 PM'
      + '\n\n'
      + 'Name: Maria Cruz\nProgram: Exam Prep\nStudent ID: BB-2\nSchedule: Mon, 8:00 AM–9:00 AM'
    );
  } finally {
    restore();
  }
});

test('buildTutorStudentListContext: a student taught in TWO programs under this tutor gets TWO full repeated blocks, never one combined Program line', async () => {
  const restore = stubModels({
    scheduleRows: [
      { _id: 's1', tutor: 'tutor-1', tutors: [], student: RENE, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-23', startTime: '15:00', endTime: '16:00' },
      { _id: 's2', tutor: 'tutor-1', tutors: [], student: null, students: [RENE], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: '2026-10-26', startTime: '08:00', endTime: '10:00' },
    ],
    enrollments: [
      {
        _id: 'enr-1',
        student: RENE._id,
        permanentStudentId: 'BB-20261015-0007',
        packages: [
          { programCode: 'ACT102', displayName: 'Academic Tutorial – Premier (Pre-School / Elementary)' },
          { programCode: 'TPG101', displayName: 'Toddlers Playgroup – 16 Hours' },
        ],
      },
    ],
  });
  try {
    const result = await buildTutorStudentListContext('tutor-1');
    const blocks = result.fallbackReply.split('\n\n');
    assert.equal(blocks.length, 2, 'must be two separate full blocks, not one combined block');
    assert.equal(
      blocks[0],
      'Name: Rene Bituin\nProgram: Academic Tutorial – Premier (Pre-School / Elementary)\nStudent ID: BB-20261015-0007\nSchedule: Fri, 3:00 PM–4:00 PM'
    );
    assert.equal(
      blocks[1],
      'Name: Rene Bituin\nProgram: Toddlers Playgroup – 16 Hours\nStudent ID: BB-20261015-0007\nSchedule: Mon, 8:00 AM–10:00 AM'
    );
    // Never a single line combining both program names.
    assert.doesNotMatch(result.fallbackReply, /Academic Tutorial.*,.*Toddlers Playgroup/);
  } finally {
    restore();
  }
});

// ── Gemini must never rephrase this reply — verified by stubbing geminiClient and
//    asserting it is NEVER CALLED for the my_students topic, with the exact pre-built
//    text returned byte-for-byte instead.
test('generateChatbotLlmReply: the my_students topic bypasses Gemini entirely and returns the exact pre-built block text', async () => {
  let llmCalls = 0;
  const origReply = geminiClient.generateChatbotReply;
  geminiClient.generateChatbotReply = async () => { llmCalls += 1; return 'Si Rene Bituin na may programang Academic Tutorial.'; };
  try {
    const groundedContext = {
      topic: 'my_students',
      contextText: 'Role: tutor\nAssigned students: 1\n\nName: Rene Bituin\nProgram: Academic Tutorial\nStudent ID: BB-1\nSchedule: Not yet scheduled',
      fallbackReply: 'Name: Rene Bituin\nProgram: Academic Tutorial\nStudent ID: BB-1\nSchedule: Not yet scheduled',
    };
    const reply = await generateChatbotLlmReply({
      user: TUTOR,
      resolvedMessage: 'sino sino ang mga estudyante ko?',
      rawMessage: 'sino sino ang mga estudyante ko?',
      groundedContext,
      effectiveLanguageProfile: 'taglish',
      responsePreference: {},
      history: [],
    });
    assert.equal(llmCalls, 0, 'Gemini must never be invoked for this topic');
    assert.equal(reply, groundedContext.fallbackReply);
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});

test('generateChatbotLlmReply: a DIFFERENT topic is unaffected — Gemini is still called normally (bypass is scoped to my_students only)', async () => {
  let llmCalls = 0;
  const origReply = geminiClient.generateChatbotReply;
  geminiClient.generateChatbotReply = async () => { llmCalls += 1; return 'A normal Gemini-composed reply.'; };
  try {
    const groundedContext = { topic: 'schedule', contextText: 'Role: tutor\nSome schedule data', fallbackReply: 'Your next session is tomorrow.' };
    const reply = await generateChatbotLlmReply({
      user: TUTOR,
      resolvedMessage: 'what is my schedule today',
      rawMessage: 'what is my schedule today',
      groundedContext,
      effectiveLanguageProfile: 'english',
      responsePreference: {},
      history: [],
    });
    assert.equal(llmCalls, 1, 'Gemini must still be called for topics outside the exact-passthrough set');
    assert.equal(reply, 'A normal Gemini-composed reply.');
  } finally {
    geminiClient.generateChatbotReply = origReply;
  }
});
