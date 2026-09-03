const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getProgramPolicy,
  validateTimeWindow,
  validateTutorCount,
  validatePlaygroupChildCount,
  calculatePlaygroupTutorRequirement,
  enrollmentCoversSubject,
  PLAYGROUP_MIN_CHILDREN,
  PLAYGROUP_MAX_CHILDREN,
} = require('../utils/schedulingPolicy');
const { matchesParentPreference } = require('../utils/schedulePreferences');

// ─── Program policies ─────────────────────────────────────────────────────────
test('program policies define one-on-one rules for ACT102 and EXP106', () => {
  assert.equal(getProgramPolicy({ code: 'ACT102' }).sessionType, 'one-on-one');
  assert.equal(getProgramPolicy({ code: 'ACT102' }).durationMinutes, 120);
  assert.equal(getProgramPolicy({ code: 'EXP106' }).sessionType, 'one-on-one');
  assert.equal(getProgramPolicy({ code: 'EXP106' }).durationMinutes, 120);
});

test('TPG101 policy defines playgroup with 2-child minimum and 10-child maximum', () => {
  const policy = getProgramPolicy({ code: 'TPG101' });
  assert.equal(policy.sessionType, 'playgroup');
  assert.equal(policy.minChildren, PLAYGROUP_MIN_CHILDREN);
  assert.equal(policy.maxStudents, PLAYGROUP_MAX_CHILDREN);
  assert.equal(PLAYGROUP_MIN_CHILDREN, 2);
  assert.equal(PLAYGROUP_MAX_CHILDREN, 10);
});

// ─── One-on-one time windows ──────────────────────────────────────────────────
test('one-on-one sessions use valid two-hour operating slots', () => {
  const policy = getProgramPolicy({ code: 'ACT102' });
  const monday = '2026-09-07T00:00:00.000Z';
  assert.equal(validateTimeWindow({ date: monday, startTime: '08:00', endTime: '10:00', policy }), null);
  assert.match(validateTimeWindow({ date: monday, startTime: '11:00', endTime: '13:00', policy }), /lunch/i);
  assert.match(validateTimeWindow({ date: monday, startTime: '08:00', endTime: '09:00', policy }), /2 hours/i);
});

// ─── Playgroup fixed time slots ───────────────────────────────────────────────
test('playgroup only allows fixed morning and afternoon slots', () => {
  const policy = getProgramPolicy({ code: 'TPG101' });
  const monday = '2026-09-07T00:00:00.000Z';
  assert.equal(validateTimeWindow({ date: monday, startTime: '08:00', endTime: '10:00', policy }), null);
  assert.equal(validateTimeWindow({ date: monday, startTime: '13:00', endTime: '15:00', policy }), null);
  assert.match(validateTimeWindow({ date: monday, startTime: '10:00', endTime: '12:00', policy }), /Toddlers Playgroup/i);
});

// ─── Variable playgroup tutor ratio ──────────────────────────────────────────
test('calculatePlaygroupTutorRequirement returns correct counts', () => {
  // 2–3 children → 1 tutor
  assert.equal(calculatePlaygroupTutorRequirement(2).recommended, 1);
  assert.equal(calculatePlaygroupTutorRequirement(3).recommended, 1);
  // 4–6 children → 2 tutors
  assert.equal(calculatePlaygroupTutorRequirement(4).recommended, 2);
  assert.equal(calculatePlaygroupTutorRequirement(6).recommended, 2);
  // 7–9 children → 3 tutors
  assert.equal(calculatePlaygroupTutorRequirement(7).recommended, 3);
  assert.equal(calculatePlaygroupTutorRequirement(9).recommended, 3);
  // 10 children → 4 tutors (capped)
  assert.equal(calculatePlaygroupTutorRequirement(10).recommended, 4);
});

test('validateTutorCount uses dynamic ratio for playgroup', () => {
  const policy = getProgramPolicy({ code: 'TPG101' });
  // 3 children need 1 tutor — 1 tutor is fine
  assert.equal(validateTutorCount(policy, 1, 3), null);
  // 3 children need 1 tutor — 3 tutors is too many (max=1)
  assert.match(validateTutorCount(policy, 3, 3), /3 children require/i);
  // 7 children need 3 tutors — 2 is ok (min=2), 3 is ok (max=3), 4 is too many
  assert.equal(validateTutorCount(policy, 2, 7), null);
  assert.equal(validateTutorCount(policy, 3, 7), null);
  assert.match(validateTutorCount(policy, 4, 7), /7 children require/i);
  // 10 children need 4 tutors
  assert.equal(validateTutorCount(policy, 4, 10), null);
  assert.match(validateTutorCount(policy, 5, 10), /10 children require/i);
});

// ─── Playgroup child count validation ────────────────────────────────────────
test('validatePlaygroupChildCount enforces 2-child minimum and 10-child maximum', () => {
  assert.match(validatePlaygroupChildCount(0), /at least/i);
  assert.match(validatePlaygroupChildCount(1), /at least/i);
  assert.equal(validatePlaygroupChildCount(2), null);
  assert.equal(validatePlaygroupChildCount(5), null);
  assert.equal(validatePlaygroupChildCount(10), null);
  assert.match(validatePlaygroupChildCount(11), /cannot exceed/i);
});

// ─── Operating day / hour restrictions ────────────────────────────────────────
test('scheduling is limited to Monday through Saturday and operating hours', () => {
  const policy = getProgramPolicy({ code: 'ACT102' });
  assert.match(validateTimeWindow({ date: '2026-09-06T00:00:00.000Z', startTime: '08:00', endTime: '10:00', policy }), /Monday through Saturday/i);
  assert.match(validateTimeWindow({ date: '2026-09-07T00:00:00.000Z', startTime: '16:00', endTime: '18:00', policy }), /8:00 AM and 5:00 PM/i);
});

// ─── Parent preference matching ───────────────────────────────────────────────
test('parent preferred start date and time are not ignored', () => {
  const monday = '2026-09-14T00:00:00.000Z';
  assert.equal(
    matchesParentPreference({ preferredStartDate: '2026-09-07', preferredTime: 'no_preference', date: monday, startTime: '08:00' }).ok,
    true
  );
  assert.equal(
    matchesParentPreference({ preferredStartDate: '2026-09-21', preferredTime: 'morning', date: monday, startTime: '08:00' }).ok,
    false
  );
  assert.equal(
    matchesParentPreference({ preferredStartDate: null, preferredTime: 'afternoon', date: monday, startTime: '08:00' }).ok,
    false
  );
  assert.equal(
    matchesParentPreference({ preferredStartDate: null, preferredTime: 'afternoon', date: monday, startTime: '13:00' }).ok,
    true
  );
});

// ─── Enrollment coverage ──────────────────────────────────────────────────────
test('approved package enrollments match the program without selectedSubjects', () => {
  assert.equal(
    enrollmentCoversSubject({ packages: [{ programCode: 'ACT102' }], selectedSubjects: [] }, { _id: 'sub1', code: 'ACT102', name: 'Academic Tutorial' }),
    true
  );
  assert.equal(
    enrollmentCoversSubject({ packages: [{ programCode: 'TPG101' }], selectedSubjects: [] }, { _id: 'sub2', code: 'ACT102', name: 'Academic Tutorial' }),
    false
  );
});
