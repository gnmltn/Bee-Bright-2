/**
 * Shared types for the Bee Bright Enrollment Wizard.
 */
import type { AssessmentTemplate } from './assessment-types';

export interface SelectedPackage {
  programCode: string;
  packageSlug: string;
  displayName: string;
  price: number;       // priceFull from Pricing
  priceDown: number;   // 50% down
  paymentOption: 'full' | 'down';
  durationDesc: string;
  /** How many sessions this package covers — used by scheduler for slot generation. */
  sessionCount: number | null;
}

export interface ConsentItem {
  name: string;
  label: string;
  accepted: boolean;
  version: string;
}

/** One uploaded document — stored as base64 data URL */
export interface UploadedDoc {
  dataUrl: string;
  fileName: string;
  fileSize: number; // bytes
}

export interface WizardData {
  // ── Step 1 – Requirements / document uploads ──────────────────────────
  docBirthCertificate: UploadedDoc | null;
  docStudentPhoto: UploadedDoc | null;
  docGuardianId: UploadedDoc | null;

  // ── Step 2 – Parent registration ──────────────────────────────────────
  parentName: string;
  parentEmail: string;
  parentMobile: string;
  parentPassword: string;
  parentId: string | null;
  enrollmentToken: string | null;

  // ── Step 5 – Student info ─────────────────────────────────────────────
  studentFirstName: string;
  studentMiddleName: string;
  studentLastName: string;
  birthdate: string; // YYYY-MM-DD

  // ── Step 6 – Program selection ────────────────────────────────────────
  selectedPackages: SelectedPackage[];
  // Payment is always 50% down — second half due after half the sessions are completed.
  // 'full' kept in the type only for legacy data compatibility; UI always uses 'down'.
  paymentOption: 'down';

  // ── Step 7 – Preferred schedule ───────────────────────────────────────
  preferredStartDate: string;
  preferredTime: 'morning' | 'afternoon' | 'no_preference';
  /**
   * Days of the week the child is available.
   * Values: 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday'
   * Empty array = no preference (any weekday).
   */
  preferredDays: string[];

  // ── Step 8 – Guardian info ────────────────────────────────────────────
  guardianName: string;
  guardianPhone: string;
  guardianEmail: string;
  alternateGuardianName: string;
  alternateGuardianPhone: string;

  // ── Step 9 – Health & learning ────────────────────────────────────────
  allergies: string;
  medications: string;
  specialNeeds: boolean;
  specialNeedsDetails: string;
  emergencyContact: string;

  // ── Conditional – Pre-enrollment assessment (Academic Tutorial K / Grade 1) ──
  assessmentApplicable: boolean | null;
  assessmentTemplateId: string | null;
  assessmentSkipReason: string;
  assessmentInfoValues: Record<string, string>;
  assessmentRatings: Record<string, string>;
  assessmentRemarks: string;
  assessmentGoals: { goal: string; timeline: string }[];
  assessmentAssessedBy: string;
  assessmentSnapshot: AssessmentTemplate | null;

  // ── Step 10 – Billing ─────────────────────────────────────────────────
  paymentMethod: 'gcash' | 'seabank' | 'bdo';
  proofDataUrl: string | null;   // base64 payment receipt
  proofFileName: string | null;
  payerReference: string;

  // ── Step 11 – Participation agreement ────────────────────────────────
  consentItems: ConsentItem[];
  consentVersion: string;

  // ── Submission result ─────────────────────────────────────────────────
  submittedEnrollmentId: string | null;
  submittedPaymentId: string | null;
  submittedAmountDue: number | null;
}

export const DEFAULT_CONSENT_ITEMS: Omit<ConsentItem, 'accepted'>[] = [
  { name: 'participation_agreement', label: 'Participation Agreement – I agree to the terms of student participation.', version: '1.0' },
  { name: 'data_privacy',            label: 'Data Privacy – I consent to the collection and use of personal data for enrollment purposes.', version: '1.0' },
  { name: 'medical_consent',         label: 'Medical Consent – I authorize the center to administer first-aid in case of emergency.', version: '1.0' },
  { name: 'parent_responsibilities', label: 'Parent Responsibilities – I understand and accept the responsibilities outlined in the agreement.', version: '1.0' },
  { name: 'information_accuracy',    label: 'Information Accuracy – I confirm that all information provided is accurate and truthful.', version: '1.0' },
];

