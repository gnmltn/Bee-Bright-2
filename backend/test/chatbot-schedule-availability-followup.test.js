/**
 * Request 1 follow-up — 4 real bugs found from a live admin conversation transcript:
 *
 * 1. Flaky backend errors: the exact same scheduling-availability question once 500'd
 *    (the chat widget's generic network-failure text) and once succeeded. Root cause:
 *    tryClassifierShortcut calls resolveGroundedContextForTopic directly, with NO
 *    try/catch of its own (unlike getGroundedChatContext's identical call, which IS
 *    protected) — a transient DB hiccup there threw all the way out to chat()'s single
 *    outer try/catch, taking the whole reply down. Same shape of bug as the
 *    revenue-grounding 500 (see getGroundedChatContext's own comment); fixed the same
 *    way — wrap it so a failure degrades to "no shortcut" instead of a hard 500.
 *
 * 2. "Full ba ang 8-9AM sa Oct 21?" — a direct "is this EXACT date+time slot full"
 *    question never got a real yes/no; the chatbot deflected to "go check the Schedule
 *    tab yourself". No grounded topic recognized this shape at all. Fixed with a new
 *    slot_capacity topic (buildAdminSlotCapacityContext), reusing the exact same
 *    getAvailableTutorsGridForWindow computation the Scheduling Wizard's own calendar
 *    grid uses.
 *
 * 3. "Anong oras may available na tutors para sa Toddlers Playgroup sa Monday?" — asking
 *    about tutors IN GENERAL (no one named) for a program+day just repeated generic
 *    operating hours, because buildAdminScheduleAvailabilityContext only ever handled a
 *    NAMED tutor and otherwise deflected with "please tell me which tutor", leaving
 *    Gemini nothing concrete to answer from. Fixed by computing real per-tutor
 *    availability across the whole active roster when a program (optionally a day) is
 *    named but no specific tutor is.
 *
 * 4. A bare name reply to the chatbot's own disambiguation prompt ("Jake Soriano", then
 *    "Jake Porbile pala", after asking about ambiguous "Jake") both got "I cannot find a
 *    student named [name]" even though Jake Porbile genuinely exists — because a bare
 *    name carries none of isScheduleAvailabilityQuestion's trigger words, so the real
 *    name-matching logic a full question goes through never ran. Fixed with
 *    getCarriedOverAdminScheduleAvailabilityMessage, which reconstructs the ORIGINAL
 *    full question with the clarified name spliced in (preserving tutor/time-of-day
 *    context), mirroring the existing parent-side disambiguation-carryover pattern.
 *
 * 5. Tutor chatbot: an assigned student's attendance question ("Luna's overall
 *    attendance", "attendance report", "her absent count and dates") always got a vague
 *    "can't find"/"not in my records" reply — even before genuinely checking whether the
 *    student is assigned to this tutor — because no attendance topic existed for tutors
 *    at all (only the parent branch had one). Fixed with a new tutor-side 'attendance'
 *    topic (buildTutorAttendanceContext), reusing the EXACT SAME cycle resolution and
 *    per-program date-range computation already behind the Tutor Dashboard's Student
 *    summary / My Students tabs (attachCycleByStudent + attachProgramDateRangeToCycles),
 *    with a plain "not one of your assigned students" reply (not a generic not-found)
 *    when a named student genuinely isn't this tutor's.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Subject = require('../models/Subject');
const Schedule = require('../models/Schedule');
const TutorUnavailability = require('../models/TutorUnavailability');
const Pricing = require('../models/Pricing');
const AuditLog = require('../models/AuditLog');
AuditLog.create = async () => ({});
const {
  tryClassifierShortcut,
  isSlotCapacityQuestion,
  parseExplicitSlotTimeRange,
  buildAdminSlotCapacityContext,
  extractDayOfWeekFromMessage,
  extractAllDaysOfWeekFromMessage,
  isScheduleAvailabilityQuestion,
  isAdminTutorListQuestion,
  extractForPhrasesForScheduling,
  buildAdminScheduleAvailabilityContext,
  buildAdminTutorRosterAvailabilityContext,
  getCarriedOverAdminScheduleAvailabilityMessage,
  looksLikeNameClarificationNeeded,
  detectGroundedTopic,
  isAttendanceQuestion,
  extractAttendanceNameCandidate,
  buildTutorAttendanceContext,
} = require('../controllers/aiController');

const ADMIN = { _id: 'admin-1', role: 'admin' };
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

const JAKE = {
  _id: 'tutor-jake',
  firstName: 'Jake',
  lastName: 'Soriano',
  employmentType: 'part-time',
  availability: 'Mon 8:00 AM - 10:00 AM, Tue 9:00 AM - 10:00 AM, Thu 9:00 AM - 10:00 AM, Fri 9:00 AM - 10:00 AM, Sat 9:00 AM - 10:00 AM',
};

function stubCommon({ tutors = [JAKE], scheduleRows = [], unavailable = false, alreadyScheduled = false, enrollmentRows = null } = {}) {
  const orig = {
    userFind: User.find,
    userFindOne: User.findOne,
    unavailExists: TutorUnavailability.exists,
    scheduleFind: Schedule.find,
    scheduleExists: Schedule.exists,
    subjectFindOne: Subject.findOne,
    enrollmentFind: Enrollment.find,
  };
  User.find = (query) => {
    if (query?.role === 'tutor') return mockQuery(tutors);
    return mockQuery((query?._id?.$in || []).map((id) => ({ _id: id })));
  };
  User.findOne = (query) => mockQuery(tutors.find((t) => String(t._id) === String(query._id)) || null);
  TutorUnavailability.exists = async () => unavailable;
  Schedule.find = () => mockQuery(scheduleRows);
  Schedule.exists = async () => alreadyScheduled;
  Subject.findOne = () => mockQuery({ _id: 'subj-act102' });
  // Only stubbed when a test actually passes enrollmentRows — findChildEnrollmentGroupByName
  // (used by buildAdminScheduleAvailabilityContext to resolve a named student) queries this.
  if (enrollmentRows !== null) Enrollment.find = () => mockQuery(enrollmentRows);
  return () => {
    User.find = orig.userFind;
    User.findOne = orig.userFindOne;
    TutorUnavailability.exists = orig.unavailExists;
    Schedule.find = orig.scheduleFind;
    Schedule.exists = orig.scheduleExists;
    Subject.findOne = orig.subjectFindOne;
    if (enrollmentRows !== null) Enrollment.find = orig.enrollmentFind;
  };
}

// ── ISSUE 1: no flaky 500s from the classifier shortcut path ──────────────────────────

function stubFetch(impl) {
  const orig = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = orig; };
}

function predictionResponse(intent, confidence) {
  return async () => ({ ok: true, json: async () => ({ success: true, intent, confidence }) });
}

test('ISSUE 1: a transient DB error inside the classifier-shortcut path degrades to null (no shortcut) instead of throwing a hard 500 — repeating the same question never flakes', async () => {
  const restoreFetch = stubFetch(predictionResponse('schedule', 0.99));
  const origScheduleFind = Schedule.find;
  Schedule.find = () => { throw new Error('simulated transient DB hiccup'); };
  try {
    const reply = await tryClassifierShortcut(
      { user: ADMIN },
      'anong oras available si mariana luis para kay alex soriano sa hapon?',
      []
    );
    assert.equal(reply, null, 'a DB error inside the shortcut must degrade to null, not throw/propagate');
  } finally {
    Schedule.find = origScheduleFind;
    restoreFetch();
  }
});

test('ISSUE 1: the SAME question, asked again once the transient error is gone, succeeds normally — consistent answers either way', async () => {
  const restoreFetch = stubFetch(predictionResponse('schedule', 0.99));
  const origScheduleFind = Schedule.find;
  Schedule.find = () => mockQuery([]); // the hiccup is gone this time — a normal, fast DB response
  try {
    const reply = await tryClassifierShortcut({ user: ADMIN }, 'anong oras available si mariana luis para kay alex soriano sa hapon?', []);
    // No hard error this time — a real (if generic, since the classifier's own 'schedule'
    // route reuses the plain admin schedule context, not schedule_availability) reply
    // comes back, proving the SAME question no longer intermittently 500s.
    assert.equal(reply, 'There are no upcoming sessions scheduled right now.');
  } finally {
    Schedule.find = origScheduleFind;
    restoreFetch();
  }
});

// ── ISSUE 2: direct "is this exact slot full" questions ───────────────────────────────

test('isSlotCapacityQuestion / parseExplicitSlotTimeRange: recognizes "Full ba ang 8-9AM..." but not a plain "is Monday full"', () => {
  assert.equal(isSlotCapacityQuestion('full ba ang 8-9am sa oct 21?'), true);
  assert.equal(isSlotCapacityQuestion('is monday full?'), false, 'no explicit time range -> not this topic');
  assert.deepEqual(parseExplicitSlotTimeRange('full ba ang 8-9am sa oct 21?'), { startTime: '08:00', endTime: '09:00' });
  assert.deepEqual(parseExplicitSlotTimeRange('full ba ang 10-11am sa oct 21?'), { startTime: '10:00', endTime: '11:00' });
});

test('detectGroundedTopic: "Full ba ang 8-9AM sa Oct 21?" resolves to slot_capacity for admin', () => {
  assert.equal(detectGroundedTopic(ADMIN, 'Full ba ang 8-9AM sa Oct 21?'), 'slot_capacity');
});

function nonSundayOct21(year) {
  const d = new Date(Date.UTC(year, 9, 21));
  return d.getUTCDay() === 0 ? new Date(Date.UTC(year, 9, 22)) : d;
}

test('ISSUE 2: a direct slot-capacity question gets a real "not full" answer with real free tutor names, reusing the Wizard calendar\'s own grid data', async () => {
  const targetDate = nonSundayOct21(2030);
  const dayLabel = `October ${targetDate.getUTCDate()}, 2030`;
  const origUserFind = User.find;
  const origScheduleFind = Schedule.find;
  const origUnavailFind = TutorUnavailability.find;
  User.find = (query) => {
    if (query?.role === 'tutor') return mockQuery([{ _id: 'tutor-nicole', firstName: 'Nicole', lastName: 'Monzada', employmentType: 'full-time', availability: '' }]);
    return mockQuery((query?._id?.$in || []).map((id) => ({ _id: id })));
  };
  Schedule.find = () => mockQuery([]); // nothing booked
  TutorUnavailability.find = () => mockQuery([]);
  try {
    const result = await buildAdminSlotCapacityContext(`Full ba ang 8-9AM sa ${dayLabel}?`);
    assert.match(result.fallbackReply, /not full/i);
    assert.match(result.fallbackReply, /Nicole Monzada/);
  } finally {
    User.find = origUserFind;
    Schedule.find = origScheduleFind;
    TutorUnavailability.find = origUnavailFind;
  }
});

test('ISSUE 2: when every active tutor is already booked at that exact slot, reports it as full with the real reason — not a deflection', async () => {
  const targetDate = nonSundayOct21(2030);
  const dayLabel = `October ${targetDate.getUTCDate()}, 2030`;
  const origUserFind = User.find;
  const origScheduleFind = Schedule.find;
  const origUnavailFind = TutorUnavailability.find;
  User.find = (query) => {
    if (query?.role === 'tutor') return mockQuery([{ _id: 'tutor-nicole', firstName: 'Nicole', lastName: 'Monzada', employmentType: 'full-time', availability: '' }]);
    return mockQuery((query?._id?.$in || []).map((id) => ({ _id: id })));
  };
  Schedule.find = () => mockQuery([
    { tutor: 'tutor-nicole', tutors: ['tutor-nicole'], date: targetDate, startTime: '08:00', endTime: '09:00', sessionType: 'one-on-one' },
  ]);
  TutorUnavailability.find = () => mockQuery([]);
  try {
    const result = await buildAdminSlotCapacityContext(`Full ba ang 8-9AM sa ${dayLabel}?`);
    assert.match(result.fallbackReply, /is full/i);
    assert.doesNotMatch(result.fallbackReply, /not full/i);
  } finally {
    User.find = origUserFind;
    Schedule.find = origScheduleFind;
    TutorUnavailability.find = origUnavailFind;
  }
});

// ── ISSUE 3: Playgroup (or 1-on-1) tutor-roster availability, no tutor named ───────────

test('extractDayOfWeekFromMessage: resolves an explicit weekday name', () => {
  assert.equal(extractDayOfWeekFromMessage('available na tutors sa monday'), 1);
  assert.equal(extractDayOfWeekFromMessage('available na tutors sa saturday'), 6);
  assert.equal(extractDayOfWeekFromMessage('available na tutors'), null);
});

test('ISSUE 3: "which tutors are available for Toddlers Playgroup on Monday" gets REAL per-tutor data, not a generic operating-hours deflection', async () => {
  const restore = stubCommon({ tutors: [JAKE] });
  try {
    const result = await buildAdminScheduleAvailabilityContext('Anong oras may available na tutors para sa Toddlers Playgroup sa Monday?');
    // Jake's Monday 8-10 AM window covers Playgroup's fixed 8-10 AM window.
    assert.match(result.fallbackReply, /Jake Soriano/);
    assert.match(result.fallbackReply, /8:00 AM-10:00 AM/);
    assert.doesNotMatch(result.fallbackReply, /which tutor/i, 'must not fall back to the generic "please tell me which tutor" deflection');
  } finally {
    restore();
  }
});

test('ISSUE 3: no tutor has real availability for the program/day -> an honest "no tutors" answer, not a fabricated one', async () => {
  const restore = stubCommon({ tutors: [{ ...JAKE, availability: '' }] });
  try {
    const result = await buildAdminScheduleAvailabilityContext('Anong oras may available na tutors para sa Toddlers Playgroup sa Sunday?');
    assert.match(result.fallbackReply, /no tutors/i);
  } finally {
    restore();
  }
});

// ── ISSUE 4: bare-name reply to the chatbot's own disambiguation prompt ────────────────

test('looksLikeNameClarificationNeeded: matches both a genuine disambiguation reply and a "could not find" reply', () => {
  assert.equal(looksLikeNameClarificationNeeded('More than one student matches "jake". Please specify the full name.'), true);
  assert.equal(looksLikeNameClarificationNeeded('I could not find a student matching "jake soriano".'), true);
  assert.equal(looksLikeNameClarificationNeeded('Jake Soriano is available Monday 9-10 AM.'), false);
});

test('ISSUE 4: a bare name reply to a disambiguation prompt reconstructs the ORIGINAL full question with the clarified name, preserving the tutor/time-of-day context', async () => {
  const restore = stubCommon();
  try {
    const history = [
      { role: 'user', content: 'what is available schedule for jake soriano for jake in the afternoon' },
      { role: 'assistant', content: 'More than one student matches "jake". Please specify the full name.' },
    ];
    const reconstructed = await getCarriedOverAdminScheduleAvailabilityMessage('Jake Porbile', history);
    // The admin's own typed casing for the clarified name is preserved; everything else
    // from the original question (lowercase, as it was) is untouched.
    assert.equal(reconstructed, 'what is available schedule for jake soriano for Jake Porbile in the afternoon');
    // Critically: the TUTOR's own name ("jake soriano") must survive untouched — a naive
    // substring replace would have clobbered it too, since it also contains "jake".
    assert.match(reconstructed, /jake soriano/);
  } finally {
    restore();
  }
});

test('ISSUE 4: a SECOND bare-name attempt (after a first one also failed) still finds the TRUE original question further back in history', async () => {
  const restore = stubCommon();
  try {
    const history = [
      { role: 'user', content: 'what is available schedule for jake soriano for jake in the afternoon' },
      { role: 'assistant', content: 'More than one student matches "jake". Please specify the full name.' },
      { role: 'user', content: 'Jake Soriano' },
      { role: 'assistant', content: 'I could not find a student matching "jake soriano".' },
    ];
    const reconstructed = await getCarriedOverAdminScheduleAvailabilityMessage('Jake Porbile pala', history);
    assert.equal(reconstructed, 'what is available schedule for jake soriano for Jake Porbile in the afternoon');
  } finally {
    restore();
  }
});

test('ISSUE 4: a genuine new full-sentence question after a disambiguation prompt is left untouched (not hijacked into the old context)', async () => {
  const history = [
    { role: 'user', content: 'what is available schedule for jake soriano for jake in the afternoon' },
    { role: 'assistant', content: 'More than one student matches "jake". Please specify the full name.' },
  ];
  const reconstructed = await getCarriedOverAdminScheduleAvailabilityMessage('what is available schedule for nicole monzada for maria cruz', history);
  assert.equal(reconstructed, null);
});

test('ISSUE 4: with no prior disambiguation-shaped reply, a bare name is left alone (no false reconstruction)', async () => {
  const history = [
    { role: 'user', content: 'what is the revenue this month' },
    { role: 'assistant', content: 'Revenue (October 2026): PHP 50,000 from 10 verified payments.' },
  ];
  const reconstructed = await getCarriedOverAdminScheduleAvailabilityMessage('Jake Porbile', history);
  assert.equal(reconstructed, null);
});

// ── ISSUE 5: tutor chatbot attendance reports ──────────────────────────────────────────

function mockQuery2(result) {
  const q = {
    select: () => q, sort: () => q, limit: () => q, populate: () => q,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

/** attachProgramDateRangeToCycles' own "every schedule for this student, any tutor"
 *  query never populates student/students (production shape) — it only reads raw ids.
 *  getTutorStudents' roster query and buildTutorAttendanceContext's own tutor+student
 *  query, by contrast, need the POPULATED {_id, firstName, lastName} shape this fixture
 *  is written in. Derived automatically so each test only writes one fixture. */
