/**
 * Email address rules applied to EVERY email field (parent, tutor and admin signup /
 * login / profile / invite forms). Mirror of frontend/src/utils/emailRules.ts — keep the
 * two in sync (both are covered by tests using the same cases).
 *
 * Rule (from the "email validation rules" reference): in the part BEFORE the "@" (the
 * local part) these characters are not allowed anywhere:
 *     spaces   ( )   [ ]   < >   ;  :   ,   \
 * ...unless the ENTIRE local part is wrapped in double quotes ("like this"@example.com).
 * A stray double quote, an extra "@", or leading/trailing/double periods in an unquoted
 * local part are rejected as well, and the domain must be a normal dotted hostname.
 */

const FORBIDDEN_LOCAL_CHARS = [' ', '(', ')', '[', ']', '<', '>', ';', ':', ',', '\\'];

const CHAR_NAMES = {
  '(': 'the character "("',
  ')': 'the character ")"',
  '[': 'the character "["',
  ']': 'the character "]"',
  '<': 'the character "<"',
  '>': 'the character ">"',
  ';': 'a semicolon (;)',
  ':': 'a colon (:)',
  ',': 'a comma (,)',
  '\\': 'a backslash (\\)',
};

const QUOTE_HINT = 'unless the whole part before the @ is wrapped in double quotes';
const DOMAIN_RE = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

/**
 * @param {unknown} value raw input (surrounding whitespace is ignored)
 * @returns {string|null} a user-facing error message, or null when the email is acceptable
 */
function getEmailError(value) {
  const email = String(value ?? '').trim();
  if (!email) return 'Email is required.';
  if (email.length > 254) return 'Email address is too long.';

  const at = email.lastIndexOf('@');
  if (at === -1) return 'Enter a valid email address — it must contain an @.';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local) return 'Enter the part of the email that comes before the @.';
  if (local.length > 64) return 'The part of the email before the @ is too long (64 characters maximum).';

  const isQuoted = local.length >= 2 && local.startsWith('"') && local.endsWith('"');
  if (isQuoted) {
    // Fully wrapped in double quotes: the restricted symbols are allowed inside.
    const inner = local.slice(1, -1);
    if (!inner || !/^(?:[^"\\]|\\.)+$/.test(inner)) {
      return 'Inside the double quotes, a double quote (") or backslash (\\) must be escaped with a backslash.';
    }
  } else {
    for (const ch of local) {
      if (ch === ' ') return `Email addresses cannot contain spaces ${QUOTE_HINT}.`;
      if (FORBIDDEN_LOCAL_CHARS.includes(ch)) {
        return `${CHAR_NAMES[ch][0].toUpperCase()}${CHAR_NAMES[ch].slice(1)} is not allowed in an email address before the @ ${QUOTE_HINT}.`;
      }
      if (ch === '"') return `A double quote (") is only allowed if the whole part before the @ is wrapped in double quotes.`;
      if (ch === '@') return `Only one @ is allowed ${QUOTE_HINT}.`;
    }
    if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
      return 'The part before the @ cannot start or end with a period or contain two periods in a row.';
    }
  }

  if (!DOMAIN_RE.test(domain)) return 'Enter a valid domain after the @ (for example gmail.com).';
  return null;
}

/** express-validator `.custom()` adapter: throws the message, so it lands in `errors[].msg`. */
function assertValidEmail(value) {
  const error = getEmailError(value);
  if (error) throw new Error(error);
  return true;
}

module.exports = { getEmailError, assertValidEmail, FORBIDDEN_LOCAL_CHARS };
