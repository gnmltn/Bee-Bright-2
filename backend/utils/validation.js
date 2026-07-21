/**
 * Input validation helpers for personal information.
 * Names: letters, spaces, hyphens, apostrophes only (no numbers).
 * Phone: digits, +, spaces, hyphens, parentheses only (no letters).
 */

/** Returns true if value contains any digit 0-9 (invalid for names). */
function hasNumbersInName(value) {
  return /[0-9]/.test(value || '');
}

/** Returns true if value contains any letter a-z or A-Z (invalid for phone). */
function hasLettersInPhone(value) {
  return /[a-zA-Z]/.test(value || '');
}

/** Validate name fields - must not contain numbers. Returns error message or null. */
function validateName(value, fieldName = 'Name') {
  if (!value || typeof value !== 'string') return null;
  if (hasNumbersInName(value)) {
    return `${fieldName} must not contain numbers`;
  }
  return null;
}

/** Validate phone - must not contain letters. Returns error message or null. */
function validatePhoneNoLetters(value) {
  if (!value || typeof value !== 'string') return null;
  if (hasLettersInPhone(value)) {
    return 'Phone number must not contain letters';
  }
  return null;
}

module.exports = {
  hasNumbersInName,
  hasLettersInPhone,
  validateName,
  validatePhoneNoLetters,
};
