/**
 * "bug (14).pdf" Group 2 — the "My Students"/"Assigned Students" mail icon on the tutor
 * dashboard linked to `mailto:child.<id>@students.beebright.internal`, the same permanent
 * placeholder address identified as the root cause of the Group AS announcement-email bug
 * (see scheduleController.js's resolveOrCreateStudentUser) — never the real, deliverable
 * PARENT email.
 *
 * Fix: getMyStudentCards (the data source for both the "My Students" cards grid and the
 * "Assigned Students" panel's parent-contact lookup) now also resolves each child's real
 * parent via Enrollment (same pattern as announcementController.js's notifyParentsOfStudents)
 * and returns parentEmail/parentName alongside each card.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Schedule = require('../models/Schedule');
const Enrollment = require('../models/Enrollment');
const { getMyStudentCards } = require('../controllers/scheduleController');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}
function mockQuery(result) {
  const q = {
    select: () => q, sort: () => q, populate: () => q, lean: () => q,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch: (fn) => Promise.resolve(result).catch(fn),
  };
  return q;
}

test('getMyStudentCards: resolves each student\'s real PARENT email/name via Enrollment, never the placeholder student-account address', async () => {
  const origScheduleFind = Schedule.find;
  const origEnrollmentFind = Enrollment.find;

  Schedule.find = () => mockQuery([
    {
      student: { _id: 'student-1', firstName: 'Ana', lastName: 'Cruz' },
      students: [],
      subject: { name: 'Academic Tutorial', code: 'ACT102' },
      date: new Date(),
      startTime: '09:00',
      endTime: '10:00',
    },
  ]);
  Enrollment.find = () => mockQuery([
    {
      student: 'student-1',
      permanentStudentId: 'BB-20260101-0001',
      enrollmentId: 'BB-20260101-0001',
      packages: [{ programCode: 'ACT102', displayName: 'Academic Tutorial' }],
      parent: { firstName: 'Rosa', lastName: 'Cruz', email: 'rosa.cruz@real-parent.test' },
    },
  ]);

  try {
    const res = mockRes();
    await getMyStudentCards({ user: { id: 'tutor-1', role: 'tutor' } }, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.students.length, 1);
    const card = res._body.students[0];
    assert.equal(card.parentEmail, 'rosa.cruz@real-parent.test');
    assert.equal(card.parentName, 'Rosa Cruz');
    assert.ok(!String(card.parentEmail).includes('students.beebright.internal'));
  } finally {
    Schedule.find = origScheduleFind;
    Enrollment.find = origEnrollmentFind;
  }
});

test('getMyStudentCards: a student with no approved/active Enrollment on file gets a null parent contact, not a crash', async () => {
  const origScheduleFind = Schedule.find;
  const origEnrollmentFind = Enrollment.find;

  Schedule.find = () => mockQuery([
    {
      student: { _id: 'student-2', firstName: 'Ben', lastName: 'Diaz' },
      students: [],
      subject: { name: 'Academic Tutorial', code: 'ACT102' },
      date: new Date(),
      startTime: '09:00',
      endTime: '10:00',
    },
  ]);
  Enrollment.find = () => mockQuery([]);

  try {
    const res = mockRes();
    await getMyStudentCards({ user: { id: 'tutor-1', role: 'tutor' } }, res);

    assert.equal(res._status, 200);
    const card = res._body.students[0];
    assert.equal(card.parentEmail, null);
    assert.equal(card.parentName, null);
  } finally {
    Schedule.find = origScheduleFind;
    Enrollment.find = origEnrollmentFind;
  }
});
