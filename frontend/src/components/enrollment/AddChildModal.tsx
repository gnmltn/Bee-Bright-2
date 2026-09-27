/**
 * "+ Add Child" — a NEW child enrolling from the parent dashboard. Rendered in-dashboard as a
 * modal and built from the SAME step components as the main enrollment wizard
 * (EnrollmentWizard.tsx) and RenewProgramModal, so the flows can't drift apart:
 *
 *   documents → child info → programs → [assessment] → schedule preference → health →
 *   billing/payment → agreement → final review (summary of the whole form) → submit
 *
 * - The parent is already logged in: no account / e-mail-verification steps, and the parent's
 *   own registered phone is the emergency contact (no separate field).
 * - The assessment step only exists for programs that have one (Academic Tutorial /
 *   Examination Preparation) — never for Toddlers Playgroup.
 * - Schedule preference collects the same start date / time slot / available days as the main
 *   flow, so the admin's enrollment-details popup shows them for added children too.
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { INITIAL_WIZARD_DATA, WizardData } from './wizard-types';
import { assessmentService, pricingService } from '@/services/api';
import { ASSESSMENT_ELIGIBLE_PROGRAM_CODES } from '@/constants/programs';

import Step1Requirements from './steps/Step1Requirements';
import Step5StudentInfo from './steps/Step5StudentInfo';
import Step6Programs from './steps/Step6Programs';
import StepAssessment from './steps/StepAssessment';
import Step7Schedule from './steps/Step7Schedule';
import Step9Health from './steps/Step9Health';
import Step10Billing from './steps/Step10Billing';
import Step11Consent from './steps/Step11Consent';
import Step12Review from './steps/Step12Review';

/** Pre-fill for resubmitting a rejected enrollment. */
export type AddChildPrefill = {
  firstName: string;
  middleName?: string;
  lastName: string;
  birthdate: string;
  /** Display name of the package the rejected enrollment was for, to pre-select the same one. */
  packageDisplayName?: string;
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill?: AddChildPrefill | null;
  /** Called once the enrollment is submitted, after the modal closes itself. */
  onEnrolled: (enrollmentId: string) => void;
}

type StepDef = { id: string; label: string };

const BASE_STEPS: StepDef[] = [
  { id: 'requirements', label: 'Documents' },
  { id: 'student', label: 'Child Information' },
  { id: 'programs', label: 'Programs' },
  { id: 'schedule', label: 'Schedule Preference' },
  { id: 'health', label: 'Health' },
  { id: 'billing', label: 'Billing' },
  { id: 'agreement', label: 'Agreement' },
  { id: 'review', label: 'Final Review' },
];

