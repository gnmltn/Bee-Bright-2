/**
 * Certificate feature, part 6 — admin "2 sessions left" reminder email. No existing DB
 * connection is needed; everything is model/service-stubbed, same convention as
 * test/certificates.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Enrollment = require('../models/Enrollment');
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const emailService = require('../utils/emailService');
const { runSessionReminderCheck, SESSIONS_REMAINING_THRESHOLD } = require('../utils/sessionReminderScheduler');

function mockQuery(result) {
  const q = {
    select: () => q,
    populate: () => q,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

const SUBJECT_ACT102 = { code: 'ACT102', name: 'Academic Tutorial' };
const TODAY = new Date();
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000);
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000);

function stubModels({ enrollments, schedules, admins = [{ email: 'admin@beebright.test' }] } = {}) {
  const origEnrollmentFind = Enrollment.find;
  const origEnrollmentUpdateOne = Enrollment.updateOne;
  const origScheduleFind = Schedule.find;
  const origUserFind = User.find;
  const origSendEmail = emailService.sendEmail;

  const updateOneCalls = [];
  const sentEmails = [];

  Enrollment.find = () => mockQuery(enrollments);
  Enrollment.updateOne = async (filter, update) => {
    updateOneCalls.push({ filter, update });
    const e = enrollments.find((en) => String(en._id) === String(filter._id));
    if (e) {
      e.sessionReminderSentPrograms = e.sessionReminderSentPrograms || [];
      for (const code of update.$addToSet ? [update.$addToSet.sessionReminderSentPrograms] : []) {
        if (!e.sessionReminderSentPrograms.includes(code)) e.sessionReminderSentPrograms.push(code);
      }
    }
    return { acknowledged: true };
  };
  // Mirrors the real query's date:{$gte: today} filter — the controller relies on the
  // DB to have already excluded past sessions, so the stub must do the same for the
  // "only upcoming counts" test to actually exercise that behavior.
  Schedule.find = (query) => {
    const minDate = query?.date?.$gte;
    const rows = minDate ? schedules.filter((s) => new Date(s.date).getTime() >= new Date(minDate).getTime()) : schedules;
    return mockQuery(rows);
  };
  User.find = () => mockQuery(admins);
  emailService.sendEmail = async (message) => { sentEmails.push(message); return { sandboxed: true }; };

  return {
    updateOneCalls,
    sentEmails,
    restore() {
      Enrollment.find = origEnrollmentFind;
      Enrollment.updateOne = origEnrollmentUpdateOne;
      Schedule.find = origScheduleFind;
      User.find = origUserFind;
      emailService.sendEmail = origSendEmail;
    },
  };
}

function enrollment(overrides = {}) {
  return {
    _id: 'enr-1',
    student: 'student-1',
    studentSnapshot: { firstName: 'Ana', lastName: 'Cruz' },
    packages: [{ programCode: 'ACT102' }],
    sessionReminderSentPrograms: [],
    ...overrides,
  };
}

test(`fires exactly once when a student has ${SESSIONS_REMAINING_THRESHOLD} upcoming sessions left in a program`, async () => {
  const schedules = [
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
  ];
  const { restore, sentEmails, updateOneCalls } = stubModels({ enrollments: [enrollment()], schedules });
  try {
    await runSessionReminderCheck();
    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].subject, /Ana Cruz/);
    assert.match(sentEmails[0].subject, /ACT102/);
    assert.equal(updateOneCalls.length, 1);
    assert.equal(updateOneCalls[0].update.$addToSet.sessionReminderSentPrograms, 'ACT102');
  } finally { restore(); }
});

test('does not fire when the remaining count is not exactly the threshold', async () => {
  const schedules = [
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
  ];
  const { restore, sentEmails } = stubModels({ enrollments: [enrollment()], schedules });
  try {
    await runSessionReminderCheck();
    assert.equal(sentEmails.length, 0, '3 remaining must not trigger the 2-remaining reminder');
  } finally { restore(); }
});

test('only counts UPCOMING sessions — past sessions are ignored even if they push the total above the threshold', async () => {
  const schedules = [
    // 5 already-past sessions for this program...
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: YESTERDAY },
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: YESTERDAY },
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: YESTERDAY },
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: YESTERDAY },
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: YESTERDAY },
    // ...but only 2 upcoming.
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
  ];
  const { restore, sentEmails } = stubModels({ enrollments: [enrollment()], schedules });
  try {
    await runSessionReminderCheck();
    assert.equal(sentEmails.length, 1, 'only the 2 UPCOMING sessions should count toward the threshold');
  } finally { restore(); }
});

test('never fires twice for the same enrollment + program', async () => {
  const schedules = [
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
  ];
  const e = enrollment({ sessionReminderSentPrograms: ['ACT102'] });
  const { restore, sentEmails } = stubModels({ enrollments: [e], schedules });
  try {
    await runSessionReminderCheck();
    assert.equal(sentEmails.length, 0, 'already notified for ACT102 — must not send again');
  } finally { restore(); }
});

test('a second run after the first does not send a duplicate email for the same program', async () => {
  const schedules = [
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
  ];
  const e = enrollment();
  const { restore, sentEmails } = stubModels({ enrollments: [e], schedules });
  try {
    await runSessionReminderCheck();
    assert.equal(sentEmails.length, 1);
    await runSessionReminderCheck();
    assert.equal(sentEmails.length, 1, 'the in-memory enrollment now carries ACT102 in sessionReminderSentPrograms — must not fire again');
  } finally { restore(); }
});

test('multiple programs on one enrollment are checked independently', async () => {
  const SUBJECT_EXP106 = { code: 'EXP106', name: 'Examination Preparation' };
  const schedules = [
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
    { student: 'student-1', students: [], subject: SUBJECT_EXP106, date: TOMORROW },
  ];
  const e = enrollment({ packages: [{ programCode: 'ACT102' }, { programCode: 'EXP106' }] });
  const { restore, sentEmails } = stubModels({ enrollments: [e], schedules });
  try {
    await runSessionReminderCheck();
    assert.equal(sentEmails.length, 1, 'only ACT102 (exactly 2 remaining) should trigger — EXP106 has only 1');
    assert.match(sentEmails[0].subject, /ACT102/);
  } finally { restore(); }
});

test('no admin recipients configured — never throws, skips sending, and does NOT mark the program as sent (so it can retry later)', async () => {
  const schedules = [
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
    { student: 'student-1', students: [], subject: SUBJECT_ACT102, date: TOMORROW },
  ];
  const { restore, sentEmails, updateOneCalls } = stubModels({ enrollments: [enrollment()], schedules, admins: [] });
  try {
    await assert.doesNotReject(runSessionReminderCheck());
    assert.equal(sentEmails.length, 0);
    assert.equal(updateOneCalls.length, 0, 'must not be marked "already notified" when nobody was actually notified');
  } finally { restore(); }
});
