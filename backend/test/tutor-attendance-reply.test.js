/**
 * Batch 11 — getAttendanceReply() is the role-agnostic fallback used whenever no more
 * specific attendance handler/dataset entry matches. Live QA testing found ~20 distinct
 * tutor-phrased attendance questions all falling through to this one generic reply, which
 * told the TUTOR "your attendance is recorded automatically during class sessions" — true
 * for a student/parent (who only view it), false for a tutor (who manually marks it via
 * the Attendance tab). Every tester Note on every one of those questions flagged exactly
 * this. Fixed by making the reply role-aware instead of adding any new DB-backed feature
 * (mark_attendance stays deliberately unwired, per the existing Task 34 decision).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { getAttendanceReply } = require('../controllers/aiController');

test('getAttendanceReply: tutor gets the manual-marking text, never "automatic"', () => {
  const reply = getAttendanceReply('english', {}, 'tutor');
  assert.match(reply, /Attendance tab/i);
  assert.match(reply, /mark/i);
  assert.doesNotMatch(reply, /recorded automatically/i);
});

test('getAttendanceReply: student/parent/no-role keep the original "view only" text', () => {
  for (const role of ['student', 'parent', 'admin', undefined, '']) {
    const reply = getAttendanceReply('english', {}, role);
    assert.match(reply, /recorded automatically/i, `role=${role}`);
  }
});

test('getAttendanceReply: tutor step-by-step variant is also corrected', () => {
  const reply = getAttendanceReply('english', { wantsStepByStep: true }, 'tutor');
  assert.match(reply, /Mark Attendance/i);
  assert.match(reply, /Attendance tab/i);
  assert.doesNotMatch(reply, /recorded automatically/i);
  assert.match(reply, /not automatic/i);
});

test('getAttendanceReply: tutor summary variant is also corrected', () => {
  const reply = getAttendanceReply('english', { wantsSummary: true }, 'tutor');
  assert.match(reply, /Attendance tab/i);
  assert.doesNotMatch(reply, /recorded automatically/i);
});

test('getAttendanceReply: Filipino tutor replies also avoid "automatic"', () => {
  const reply = getAttendanceReply('filipino', {}, 'tutor');
  assert.match(reply, /Attendance tab/i);
  assert.doesNotMatch(reply, /[Aa]utomatic na nire-record/);
});

test('getAttendanceReply: non-tutor Filipino replies are unchanged', () => {
  const reply = getAttendanceReply('filipino', {}, 'parent');
  assert.match(reply, /Automatic na nire-record/);
});
