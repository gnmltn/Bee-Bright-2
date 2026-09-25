/**
 * Email address rules applied to EVERY email field (parent, tutor and admin signup /
 * login / invite / recovery forms). Mirror of backend/utils/emailRules.js — keep the two
 * in sync (both are covered by tests using the same cases).
 *
 * Rule: in the part BEFORE the "@" (the local part) these characters are not allowed
 * anywhere:  spaces  ( )  [ ]  < >  ;  :  ,  \   — unless the ENTIRE local part is
 * wrapped in double quotes ("like this"@example.com). A stray double quote, an extra "@",
 * or leading/trailing/double periods in an unquoted local part are rejected as well, and
 * the domain must be a normal dotted hostname.
 */
import { useState } from "react";

export const FORBIDDEN_LOCAL_CHARS = [" ", "(", ")", "[", "]", "<", ">", ";", ":", ",", "\\"];

const CHAR_NAMES: Record<string, string> = {
  "(": 'The character "("',
  ")": 'The character ")"',
  "[": 'The character "["',
  "]": 'The character "]"',
  "<": 'The character "<"',
  ">": 'The character ">"',
  ";": "A semicolon (;)",
  ":": "A colon (:)",
  ",": "A comma (,)",
  "\\": "A backslash (\\)",
};

const QUOTE_HINT = "unless the whole part before the @ is wrapped in double quotes";
const DOMAIN_RE = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

const isQuotedLocal = (local: string) => local.length >= 2 && local.startsWith('"') && local.endsWith('"');

/** A user-facing error for the first offending character in the local part, or null. Safe to call while typing. */
export function getEmailCharacterError(value: string): string | null {
  const email = String(value ?? "").trim();
  const at = email.lastIndexOf("@");
  // Before an "@" is typed the whole text is still "the local part" — but only complain
  // once the user has moved past it, except for characters that can never be valid.
  const local = at === -1 ? email : email.slice(0, at);
  if (!local || isQuotedLocal(local) || local.startsWith('"')) return null;
  for (const ch of local) {
    if (ch === " ") return `Email addresses cannot contain spaces ${QUOTE_HINT}.`;
    if (FORBIDDEN_LOCAL_CHARS.includes(ch)) return `${CHAR_NAMES[ch]} is not allowed in an email address before the @ ${QUOTE_HINT}.`;
    if (ch === '"') return 'A double quote (") is only allowed if the whole part before the @ is wrapped in double quotes.';
  }
  return null;
}

/** @returns a user-facing error message, or null when the email is acceptable */
export function getEmailError(value: string): string | null {
  const email = String(value ?? "").trim();
  if (!email) return "Email is required.";
  if (email.length > 254) return "Email address is too long.";

  const at = email.lastIndexOf("@");
  if (at === -1) return "Enter a valid email address — it must contain an @.";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local) return "Enter the part of the email that comes before the @.";
  if (local.length > 64) return "The part of the email before the @ is too long (64 characters maximum).";

  if (isQuotedLocal(local)) {
    const inner = local.slice(1, -1);
    if (!inner || !/^(?:[^"\\]|\\.)+$/.test(inner)) {
      return 'Inside the double quotes, a double quote (") or backslash (\\) must be escaped with a backslash.';
    }
  } else {
    for (const ch of local) {
      if (ch === " ") return `Email addresses cannot contain spaces ${QUOTE_HINT}.`;
      if (FORBIDDEN_LOCAL_CHARS.includes(ch)) return `${CHAR_NAMES[ch]} is not allowed in an email address before the @ ${QUOTE_HINT}.`;
      if (ch === '"') return 'A double quote (") is only allowed if the whole part before the @ is wrapped in double quotes.';
      if (ch === "@") return `Only one @ is allowed ${QUOTE_HINT}.`;
    }
    if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
      return "The part before the @ cannot start or end with a period or contain two periods in a row.";
    }
  }

  if (!DOMAIN_RE.test(domain)) return "Enter a valid domain after the @ (for example gmail.com).";
  return null;
}

/**
 * Inline feedback for an email field: a disallowed character is reported immediately
 * as it is typed; every other problem (missing @, bad domain…) waits until the field
 * is left, so half-typed addresses are not nagged at.
 */
export function useEmailFieldError(value: string) {
  const [touched, setTouched] = useState(false);
  const text = String(value ?? "");
  const error = text.trim() ? getEmailCharacterError(text) ?? (touched ? getEmailError(text) : null) : null;
  return { error, onBlur: () => setTouched(true) };
}
