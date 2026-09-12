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

test('TPG101 policy defines playgroup with 2-child minimum and 12-child maximum', () => {
  const policy = getProgramPolicy({ code: 'TPG101' });
  assert.equal(policy.sessionType, 'playgroup');
  assert.equal(policy.minChildren, PLAYGROUP_MIN_CHILDREN);
  assert.equal(policy.maxStudents, PLAYGROUP_MAX_CHILDREN);
  assert.equal(PLAYGROUP_MIN_CHILDREN, 2);
  assert.equal(PLAYGROUP_MAX_CHILDREN, 12);
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

// ─── Variable playgroup tutor ratio (BeeBright-confirmed: 1 tutor per 2 children,
// minimum only — never a maximum; see Final Implementation Prompt Section 4) ──
test('calculatePlaygroupTutorRequirement returns ceil(children/2), no upper cap', () => {
  assert.equal(calculatePlaygroupTutorRequirement(1).min, 1); // below minimum children, still a sane floor
  assert.equal(calculatePlaygroupTutorRequirement(2).min, 1);
  assert.equal(calculatePlaygroupTutorRequirement(5).min, 3);
  assert.equal(calculatePlaygroupTutorRequirement(10).min, 5);
  assert.equal(calculatePlaygroupTutorRequirement(12).min, 6);
  assert.equal(calculatePlaygroupTutorRequirement(12).recommended, 6);
});

test('validateTutorCount uses the dynamic minimum for playgroup and never blocks above it', () => {
  const policy = getProgramPolicy({ code: 'TPG101' });
  // 5 children need ceil(5/2)=3 tutors minimum
  assert.match(validateTutorCount(policy, 1, 5), /5 children require at least 3/i);
  assert.match(validateTutorCount(policy, 2, 5), /5 children require at least 3/i);
  assert.equal(validateTutorCount(policy, 3, 5), null);
  // Assigning MORE than the minimum must never be blocked or warned.
  assert.equal(validateTutorCount(policy, 4, 5), null);
  assert.equal(validateTutorCount(policy, 10, 5), null);
  // 12 children need ceil(12/2)=6 tutors minimum
  assert.equal(validateTutorCount(policy, 6, 12), null);
  assert.match(validateTutorCount(policy, 5, 12), /12 children require at least 6/i);
  assert.equal(validateTutorCount(policy, 12, 12), null); // far above minimum — still allowed
});

// ─── Playgroup child count validation ────────────────────────────────────────
test('validatePlaygroupChildCount enforces 2-child minimum and 12-child maximum', () => {
  assert.match(validatePlaygroupChildCount(0), /at least/i);
  assert.match(validatePlaygroupChildCount(1), /at least/i);
  assert.equal(validatePlaygroupChildCount(2), null);
  assert.equal(validatePlaygroupChildCount(5), null);
  assert.equal(validatePlaygroupChildCount(10), null);
  assert.equal(validatePlaygroupChildCount(12), null);
  assert.match(validatePlaygroupChildCount(13), /cannot exceed/i);
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

// ─── Preferred days (Final Implementation Prompt Section 3 — was a dead field) ─
test('parent preferred days are surfaced as a warning, not silently ignored', () => {
  const monday = '2026-09-14T00:00:00.000Z';    // a Monday
  const tuesday = '2026-09-15T00:00:00.000Z';   // a Tuesday — not in the preferred list below
  // No preferredDays set -> no constraint at all.
  assert.equal(matchesParentPreference({ date: monday, startTime: '08:00' }).ok, true);
  // Empty array -> no constraint (treated the same as "no preference").
  assert.equal(matchesParentPreference({ preferredDays: [], date: monday, startTime: '08:00' }).ok, true);
  // Scheduled day is in the preferred list.
  assert.equal(matchesParentPreference({ preferredDays: ['Monday', 'Wednesday', 'Friday'], date: monday, startTime: '08:00' }).ok, true);
  // Scheduled day is NOT in the preferred list -> flagged, with the days named in the reason.
  const mismatch = matchesParentPreference({ preferredDays: ['Monday', 'Wednesday', 'Friday'], date: tuesday, startTime: '08:00' });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /Monday\/Wednesday\/Friday/);
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
