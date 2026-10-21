/**
 * Real bug (live-reported, PDF batch): "pwede ko ba makita yung list ng student ng hindi
 * pa na i-schedule" (students still waiting to be scheduled for 1-on-1 or Toddlers
 * Playgroup) always got a bare "go check the Schedule tab yourself" deflection, never the
 * real list, and the panelist specified an exact required format — one block per student:
 *
 *   Name: Rene Bituin
 *   Program: Academic Tutorial – Premier (Pre-School / Elementary)
 *   Student ID: BB-20261015-0007
 *
 * Fixed with a new admin-only grounded topic (unscheduled_students) reusing the EXACT
 * SAME eligibility check (isStudentAlreadyScheduledForProgram) the 1-on-1/Playgroup
 * Scheduling Wizards' own "Select a student" dropdowns already use.
 *
 * Also covers a real shadowing bug found while wiring this: the question also matches
 * getAdminSystemKnowledgeReply's generic "list all students" pattern, which would have
 * returned EVERY enrolled student (not just unscheduled ones) had it run first —
 * getResolvedReply now gives the real grounded unscheduled_students topic priority over
 * that generic handler, the same way renew_program/student_notes already take priority.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Enrollment = require('../models/Enrollment');
const Subject = require('../models/Subject');
const Schedule = require('../models/Schedule');

const {
  isUnscheduledStudentsListQuestion,
  buildAdminUnscheduledStudentsContext,
  detectGroundedTopic,
  getResolvedReply,
} = require('../controllers/aiController');

const ADMIN = { _id: 'admin-1', role: 'admin' };

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

function enrollment(overrides = {}) {
  return {
    _id: overrides._id || 'enr-1',
    status: 'approved',
    student: overrides.student || 'student-1',
    studentSnapshot: overrides.studentSnapshot || { firstName: 'Rene', lastName: 'Bituin' },
    packages: overrides.packages || [{ programCode: 'ACT102', displayName: 'Academic Tutorial – Premier (Pre-School / Elementary)' }],
    permanentStudentId: overrides.permanentStudentId !== undefined ? overrides.permanentStudentId : 'BB-20261015-0007',
    studentId: overrides.studentId || null,
    ...overrides,
  };
}

// alreadyScheduledIds: Set of studentUserId strings that already have a live Schedule row.
function stubModels({ enrollments = [], alreadyScheduledIds = new Set() } = {}) {
  const orig = { enrollmentFind: Enrollment.find, subjectFindOne: Subject.findOne, scheduleExists: Schedule.exists };
  Enrollment.find = () => mockQuery(enrollments);
  Subject.findOne = () => mockQuery({ _id: 'subj-1' });
  Schedule.exists = async (query) => {
    const studentId = String(query?.$or?.[0]?.student || '');
    return alreadyScheduledIds.has(studentId);
  };
  return () => {
    Enrollment.find = orig.enrollmentFind;
    Subject.findOne = orig.subjectFindOne;
    Schedule.exists = orig.scheduleExists;
  };
}

test('isUnscheduledStudentsListQuestion: matches the reported Tagalog phrasing and English equivalents', () => {
  assert.equal(isUnscheduledStudentsListQuestion('pwede ko ba makita yung list ng student ng hindi pa na i-schedule'), true);
  assert.equal(isUnscheduledStudentsListQuestion('which students are not yet scheduled?'), true);
  assert.equal(isUnscheduledStudentsListQuestion('what is my schedule today'), false);
});

test('detectGroundedTopic: the reported phrasing resolves to unscheduled_students for admin', () => {
  assert.equal(detectGroundedTopic(ADMIN, 'pwede ko ba makita yung list ng student ng hindi pa na i-schedule'), 'unscheduled_students');
});

test('buildAdminUnscheduledStudentsContext: lists every NOT-yet-scheduled student in the exact required block format', async () => {
  const restore = stubModels({
    enrollments: [enrollment()],
    alreadyScheduledIds: new Set(),
  });
  try {
    const result = await buildAdminUnscheduledStudentsContext();
    assert.match(result.fallbackReply, /Name: Rene Bituin/);
    assert.match(result.fallbackReply, /Program: Academic Tutorial – Premier \(Pre-School \/ Elementary\)/);
    assert.match(result.fallbackReply, /Student ID: BB-20261015-0007/);
    // Required block order: Name, then Program, then Student ID.
    const nameIdx = result.fallbackReply.indexOf('Name:');
    const programIdx = result.fallbackReply.indexOf('Program:');
    const idIdx = result.fallbackReply.indexOf('Student ID:');
    assert.ok(nameIdx < programIdx && programIdx < idIdx);
  } finally {
    restore();
  }
});

test('buildAdminUnscheduledStudentsContext: a student who already has a schedule for that program is excluded entirely', async () => {
  const restore = stubModels({
    enrollments: [enrollment({ student: 'student-scheduled' })],
    alreadyScheduledIds: new Set(['student-scheduled']),
  });
  try {
    const result = await buildAdminUnscheduledStudentsContext();
    assert.doesNotMatch(result.fallbackReply, /Rene Bituin/);
    assert.match(result.fallbackReply, /already has a schedule|nobody is waiting/i);
  } finally {
    restore();
  }
});

test('buildAdminUnscheduledStudentsContext: a student enrolled in TWO programs, only one unscheduled, is listed once for that one program', async () => {
  const restore = stubModels({
    enrollments: [
      enrollment({
        student: 'student-two-programs',
        packages: [
          { programCode: 'ACT102', displayName: 'Academic Tutorial – Premier (Pre-School / Elementary)' },
          { programCode: 'TPG101', displayName: 'Toddlers Playgroup – Starter' },
        ],
      }),
    ],
    alreadyScheduledIds: new Set(),
  });
  // ACT102 already scheduled, TPG101 not — Schedule.exists must distinguish by program,
  // so stub it directly here instead of the generic alreadyScheduledIds set.
  Subject.findOne = (query) => mockQuery({ _id: query?.code === 'ACT102' ? 'subj-act' : 'subj-tpg' });
  Schedule.exists = async (query) => {
    // isStudentAlreadyScheduledForProgram queries Schedule.exists({$or:[{student},{students}], subject}).
    return query?.subject === 'subj-act';
  };
  try {
    const result = await buildAdminUnscheduledStudentsContext();
    assert.doesNotMatch(result.fallbackReply, /Academic Tutorial/);
    assert.match(result.fallbackReply, /Toddlers Playgroup/);
    // Exactly one block for this student (only the unscheduled program).
    const occurrences = result.fallbackReply.split('Name: Rene Bituin').length - 1;
    assert.equal(occurrences, 1);
  } finally {
    restore();
  }
});

test('buildAdminUnscheduledStudentsContext: an honest "nobody waiting" reply when every student already has a schedule', async () => {
  const restore = stubModels({ enrollments: [], alreadyScheduledIds: new Set() });
  try {
    const result = await buildAdminUnscheduledStudentsContext();
    assert.match(result.fallbackReply, /nobody is waiting to be scheduled/i);
  } finally {
    restore();
  }
});

test('getResolvedReply: the real unscheduled_students grounded reply takes priority over the generic admin "list all students" handler', async () => {
  const restore = stubModels({
    enrollments: [enrollment()],
    alreadyScheduledIds: new Set(),
  });
  try {
    const groundedContext = await buildAdminUnscheduledStudentsContext();
    const reply = await getResolvedReply(
      ADMIN,
      'pwede ko ba makita yung list ng student ng hindi pa na i-schedule',
      null,
      { ...groundedContext, topic: 'unscheduled_students' },
      'english',
      []
    );
    assert.match(reply, /Student ID: BB-20261015-0007/);
  } finally {
    restore();
  }
});