export default function AddChildModal({ open, onOpenChange, prefill, onEnrolled }: Props) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [step, setStep] = useState(1);
  const [includeAssessment, setIncludeAssessment] = useState(false);
  const [data, setData] = useState<WizardData>(INITIAL_WIZARD_DATA);
  const [submitting, setSubmitting] = useState(false);

  // Every open starts from a blank form (plus the parent's own details, and the rejected
  // enrollment's child info on a resubmission) — nothing leaks from an abandoned attempt.
  useEffect(() => {
    if (!open) return;
    const parentName = [user?.firstName, user?.middleName, user?.lastName].filter(Boolean).join(' ').trim();
    const parentEmail = user?.email || '';
    const parentPhone = user?.phone || '';
    setData({
      ...INITIAL_WIZARD_DATA,
      parentName,
      parentFirstName: user?.firstName || '',
      parentMiddleName: (user as { middleName?: string } | null)?.middleName || '',
      parentLastName: user?.lastName || '',
      parentEmail,
      parentMobile: parentPhone,
      guardianName: user?.guardianName || parentName,
      guardianPhone: user?.guardianPhone || parentPhone,
      guardianEmail: parentEmail,
      // The parent's own registered phone serves as the emergency contact.
      emergencyContact: parentPhone,
      studentFirstName: prefill?.firstName || '',
      studentMiddleName: prefill?.middleName || '',
      studentLastName: prefill?.lastName || '',
      birthdate: prefill?.birthdate ? prefill.birthdate.slice(0, 10) : '',
    });
    setStep(1);
    setIncludeAssessment(false);

    if (prefill?.packageDisplayName) {
      pricingService.getAll().then((res) => {
        const match = res.data.pricing.find((p) => p.displayName === prefill.packageDisplayName);
        if (!match) return;
        setData((prev) => ({
          ...prev,
          selectedPackages: [{
            programCode: match.programCode,
            packageSlug: match.packageSlug,
            displayName: match.displayName,
            price: match.priceFull,
            priceDown: match.priceDown ?? Math.ceil(match.priceFull * 0.5),
            paymentOption: 'down',
            durationDesc: match.durationDesc || '',
            sessionCount: match.sessionCount ?? null,
          }],
        }));
      }).catch(() => { /* the parent simply picks a package again */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill]);

  const selectedProgramCodes = data.selectedPackages.map((p) => p.programCode);
  const programCodesKey = [...selectedProgramCodes].sort().join(',');

  // The assessment step exists only when a chosen program has an assessment form to fill in.
  useEffect(() => {
    if (!open) return;
    const applicable = selectedProgramCodes.filter((code) => ASSESSMENT_ELIGIBLE_PROGRAM_CODES.has(code));
    if (applicable.length === 0) {
      setIncludeAssessment(false);
      // Playgroup (or nothing yet): make sure no stale assessment answers are submitted.
      setData((prev) => (prev.assessmentApplicable === null ? prev : {
        ...prev,
        assessmentApplicable: null,
        assessmentTemplateId: null,
        assessmentSkipReason: '',
        assessmentInfoValues: {},
        assessmentRatings: {},
        assessmentRemarks: '',
        assessmentGoals: [],
        assessmentAssessedBy: '',
        assessmentSnapshot: null,
      }));
      return;
    }
    let cancelled = false;
    assessmentService
      .getTemplates(applicable)
      .then((res) => { if (!cancelled) setIncludeAssessment((res.data?.templates?.length || 0) > 0); })
      .catch(() => { if (!cancelled) setIncludeAssessment(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, programCodesKey]);

  const steps = useMemo<StepDef[]>(() => {
    if (!includeAssessment) return BASE_STEPS;
    const copy = [...BASE_STEPS];
    const at = copy.findIndex((s) => s.id === 'programs');
    copy.splice(at + 1, 0, { id: 'assessment', label: 'Assessment' });
    return copy;
  }, [includeAssessment]);

  useEffect(() => {
    if (step > steps.length) setStep(steps.length);
  }, [steps.length, step]);

  const currentStepId = steps[step - 1]?.id || 'requirements';

  const update = useCallback((partial: Partial<WizardData>) => {
    setData((prev) => ({ ...prev, ...partial }));
  }, []);

  const goNext = useCallback(() => setStep((s) => Math.min(s + 1, steps.length)), [steps.length]);
  const goPrev = useCallback(() => setStep((s) => Math.max(s - 1, 1)), []);

  const handleEnrolled = useCallback((enrollmentId: string) => {
    onOpenChange(false);
    onEnrolled(enrollmentId);
  }, [onOpenChange, onEnrolled]);

  const progressPct = Math.round(((step - 1) / Math.max(1, steps.length - 1)) * 100);
  const stepProps = { data, update, onNext: goNext, onBack: goPrev, submitting, setSubmitting, onEnrolled: handleEnrolled, toast, keepSessionToken: true };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Child</DialogTitle>
          <DialogDescription>
            Step {step} of {steps.length}: {steps[step - 1]?.label}. This creates an enrollment under your account, not another login account.
          </DialogDescription>
        </DialogHeader>

        <div className="mb-2">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>

        <div className="pt-1">
          {currentStepId === 'requirements' && <Step1Requirements {...stepProps} addChild />}
          {currentStepId === 'student' && <Step5StudentInfo {...stepProps} />}
          {currentStepId === 'programs' && <Step6Programs {...stepProps} />}
          {currentStepId === 'assessment' && <StepAssessment {...stepProps} />}
          {currentStepId === 'schedule' && <Step7Schedule {...stepProps} />}
          {currentStepId === 'health' && <Step9Health {...stepProps} hideEmergencyContact />}
          {currentStepId === 'billing' && <Step10Billing {...stepProps} />}
          {currentStepId === 'agreement' && <Step11Consent {...stepProps} />}
          {currentStepId === 'review' && <Step12Review {...stepProps} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
