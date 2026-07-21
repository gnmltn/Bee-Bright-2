export const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

export const validatePhone = (phone: string): boolean => {
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  return phoneRegex.test(phone);
};

/** Names: letters and spaces only. No numbers or special characters. */
export const sanitizeName = (value: string): string => {
  return (value || "").replace(/[^a-zA-Z\s]/g, "");
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
