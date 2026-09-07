/**
 * Age-eligibility utilities for Bee Bright program selection.
 *
 * Active programs (3 only, owner-confirmed):
 *   TPG101 – Toddlers Playgroup:        2 – 4 years old
 *   ACT102 – Academic Tutorial:         2 – 18 years old (1-on-1)
 *   EXP106 – Examination Preparation:   3 – 18 years old
 *
 * General enrollment age range: 2–18 (MIN_ENROLL_AGE / MAX_ENROLL_AGE).
 */

const MIN_ENROLL_AGE = 2;
const MAX_ENROLL_AGE = 18;
// Plausibility bound for a human birthdate — only catches typos (e.g. year 0111).
const MAX_REALISTIC_AGE = 120;

const PROGRAM_ELIGIBILITY = {
  TPG101: { min: 2, max: 4,  label: 'Toddlers Playgroup' },
  ACT102: { min: 2, max: 18, label: 'Academic Tutorial' },
  EXP106: { min: 3, max: 18, label: 'Examination Preparation' },
};

/**
 * A program whose `max` is a small explicit upper bound is written as an age
 * BAND ("ages 2 to 4"). Purely a copy/message distinction — the comparison is
 * the same for every program. Programs whose `max` is just an upper cap
 * (Academic Tutorial / Exam Prep at 18) read as "up to N years old".
 */
function isAgeBand(rule) {
  return rule && rule.max !== null && rule.max <= 5;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A birthdate is a calendar date, not an instant. `new Date('2024-09-07')` is
 * parsed by JS as UTC midnight, which lands on the previous/next local day
 * depending on the timezone — so parse bare YYYY-MM-DD as LOCAL midnight.
 */
function parseBirthdate(birthdate) {
  if (birthdate instanceof Date) return new Date(birthdate.getTime());
  const raw = String(birthdate ?? '').trim();
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (bare) return new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]));
  return new Date(raw);
}

/**
 * Compute age in decimal years from a birthdate, using real calendar
 * anniversaries.
 *
 * A naive `elapsedMs / (365.25 days)` is WRONG at every birthday: two calendar
 * years is 730 days but 2 × 365.25 = 730.5, so a child on their exact 2nd
 * birthday came out as 1.9997 and failed every `age >= 2` check. Here the whole
 * part is the number of birthdays passed and the fraction is the progress
 * toward the next one, so "exactly N years old today" is always >= N.
 *
 * @param {Date|string} birthdate
 * @returns {number} age in years (float; negative for a future birthdate)
 */
function computeAge(birthdate) {
  const birth = parseBirthdate(birthdate);
  const now = new Date();
  if (Number.isNaN(birth.getTime())) return NaN;
  if (now.getTime() < birth.getTime()) {
    return (now.getTime() - birth.getTime()) / (365.2425 * MS_PER_DAY); // negative
  }

  // Whole years = birthdays already passed.
  let years = now.getFullYear() - birth.getFullYear();
  const anniversary = new Date(birth.getTime());
  anniversary.setFullYear(birth.getFullYear() + years);
  if (anniversary.getTime() > now.getTime()) {
    years -= 1;
    anniversary.setFullYear(birth.getFullYear() + years);
  }

  // Fraction = progress from the last birthday to the next one.
  const nextAnniversary = new Date(anniversary.getTime());
  nextAnniversary.setFullYear(anniversary.getFullYear() + 1);
  const span = nextAnniversary.getTime() - anniversary.getTime();
  const fraction = span > 0 ? (now.getTime() - anniversary.getTime()) / span : 0;
  return years + fraction;
}

/**
 * Human-readable age string: "2 years 3 months"
 */
function formatAge(birthdate) {
  const birth = parseBirthdate(birthdate);
  const now = new Date();
  let years = now.getFullYear() - birth.getFullYear();
  let months = now.getMonth() - birth.getMonth();
  if (months < 0) { years--; months += 12; }
  if (now.getDate() < birth.getDate()) months--;
  if (months < 0) { years--; months += 12; }
  const parts = [];
  if (years > 0) parts.push(`${years} year${years !== 1 ? 's' : ''}`);
  if (months > 0) parts.push(`${months} month${months !== 1 ? 's' : ''}`);
  return parts.length ? parts.join(' ') : 'less than 1 month';
}

