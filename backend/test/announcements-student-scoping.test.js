/**
 * ChildSelector_AddChildModal_TutorRemarksView.pdf A — a parent's own account id
 * never matches Announcement.targetStudentIds (those are keyed by the CHILD's own
 * studentUserId), so getForStudent must accept ?studentId= for a parent caller and
 * use that to resolve student-specific announcements, instead of always using the
 * caller's own id.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const auditService = require('../utils/auditService');
auditService.logAudit = async () => {};

const Announcement = require('../models/Announcement');
const Enrollment = require('../models/Enrollment');
const { getForStudent } = require('../controllers/announcementController');

function mockRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => { res._status = c; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

test('getForStudent: a student caller still resolves announcements by their own id (unchanged)', async () => {
  const origFind = Announcement.find;
  let capturedFilter = null;
  Announcement.find = (filter) => {
    capturedFilter = filter;
    return { sort: () => ({ populate: () => ({ lean: async () => [] }) }) };
  };
  try {
    const res = mockRes();
    const studentId = '507f1f77bcf86cd799439022';
    await getForStudent({ user: { id: studentId, role: 'student' }, query: {} }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const matchedId = capturedFilter.$or.find((o) => o.targetStudentIds)?.targetStudentIds?.toString();
    assert.equal(matchedId, studentId);
  } finally { Announcement.find = origFind; }
});

test('getForStudent: a parent WITHOUT ?studentId= only sees targetType:"all" announcements, never their own account id', async () => {
  const origFind = Announcement.find;
  let capturedFilter = null;
  Announcement.find = (filter) => {
    capturedFilter = filter;
    return { sort: () => ({ populate: () => ({ lean: async () => [] }) }) };
  };
  try {
    const res = mockRes();
    await getForStudent({ user: { id: 'parent-1', _id: 'parent-1', role: 'parent' }, query: {} }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.deepEqual(capturedFilter.$or, [{ targetType: 'all' }], 'must not fall back to matching the parent\'s own id against targetStudentIds');
  } finally { Announcement.find = origFind; }
});

test('getForStudent: a parent WITH ?studentId= for a child they own resolves announcements targeted at that child', async () => {
  const origFind = Announcement.find;
  const origExists = Enrollment.exists;
  let capturedFilter = null;
  Announcement.find = (filter) => {
    capturedFilter = filter;
    return { sort: () => ({ populate: () => ({ lean: async () => [] }) }) };
  };
  Enrollment.exists = async () => true;
  try {
    const res = mockRes();
    const childId = '507f1f77bcf86cd799439011';
    await getForStudent({ user: { id: 'parent-1', _id: 'parent-1', role: 'parent' }, query: { studentId: childId } }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const hasChildMatch = capturedFilter.$or.some((o) => o.targetStudentIds && o.targetStudentIds.toString() === childId);
    assert.ok(hasChildMatch, 'must filter by the selected child\'s own id, not the parent\'s');
  } finally { Announcement.find = origFind; Enrollment.exists = origExists; }
});

test('getForStudent: a parent WITH ?studentId= for a child they do NOT own is rejected', async () => {
  const origExists = Enrollment.exists;
  Enrollment.exists = async () => false;
  try {
    const res = mockRes();
    await getForStudent({ user: { id: 'parent-1', _id: 'parent-1', role: 'parent' }, query: { studentId: '507f1f77bcf86cd799439099' } }, res);
    assert.equal(res._status, 403);
  } finally { Enrollment.exists = origExists; }
});

test('getForStudent: admin-authored announcements always show the author as "Bee Bright Admin"; tutor-authored keep the tutor', async () => {
  const origFind = Announcement.find;
  const rows = [
    { _id: 'a1', authorRole: 'admin', author: { firstName: 'Super', lastName: 'Admin' }, title: 'Holiday' },
    { _id: 'a2', authorRole: 'tutor', author: { firstName: 'Tina', lastName: 'Reyes' }, title: 'Quiz' },
  ];
  Announcement.find = () => ({ sort: () => ({ populate: () => ({ lean: async () => rows }) }) });
  try {
    const res = mockRes();
    await getForStudent({ user: { id: '507f1f77bcf86cd799439022', role: 'student' }, query: {} }, res);
    assert.equal(res._status, 200);
    const [admin, tutor] = res._body.announcements;
    assert.deepEqual(admin.author, { firstName: 'Bee Bright', lastName: 'Admin' });
    assert.deepEqual(tutor.author, { firstName: 'Tina', lastName: 'Reyes' });
  } finally { Announcement.find = origFind; }
});
