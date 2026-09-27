import { getEmailError } from "./emailRules";

export const validateEmail = (email: string): boolean => getEmailError(email) === null;

export const validatePhone = (phone: string): boolean => {
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  return phoneRegex.test(phone);
};

/** Names: letters, spaces, hyphens and apostrophes only (e.g. "Dela Cruz", "O'Brien"). No numbers or other symbols. */
export const sanitizeName = (value: string): string => {
  return (value || "").replace(/[^a-zA-Z\s'-]/g, "");
};

/** Error message for a name field, or null when valid — mirrors backend/utils/validation.js's validateFullName. */
export const getNameError = (value: string, fieldName: string, required = true): string | null => {
  const raw = value || "";
  if (!raw.trim()) return required ? `${fieldName} is required.` : null;
  if (raw !== raw.trim()) return `${fieldName} must not start or end with a space.`;
  if (/\s{2,}/.test(raw)) return `${fieldName} must not contain double spaces.`;
  if (/\d/.test(raw)) return `${fieldName} must not contain numbers.`;
  if (!/^[a-zA-Z\s'-]+$/.test(raw)) return `${fieldName} may only contain letters, spaces, hyphens and apostrophes.`;
  return null;
};

/** First letter of each word uppercase, rest lowercase. */
export const formatNameCapitalize = (value: string): string => {
  return (value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
};

/** Typing-safe formatter: capitalizes words but preserves a trailing space while user types. */
export const formatNameWhileTyping = (value: string): string => {
  const cleaned = sanitizeName(value || "");
  const hasTrailingSpace = /\s$/.test(cleaned);
  const words = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase());

  const formatted = words.join(" ");
  return hasTrailingSpace ? `${formatted} ` : formatted;
};

/** Phone: digits, +, spaces, hyphens, parentheses only. No letters. */
export const sanitizePhoneInput = (value: string): string => {
  return (value || "").replace(/[a-zA-Z]/g, "");
};

export const hasNumbersInName = (value: string): boolean => /[0-9]/.test(value || "");
export const hasLettersInPhone = (value: string): boolean => /[a-zA-Z]/.test(value || "");

/** Philippine mobile: 11 digits starting with 09 (accepts spaces/hyphens/+63 while typing). */
export const getPhMobileError = (value: string, fieldName = "Phone number"): string | null => {
  const raw = (value || "").trim();
  if (!raw) return `${fieldName} is required.`;
  if (/[a-zA-Z]/.test(raw)) return `${fieldName} must not contain letters.`;
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("63") && digits.length === 12) digits = `0${digits.slice(2)}`;
  if (digits.startsWith("9") && digits.length === 10) digits = `0${digits}`;
  if (!/^09\d{9}$/.test(digits)) return `Enter a valid Philippine mobile number (09XX XXX XXXX, 11 digits).`;
  return null;
};

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

/** Mirrors the backend's password rule exactly (8+ chars, upper, lower, digit, special). */
export const getPasswordError = (value: string): string | null => {
  if (!value) return "Password is required.";
  if (!PASSWORD_REGEX.test(value)) {
    return "Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character (@$!%*?&).";
  }
  return null;
};

export const getConfirmPasswordError = (password: string, confirmPassword: string): string | null => {
  if (!confirmPassword) return "Please confirm the password.";
  if (password !== confirmPassword) return "Passwords do not match.";
  return null;
};

export const validateEnrollmentForm = (formData: any): string[] => {
  const errors: string[] = [];
  
  if (!formData.firstName?.trim()) errors.push("First name is required");
  if (!formData.lastName?.trim()) errors.push("Last name is required");
  if (!formData.email?.trim()) errors.push("Email is required");
  if (!validateEmail(formData.email)) errors.push("Invalid email format");
  if (!formData.phone?.trim()) errors.push("Phone number is required");
  if (!validatePhone(formData.phone)) errors.push("Invalid phone number");
  if (!formData.gradeLevel) errors.push("Grade level is required");
  if (!formData.guardianName?.trim()) errors.push("Guardian name is required");
  
  return errors;
};
