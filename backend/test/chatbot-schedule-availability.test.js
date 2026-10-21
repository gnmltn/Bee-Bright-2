/**
 * Request 1 — AI scheduling SUGGESTIONS in the admin chatbot. Real bug (live-reported):
 * "what is available schedule for [tutor] for [student] in the morning" got a generic/
 * malformed answer (e.g. "you can choose this day... from 8am to 8am") because no
 * scheduling-availability topic existed — the only schedule-related grounding
 * (buildAdminScheduleContext) just lists already-booked sessions, never a tutor's real
 * availability. These tests exercise the new topic end to end, through the real
 * detectGroundedTopic/resolveGroundedContextForTopic dispatch, mocking only the
 * underlying models (User/Enrollment/Subject/Schedule/TutorUnavailability) — the same
 * level everything else in this test suite mocks at.
 *
 * Follow-up fixes covered here too:
 *  - Scope: suggestions only apply to students who still need scheduling — the EXACT
 *    same eligibility the 1-on-1 and Playgroup wizards' own "Select a student"
 *    dropdowns already use (isStudentAlreadyScheduledForProgram mirrors their
 *    alreadyScheduled checks), for both ACT102/EXP106 (1-on-1) and TPG101 (Playgroup).
 *  - Dates: every suggested day must carry a real calendar date together with its
 *    weekday (e.g. "Tuesday, October 20, 2026"), computed from the real calendar so
 *    they can never disagree, and never in the past.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Subject = require('../models/Subject');
const Schedule = require('../models/Schedule');
const TutorUnavailability = require('../models/TutorUnavailability');
const {
  isScheduleAvailabilityQuestion,
  extractTimeOfDayFromMessage,
  extractForPhrasesForScheduling,
  resolveTutorForScheduling,
  resolveSchedulingProgramForStudent,
  buildAdminScheduleAvailabilityContext,
  detectGroundedTopic,
} = require('../controllers/aiController');

const ADMIN = { _id: 'admin-1', role: 'admin' };

const mockQuery = (result) => {
  const q = {
    select: () => q,
    sort: () => q,
    limit: () => q,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
};

// Covers Mon/Tue/Thu/Fri/Sat 9-10 AM (1-on-1) and Mon 8-10 AM (also covers the
// Toddlers Playgroup 8-10 AM fixed window) — NOT Wednesday at all, used to prove a
// genuinely-outside-availability day is reported correctly.
const JAKE = {
  _id: 'tutor-jake',
  firstName: 'Jake',
  lastName: 'Soriano',
  employmentType: 'part-time',
  availability: 'Mon 8:00 AM - 10:00 AM, Tue 9:00 AM - 10:00 AM, Thu 9:00 AM - 10:00 AM, Fri 9:00 AM - 10:00 AM, Sat 9:00 AM - 10:00 AM',
};

function stubCommon({ tutors = [JAKE], scheduleRows = [], unavailable = false, alreadyScheduled = false } = {}) {
  const orig = {
    userFind: User.find,
    userFindOne: User.findOne,
    unavailExists: TutorUnavailability.exists,
    scheduleFind: Schedule.find,
    scheduleExists: Schedule.exists,
    subjectFindOne: Subject.findOne,
  };
  User.find = (query) => {
    if (query?.role === 'tutor') return mockQuery(tutors);
    // filterLiveSessions' own User.find({_id: {$in:...}}) — treat everyone involved as live.
    return mockQuery((query?._id?.$in || []).map((id) => ({ _id: id })));
  };
  User.findOne = (query) => mockQuery(tutors.find((t) => String(t._id) === String(query._id)) || null);
  TutorUnavailability.exists = async () => unavailable;
  Schedule.find = () => mockQuery(scheduleRows);
  Schedule.exists = async () => alreadyScheduled;
  Subject.findOne = () => mockQuery({ _id: 'subj-act102' });
  return () => {
    User.find = orig.userFind;
    User.findOne = orig.userFindOne;
    TutorUnavailability.exists = orig.unavailExists;
    Schedule.find = orig.scheduleFind;
    Schedule.exists = orig.scheduleExists;
    Subject.findOne = orig.subjectFindOne;
  };
}

function makeStudentEnrollment(overrides = {}) {
  return {
    _id: 'enr-1',
    status: 'approved',
    student: 'student-maria',
    studentSnapshot: { firstName: 'Maria', lastName: 'Cruz' },
    packages: [{ programCode: 'ACT102', displayName: 'Academic Tutorial' }],
    preferredDaysByProgram: [],
    preferredSlots: [],
    permanentStudentId: 'BB-001',
    ...overrides,
  };
}

// Parses every "Weekday, Month Day, Year" substring out of a reply — used to confirm
// dates/weekdays never disagree and nothing in the past is ever suggested.
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function extractDatedMentions(text) {
  const re = /(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push({ weekday: m[1], full: m[0], date: new Date(`${m[2]} ${m[3]}, ${m[4]} UTC`) });
  return out;
}

test('isScheduleAvailabilityQuestion: matches an availability question, not a plain "what is my schedule"', () => {
  assert.equal(isScheduleAvailabilityQuestion('what is available schedule for jake soriano for maria cruz in the morning'), true);
  assert.equal(isScheduleAvailabilityQuestion('what is my schedule today'), false);
});

test('detectGroundedTopic: the exact reported phrasing resolves to schedule_availability for admin, not the generic schedule topic', () => {
  assert.equal(detectGroundedTopic(ADMIN, 'what is available schedule for jake soriano for maria cruz in the morning'), 'schedule_availability');
});

test('extractTimeOfDayFromMessage: morning/afternoon/evening/none', () => {
  assert.equal(extractTimeOfDayFromMessage('available in the morning'), 'morning');
  assert.equal(extractTimeOfDayFromMessage('available in the afternoon'), 'afternoon');
  assert.equal(extractTimeOfDayFromMessage('available in the evening'), 'evening');
  assert.equal(extractTimeOfDayFromMessage('available schedule'), null);
});

test('extractForPhrasesForScheduling: the exact reported phrasing extracts BOTH names, tutor first then student', () => {
  const normalized = 'what is available schedule for jake soriano for maria cruz in the morning';
  assert.deepEqual(extractForPhrasesForScheduling(normalized), ['jake soriano', 'maria cruz']);
});

test('resolveTutorForScheduling: resolves the real tutor from a "for X" phrase, not the student phrase', async () => {
  const restore = stubCommon();
  try {
    const { tutor, remainingPhrases } = await resolveTutorForScheduling('for jake soriano for maria cruz', ['jake soriano', 'maria cruz']);
    assert.equal(tutor._id, 'tutor-jake');
    assert.deepEqual(remainingPhrases, ['maria cruz']);
  } finally {
    restore();
  }
});

test('resolveSchedulingProgramForStudent: picks the one-on-one package by default, Playgroup only when the message says so', () => {
  const both = makeStudentEnrollment({ packages: [{ programCode: 'ACT102' }, { programCode: 'TPG101' }] });
  assert.deepEqual(resolveSchedulingProgramForStudent(both, 'is jake available for maria'), { programCode: 'ACT102', sessionType: 'one-on-one' });
  assert.deepEqual(resolveSchedulingProgramForStudent(both, 'is jake available for maria playgroup'), { programCode: 'TPG101', sessionType: 'playgroup' });
  const playgroupOnly = makeStudentEnrollment({ packages: [{ programCode: 'TPG101' }] });
  assert.deepEqual(resolveSchedulingProgramForStudent(playgroupOnly, 'is jake available for maria'), { programCode: 'TPG101', sessionType: 'playgroup' });
});

test('buildAdminScheduleAvailabilityContext: no tutor resolved -> a clear clarification reply, not a hallucinated answer', async () => {
  const restore = stubCommon({ tutors: [JAKE] });
  try {
    const result = await buildAdminScheduleAvailabilityContext('is anyone available tomorrow morning');
    assert.match(result.fallbackReply, /which tutor/i);
  } finally {
    restore();
  }
});

test('buildAdminScheduleAvailabilityContext: a resolved tutor with real open slots gets a real, specific answer with a real calendar date (not generic/malformed)', async () => {
  const restore = stubCommon();
  try {
    const result = await buildAdminScheduleAvailabilityContext('what is available schedule for jake soriano');
    assert.match(result.fallbackReply, /Jake Soriano/);
    assert.match(result.fallbackReply, /9:00 AM-10:00 AM/);
    assert.doesNotMatch(result.fallbackReply, /8am to 8am/i, 'must never reproduce the old malformed placeholder answer');

    const mentions = extractDatedMentions(result.fallbackReply);
    assert.ok(mentions.length > 0, 'every suggested day must carry a real calendar date, not a bare weekday');
  } finally {
    restore();
  }
});

// ── Date formatting: every suggested day must carry a REAL date matching its weekday ──

test('DATES: every date mentioned in a suggestion reply has a weekday that matches its own calendar date, and none are in the past', async () => {
  const restore = stubCommon();
  try {
    const result = await buildAdminScheduleAvailabilityContext('what is available schedule for jake soriano');
    const mentions = extractDatedMentions(result.fallbackReply);
    assert.ok(mentions.length > 0);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (const { weekday, date, full } of mentions) {
      assert.equal(WEEKDAY_NAMES[date.getUTCDay()], weekday, `"${full}" claims ${weekday} but the real calendar date is a ${WEEKDAY_NAMES[date.getUTCDay()]}`);
      assert.ok(date >= today, `"${full}" must not be in the past`);
    }
  } finally {
    restore();
  }
});

test('DATES: a recurring open slot lists more than one real upcoming date, not just the first occurrence', async () => {
  const restore = stubCommon();
  try {
    const result = await buildAdminScheduleAvailabilityContext('what is available schedule for jake soriano on monday');
    const mentions = extractDatedMentions(result.fallbackReply);
    const mondayMentions = mentions.filter((m) => m.weekday === 'Monday');
    assert.ok(mondayMentions.length >= 2, 'a recurring Monday slot should list several real upcoming Mondays, not just the next one');
  } finally {
    restore();
  }
});

// ── Scope: unscheduled students only (same eligibility as the wizards' dropdowns) ──

test('SCOPE: an unscheduled 1-on-1 student gets real suggestions', async () => {
  const enrollmentDoc = makeStudentEnrollment();
  const origEnrollmentFind = Enrollment.find;
  Enrollment.find = () => mockQuery([enrollmentDoc]);
  const restore = stubCommon({ alreadyScheduled: false });
  try {
    const result = await buildAdminScheduleAvailabilityContext('what is available schedule for jake soriano for maria cruz');
    assert.match(result.fallbackReply, /Maria Cruz/);
    assert.match(result.fallbackReply, /9:00 AM-10:00 AM/);
    assert.doesNotMatch(result.fallbackReply, /already has a schedule/i);
  } finally {
    Enrollment.find = origEnrollmentFind;
    restore();
  }
});

test('SCOPE: an unscheduled Playgroup student gets real suggestions, using the fixed Playgroup windows', async () => {
  const enrollmentDoc = makeStudentEnrollment({ packages: [{ programCode: 'TPG101', displayName: 'Toddlers Playgroup' }] });
  const origEnrollmentFind = Enrollment.find;
  Enrollment.find = () => mockQuery([enrollmentDoc]);
  const restore = stubCommon({ alreadyScheduled: false });
  try {
    const result = await buildAdminScheduleAvailabilityContext('what is available schedule for jake soriano for maria cruz playgroup');
    assert.match(result.fallbackReply, /Maria Cruz/);
    // Jake's Monday 8-10 AM window covers the Playgroup fixed 8:00 AM-10:00 AM slot.
    assert.match(result.fallbackReply, /8:00 AM-10:00 AM/);
    assert.doesNotMatch(result.fallbackReply, /already has a schedule/i);
  } finally {
    Enrollment.find = origEnrollmentFind;
    restore();
  }
});

test('SCOPE: a student who ALREADY has a schedule for that program gets the "already scheduled" reply, no suggestions', async () => {
  const enrollmentDoc = makeStudentEnrollment();
  const origEnrollmentFind = Enrollment.find;
  Enrollment.find = () => mockQuery([enrollmentDoc]);
  const restore = stubCommon({ alreadyScheduled: true });
  try {
    const result = await buildAdminScheduleAvailabilityContext('what is available schedule for jake soriano for maria cruz');
    assert.match(result.fallbackReply, /Maria Cruz already has a schedule/i);
    assert.match(result.fallbackReply, /still waiting to be scheduled/i);
    assert.doesNotMatch(result.fallbackReply, /9:00 AM-10:00 AM/, 'no suggestion content once the student is already scheduled');
  } finally {
    Enrollment.find = origEnrollmentFind;
    restore();
  }
});

test('SCOPE: a student whose sessions were deleted (no Schedule rows left) is treated as unscheduled again', async () => {
  const enrollmentDoc = makeStudentEnrollment();
  const origEnrollmentFind = Enrollment.find;
  Enrollment.find = () => mockQuery([enrollmentDoc]);
  // Schedule.exists -> false (nothing left to match), exactly as if their sessions had
  // never existed or were deleted — isStudentAlreadyScheduledForProgram has no
  // separate "was once scheduled" memory, only the CURRENT existence of a Schedule row.
  const restore = stubCommon({ alreadyScheduled: false });
  try {
    const result = await buildAdminScheduleAvailabilityContext('what is available schedule for jake soriano for maria cruz');
    assert.doesNotMatch(result.fallbackReply, /already has a schedule/i);
    assert.match(result.fallbackReply, /9:00 AM-10:00 AM/);
  } finally {
    Enrollment.find = origEnrollmentFind;
    restore();
  }
});

test('SCOPE: a nonexistent student keeps the existing "can\'t find" behavior', async () => {
  const origEnrollmentFind = Enrollment.find;
  Enrollment.find = () => mockQuery([]);
  const restore = stubCommon();
  try {
    const result = await buildAdminScheduleAvailabilityContext('what is available schedule for jake soriano for ghost student');
    assert.match(result.fallbackReply, /could not find a student/i);
    assert.doesNotMatch(result.fallbackReply, /9:00 AM-10:00 AM/);
  } finally {
    Enrollment.find = origEnrollmentFind;
    restore();
  }
});

test('buildAdminScheduleAvailabilityContext: reconciles the parent\'s preferred days against REAL availability, with real dates — the exact example from the request', async () => {
  // Jake is free Mon/Tue/Thu/Fri/Sat (per fixture) but NOT Wednesday.
  // Parent preferred Mon/Tue/Wed for ACT102 — Wed must come back blocked, with a real
  // reason, and Thu/Fri/Sat should surface as real alternatives, all with real dates.
  const enrollmentDoc = makeStudentEnrollment({
    preferredDaysByProgram: [{ programCode: 'ACT102', days: ['Monday', 'Tuesday', 'Wednesday'] }],
    preferredSlots: [{ programCode: 'ACT102', startTime: '09:00', endTime: '10:00' }],
  });
  const origEnrollmentFind = Enrollment.find;
  Enrollment.find = () => mockQuery([enrollmentDoc]);
  const restore = stubCommon({ alreadyScheduled: false });
  try {
    const result = await buildAdminScheduleAvailabilityContext('what is available schedule for jake soriano for maria cruz');
    assert.match(result.fallbackReply, /Monday/);
    assert.match(result.fallbackReply, /Tuesday/);
    assert.match(result.fallbackReply, /Wednesday/);
    assert.match(result.fallbackReply, /not/i);
    assert.match(result.fallbackReply, /Thursday/);

    const mentions = extractDatedMentions(result.fallbackReply);
    assert.ok(mentions.length > 0, 'the reconciliation reply must carry real dates too, not just weekday names');
  } finally {
    Enrollment.find = origEnrollmentFind;
    restore();
  }
});

test('buildAdminScheduleAvailabilityContext: a tutor with NO open slots at all gets an honest answer, not a fabricated one', async () => {
  const restore = stubCommon({ tutors: [{ ...JAKE, availability: '' }] });
  try {
    const result = await buildAdminScheduleAvailabilityContext('what is available schedule for jake soriano in the evening');
    assert.match(result.fallbackReply, /no open/i);
  } finally {
    restore();
  }
});

// Hard safety constraint from the request: Gemini must only SUGGEST, never create,
// modify, or submit an actual schedule — admin always finalizes through the unchanged
// Scheduling Wizard. Verified structurally: the module only ever IMPORTS read-only
// functions from scheduleController.js (checked against its actual destructuring
// line, not a blind text scan, since this file's own doc comment legitimately NAMES
// the mutating functions it does NOT import, as an explanation).
test('SAFETY: scheduleAvailability.js only imports READ-ONLY functions from scheduleController.js', () => {
  const file = path.join(__dirname, '..', 'utils', 'scheduleAvailability.js');
  const text = fs.readFileSync(file, 'utf8');
  const importLine = text.match(/require\(['"]\.\.\/controllers\/scheduleController['"]\)\s*;?/);
  const destructureMatch = text.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"]\.\.\/controllers\/scheduleController['"]\)/);
  assert.ok(importLine && destructureMatch, 'must import scheduleController.js via destructuring (so the imported names are statically checkable)');
  const importedNames = destructureMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
  const mutatingNames = ['createMonthlySchedules', 'createOrJoinPlaygroupGroup', 'createSchedule', 'bulkDeleteSchedules', 'deleteSchedule', 'markAttendance', 'assignSubstituteTutor', 'emergencyReschedule', 'enrollStudentInSession', 'removeStudentFromSession'];
  for (const name of importedNames) {
    assert.ok(!mutatingNames.includes(name), `scheduleAvailability.js must not import the mutating function ${name}`);
  }
  assert.ok(importedNames.includes('canTutorHandleSchedule'));
  assert.ok(importedNames.includes('hasStudentScheduleConflict'));
});
