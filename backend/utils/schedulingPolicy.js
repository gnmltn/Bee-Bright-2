const OPERATING_DAYS = [0, 1, 2, 3, 4, 5];
const OPERATING_START_MINUTES = 8 * 60;
const LUNCH_START_MINUTES = 12 * 60;
const LUNCH_END_MINUTES = 13 * 60;
const OPERATING_END_MINUTES = 17 * 60;

// ─── Playgroup constants ───────────────────────────────────────────────────────
// Toddlers Playgroup is a GROUP session — minimum 2 children required.
// Tutor count scales with child count using a deterministic supervision ratio.
//
// Policy (BeeBright program-manager-confirmed, supersedes the earlier 1:3-ratio /
// 4-tutor-cap rule): base ratio is 1 tutor per 2 children, max 12 children per
// session. There is NO upper cap on tutors — staff may assign more than the
// computed minimum at any time (e.g. based on the toddlers' behavior that day),
// and the system must never block that; it only blocks going BELOW the minimum.
const PLAYGROUP_MIN_CHILDREN = 2;
const PLAYGROUP_MAX_CHILDREN = 12;

/**
 * Calculate the MINIMUM number of tutors required for a Toddlers Playgroup
 * session, based on the number of enrolled children.
 *
 * Supervision ratio rule: 1 tutor per 2 children, rounded up —
 * requiredTutors = ceil(childCount / 2). There is no maximum: assigning more
 * tutors than this minimum is always allowed (admin discretion), never warned
 * or blocked.
 *
 * @param {number} childCount — number of children enrolled in the session
 * @returns {{ min: number, recommended: number }}
 */
function calculatePlaygroupTutorRequirement(childCount) {
  const count = Math.max(0, Number(childCount) || 0);
  if (count < PLAYGROUP_MIN_CHILDREN) {
    // Below minimum children — caller should reject the child count itself
    // (validatePlaygroupChildCount); still return a sane minimum tutor count.
    return { min: 1, recommended: 1 };
  }
  const min = Math.ceil(count / 2);
  return {
    min,          // the minimum required count — the only bound ever enforced
    recommended: min,
  };
}

const PROGRAM_POLICIES = {
  ACT102: {
    sessionType: 'one-on-one',
    maxStudents: 1,
    minTutors: 1,
    maxTutors: 1,
    durationMinutes: 120,
  },
  EXP106: {
    sessionType: 'one-on-one',
    maxStudents: 1,
    minTutors: 1,
    maxTutors: 1,
    durationMinutes: 120,
  },
  TPG101: {
    sessionType: 'playgroup',
    minChildren: PLAYGROUP_MIN_CHILDREN,
    maxStudents: PLAYGROUP_MAX_CHILDREN,
    // The real per-session minimum is dynamic — use
    // calculatePlaygroupTutorRequirement(childCount). These static fields are only
    // used before a child count is known (e.g. creating an empty slot or a weekly
    // template entry): minTutors is the absolute floor (2 children → 1 tutor);
    // maxTutors is intentionally uncapped — admin may always assign more tutors.
    minTutors: 1,
    maxTutors: Infinity,
    fixedSlots: [
      { startTime: '08:00', endTime: '10:00' },
      { startTime: '13:00', endTime: '15:00' },
    ],
  },
};

const SUBJECT_NAME_TO_CODE = [
  ['academic tutorial', 'ACT102'],
  ['examination preparation', 'EXP106'],
  ['exam prep', 'EXP106'],
  ['toddlers playgroup', 'TPG101'],
  ['playgroup', 'TPG101'],
];

function resolveProgramCode(subject) {
  const code = String(subject?.code || subject?.programCode || '').toUpperCase();
  if (PROGRAM_POLICIES[code]) return code;
  const name = String(subject?.name || subject?.displayName || '').toLowerCase();
  return SUBJECT_NAME_TO_CODE.find(([label]) => name.includes(label))?.[1] || null;
}

function getProgramPolicy(subject) {
  const programCode = resolveProgramCode(subject);
  return programCode ? { programCode, ...PROGRAM_POLICIES[programCode] } : null;
}

