/**
 * Admin "Add Student" (walk-in) — Payments_FullyPaid_NewProgramRefinements_
 * AdminWalkIn.pdf Section E. A parent physically walks in; the admin runs them
 * through the same 7 steps as the self-service enrollment wizard, but ends with
 * a pay-on-site billing step (admin types the amount actually collected) instead
 * of a GCash/MariBank/BDO proof upload, and the enrollment is approved
 * immediately (no review queue — the admin already reviewed it live).
 *
 * Reuses Step2ParentAccount/Step3OtpVerify/Step5StudentInfo/Step6Programs/
 * Step7Schedule from the parent-facing wizard as-is, so this never drifts from
 * the rules those enforce (age eligibility, package pricing, etc). Both
 * Step2/Step3 get keepSessionToken=true so the admin's own session survives
 * creating and verifying a brand-new parent mid-flow.
 */
import { useState, useCallback, useEffect } from 'react';
import { Loader2, Send } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import StepNav from '@/components/enrollment/StepNav';
import { INITIAL_WIZARD_DATA, WizardData, computeTotalFee, formatAge, DEFAULT_CONSENT_ITEMS, PROGRAM_LABELS } from '@/components/enrollment/wizard-types';
import { enrollmentService } from '@/services/api';

import Step2ParentAccount from '@/components/enrollment/steps/Step2ParentAccount';
import Step3OtpVerify from '@/components/enrollment/steps/Step3OtpVerify';
import Step5StudentInfo from '@/components/enrollment/steps/Step5StudentInfo';
import Step6Programs from '@/components/enrollment/steps/Step6Programs';
import Step7Schedule from '@/components/enrollment/steps/Step7Schedule';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnrolled: () => void;
}

type StepDef = { id: string; label: string };

const STEPS: StepDef[] = [
  { id: 'account', label: 'Parent Account' },
  { id: 'verify', label: 'Verify Email' },
  { id: 'student', label: 'Student Info' },
  { id: 'programs', label: 'Programs' },
  { id: 'schedule', label: 'Schedule Pref' },
  { id: 'billing', label: 'Billing' },
  { id: 'review', label: 'Final Review' },
];

