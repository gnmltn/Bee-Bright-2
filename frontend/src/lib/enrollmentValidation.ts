/**
 * Shared validation + formatting helpers for the Bee Bright enrollment flows
 * (main wizard + Student Dashboard "Add Child" modal).
 *
 * Every rule here is mirrored server-side (backend/utils/validation.js,
 * backend/utils/ageEligibility.js) — the client copy is for instant feedback only.
 */

// ── Full name ────────────────────────────────────────────────────────────
// Letters + single spaces between name parts. Common name characters (ñ, -, ')
// are allowed. No digits, no other punctuation, no leading/trailing/double space.
const NAME_ALLOWED_CHAR = /^[\p{L}\p{M} '-]+$/u;

/** Title Case: first letter of every word upper, the rest lower. Collapses spaces. */
export function toTitleCase(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) =>
      word
        .split('-')
        .map((seg) => (seg ? seg.charAt(0).toLocaleUpperCase() + seg.slice(1).toLocaleLowerCase() : seg))
        .join('-'),
    )
    .join(' ');
}

export interface FieldResult {
  valid: boolean;
  error: string | null;
}

/**
 * @param value    raw input
 * @param label    field label for the message ("Full Name", "First Name", …)
 * @param opts.minParts  minimum number of name parts (2 for a full name field, 1 for First/Last)
 */
export function validateFullName(
  value: string,
  label = 'Full name',
  opts: { minParts?: number; required?: boolean } = {},
): FieldResult {
  const { minParts = 1, required = true } = opts;
  const raw = String(value ?? '');

  if (!raw.trim()) {
    return required ? { valid: false, error: `${label} is required.` } : { valid: true, error: null };
  }
  if (raw !== raw.trim()) {
    return { valid: false, error: `${label} must not start or end with a space.` };
  }
  if (/\s{2,}/.test(raw)) {
    return { valid: false, error: `${label} must not contain double spaces.` };
  }
  if (/\d/.test(raw)) {
    return { valid: false, error: `${label} must not contain numbers.` };
  }
  if (!NAME_ALLOWED_CHAR.test(raw)) {
    return { valid: false, error: `${label} may only contain letters, spaces, hyphens and apostrophes.` };
  }
  const parts = raw.split(' ').filter(Boolean);
  if (parts.length < minParts) {
    return {
      valid: false,
      error: minParts >= 2 ? `${label} must include at least a first and last name.` : `${label} is required.`,
    };
  }
  if (toTitleCase(raw) !== raw) {
    return { valid: false, error: `${label} must be in Title Case (e.g. Jay Kenneth Soriano).` };
  }
  return { valid: true, error: null };
}

// ── PH mobile number ─────────────────────────────────────────────────────
const PH_MOBILE_RE = /^09\d{9}$/;

/** Digits only from any user input (strips spaces, +63 prefix → 0). */
export function normalizeMobile(value: string): string {
  let d = String(value ?? '').replace(/\D/g, '');
  if (d.startsWith('63') && d.length === 12) d = `0${d.slice(2)}`;
  if (d.startsWith('9') && d.length === 10) d = `0${d}`;
  return d;
}

export function validateMobileNumber(
  value: string,
  label = 'Mobile number',
  opts: { required?: boolean } = {},
): FieldResult {
  const { required = true } = opts;
  const raw = String(value ?? '').trim();
  if (!raw) {
    return required ? { valid: false, error: `${label} is required.` } : { valid: true, error: null };
  }
  if (/[a-zA-Z]/.test(raw)) {
    return { valid: false, error: `${label} must not contain letters.` };
  }
  if (/[^\d\s+()-]/.test(raw)) {
    return { valid: false, error: `${label} must contain digits only.` };
  }
  if (!PH_MOBILE_RE.test(normalizeMobile(raw))) {
    return { valid: false, error: `Enter a valid Philippine mobile number (09XXXXXXXXX, 11 digits).` };
  }
  return { valid: true, error: null };
}

// ── Birthdate / age ──────────────────────────────────────────────────────
export const MIN_ENROLL_AGE = 2;   // years — must be at least this old
export const MAX_ENROLL_AGE = 18;  // years — reasonable upper bound for the programs
// Plausibility bound for a human birthdate — only catches typos (e.g. year 0111).
const MAX_REALISTIC_AGE = 120;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A birthdate is a calendar date, not an instant. `new Date('2024-09-07')` is
 * parsed by JS as UTC midnight, which lands on the previous/next local day
 * depending on the timezone — so parse bare YYYY-MM-DD as LOCAL midnight.
 */
export function parseBirthdate(birthdate: string | Date): Date {
  if (birthdate instanceof Date) return new Date(birthdate.getTime());
  const raw = String(birthdate ?? '').trim();
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (bare) return new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]));
  return new Date(raw);
}