export const INITIAL_WIZARD_DATA: WizardData = {
  // Step 1 documents
  docBirthCertificate: null,
  docStudentPhoto: null,
  docGuardianId: null,

  // Step 2
  parentName: '', parentEmail: '', parentMobile: '', parentPassword: '',
  parentId: null, enrollmentToken: null,

  // Step 5
  studentFirstName: '', studentMiddleName: '', studentLastName: '', birthdate: '',

  // Step 6 — always 50% down payment
  selectedPackages: [], paymentOption: 'down' as const,

  // Step 7
  preferredStartDate: '', preferredTime: 'no_preference', preferredDays: [],

  // Step 8
  guardianName: '', guardianPhone: '', guardianEmail: '',
  alternateGuardianName: '', alternateGuardianPhone: '',

  // Step 9
  allergies: '', medications: '', specialNeeds: false, specialNeedsDetails: '', emergencyContact: '',

  assessmentApplicable: null,
  assessmentTemplateId: null,
  assessmentSkipReason: '',
  assessmentInfoValues: {},
  assessmentRatings: {},
  assessmentRemarks: '',
  assessmentGoals: [],
  assessmentAssessedBy: '',
  assessmentSnapshot: null,

  // Step 10
  paymentMethod: 'gcash', proofDataUrl: null, proofFileName: null, payerReference: '',

  // Step 11
  consentItems: DEFAULT_CONSENT_ITEMS.map((c) => ({ ...c, accepted: false })),
  consentVersion: '1.0',

  // Result
  submittedEnrollmentId: null, submittedPaymentId: null, submittedAmountDue: null,
};

// ── Age eligibility (mirrors backend/utils/ageEligibility.js) ─────────────
// Only 3 active programs. Toddlers Playgroup is ages 2–4 (owner-confirmed):
// eligible from the 2nd birthday through the whole 4th year, out at 5.
// General enrollment age range is 2–18 (see lib/enrollmentValidation.ts).
export const PROGRAM_ELIGIBILITY: Record<string, { min: number; max: number | null; label: string }> = {
  TPG101: { min: 2, max: 4,  label: 'Toddlers Playgroup' },
  ACT102: { min: 2, max: 18, label: 'Academic Tutorial' },
  EXP106: { min: 3, max: 18, label: 'Examination Preparation' },
};

// Age maths lives in ONE place. Re-exported here so the wizard steps can keep
// importing it from wizard-types — do not add a second copy.
export { computeAgeYears, formatAge, parseBirthdate } from '@/lib/enrollmentValidation';

/**
 * A program whose `max` is a small explicit upper bound is written as an age
 * BAND ("ages 2 to 4"). Purely a copy/message distinction — the comparison is
 * the same for every program. Programs whose `max` is just an upper cap
 * (Academic Tutorial / Exam Prep at 18) read as "up to N years old".
 */
function isAgeBand(rule: { max: number | null }): boolean {
  return rule.max !== null && rule.max <= 5;
}

export function checkProgramEligibility(
  programCode: string,
  ageYears: number
): { eligible: boolean; reason: string | null } {
  const rule = PROGRAM_ELIGIBILITY[programCode];
  if (!rule) return { eligible: true, reason: null };
  if (!Number.isFinite(ageYears) || ageYears <= 0) {
    return { eligible: false, reason: 'Enter a valid birthdate first.' };
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
 * birthday until the day before the 5th. Single shared check — mirrors
 * backend/utils/ageEligibility.js `isEligibleForToddlers`.
 */
export function isEligibleForToddlers(ageYears: number): boolean {
  return checkProgramEligibility('TPG101', ageYears).eligible;
}

// Payment is always 50% down — always use priceDown.
// The 'option' param is kept for backward compat but ignored.
export function computeTotalFee(packages: SelectedPackage[], _option?: 'full' | 'down'): number {
  return packages.reduce((s, p) => s + p.priceDown, 0);
}

export const PROGRAM_LABELS: Record<string, string> = {
  TPG101: 'Toddlers Playgroup',
  ACT102: 'Academic Tutorial',
  EXP106: 'Examination Preparation',
};

/** Max file size for document uploads (5 MB). See lib/enrollmentValidation.ts. */
export const MAX_DOC_BYTES = 5 * 1024 * 1024;
export const ALLOWED_DOC_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
