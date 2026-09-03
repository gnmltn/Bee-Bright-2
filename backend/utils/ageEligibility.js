/**
 * Age-eligibility utilities for Bee Bright program selection.
 *
 * Active programs (3 only, from brochure + client interview):
 *   TPG101 – Toddlers Playgroup:        1.5 – 3 years old
 *   ACT102 – Academic Tutorial:         2+  years old (1-on-1)
 *   EXP106 – Examination Preparation:   3+  years old
 */

const PROGRAM_ELIGIBILITY = {
  TPG101: { min: 1.5, max: 3,    label: 'Toddlers Playgroup' },
  ACT102: { min: 2,   max: null, label: 'Academic Tutorial' },
  EXP106: { min: 3,   max: null, label: 'Examination Preparation' },
};

/**
 * Compute age in decimal years from a birthdate.
 * @param {Date|string} birthdate
 * @returns {number} age in years (float, e.g. 1.75)
 */
function computeAge(birthdate) {
  const birth = new Date(birthdate);
  const now = new Date();
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  return (now.getTime() - birth.getTime()) / msPerYear;
}

/**
 * Human-readable age string: "2 years 3 months"
 */
function formatAge(birthdate) {
  const birth = new Date(birthdate);
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

  if (ageYears < rule.min) {
    const minLabel = rule.min % 1 === 0
      ? `${rule.min} years old`
      : `${rule.min} years old (${Math.floor(rule.min * 12)} months)`;
    return {
      eligible: false,
      reason: `${rule.label} requires a minimum age of ${minLabel}. Child is too young.`,
    };
  }

  if (rule.max !== null && ageYears > rule.max) {
    return {
      eligible: false,
      reason: `${rule.label} is designed for children up to ${rule.max} years old.`,
    };
  }

  return { eligible: true, reason: null };
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
  computeAge,
  formatAge,
  checkProgramEligibility,
  validateProgramSelection,
};
