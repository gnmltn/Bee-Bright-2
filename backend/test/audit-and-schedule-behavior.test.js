const test = require('node:test');
const assert = require('node:assert/strict');
const { isHiddenAuditAction } = require('../controllers/auditController');
const { timeRangesOverlap, getMinutesSinceMidnight, getSessionEndTime } = require('../controllers/scheduleController');

test('hides login/logout style audit actions', () => {
  assert.equal(isHiddenAuditAction('Login'), true);
  assert.equal(isHiddenAuditAction('Admin Login MFA'), true);
  assert.equal(isHiddenAuditAction('Logout'), true);
  assert.equal(isHiddenAuditAction('Add Tutor'), false);
});

test('detects overlapping time ranges correctly', () => {
  assert.equal(timeRangesOverlap('09:00', '11:00', '10:00', '12:00'), true);
  assert.equal(timeRangesOverlap('09:00', '10:00', '10:00', '11:00'), false);
  assert.equal(timeRangesOverlap('09:00', '11:00', '11:00', '12:00'), false);
});

test('computes end times and minutes consistently', () => {
  assert.equal(getMinutesSinceMidnight('08:30'), 510);
  assert.equal(getSessionEndTime('09:00', '11:00'), '11:00');
  assert.equal(getSessionEndTime('10:30', ''), '12:30');
});
