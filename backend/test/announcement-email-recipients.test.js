/**
 * "bug (13).pdf" Group AS — announcement notification emails were silently bouncing off
 * "child.<id>@students.beebright.internal", the internal placeholder every `role:'student'`
 * User account's own `.email` field always holds (see scheduleController.js's
 * resolveOrCreateStudentUser). Both createAnnouncement's admin branch and
 * approveAnnouncement queried `role:'student'` User docs directly and emailed THAT
 * placeholder address — no parent or tutor was ever actually reachable.
 *
 * Fix: admin announcements now email every real PARENT + TUTOR account directly (their own
 * real registered email). Tutor announcements (sent on admin approval) now resolve each
 * targeted student's real PARENT via Enrollment, one email per parent, deduped. A tutor can
 * also no longer target a student they don't actually handle (group-aware roster check).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const emailService = require('../utils/emailService');
const capturedEmails = [];
// announcementController.js destructures `sendAnnouncementEmail` from this module at ITS
// OWN require-time (`const { sendAnnouncementEmail } = require(...)`), which captures
// whatever this property is AT THAT MOMENT as a plain function reference — reassigning it
// later (e.g. inside a test, after the controller is already required) would silently not
// affect what the controller actually calls. Must be set before requiring the controller
// below, same gotcha as scheduleController.js's own destructured `sendEmail` import.
emailService.sendAnnouncementEmail = async (to, recipientName, title, body, category) => {
  capturedEmails.push({ to, recipientName, title, body, category });
  return true;
};

const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const Announcement = require('../models/Announcement');
const User = require('../models/User');
const Schedule = require('../models/Schedule');
const Enrollment = require('../models/Enrollment');
const { createAnnouncement, approveAnnouncement, getMyStudents } = require('../controllers/announcementController');

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

test('createAnnouncement (admin): emails every real parent + tutor at THEIR OWN email, never a student\'s placeholder address', async () => {
  capturedEmails.length = 0;
  const origAnnCreate = Announcement.create;
  const origAnnFindById = Announcement.findById;
  const origUserFind = User.find;

  const created = { _id: 'ann-1', title: 'Holiday', body: 'No classes Monday', category: 'holiday', save: async function () { return this; } };
  Announcement.create = async () => created;
  Announcement.findById = () => mockQuery(created);

  const parents = [{ _id: 'parent-1', email: 'parent1@example.com', firstName: 'Maria', lastName: 'Cruz' }];
  const tutors = [{ _id: 'tutor-1', email: 'tutor1@example.com', firstName: 'Jake', lastName: 'Soriano' }];
  User.find = (filter) => mockQuery(filter.role === 'parent' ? parents : filter.role === 'tutor' ? tutors : []);

  try {
    const res = mockRes();
    await createAnnouncement({
      user: { id: 'admin-1', role: 'admin' },
      body: { title: 'Holiday', body: 'No classes Monday', category: 'holiday', targetType: 'all' },
    }, res);
    assert.equal(res._status, 201, JSON.stringify(res._body));

    const toParent = capturedEmails.find((e) => e.to === 'parent1@example.com');
    const toTutor = capturedEmails.find((e) => e.to === 'tutor1@example.com');
    assert.ok(toParent, 'expected the real parent to be emailed');
    assert.ok(toTutor, 'expected the real tutor to be emailed');
    const toPlaceholder = capturedEmails.find((e) => String(e.to).includes('students.beebright.internal'));
    assert.equal(toPlaceholder, undefined, 'must never send to the internal student placeholder domain');
  } finally {
    Announcement.create = origAnnCreate;
    Announcement.findById = origAnnFindById;
    User.find = origUserFind;
  }
});

test('createAnnouncement (tutor): rejects targeting a student the tutor does not actually handle', async () => {
  const origSchedFind = Schedule.find;
  Schedule.find = () => mockQuery([]); // empty roster — tutor handles nobody
  try {
    const res = mockRes();
    await createAnnouncement({
      user: { id: 'tutor-1', role: 'tutor' },
      body: { title: 'Quiz', body: 'Bring pencils', category: 'quiz', targetType: 'specific_students', targetStudentIds: ['kid-not-mine'] },
    }, res);
    assert.equal(res._status, 403, JSON.stringify(res._body));
  } finally { Schedule.find = origSchedFind; }
});

test('approveAnnouncement: emails only the targeted students\' REAL parents (via Enrollment), one email per parent, never a student\'s placeholder', async () => {
  capturedEmails.length = 0;
  const origAnnFindById = Announcement.findById;
  const origEnrollFind = Enrollment.find;

  const ann = {
    _id: 'ann-2', status: 'pending', title: 'Reschedule', body: 'Moved to Friday', category: 'reschedule',
    targetStudentIds: ['kid-1', 'kid-2'],
    save: async function () { return this; },
  };
  let callCount = 0;
  Announcement.findById = () => {
    callCount += 1;
    // First call = the live doc being approved; second (populated re-fetch) just needs to
    // support the same chain.
    return mockQuery(ann);
  };
  const enrollments = [
    { student: 'kid-1', parent: { _id: 'parent-1', email: 'carla@example.com', firstName: 'Carla', lastName: 'Cruz' } },
    { student: 'kid-2', parent: { _id: 'parent-2', email: 'david@example.com', firstName: 'David', lastName: 'Santos' } },
  ];
  Enrollment.find = () => mockQuery(enrollments);

  try {
    const res = mockRes();
    await approveAnnouncement({ params: { id: '507f1f77bcf86cd799439201' }, user: { id: 'admin-1' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));

    assert.equal(capturedEmails.length, 2, 'exactly one email per targeted child\'s own parent');
    assert.ok(capturedEmails.find((e) => e.to === 'carla@example.com'));
    assert.ok(capturedEmails.find((e) => e.to === 'david@example.com'));
    const toPlaceholder = capturedEmails.find((e) => String(e.to).includes('students.beebright.internal'));
    assert.equal(toPlaceholder, undefined, 'must never send to a student\'s own placeholder address');
  } finally {
    Announcement.findById = origAnnFindById;
    Enrollment.find = origEnrollFind;
  }
});

test('approveAnnouncement: a parent with TWO targeted children in the same announcement only gets ONE email', async () => {
  capturedEmails.length = 0;
  const origAnnFindById = Announcement.findById;
  const origEnrollFind = Enrollment.find;

  const ann = {
    _id: 'ann-3', status: 'pending', title: 'Exam', body: 'Exam week', category: 'exam',
    targetStudentIds: ['kid-1', 'kid-3'],
    save: async function () { return this; },
  };
  Announcement.findById = () => mockQuery(ann);
  const sameParent = { _id: 'parent-1', email: 'carla@example.com', firstName: 'Carla', lastName: 'Cruz' };
  const enrollments = [
    { student: 'kid-1', parent: sameParent },
    { student: 'kid-3', parent: sameParent }, // same parent, a sibling
  ];
  Enrollment.find = () => mockQuery(enrollments);

  try {
    const res = mockRes();
    await approveAnnouncement({ params: { id: '507f1f77bcf86cd799439202' }, user: { id: 'admin-1' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const toCarla = capturedEmails.filter((e) => e.to === 'carla@example.com');
    assert.equal(toCarla.length, 1, 'a parent of two targeted siblings must only be emailed once');
  } finally {
    Announcement.findById = origAnnFindById;
    Enrollment.find = origEnrollFind;
  }
});

test('getMyStudents: group-aware — includes a Playgroup tutor\'s co-tutor roster (tutors[]/students[]), not just the singular tutor/student fields', async () => {
  const origSchedFind = Schedule.find;
  const origUserFind = User.find;
  Schedule.find = () => mockQuery([
    { student: null, students: ['kid-1', 'kid-2'] }, // Playgroup session, this tutor is a co-tutor
  ]);
  const students = [
    { _id: 'kid-1', firstName: 'Ana', lastName: 'Cruz', email: 'child.enr-1@students.beebright.internal' },
    { _id: 'kid-2', firstName: 'Ben', lastName: 'Santos', email: 'child.enr-2@students.beebright.internal' },
  ];
  User.find = () => mockQuery(students);
  try {
    const res = mockRes();
    await getMyStudents({ user: { id: 'tutor-1' } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.students.length, 2, 'a Playgroup co-tutor\'s students must appear in the picker roster');
  } finally { Schedule.find = origSchedFind; User.find = origUserFind; }
});
