/**
 * Shared types for the Bee Bright Enrollment Wizard.
 */
import type { PricingPackage } from '@/services/api';

export interface SelectedPackage {
  programCode: string;
  packageSlug: string;
  displayName: string;
  price: number;       // priceFull from Pricing
  priceDown: number;   // 50% down
  paymentOption: 'full' | 'down';
  durationDesc: string;
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
  preferredStartDate: '', preferredTime: 'no_preference',

  // Step 8
  guardianName: '', guardianPhone: '', guardianEmail: '',
  alternateGuardianName: '', alternateGuardianPhone: '',

  // Step 9
  allergies: '', medications: '', specialNeeds: false, specialNeedsDetails: '', emergencyContact: '',

  // Step 10
  paymentMethod: 'gcash', proofDataUrl: null, proofFileName: null, payerReference: '',

  // Step 11
  consentItems: DEFAULT_CONSENT_ITEMS.map((c) => ({ ...c, accepted: false })),
  consentVersion: '1.0',

  // Result
  submittedEnrollmentId: null, submittedPaymentId: null, submittedAmountDue: null,
};

// ── Age eligibility (mirrors backend/utils/ageEligibility.js) ─────────────
// Only 3 active programs per brochure.
export const PROGRAM_ELIGIBILITY: Record<string, { min: number; max: number | null; label: string }> = {
  TPG101: { min: 1.5, max: 3,    label: 'Toddlers Playgroup' },
  ACT102: { min: 2,   max: null, label: 'Academic Tutorial' },
  EXP106: { min: 3,   max: null, label: 'Examination Preparation' },
};

export function computeAgeYears(birthdate: string): number {
  if (!birthdate) return 0;
  const birth = new Date(birthdate);
  const now = new Date();
  return (now.getTime() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
}

export function formatAge(birthdate: string): string {
  if (!birthdate) return '';
  const birth = new Date(birthdate);
  const now = new Date();
  let years = now.getFullYear() - birth.getFullYear();
  let months = now.getMonth() - birth.getMonth();
  if (months < 0) { years--; months += 12; }
  if (now.getDate() < birth.getDate()) months--;
  if (months < 0) { years--; months += 12; }
  const parts: string[] = [];
  if (years > 0) parts.push(`${years} yr${years !== 1 ? 's' : ''}`);
  if (months > 0) parts.push(`${months} mo${months !== 1 ? 's' : ''}`);
  return parts.length ? parts.join(' ') : 'less than 1 month';
}

export function checkProgramEligibility(
  programCode: string,
  ageYears: number
): { eligible: boolean; reason: string | null } {
  const rule = PROGRAM_ELIGIBILITY[programCode];
  if (!rule) return { eligible: true, reason: null };
  if (ageYears < rule.min) {
    const minLabel =
      rule.min % 1 !== 0
        ? `${rule.min} yrs (${Math.floor(rule.min * 12)} months)`
        : `${rule.min} years old`;
    return { eligible: false, reason: `${rule.label} requires minimum age of ${minLabel}.` };
  }
  if (rule.max !== null && ageYears > rule.max + 0.5) {
    return { eligible: false, reason: `${rule.label} is for children up to ${rule.max} years old.` };
  }
  return { eligible: true, reason: null };
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

/** Max file size for document uploads in Step 1 (10 MB) */
export const MAX_DOC_BYTES = 10 * 1024 * 1024;
export const ALLOWED_DOC_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