function getMinutes(value) {
  const [hours, minutes] = String(value || '').split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : NaN;
}

function isOperatingDay(date) {
  return OPERATING_DAYS.includes(new Date(date).getUTCDay() === 0 ? 6 : new Date(date).getUTCDay() - 1);
}

function validateTimeWindow({ date, startTime, endTime, policy }) {
  const start = getMinutes(startTime);
  const end = getMinutes(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'Start and end times are invalid.';
  if (!isOperatingDay(date)) return 'Schedules are available Monday through Saturday only.';
  if (start < OPERATING_START_MINUTES || end > OPERATING_END_MINUTES) return 'Schedules must be between 8:00 AM and 5:00 PM.';
  if (start < LUNCH_END_MINUTES && end > LUNCH_START_MINUTES) return 'Schedules cannot overlap the 12:00 PM to 1:00 PM lunch break.';
  if (policy?.durationMinutes && end - start !== policy.durationMinutes) return 'One-on-one sessions must be exactly 2 hours.';
  if (policy?.fixedSlots && !policy.fixedSlots.some((slot) => slot.startTime === startTime && slot.endTime === endTime)) {
    return 'Toddlers Playgroup is available only from 8:00 AM to 10:00 AM or 1:00 PM to 3:00 PM.';
  }
  return null;
}

function validateTutorCount(policy, count, childCount) {
  if (!policy) return null;

  // Playgroup: minimum tutor requirement is dynamic based on child count. Only
  // the lower bound is ever enforced — assigning MORE tutors than the minimum
  // is always allowed (admin discretion, e.g. the toddlers' behavior that day).
  if (policy.sessionType === 'playgroup' && childCount != null) {
    const req = calculatePlaygroupTutorRequirement(childCount);
    if (count < req.min) {
      return `${childCount} children require at least ${req.min} tutor${req.min !== 1 ? 's' : ''} (${count} selected).`;
    }
    return null;
  }

  // One-on-one / static policy
  if (count < policy.minTutors || count > policy.maxTutors) {
    return `This program requires ${policy.minTutors === policy.maxTutors ? policy.minTutors : `${policy.minTutors}-${policy.maxTutors}`} tutor${policy.maxTutors === 1 ? '' : 's'}.`;
  }
  return null;
}

/**
 * Validate that a playgroup session has at least PLAYGROUP_MIN_CHILDREN children.
 * Returns an error string or null.
 */
function validatePlaygroupChildCount(childCount) {
  const count = Number(childCount) || 0;
  if (count < PLAYGROUP_MIN_CHILDREN) {
    return `Toddlers Playgroup requires at least ${PLAYGROUP_MIN_CHILDREN} children per session.`;
  }
  if (count > PLAYGROUP_MAX_CHILDREN) {
    return `Toddlers Playgroup cannot exceed ${PLAYGROUP_MAX_CHILDREN} children per session.`;
  }
  return null;
}

function enrollmentCoversSubject(enrollment, subject) {
  if (!enrollment || !subject) return false;
  const subjectId = String(subject._id || '');
  const selected = enrollment.selectedSubjects || [];
  if (subjectId && selected.some((item) => String(item._id || item) === subjectId)) return true;
  const programCode = resolveProgramCode(subject);
  const packages = enrollment.packages || [];
  if (programCode && packages.some((pkg) => String(pkg.programCode || '').toUpperCase() === programCode)) return true;
  return false;
}

module.exports = {
  PROGRAM_POLICIES,
  OPERATING_DAYS,
  OPERATING_START_MINUTES,
  LUNCH_START_MINUTES,
  LUNCH_END_MINUTES,
  OPERATING_END_MINUTES,
  PLAYGROUP_MIN_CHILDREN,
  PLAYGROUP_MAX_CHILDREN,
  resolveProgramCode,
  getProgramPolicy,
  validateTimeWindow,
  validateTutorCount,
  validatePlaygroupChildCount,
  calculatePlaygroupTutorRequirement,
  enrollmentCoversSubject,
  getMinutes,
};