function toRawStudentRows(rows) {
  return rows.map((r) => ({
    ...r,
    student: r.student ? (r.student._id || r.student) : r.student,
    students: (r.students || []).map((s) => s._id || s),
  }));
}

function stubAttendanceModels({ scheduleRows = [], enrollments = [], pricing = [] } = {}) {
  const orig = { scheduleFind: Schedule.find, enrollmentFind: Enrollment.find, pricingFind: Pricing.find };
  const rawRows = toRawStudentRows(scheduleRows);
  Schedule.find = (query) => {
    const orClauses = query?.$or || [];
    const mentionsTutor = orClauses.some((c) => 'tutor' in c || 'tutors' in c);
    const mentionsStudentOnly = !mentionsTutor && orClauses.some((c) => 'student' in c || 'students' in c);
    return mockQuery2(mentionsStudentOnly ? rawRows : scheduleRows);
  };
  Enrollment.find = () => mockQuery2(enrollments);
  Pricing.find = () => mockQuery2(pricing);
  return () => {
    Schedule.find = orig.scheduleFind;
    Enrollment.find = orig.enrollmentFind;
    Pricing.find = orig.pricingFind;
  };
}

const LUNA = { _id: 'student-luna', firstName: 'Luna', lastName: 'Cruz' };

test('isAttendanceQuestion / extractAttendanceNameCandidate: recognizes attendance phrasing and pulls a possessive name, never a question word', () => {
  assert.equal(isAttendanceQuestion("what's luna's overall attendance"), true);
  assert.equal(isAttendanceQuestion('give me an attendance report'), true);
  assert.equal(isAttendanceQuestion('what is her absent count'), true);
  assert.equal(extractAttendanceNameCandidate("What's Luna's attendance?"), 'Luna');
  assert.equal(extractAttendanceNameCandidate("What is Mark Dela Cruz's attendance?"), 'Mark Dela Cruz');
});