function AdminBillingStep({ data, amountPaid, setAmountPaid, onNext, onBack }: {
  data: WizardData; amountPaid: string; setAmountPaid: (v: string) => void; onNext: () => void; onBack: () => void;
}) {
  const totalFull = data.selectedPackages.reduce((s, p) => s + p.price, 0);
  const expectedDown = computeTotalFee(data.selectedPackages);
  const numeric = Number(amountPaid);
  const valid = Number.isFinite(numeric) && numeric > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Billing — Pay on Site</h2>
        <p className="text-muted-foreground text-sm mt-1">
          No online payment for a walk-in — type in the amount that was actually collected in person.
        </p>
      </div>

      <div className="p-4 bg-muted rounded-xl space-y-1">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Total package fee</span>
          <span className="font-semibold">₱{totalFull.toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Standard 50% down payment</span>
          <span className="font-semibold">₱{expectedDown.toLocaleString()}</span>
        </div>
      </div>

      <div className="space-y-1.5 max-w-xs">
        <Label htmlFor="admin-amount-paid">Amount Collected *</Label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">₱</span>
          <Input
            id="admin-amount-paid"
            type="number"
            min={1}
            step="1"
            className="pl-7"
            value={amountPaid}
            onChange={(e) => setAmountPaid(e.target.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Defaults to the standard 50% down payment — adjust if a different amount was actually handed over
          (e.g. the full price paid up front).
        </p>
      </div>

      <StepNav onBack={onBack} onNext={onNext} disableNext={!valid} />
    </div>
  );
}

function AdminReviewStep({
  data, amountPaid, parentAgreed, setParentAgreed, submitting, onBack, onSubmit,
}: {
  data: WizardData; amountPaid: string; parentAgreed: boolean; setParentAgreed: (v: boolean) => void;
  submitting: boolean; onBack: () => void; onSubmit: () => void;
}) {
  const totalFull = data.selectedPackages.reduce((s, p) => s + p.price, 0);
  const numericPaid = Number(amountPaid) || 0;

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right max-w-[60%]">{value || '—'}</span>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Final Review</h2>
        <p className="text-muted-foreground text-sm mt-1">Double-check everything before finalizing this walk-in enrollment.</p>
      </div>

      <div className="space-y-4 bg-muted/30 rounded-xl p-4 border border-border">
        <div className="space-y-1.5">
          <p className="font-semibold text-sm border-b border-border pb-1">Parent / Guardian</p>
          <Row label="Name" value={data.parentName} />
          <Row label="Email" value={data.parentEmail} />
          <Row label="Mobile" value={data.parentMobile} />
        </div>
        <div className="space-y-1.5">
          <p className="font-semibold text-sm border-b border-border pb-1">Student</p>
          <Row label="Name" value={`${data.studentFirstName} ${data.studentMiddleName || ''} ${data.studentLastName}`.replace(/\s+/g, ' ').trim()} />
          <Row label="Age" value={data.birthdate ? formatAge(data.birthdate) : '—'} />
        </div>
        <div className="space-y-1.5">
          <p className="font-semibold text-sm border-b border-border pb-1">Programs</p>
          {data.selectedPackages.map((p) => (
            <div key={`${p.programCode}-${p.packageSlug}`} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{PROGRAM_LABELS[p.programCode] || p.programCode} — {p.displayName}</span>
              <span className="font-medium">₱{p.price.toLocaleString()}</span>
            </div>
          ))}
          <div className="flex justify-between text-sm font-bold pt-1 border-t border-border">
            <span>Total package fee</span>
            <span>₱{totalFull.toLocaleString()}</span>
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="font-semibold text-sm border-b border-border pb-1">Schedule Preference</p>
          <Row label="Preferred Start" value={data.preferredStartDate ? new Date(data.preferredStartDate).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'} />
          {data.preferredDaysByProgram.map((p) => (
            <Row key={p.programCode} label={`Days — ${PROGRAM_LABELS[p.programCode] || p.programCode}`} value={p.days.length > 0 ? p.days.join(', ') : 'Any available weekday'} />
          ))}
        </div>
        <div className="space-y-1.5">
          <p className="font-semibold text-sm border-b border-border pb-1">Billing</p>
          <Row label="Payment method" value="Cash / pay on-site" />
          <div className="flex justify-between text-sm font-bold">
            <span>Amount collected</span>
            <span className="text-amber-600">₱{numericPaid.toLocaleString()}</span>
          </div>
          {numericPaid < totalFull && (
            <Row label="Remaining balance" value={`₱${(totalFull - numericPaid).toLocaleString()}`} />
          )}
        </div>
      </div>

      <label className="flex items-start gap-3 text-sm text-muted-foreground">
        <Checkbox checked={parentAgreed} onCheckedChange={(checked) => setParentAgreed(checked === true)} />
        <span>The parent/guardian, present in person, has reviewed and agreed to the Participation Agreement, Data Privacy, Medical Consent, Parent Responsibilities, and Information Accuracy terms.</span>
      </label>

      <div className="flex items-center justify-between pt-4 border-t border-border">
        <Button variant="outline" onClick={onBack} disabled={submitting}>Back</Button>
        <Button onClick={onSubmit} disabled={submitting || !parentAgreed} className="gap-2 bg-amber-500 hover:bg-amber-600 text-white min-w-[180px]">
          {submitting ? <><Loader2 className="h-4 w-4 animate-spin" /> Finalizing…</> : <><Send className="h-4 w-4" /> Finalize Enrollment</>}
        </Button>
      </div>
    </div>
  );
}

export default function AdminAddStudentWizard({ open, onOpenChange, onEnrolled }: Props) {
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [data, setData] = useState<WizardData>(INITIAL_WIZARD_DATA);
  const [amountPaid, setAmountPaid] = useState('');
  const [parentAgreed, setParentAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const reset = useCallback(() => {
    setStep(1);
    setData(INITIAL_WIZARD_DATA);
    setAmountPaid('');
    setParentAgreed(false);
  }, []);

  // Default the "amount collected" field to the standard 50% down payment
  // whenever the selected packages change, unless the admin already typed
  // something in (never clobber a manual edit).
  const expectedDown = computeTotalFee(data.selectedPackages);
  useEffect(() => {
    if (amountPaid === '' && expectedDown > 0) setAmountPaid(String(expectedDown));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expectedDown]);

  const update = useCallback((partial: Partial<WizardData>) => {
    setData((prev) => ({ ...prev, ...partial }));
  }, []);

  const goNext = useCallback(() => setStep((s) => Math.min(s + 1, STEPS.length)), []);
  const goBack = useCallback(() => setStep((s) => Math.max(s - 1, 1)), []);

  const handleClose = () => {
    if (submitting) return;
    reset();
    onOpenChange(false);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const consentItems = DEFAULT_CONSENT_ITEMS.map((c) => ({ ...c, accepted: true }));
      const res = await enrollmentService.adminWalkInEnroll({
        parentId: data.parentId!,
        packages: data.selectedPackages.map((p) => ({
          programCode: p.programCode, packageSlug: p.packageSlug, displayName: p.displayName, price: p.price, paymentOption: 'down',
        })),
        studentFirstName: data.studentFirstName,
        studentLastName: data.studentLastName,
        studentMiddleName: data.studentMiddleName || undefined,
        birthdate: data.birthdate,
        preferredStartDate: data.preferredStartDate || undefined,
        preferredDaysByProgram: data.preferredDaysByProgram.length > 0 ? data.preferredDaysByProgram : undefined,
        preferredSlots: (data.preferredSlots ?? []).length > 0
          ? data.preferredSlots!.map((s) => ({ programCode: s.programCode, startTime: s.startTime, endTime: s.endTime }))
          : undefined,
        consentVersion: '1.0',
        consentItems,
        amountPaid: Number(amountPaid),
      });
      if (res.data?.success) {
        toast({ title: 'Enrollment finalized', description: `Enrollment ID: ${res.data.enrollmentId}` });
        reset();
        onOpenChange(false);
        onEnrolled();
      } else {
        toast({ title: 'Failed to finalize', description: res.data?.message || 'Please try again.', variant: 'destructive' });
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Failed to finalize enrollment.';
      toast({ title: 'Failed to finalize', description: msg, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const currentStepId = STEPS[step - 1]?.id || 'account';
  const progressPct = Math.round(((step - 1) / Math.max(1, STEPS.length - 1)) * 100);
  const stepProps = { data, update, onNext: goNext, onBack: goBack, toast, keepSessionToken: true };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Student (Walk-in)</DialogTitle>
          <DialogDescription>
            Step {step} of {STEPS.length}: {STEPS[step - 1]?.label}. Creates a real parent account and an approved
            enrollment, same as a self-service enrollment.
          </DialogDescription>
        </DialogHeader>

        <div className="mb-2">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>

        <div className="pt-1">
          {currentStepId === 'account' && <Step2ParentAccount {...stepProps} />}
          {currentStepId === 'verify' && <Step3OtpVerify {...stepProps} />}
          {currentStepId === 'student' && <Step5StudentInfo {...stepProps} />}
          {currentStepId === 'programs' && <Step6Programs {...stepProps} />}
          {currentStepId === 'schedule' && <Step7Schedule {...stepProps} />}
          {currentStepId === 'billing' && (
            <AdminBillingStep data={data} amountPaid={amountPaid} setAmountPaid={setAmountPaid} onNext={goNext} onBack={goBack} />
          )}
          {currentStepId === 'review' && (
            <AdminReviewStep
              data={data} amountPaid={amountPaid} parentAgreed={parentAgreed} setParentAgreed={setParentAgreed}
              submitting={submitting} onBack={goBack} onSubmit={handleSubmit}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
