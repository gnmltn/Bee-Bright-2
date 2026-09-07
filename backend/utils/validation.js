/**
 * Input validation helpers for personal information.
 * Mirrors frontend/src/lib/enrollmentValidation.ts — server-side is the enforced copy.
 */

const User = require('../models/User');

const NAME_ALLOWED_CHAR = /^[\p{L}\p{M} '-]+$/u;
const PH_MOBILE_RE = /^09\d{9}$/;

/** Returns true if value contains any digit 0-9 (invalid for names). */
function hasNumbersInName(value) {
  return /[0-9]/.test(value || '');
}

/** Returns true if value contains any letter a-z or A-Z (invalid for phone). */
function hasLettersInPhone(value) {
  return /[a-zA-Z]/.test(value || '');
}

/** Legacy: name must not contain numbers. Returns error message or null. */
function validateName(value, fieldName = 'Name') {
  if (!value || typeof value !== 'string') return null;
  if (hasNumbersInName(value)) return `${fieldName} must not contain numbers`;
  return null;
}

/** Legacy: phone must not contain letters. Returns error message or null. */
function validatePhoneNoLetters(value) {
  if (!value || typeof value !== 'string') return null;
  if (hasLettersInPhone(value)) return 'Phone number must not contain letters';
  return null;
}

/** Title Case: first letter of every word/hyphen-segment upper, the rest lower. */
function toTitleCase(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => w.split('-').map((s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s)).join('-'))
    .join(' ');
}

/**
 * Full-name validation: letters + single spaces (ñ, -, ' allowed), Title Case,
 * no leading/trailing/double space, no digits, no other punctuation.
 * @returns error message string, or null when valid
 */
function validateFullName(value, fieldName = 'Full name', { minParts = 1, required = true } = {}) {
  const raw = String(value ?? '');
  if (!raw.trim()) return required ? `${fieldName} is required.` : null;
  if (raw !== raw.trim()) return `${fieldName} must not start or end with a space.`;
  if (/\s{2,}/.test(raw)) return `${fieldName} must not contain double spaces.`;
  if (/\d/.test(raw)) return `${fieldName} must not contain numbers.`;
  if (!NAME_ALLOWED_CHAR.test(raw)) return `${fieldName} may only contain letters, spaces, hyphens and apostrophes.`;
  if (raw.split(' ').filter(Boolean).length < minParts) {
    return minParts >= 2 ? `${fieldName} must include at least a first and last name.` : `${fieldName} is required.`;
  }
  return null;
}

/** Digits only, +63/9-prefix normalised to leading 0. */
function normalizeMobile(value) {
  let d = String(value ?? '').replace(/\D/g, '');
  if (d.startsWith('63') && d.length === 12) d = `0${d.slice(2)}`;
  if (d.startsWith('9') && d.length === 10) d = `0${d}`;
  return d;
}

/**
 * PH mobile number: 11 digits, starts with 09, digits only.
 * @returns error message string, or null when valid
 */
function validatePhMobile(value, fieldName = 'Mobile number', { required = true } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return required ? `${fieldName} is required.` : null;
  if (/[a-zA-Z]/.test(raw)) return `${fieldName} must not contain letters.`;
  if (/[^\d\s+()-]/.test(raw)) return `${fieldName} must contain digits only.`;
  if (!PH_MOBILE_RE.test(normalizeMobile(raw))) {
    return `Enter a valid Philippine mobile number (09XXXXXXXXX, 11 digits).`;
  }
  return null;
}

/**
 * True when the given mobile number is already on another user's account.
 * @param {string} mobile          raw or normalised
 * @param {string|null} excludeUserId  skip this user (for profile updates)
 */
async function checkMobileNumberUnique(mobile, excludeUserId = null) {
  const digits = normalizeMobile(mobile);
  if (!PH_MOBILE_RE.test(digits)) return true; // format errors handled elsewhere
  const query = {
    phone: { $in: [digits, `0${digits.slice(1)}`, `+63${digits.slice(1)}`, `63${digits.slice(1)}`] },
    // Abandoned / in-progress Step-2 drafts must NOT reserve a mobile number.
    enrollmentDraft: { $ne: true },
  };
  if (excludeUserId) query._id = { $ne: excludeUserId };
  const existing = await User.exists(query);
  return !existing;
}

module.exports = {
  hasNumbersInName,
  hasLettersInPhone,
  validateName,
  validatePhoneNoLetters,
  validateFullName,
  validatePhMobile,
  normalizeMobile,
  toTitleCase,
  checkMobileNumberUnique,
  PH_MOBILE_RE,
};