/**
 * Check whether a student of the given age is eligible for a program.
 * @param {string} programCode
 * @param {number} ageYears – decimal age
 * @returns {{ eligible: boolean, reason: string|null }}
 */
function checkProgramEligibility(programCode, ageYears) {
  const rule = PROGRAM_ELIGIBILITY[programCode];
  if (!rule) return { eligible: true, reason: null }; // unknown code → allow

  if (!Number.isFinite(ageYears) || ageYears <= 0) {
    return { eligible: false, reason: 'A valid birthdate is required to check age eligibility.' };
  }

  const band = isAgeBand(rule);
  // A banded program shows ONE consistent message whether the child is too
  // young OR too old — e.g. "Toddlers Playgroup is for children ages 2 to 4 years old."
  const bandMessage = `${rule.label} is for children ages ${rule.min} to ${rule.max} years old.`;

  // Too young — the child has not reached their `min`th birthday yet.
  if (ageYears < rule.min) {
    return {
      eligible: false,
      reason: band ? bandMessage : `${rule.label} is for children ages ${rule.min} years old and up.`,
    };
  }

  // Too old — "ages 2 to 4" covers the whole 4th year, so a child is only out
  // once they turn 5. Same rule for an upper cap ("up to 18" runs through 18).
  if (rule.max !== null && Math.floor(ageYears) > rule.max) {
    return {
      eligible: false,
      reason: band ? bandMessage : `${rule.label} is for students up to ${rule.max} years old.`,
    };
  }

  return { eligible: true, reason: null };
}

/**
 * Toddlers Playgroup: children ages 2, 3 and 4 years old — i.e. from the 2nd
 * birthday until the day before the 5th. Single shared check used by the
 * enrollment wizard (Step 5/6), the Student Dashboard "Add Child" modal and
 * server-side submit validation.
 * @param {number} ageYears – decimal age (see computeAge)
 * @returns {boolean}
 */
function isEligibleForToddlers(ageYears) {
  return checkProgramEligibility('TPG101', ageYears).eligible;
}

/**
 * General enrollment-age gate (independent of program): min 2, max 18, real date.
 * @param {Date|string} birthdate
 * @returns {{ valid: boolean, reason: string|null, ageYears: number }}
 */
function validateEnrollmentAge(birthdate) {
  if (!birthdate) return { valid: false, reason: 'Birthdate is required.', ageYears: NaN };
  const birth = parseBirthdate(birthdate);
  if (Number.isNaN(birth.getTime())) return { valid: false, reason: 'Birthdate is not a valid date.', ageYears: NaN };

  const now = new Date();
  if (birth > now) return { valid: false, reason: 'Birthdate cannot be in the future.', ageYears: NaN };

  // Sanity bound only (catches typos like year 0111). A merely too-old student
  // falls through to the age-range message below, which is far clearer.
  const earliest = new Date();
  earliest.setFullYear(earliest.getFullYear() - MAX_REALISTIC_AGE);
  if (birth < earliest) {
    return { valid: false, reason: 'Birthdate is not realistic. Please check the year.', ageYears: NaN };
  }

  const ageYears = computeAge(birthdate);
  if (ageYears < MIN_ENROLL_AGE) {
    return { valid: false, reason: `Student must be at least ${MIN_ENROLL_AGE} years old to enroll.`, ageYears };
  }
  // "up to 18" runs through the whole 18th year — an 18-year-old can still enroll.
  if (Math.floor(ageYears) > MAX_ENROLL_AGE) {
    return { valid: false, reason: `Enrollment is for students up to ${MAX_ENROLL_AGE} years old.`, ageYears };
  }
  return { valid: true, reason: null, ageYears };
}

/**
 * Validate all selected program codes against the student's age.
 * @param {string[]} programCodes
 * @param {number}   ageYears
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateProgramSelection(programCodes, ageYears) {
  const errors = [];
  for (const code of programCodes) {
    const { eligible, reason } = checkProgramEligibility(code, ageYears);
    if (!eligible) errors.push(reason);
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  PROGRAM_ELIGIBILITY,
  MIN_ENROLL_AGE,
  MAX_ENROLL_AGE,
  computeAge,
  parseBirthdate,
  formatAge,
  checkProgramEligibility,
  isEligibleForToddlers,
  isAgeBand,
  validateProgramSelection,
  validateEnrollmentAge,
};
