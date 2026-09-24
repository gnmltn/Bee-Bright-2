/**
 * "Renew / Add Program" — an EXISTING child enrolling in another program, launched
 * from a button on their card in StudentDashboard.tsx's "My Child" tab.
 *
 * Renders IN-DASHBOARD as a modal (NewProgram_Modal_AgeCheck_PaymentBug_
 * ContactTutor.pdf Section A — the earlier standalone-page version was wrong; the
 * parent must never be taken to a separate page for this). Reuses the exact same
 * Programs/Schedule/Billing/Agreement/Review step components as the main enrollment
 * wizard (EnrollmentWizard.tsx) so the two flows can't drift apart.
 *
 * No separate birthdate-confirmation step (Payments_FullyPaid_NewProgramRefinements_
 * AdminWalkIn.pdf C) — the child's stored birthdate never changes, only their age
 * does, and Step6Programs already recomputes age fresh from `data.birthdate` (set
 * below from the stored snapshot) on every render, so it's always accurate to the
 * moment the parent opens this modal without asking them to re-enter anything.
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { INITIAL_WIZARD_DATA, WizardData } from './wizard-types';
import { assessmentService } from '@/services/api';

import Step6Programs        from './steps/Step6Programs';
import StepAssessment       from './steps/StepAssessment';
import Step7Schedule        from './steps/Step7Schedule';
import Step10Billing        from './steps/Step10Billing';
import Step11Consent        from './steps/Step11Consent';
import Step12Review         from './steps/Step12Review';

export type RenewChildInfo = {
  studentFirstName: string;
  studentMiddleName: string;
  studentLastName: string;
  birthdate: string;
  allergies: string;
  medications: string;
  specialNeeds: boolean;
  specialNeedsDetails: string;
  emergencyContact: string;
  /** Program codes with unfinished (still active/approved) sessions — see Step6Programs' blockedPrograms prop. */
  blockedPrograms?: Record<string, string>;
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  child: RenewChildInfo | null;
  /** Called once the new enrollment is successfully submitted, after the modal closes itself. */
  onEnrolled: (enrollmentId: string) => void;
}

type StepDef = { id: string; label: string };

const BASE_STEPS: StepDef[] = [
  { id: 'programs', label: 'Programs' },
  { id: 'schedule', label: 'Schedule Pref' },
  { id: 'billing', label: 'Billing' },
  { id: 'agreement', label: 'Agreement' },
  { id: 'review', label: 'Final Review' },
];

export default function RenewProgramModal({ open, onOpenChange, child, onEnrolled }: Props) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [step, setStep] = useState(1);
  const [includeAssessment, setIncludeAssessment] = useState(false);
  const [data, setData] = useState<WizardData>(INITIAL_WIZARD_DATA);
  const [submitting, setSubmitting] = useState(false);

  // Fresh prefill every time the modal opens for a (possibly different) child —
  // never carry over a previous child's in-progress selections.
  useEffect(() => {
    if (!open || !child) return;
    const parentName = [user?.firstName, user?.middleName, user?.lastName].filter(Boolean).join(' ').trim();
    const parentEmail = user?.email || '';
    const parentPhone = user?.phone || '';
    setData({
      ...INITIAL_WIZARD_DATA,
      parentName,
      parentEmail,
      parentMobile: parentPhone,
      guardianName: user?.guardianName || parentName,
      guardianPhone: user?.guardianPhone || parentPhone,
      guardianEmail: parentEmail,
      studentFirstName: child.studentFirstName,
      studentMiddleName: child.studentMiddleName,
      studentLastName: child.studentLastName,
      birthdate: child.birthdate,
      allergies: child.allergies,
      medications: child.medications,
      specialNeeds: child.specialNeeds,
      specialNeedsDetails: child.specialNeedsDetails,
      emergencyContact: child.emergencyContact,
    });
    setStep(1);
    setIncludeAssessment(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, child]);

  const selectedProgramCodes = data.selectedPackages.map((p) => p.programCode);
  const relevantAssessmentCodes = new Set(['ACT102', 'EXP106']);
  const programCodesKey = selectedProgramCodes.sort().join(',');

  useEffect(() => {
    if (!open) return;
    const applicableCodes = selectedProgramCodes.filter((code) => relevantAssessmentCodes.has(code));
    if (applicableCodes.length === 0) {
      setIncludeAssessment(false);
      return;
    }
    assessmentService
      .getTemplates(applicableCodes)
      .then((res) => setIncludeAssessment((res.data?.templates?.length || 0) > 0))
      .catch(() => setIncludeAssessment(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, programCodesKey]);

  const steps = useMemo<StepDef[]>(() => {
    if (!includeAssessment) return BASE_STEPS;
    const copy = [...BASE_STEPS];
    const programsIndex = copy.findIndex((s) => s.id === 'programs');
    copy.splice(programsIndex + 1, 0, { id: 'assessment', label: 'Assessment' });
    return copy;
  }, [includeAssessment]);

  useEffect(() => {
    if (step > steps.length) setStep(steps.length);
  }, [steps.length, step]);

  const currentStepId = steps[step - 1]?.id || 'programs';

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
  const childName = child ? [child.studentFirstName, child.studentLastName].filter(Boolean).join(' ') : '';

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Program{childName ? ` for ${childName}` : ''}</DialogTitle>
          <DialogDescription>
            Step {step} of {steps.length}: {steps[step - 1]?.label}. This creates a new enrollment for {childName || 'this child'}, not another login account.
          </DialogDescription>
        </DialogHeader>

        <div className="mb-2">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>

        {child && (
          <div className="pt-1">
            {currentStepId === 'programs' && <Step6Programs {...stepProps} blockedPrograms={child.blockedPrograms} />}
            {currentStepId === 'assessment' && <StepAssessment {...stepProps} />}
            {currentStepId === 'schedule' && <Step7Schedule {...stepProps} />}
            {currentStepId === 'billing' && <Step10Billing {...stepProps} />}
            {currentStepId === 'agreement' && <Step11Consent {...stepProps} />}
            {currentStepId === 'review' && <Step12Review {...stepProps} />}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
