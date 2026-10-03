/**
 * Batch 13 — the "tutor_students" dataset reply ("Your assigned students are {studentList}.",
 * triggered by "who are my students" / "assigned students" / etc.) used to run its own
 * Schedule.distinct('student', { tutor: user._id }) query, which only reads the singular
 * `tutor`/`student` fields on a Schedule doc. Group sessions (Toddlers Playgroup, multi-tutor
 * sessions) store their people in the plural `tutors`/`students` array fields instead, so a
 * tutor with students assigned only through those fields was missing from the list — live QA
 * testing found a tutor assigned to 4 students (per the Remarks-tab disambiguation, which
 * already used the correct, broader getTutorStudents helper) told "Your assigned students are
 * Portia Latina." (just 1) when asked the exact same question through this dataset path.
 *
 * Fix: reuse getTutorStudents (already correct — reads both singular and plural fields)
 * instead of a second, narrower, duplicate query.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Schedule = require('../models/Schedule');
const { getIntentKeywordDatasetReply } = require('../controllers/aiController');

function mockQuery(result) {
  const q = {
    populate: () => q,
    sort: () => q,
    select: () => q,
    lean: () => Promise.resolve(result),
  };
  return q;
}

const TUTOR = { _id: 't1', role: 'tutor' };

test('tutor_students dataset reply lists every student, including ones only assigned via group-session plural fields', async () => {
  const orig = Schedule.find;
  Schedule.find = () => mockQuery([
    // A solo Academic Tutorial session — singular `tutor`/`student` fields.
    {
      tutor: 't1',
      tutors: [],
      student: { _id: 's-portia', firstName: 'Portia', lastName: 'Latina' },
      students: [],
    },
    // A Toddlers Playgroup group session — plural `tutors`/`students` fields only.
    {
      tutor: null,
      tutors: ['t1'],
      student: null,
      students: [
        { _id: 's-haumea', firstName: 'Haumea', lastName: 'Azutillo' },
        { _id: 's-hera', firstName: 'Hera', lastName: 'Azutillo' },
        { _id: 's-hermes', firstName: 'Hermes', lastName: 'Azutillo' },
      ],
    },
  ]);

  try {
    const reply = await getIntentKeywordDatasetReply(TUTOR, 'who are my assigned students', 'english');
    assert.match(reply, /Portia Latina/);
    assert.match(reply, /Haumea Azutillo/);
    assert.match(reply, /Hera Azutillo/);
    assert.match(reply, /Hermes Azutillo/);
  } finally {
    Schedule.find = orig;
  }
});

test('tutor_students dataset reply: no assigned students at all', async () => {
  const orig = Schedule.find;
  Schedule.find = () => mockQuery([]);
  try {
    const reply = await getIntentKeywordDatasetReply(TUTOR, 'who are my assigned students', 'english');
    assert.match(reply, /no assigned students/i);
  } finally {
    Schedule.find = orig;
  }
});

test('tutor_students dataset reply: non-tutor role is unavailable, not a student list', async () => {
  const reply = await getIntentKeywordDatasetReply({ _id: 's1', role: 'student' }, 'who are my assigned students', 'english');
  // A student asking this phrasing either gets null (no rule matched for their role) or the
  // role-gated "unavailable" reply — never a student list (tutor_students is roleScope: 'tutor').
  if (reply !== null) {
    assert.doesNotMatch(reply, /assigned students are/i);
  }
});