/**
 * Decimal age in years, using real calendar anniversaries. Returns NaN for an
 * invalid date, negative for a future one.
 *
 * A naive `elapsedMs / (365.25 days)` is WRONG at every birthday: two calendar
 * years is 730 days but 2 × 365.25 = 730.5, so a child on their exact 2nd
 * birthday came out as 1.9997 and failed every `age >= 2` check — which is what
 * kept 2-year-olds out of Toddlers Playgroup. Here the whole part is the number
 * of birthdays passed, so "exactly N years old today" is always >= N.
 *
 * Mirrors backend/utils/ageEligibility.js `computeAge`.
 */
export function computeAgeYears(birthdate: string | Date): number {
  if (!birthdate) return NaN;
  const birth = parseBirthdate(birthdate);
  if (Number.isNaN(birth.getTime())) return NaN;
  const now = new Date();
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

/** "2 yrs 3 mos" */
export function formatAge(birthdate: string | Date): string {
  const birth = parseBirthdate(birthdate);
  if (Number.isNaN(birth.getTime())) return '';
  const now = new Date();
  let years = now.getFullYear() - birth.getFullYear();
  let months = now.getMonth() - birth.getMonth();
  if (now.getDate() < birth.getDate()) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (years < 0) return '';
  const parts: string[] = [];
  if (years > 0) parts.push(`${years} yr${years !== 1 ? 's' : ''}`);
  if (months > 0) parts.push(`${months} mo${months !== 1 ? 's' : ''}`);
  return parts.length ? parts.join(' ') : 'less than 1 month';
}

export interface AgeResult extends FieldResult {
  ageYears: number;
  ageLabel: string;
  eligible: boolean;
}

/** YYYY-MM-DD in LOCAL time (toISOString() would shift the day by the UTC offset). */
function toIsoDate(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Earliest birthdate allowed in a <input type="date">. "Up to 18" runs through
 * the whole 18th year, so the bound is the day after the 19th birthday.
 */
export function birthdateMin(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - (MAX_ENROLL_AGE + 1));
  d.setDate(d.getDate() + 1);
  return toIsoDate(d);
}
/** Latest birthdate allowed — the child's 2nd birthday is today (still eligible). */
export function birthdateMax(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - MIN_ENROLL_AGE);
  return toIsoDate(d);
}

export function validateBirthdate(birthdate: string): AgeResult {
  const base = { ageYears: NaN, ageLabel: '', eligible: false };
  if (!birthdate) return { ...base, valid: false, error: 'Birthdate is required.' };

  const birth = parseBirthdate(birthdate);
  if (Number.isNaN(birth.getTime())) {
    return { ...base, valid: false, error: 'Enter a valid birthdate.' };
  }
  const now = new Date();
  if (birth > now) {
    return { ...base, valid: false, error: 'Birthdate cannot be in the future.' };
  }
  // Sanity bound only (catches typos like year 0111). A merely too-old student
  // falls through to the age-range message below, which is far clearer.
  const earliest = new Date();
  earliest.setFullYear(earliest.getFullYear() - MAX_REALISTIC_AGE);
  if (birth < earliest) {
    return { ...base, valid: false, error: 'Birthdate is not realistic. Please check the year.' };
  }

  const ageYears = computeAgeYears(birthdate);
  const ageLabel = formatAge(birthdate);

  if (ageYears < MIN_ENROLL_AGE) {
    return { ageYears, ageLabel, eligible: false, valid: false, error: `Student must be at least ${MIN_ENROLL_AGE} years old to enroll.` };
  }
  // "up to 18" runs through the whole 18th year — an 18-year-old can still enroll.
  if (Math.floor(ageYears) > MAX_ENROLL_AGE) {
    return { ageYears, ageLabel, eligible: false, valid: false, error: `Enrollment is for students up to ${MAX_ENROLL_AGE} years old.` };
  }
  return { ageYears, ageLabel, eligible: true, valid: true, error: null };
}

// ── File upload ──────────────────────────────────────────────────────────
export const ENROLLMENT_FILE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'] as const;
export const ENROLLMENT_FILE_ACCEPT = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf';
export const MAX_ENROLLMENT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

export function validateEnrollmentFile(file: File): FieldResult {
  const okType =
    (ENROLLMENT_FILE_TYPES as readonly string[]).includes(file.type) ||
    /\.(jpe?g|png|pdf)$/i.test(file.name);
  if (!okType) {
    return { valid: false, error: 'Only JPG, JPEG, PNG or PDF files are accepted.' };
  }
  if (file.size > MAX_ENROLLMENT_FILE_BYTES) {
    return { valid: false, error: 'File is too large. Maximum size is 5 MB.' };
  }
  return { valid: true, error: null };
}