test('detectGroundedTopic: a tutor\'s attendance question resolves to the attendance topic', () => {
  assert.equal(detectGroundedTopic(TUTOR, "What's Luna's overall attendance?"), 'attendance');
});

test('ISSUE 5: an assigned student\'s attendance report returns real present/absent counts and the correct date range for an ONGOING program', async () => {
  const rows = [
    { _id: 's1', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-05', attendanceStatus: 'present' },
    { _id: 's2', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-12', attendanceStatus: 'absent' },
  ];
  const restore = stubAttendanceModels({
    scheduleRows: rows,
    enrollments: [
      { _id: 'enr-1', student: LUNA._id, enrollmentId: 'BB-1', status: 'approved', enrollmentDate: '2026-09-01', packages: [{ programCode: 'ACT102', packageSlug: 'act-4', displayName: 'Academic Tutorial' }] },
    ],
    // 4-session package, only 2 scheduled so far -> endDate stays null -> ongoing.
    pricing: [{ programCode: 'ACT102', packageSlug: 'act-4', sessionCount: 4 }],
  });
  try {
    const result = await buildTutorAttendanceContext('tutor-1', "What's Luna's overall attendance?");
    assert.match(result.fallbackReply, /present 1/i);
    assert.match(result.fallbackReply, /absent 1/i);
    assert.match(result.fallbackReply, /ongoing/i);
    assert.doesNotMatch(result.fallbackReply, /finished/i);
    assert.match(result.fallbackReply, /Oct 5, 2026/);
  } finally {
    restore();
  }
});

test('ISSUE 5: an assigned student with a FINISHED program shows its real end date instead of "ongoing"', async () => {
  const rows = [
    { _id: 's1', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: '2026-08-01', attendanceStatus: 'present' },
    { _id: 's2', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: '2026-08-08', attendanceStatus: 'present' },
  ];
  const restore = stubAttendanceModels({
    scheduleRows: rows,
    enrollments: [
      { _id: 'enr-2', student: LUNA._id, enrollmentId: 'BB-2', status: 'completed', enrollmentDate: '2026-07-01', packages: [{ programCode: 'TPG101', packageSlug: 'tpg-2', displayName: 'Toddlers Playgroup' }] },
    ],
    // Exactly 2 of 2 required sessions scheduled -> fully scheduled -> real end date.
    pricing: [{ programCode: 'TPG101', packageSlug: 'tpg-2', sessionCount: 2 }],
  });
  try {
    const result = await buildTutorAttendanceContext('tutor-1', "Luna's attendance report please");
    assert.match(result.fallbackReply, /finished/i);
    assert.doesNotMatch(result.fallbackReply, /still ongoing/i);
    assert.match(result.fallbackReply, /Aug 8, 2026/);
  } finally {
    restore();
  }
});

test('ISSUE 5: a student NOT assigned to this tutor gets a clear "not assigned to you" reply, not a generic not-found', async () => {
  const rows = [
    { _id: 's1', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-05', attendanceStatus: 'present' },
  ];
  const restore = stubAttendanceModels({ scheduleRows: rows });
  try {
    // Deliberately a different last name too — Luna's own lastName is "Cruz", and
    // resolveNamedPerson matches on EITHER first or last name alone, so a name reusing
    // Luna's last name would falsely match her instead of correctly finding no one.
    const result = await buildTutorAttendanceContext('tutor-1', "What is Mark Dela Torre's attendance?");
    assert.match(result.fallbackReply, /not one of your assigned students/i);
  } finally {
    restore();
  }
});

test('ISSUE 5: a student assigned across TWO programs gets two separate per-program reports', async () => {
  const rows = [
    { _id: 's1', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: '2026-10-05', attendanceStatus: 'present' },
    { _id: 's2', tutor: 'tutor-1', tutors: [], student: null, students: [LUNA], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: '2026-09-01', attendanceByStudent: [{ student: LUNA._id, status: 'present' }] },
  ];
  const restore = stubAttendanceModels({
    scheduleRows: rows,
    enrollments: [
      { _id: 'enr-act', student: LUNA._id, enrollmentId: 'BB-ACT', status: 'approved', enrollmentDate: '2026-09-15', packages: [{ programCode: 'ACT102', packageSlug: 'act-1', displayName: 'Academic Tutorial' }] },
      { _id: 'enr-tpg', student: LUNA._id, enrollmentId: 'BB-TPG', status: 'approved', enrollmentDate: '2026-08-01', packages: [{ programCode: 'TPG101', packageSlug: 'tpg-1', displayName: 'Toddlers Playgroup' }] },
    ],
    pricing: [
      { programCode: 'ACT102', packageSlug: 'act-1', sessionCount: 5 },
      { programCode: 'TPG101', packageSlug: 'tpg-1', sessionCount: 5 },
    ],
  });
  try {
    const result = await buildTutorAttendanceContext('tutor-1', "Luna's attendance report");
    assert.match(result.fallbackReply, /Academic Tutorial/);
    assert.match(result.fallbackReply, /Toddlers Playgroup/);
    // Two distinct program segments, not one blended tally.
    const parts = result.fallbackReply.split(';');
    assert.ok(parts.length >= 2, `expected 2 separate per-program segments, got: ${result.fallbackReply}`);
  } finally {
    restore();
  }
});

test('ISSUE 5: a tutor with no assigned students gets an honest reply, not a crash', async () => {
  const restore = stubAttendanceModels({ scheduleRows: [] });
  try {
    const result = await buildTutorAttendanceContext('tutor-1', "Luna's attendance");
    assert.match(result.fallbackReply, /could not find any students assigned/i);
  } finally {
    restore();
  }
});

// REAL BUG (found 2026-10-21): a tutor asked for a child's overall attendance on an
// already-elapsed program and the reply left several long-overdue sessions as "5
// unmarked sessions" instead of counting them as Absent — the existing 3-day-grace
// auto-absent rule (built for the tutor/parent dashboards' own UI) was never applied to
// this backend-computed chatbot summary at all. Fixed via effectiveAttendanceStatusForStudent
// (schedulingPolicy.js), reusing the exact same rule, not a new one. Dates are relative
// to "now" (not hardcoded) so this stays a real regression test no matter when it runs.
function daysAgoISODate(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function daysFromNowISODate(days) {
  return daysAgoISODate(-days);
}

test('REAL BUG FIX: a long-overdue unmarked session counts as Absent, a within-grace one stays unmarked', async () => {
  const rows = [
    { _id: 's1', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: daysAgoISODate(30), attendanceStatus: 'present' },
    { _id: 's2', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: daysAgoISODate(20), attendanceStatus: 'unmarked' },
    { _id: 's3', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: daysAgoISODate(1), attendanceStatus: 'unmarked' },
  ];
  const restore = stubAttendanceModels({
    scheduleRows: rows,
    enrollments: [
      { _id: 'enr-1', student: LUNA._id, enrollmentId: 'BB-1', status: 'approved', enrollmentDate: daysAgoISODate(60), packages: [{ programCode: 'ACT102', packageSlug: 'act-5', displayName: 'Academic Tutorial' }] },
    ],
    pricing: [{ programCode: 'ACT102', packageSlug: 'act-5', sessionCount: 5 }],
  });
  try {
    const result = await buildTutorAttendanceContext('tutor-1', "Luna's overall attendance");
    assert.match(result.contextText, /Present: 1/);
    assert.match(result.contextText, /Absent: 1/);
    assert.match(result.contextText, /Unmarked: 1/);
    assert.match(result.fallbackReply, /present 1/i);
    assert.match(result.fallbackReply, /absent 1/i);
  } finally {
    restore();
  }
});

test('REAL BUG FIX: a session already marked Present/Absent before the cutoff keeps its real status, never auto-overridden', async () => {
  const rows = [
    { _id: 's1', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: daysAgoISODate(90), attendanceStatus: 'present' },
    { _id: 's2', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'ACT102', name: 'Academic Tutorial' }, date: daysAgoISODate(80), attendanceStatus: 'absent' },
  ];
  const restore = stubAttendanceModels({ scheduleRows: rows });
  try {
    const result = await buildTutorAttendanceContext('tutor-1', "Luna's overall attendance");
    assert.match(result.contextText, /Present: 1/);
    assert.match(result.contextText, /Absent: 1/);
    assert.match(result.contextText, /Unmarked: 0/);
  } finally {
    restore();
  }
});

// REAL BUG (found 2026-10-21): "finished" was shown whenever a program's package was
// fully SCHEDULED, even when its last session was still genuinely in the future — a
// different thing from the program having actually happened yet. Matches the exact
// complaint: a Toddlers Playgroup program running Oct 6-28, 2026 (today Oct 21) was
// called "natapos" (finished) even though Oct 28 hadn't happened yet.
test('REAL BUG FIX: a fully-scheduled program whose last session is still in the future is NOT mislabeled "(finished)"', async () => {
  const rows = [
    { _id: 's1', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: daysAgoISODate(15), attendanceStatus: 'present' },
    { _id: 's2', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: daysAgoISODate(8), attendanceStatus: 'absent' },
    { _id: 's3', tutor: 'tutor-1', tutors: [], student: LUNA, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: daysFromNowISODate(7), attendanceStatus: 'unmarked' },
  ];
  const restore = stubAttendanceModels({
    scheduleRows: rows,
    enrollments: [
      { _id: 'enr-2', student: LUNA._id, enrollmentId: 'BB-2', status: 'approved', enrollmentDate: daysAgoISODate(20), packages: [{ programCode: 'TPG101', packageSlug: 'tpg-3', displayName: 'Toddlers Playgroup' }] },
    ],
    // Exactly 3 of 3 required sessions scheduled -> fully scheduled -> endDate is the
    // FUTURE date above, so it must NOT read "(finished)".
    pricing: [{ programCode: 'TPG101', packageSlug: 'tpg-3', sessionCount: 3 }],
  });
  try {
    const result = await buildTutorAttendanceContext('tutor-1', "Luna's attendance report");
    assert.doesNotMatch(result.fallbackReply, /\(finished\)/i);
    assert.match(result.fallbackReply, /fully scheduled, still ongoing/i);
    // The future session is not yet due — never auto-resolved to Absent.
    assert.match(result.fallbackReply, /present 1/i);
    assert.match(result.fallbackReply, /absent 1/i);
  } finally {
    restore();
  }
});

// ── ISSUE 6: admin scheduling-suggestion flow — name-matching consistency + real
//    tutor/day/time/student-filtered follow-ups, not a flat unfiltered list ───────────
//
// Real bugs from a live admin conversation transcript:
//
// a) Asked repeatedly about "aviery" (a real student, confirmed by a LATER correctly-
//    grounded turn in the same conversation), several earlier turns got a reply implying
//    no such student exists. Root cause was NOT the bare-first-name matching itself
//    (nameMatchesAnyPerson already handled that correctly) — it was that several natural
//    phrasings of the same question never reached buildAdminScheduleAvailabilityContext
//    at all: "pwedeng" (a common conjugation of "pwede") failed isScheduleAvailabilityQuestion's
//    word-boundary-strict match, and a name followed by a long trailing clause
//    ("...kay aviery pag mag start siya ng monday...") broke extractForPhrasesForScheduling's
//    old lookahead entirely, returning zero phrases. With nothing concrete to ground on,
//    Gemini continued from conversation history alone and invented a "no such student"
//    claim. Fixed by broadening both, AND by having buildAdminScheduleAvailabilityContext
//    always attempt the student lookup even when no tutor is named, so every reply
//    carries a REAL fact about the named student either way.
//
// b) "Sino ang available na tutor na pwede para kay [student]...Monday/Tuesday/Wednesday
//    ...8-9am...kung hindi available, bigyan mo ng tamang date" got a flat, completely
//    unfiltered tutor-roster list — the "sino...tutor" phrasing also satisfied the
//    simpler tutor-roster topic, which was checked first and won outright, even though
//    the question has real filtering criteria that topic has no way to apply. Fixed by
//    deferring the roster topic to schedule_availability whenever genuine scheduling-
//    filter signal is present, and extending the roster-availability builder to filter by
//    student + multiple days + an explicit time range together, with an earliest-
//    available-date fallback when none of the requested days work out.

const AVIERY = { _id: 'enr-aviery', status: 'approved', student: 'student-aviery', studentSnapshot: { firstName: 'Aviery', lastName: 'Soriano' }, packages: [{ programCode: 'ACT102', displayName: 'Academic Tutorial' }], preferredDaysByProgram: [], preferredSlots: [] };

test('ISSUE 6a: "pwedeng" (conjugated) is recognized the same as "pwede" — common Filipino word-boundary gap', () => {
  assert.equal(isScheduleAvailabilityQuestion('sinong pwedeng mag-fit sa 8 to 9 AM slot para kay Aviery'), true);
});

test('ISSUE 6a: extractForPhrasesForScheduling still captures a name even with a long trailing clause after it (the original failure mode)', () => {
  const normalized = 'base sa schedule preference ng parent sa nakuhang program ni aviery. pwede mo ba akong hanapan ng magandang time and date para makapag start kung sakali na may available na schedule and gusto ko sana 8to9am or 9to10 am ganun';
  assert.deepEqual(extractForPhrasesForScheduling(normalized), ['aviery']);
});

test('ISSUE 6a: extractForPhrasesForScheduling still gets the original "for X for Y in the morning" shape right (no regression)', () => {
  const normalized = 'what is available schedule for jake soriano for maria cruz in the morning';
  assert.deepEqual(extractForPhrasesForScheduling(normalized), ['jake soriano', 'maria cruz']);
});

test('ISSUE 6a: a bare-first-name scheduling question resolves the real student consistently, never a false "not found"', async () => {
  const restore = stubCommon({ tutors: [JAKE], enrollmentRows: [AVIERY] });
  try {
    // No tutor named, no literal "playgroup"/"academic tutorial" word — only the
    // student's own name plus a day, which must now be enough to ground a real answer.
    const result = await buildAdminScheduleAvailabilityContext('sino ang available na tutor kay aviery sa monday');
    assert.doesNotMatch(result.fallbackReply, /please tell me which tutor/i);
    assert.doesNotMatch(result.contextText, /no student record found/i);
  } finally {
    restore();
  }
});

test('ISSUE 6a: when truly no tutor name is given and the named student does not exist, the reply says so plainly (never silent)', async () => {
  const restore = stubCommon({ tutors: [JAKE], enrollmentRows: [] });
  try {
    const result = await buildAdminScheduleAvailabilityContext('pwede ba akong tulungan para kay ghostchild sa schedule niya');
    assert.match(result.fallbackReply, /could not find a student matching/i);
  } finally {
    restore();
  }
});

test('ISSUE 6b: detectGroundedTopic defers the tutor-roster topic to schedule_availability when real day/time filtering is present', () => {
  const msg = 'Sino ang available na tutor na pwede para kay aviery pag mag start siya ng monday, tuesday, at wednesday sa 8to9 am';
  assert.equal(isAdminTutorListQuestion(msg.toLowerCase()), true, 'still matches the simple roster pattern too');
  assert.equal(detectGroundedTopic(ADMIN, msg), 'schedule_availability', 'but the real scheduling-filter topic must win, not the flat roster list');
});

test('ISSUE 6b: detectGroundedTopic still answers a bare roster question ("ilan ang tutors") normally, unaffected', () => {
  assert.equal(detectGroundedTopic(ADMIN, 'ilan naman ang tutors at sino sino sila?'), 'tutors');
});

test('ISSUE 6b: extractAllDaysOfWeekFromMessage pulls every distinct day named, not just the first', () => {
  assert.deepEqual(extractAllDaysOfWeekFromMessage('monday, tuesday, at wednesday'), [1, 2, 3]);
  assert.deepEqual(extractAllDaysOfWeekFromMessage('walang araw dito'), []);
});

test('ISSUE 6b: a tutor+day+time+student-filtered roster question returns a REAL filtered answer, not the flat unfiltered tutor list', async () => {
  // part-time, not full-time — parseAvailability ignores the `availability` string
  // entirely for a full-time tutor (Mon-Sat 8AM-6PM is always assumed), so part-time is
  // required here to actually exercise each tutor's own distinct availability.
  const MARIANA = { _id: 'tutor-mariana', firstName: 'Mariana', lastName: 'Luis', employmentType: 'part-time', availability: 'Mon 8:00 AM - 9:00 AM' };
  const NICOLE = { _id: 'tutor-nicole', firstName: 'Nicole', lastName: 'Monzada', employmentType: 'part-time', availability: 'Tue 8:00 AM - 9:00 AM' };
  const JAKE_S = { _id: 'tutor-jakes', firstName: 'Jake', lastName: 'Soriano', employmentType: 'part-time', availability: '' }; // no real availability at all
  const restore = stubCommon({ tutors: [MARIANA, NICOLE, JAKE_S], enrollmentRows: [AVIERY], alreadyScheduled: false });
  try {
    const result = await buildAdminScheduleAvailabilityContext(
      'Sino ang available na tutor na pwede para kay aviery pag mag start siya ng monday, tuesday, at wednesday. sa 8to9 am kung hindi man available next week pwede ba na magbigay ka ng tamang date kung kailan siya pwede mag start sa time and date na yan base sa available na tutor'
    );
    // Real, filtered answer — only the tutors genuinely free at 8-9AM on one of the
    // requested days, not every active tutor's bare name.
    assert.match(result.fallbackReply, /Mariana Luis/);
    assert.match(result.fallbackReply, /Nicole Monzada/);
    assert.doesNotMatch(result.fallbackReply, /Jake Soriano/, 'this tutor has no real availability at all and must be excluded, unlike a flat roster list');
    assert.match(result.fallbackReply, /Aviery Soriano/i);
  } finally {
    restore();
  }
});

test('ISSUE 6b: when none of the specifically-requested days work, a real earliest-available-date fallback is given instead of silence', async () => {
  // Tutor is only free on Thursday — none of Mon/Tue/Wed (the requested days) work.
  const THU_ONLY = { _id: 'tutor-thu', firstName: 'Thu', lastName: 'Tutor', employmentType: 'part-time', availability: 'Thu 8:00 AM - 9:00 AM' };
  const restore = stubCommon({ tutors: [THU_ONLY], enrollmentRows: [AVIERY], alreadyScheduled: false });
  try {
    const result = await buildAdminScheduleAvailabilityContext(
      'sino ang available na tutor para kay aviery sa monday, tuesday, at wednesday sa 8to9 am'
    );
    assert.match(result.fallbackReply, /earliest real open date/i);
    assert.match(result.fallbackReply, /Thu Tutor/);
  } finally {
    restore();
  }
});

// ── ISSUE 7: the ML classifier's generic "attendance" intent shortcut was winning over
//    the real grounded per-student report whenever it predicted student_attendance/
//    attendance_history, even when a specific ASSIGNED student was actually named in
//    plain lowercase chat text ("...ni leo") — which extractAttendanceNameCandidate can't
//    catch (Title-Case only). "pwede mo ba ako gawaang report sa attendance ni leo"
//    happened to score a DIFFERENT (or no) classifier intent and so fell through to the
//    real grounded pipeline correctly; "gusto ko makita ang over all attendance ni leo"
//    scored the generic intent and got the static "mark it yourself" deflection instead
//    — same underlying capability, inconsistent answers purely by classifier luck. This
//    route is deliberately DB-free (see task34-classifier-batch3.test.js's own "no DB
//    access" test), so the fix reuses the SAME pure "for/kay/ni NAME" phrase extractor
//    the admin scheduling topic already has (extractForPhrasesForScheduling), filtering
//    out generic non-name phrases ("my student") via a small stopword check, and defers
//    (returns null, so the real grounded pipeline — which DOES do a real roster check —
//    runs instead) whenever a plausible name is present. ──────────────────────────────

test('ISSUE 7: a lowercase phrasing naming a real student ("ni leo") defers to the real grounded report (classifier shortcut skipped)', async () => {
  const restoreFetch = stubFetch(predictionResponse('student_attendance', 0.95));
  try {
    const reply = await tryClassifierShortcut(
      { user: { _id: 'tutor-1', role: 'tutor' } },
      'gusto ko makita ang over all attendance ni leo',
      []
    );
    assert.equal(reply, null, 'must defer to the real grounded pipeline, not the static deflection');
  } finally {
    restoreFetch();
  }
});

test('ISSUE 7: the OTHER originally-reported phrasing ("kay leo", with a long trailing clause) also defers', async () => {
  const restoreFetch = stubFetch(predictionResponse('student_attendance', 0.95));
  try {
    const reply = await tryClassifierShortcut(
      { user: { _id: 'tutor-1', role: 'tutor' } },
      'how about kay leo gusto ko makita over all attendance nito',
      []
    );
    assert.equal(reply, null);
  } finally {
    restoreFetch();
  }
});

test('ISSUE 7: a generic question naming NO real student ("my student") still returns the static reply — no DB access, matches the existing invariant', async () => {
  const restoreFetch = stubFetch(predictionResponse('student_attendance', 0.95));
  const origScheduleFind = Schedule.find;
  Schedule.find = () => { throw new Error('this route must never touch the DB'); };
  try {
    const reply = await tryClassifierShortcut(
      { user: { _id: 'tutor-1', role: 'tutor' } },
      'attendance history for my student',
      []
    );
    assert.match(reply, /Attendance tab/i);
  } finally {
    Schedule.find = origScheduleFind;
    restoreFetch();
  }
});

test('ISSUE 7: a non-tutor role is unaffected (always the static reply)', async () => {
  const restoreFetch = stubFetch(predictionResponse('student_attendance', 0.95));
  const reply = await tryClassifierShortcut({ user: { _id: 'parent-1', role: 'parent' } }, "what is leo's overall attendance", []);
  try {
    assert.match(reply, /recorded automatically/i);
  } finally {
    restoreFetch();
  }
});

// ── ISSUE 8: the roster-wide (no-tutor-named) availability reply must carry a real
//    calendar date with every weekday it mentions, not just the bare weekday name — the
//    actual text the admin sees (fallbackReply), not only the Gemini-grounding context.
test('ISSUE 8: the roster-availability summary names a real calendar date for every weekday, not just the bare weekday', async () => {
  const MARIANA = { _id: 'tutor-mariana', firstName: 'Mariana', lastName: 'Luis', employmentType: 'part-time', availability: 'Wed 8:00 AM - 9:00 AM' };
  const restore = stubCommon({ tutors: [MARIANA], enrollmentRows: [AVIERY] });
  try {
    const result = await buildAdminScheduleAvailabilityContext('sinong pwedeng mag-fit sa 8 to 9 AM slot para kay Aviery. at anong date ito mag i-start kung sakali?');
    assert.match(result.fallbackReply, /Mariana Luis/);
    // A real, full "Weekday, Month Day, Year" date must appear, not just "Wed".
    assert.match(result.fallbackReply, /(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/);
  } finally {
    restore();
  }
});

const LEO = { _id: 'student-leo', firstName: 'Leo', lastName: 'Soriano' };

// Direct re-check of the reported Leo Soriano example (8-session Toddlers Playgroup
// program, "Present: 2, Absent: 3, Unmarked: 3"): confirms a mix of explicit-present,
// explicit-absent, long-overdue-unmarked (must auto-resolve to Absent), still-within-
// grace-unmarked, and future-unmarked sessions are all tallied correctly and
// independently in one report — not just the single-session cases covered above.
test('ISSUE 5 (Leo re-check): a mixed 8-session report correctly separates real present/absent, auto-absent, and genuinely-still-unmarked sessions', async () => {
  const rows = [
    { _id: 's1', tutor: 'tutor-1', tutors: [], student: LEO, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: daysAgoISODate(15), attendanceStatus: 'present' },
    { _id: 's2', tutor: 'tutor-1', tutors: [], student: LEO, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: daysAgoISODate(8), attendanceStatus: 'present' },
    { _id: 's3', tutor: 'tutor-1', tutors: [], student: LEO, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: daysAgoISODate(11), attendanceStatus: 'absent' },
    { _id: 's4', tutor: 'tutor-1', tutors: [], student: LEO, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: daysAgoISODate(5), attendanceStatus: 'unmarked' }, // overdue -> Absent
    { _id: 's5', tutor: 'tutor-1', tutors: [], student: LEO, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: daysAgoISODate(4), attendanceStatus: 'unmarked' }, // overdue -> Absent
    { _id: 's6', tutor: 'tutor-1', tutors: [], student: LEO, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: daysAgoISODate(1), attendanceStatus: 'unmarked' }, // within grace -> stays unmarked
    { _id: 's7', tutor: 'tutor-1', tutors: [], student: LEO, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: daysFromNowISODate(3), attendanceStatus: 'unmarked' }, // future -> stays unmarked
    { _id: 's8', tutor: 'tutor-1', tutors: [], student: LEO, students: [], subject: { code: 'TPG101', name: 'Toddlers Playgroup' }, date: daysFromNowISODate(7), attendanceStatus: 'unmarked' }, // future -> stays unmarked
  ];
  const restore = stubAttendanceModels({
    scheduleRows: rows,
    enrollments: [
      { _id: 'enr-leo', student: LEO._id, enrollmentId: 'BB-LEO', status: 'approved', enrollmentDate: daysAgoISODate(20), packages: [{ programCode: 'TPG101', packageSlug: 'tpg-8', displayName: 'Toddlers Playgroup' }] },
    ],
    pricing: [{ programCode: 'TPG101', packageSlug: 'tpg-8', sessionCount: 8 }],
  });
  try {
    const result = await buildTutorAttendanceContext('tutor-1', 'pwede mo ba ako gawaang report sa attendance ni leo');
    assert.match(result.contextText, /Present: 2/);
    assert.match(result.contextText, /Absent: 3/, 'the 2 long-overdue unmarked sessions must now be counted as Absent, alongside the 1 explicitly marked Absent');
    assert.match(result.contextText, /Unmarked: 3/, 'only the genuinely still-undecided sessions (1 within grace + 2 future) remain Unmarked');
  } finally {
    restore();
  }
});
