import { useState } from 'react';
import { CheckCircle2, Send, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';
import { computeTotalFee, formatAge } from '../wizard-types';
import { PROGRAM_LABELS } from '@/constants/programs';
import { enrollmentService } from '@/services/api';
import { EnrollmentAssessmentView } from '@/components/enrollment/EnrollmentAssessmentView';

interface Props {
  data: WizardData; update: (p: Partial<WizardData>) => void;
  onBack: () => void; onNext: () => void;
  submitting: boolean; setSubmitting: (v: boolean) => void;
  onEnrolled: (enrollmentId: string) => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
  /**
   * True when the caller is an already-logged-in parent with a real persistent
   * session (e.g. RenewProgramModal, or EnrollmentWizard's addChildMode) rather
   * than a brand-new signup whose sessionStorage 'token' is only a short-lived,
   * enrollment-scoped credential. Defaults to false (the original brand-new-
   * enrollee behavior below, which clears that token after submission).
   */
  keepSessionToken?: boolean;
}

const METHOD_LABELS: Record<string, string> = { gcash: 'GCash', maribank: 'MariBank', bdo: 'BDO' };

export default function Step12Review({ data, update, onBack, submitting, setSubmitting, onEnrolled, toast, keepSessionToken }: Props) {
  const amountDue = computeTotalFee(data.selectedPackages); // always 50% down

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      // Build payload
      const payload = {
        packages: data.selectedPackages.map((p) => ({
          programCode: p.programCode, packageSlug: p.packageSlug,
          displayName: p.displayName, price: p.price, paymentOption: data.paymentOption,
        })),
        paymentOption: data.paymentOption,
        paymentMethod: data.paymentMethod,
        studentFirstName: data.studentFirstName,
        studentLastName: data.studentLastName,
        studentMiddleName: data.studentMiddleName || undefined,
        birthdate: data.birthdate,
        renewalOfEnrollmentId: data.renewalOfEnrollmentId || undefined,
        requirementDocuments: {
          birthCertificate: data.docBirthCertificate ? { dataUrl: data.docBirthCertificate.dataUrl, fileName: data.docBirthCertificate.fileName } : undefined,
          studentPhoto: data.docStudentPhoto ? { dataUrl: data.docStudentPhoto.dataUrl, fileName: data.docStudentPhoto.fileName } : undefined,
          guardianId: data.docGuardianId ? { dataUrl: data.docGuardianId.dataUrl, fileName: data.docGuardianId.fileName } : undefined,
        },
        preferredStartDate: data.preferredStartDate || undefined,
        preferredDaysByProgram: data.preferredDaysByProgram.length > 0 ? data.preferredDaysByProgram : undefined,
        preferredSlots: (data.preferredSlots ?? []).length > 0
          ? data.preferredSlots.map((s) => ({ programCode: s.programCode, startTime: s.startTime, endTime: s.endTime }))
          : undefined,
        allergies: data.allergies || undefined,
        medications: data.medications || undefined,
        specialNeeds: data.specialNeeds,
        specialNeedsDetails: data.specialNeedsDetails || undefined,
        emergencyContact: data.emergencyContact || undefined,
        consentVersion: data.consentVersion,
        consentItems: data.consentItems,
        // The payment proof is submitted WITH the enrollment: the parent account, the
        // enrollment and the proof are all created together at this one point.
        proofDataUrl: data.proofDataUrl || undefined,
        payerReference: data.payerReference || undefined,
        assessment: data.assessmentApplicable === null ? undefined : {
          applicable: data.assessmentApplicable,
          skipReason: data.assessmentSkipReason || undefined,
          templateId: data.assessmentTemplateId || undefined,
          infoValues: data.assessmentInfoValues,
          ratings: data.assessmentRatings,
          remarks: data.assessmentRemarks,
          goals: data.assessmentGoals,
          assessedBy: data.assessmentAssessedBy,
        },
      };

      const res = await enrollmentService.submitWizard(payload);
      const { enrollmentId, paymentId, permanentStudentId } = res.data;

      update({ submittedEnrollmentId: enrollmentId, submittedPaymentId: paymentId, submittedAmountDue: amountDue });
      if (!keepSessionToken) {
        // Clear the enrollment-scoped token from sessionStorage — it was only needed for submission
        try { window.sessionStorage.removeItem('token'); } catch { /* ignore */ }
      }
      toast({ title: '🎉 Enrollment submitted!', description: `Your Student ID is ${permanentStudentId || enrollmentId}. Check your email for confirmation.` });
      onEnrolled(enrollmentId);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Submission failed. Please try again.';
      toast({ title: 'Submission failed', description: msg, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="space-y-2">
      <p className="font-semibold text-foreground text-sm border-b border-border pb-1">{title}</p>
      {children}
    </div>
  );

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
        <p className="text-muted-foreground text-sm mt-1">Review all information before submitting. This cannot be undone.</p>
      </div>

      <div className="space-y-5 bg-muted/30 rounded-xl p-4 border border-border">
        <Section title="Parent / Guardian">
          <Row label="Name" value={data.parentName} />
          <Row label="Email" value={data.parentEmail} />
          <Row label="Mobile" value={data.parentMobile} />
        </Section>

        <Section title="Student">
          <Row label="Name" value={`${data.studentFirstName} ${data.studentMiddleName || ''} ${data.studentLastName}`.replace(/\s+/g, ' ').trim()} />
          <Row label="Birthdate" value={data.birthdate ? new Date(data.birthdate).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'} />
          <Row label="Age" value={data.birthdate ? formatAge(data.birthdate) : '—'} />
        </Section>

        <Section title="Selected Programs">
          {data.selectedPackages.map((p) => (
            <div key={`${p.programCode}-${p.packageSlug}`} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{p.displayName}</span>
              <span className="font-medium">₱{p.priceDown.toLocaleString()}</span>
            </div>
          ))}
          <div className="flex justify-between font-bold text-sm pt-2 border-t border-border">
            <span>Amount Due Now (50% Down Payment)</span>
            <span className="text-amber-600">₱{amountDue.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-xs text-muted-foreground pt-1">
            <span>Remaining balance (after mid-session)</span>
            <span>₱{(data.selectedPackages.reduce((s, p) => s + p.price, 0) - amountDue).toLocaleString()}</span>
          </div>
        </Section>

        <Section title="Payment">
          <Row label="Method" value={METHOD_LABELS[data.paymentMethod] || data.paymentMethod} />
          <Row label="Proof" value={data.proofFileName || (data.proofDataUrl ? 'Uploaded' : 'Not uploaded')} />
          <Row label="Reference No." value={data.payerReference || 'N/A'} />
        </Section>

        <Section title="Schedule Preference">
          <Row label="Preferred Start" value={data.preferredStartDate ? new Date(data.preferredStartDate).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'} />
          {data.preferredDaysByProgram.length > 0 ? (
            data.preferredDaysByProgram.map((p) => (
              <Row
                key={p.programCode}
                label={`Available Days — ${PROGRAM_LABELS[p.programCode] || p.programCode}`}
                value={p.days.length > 0 ? p.days.join(', ') : 'Any available weekday'}
              />
            ))
          ) : (
            <Row label="Available Days" value="Any available weekday" />
          )}
          {(data.preferredSlots ?? []).length > 0 && (
            <Row
              label="Preferred Slot"
              value={data.preferredSlots!.map((s) => `${s.label} (${s.programCode})`).join(', ')}
            />
          )}
        </Section>

        {data.assessmentApplicable !== null && (
          <Section title="Pre-Enrollment Assessment">
            <EnrollmentAssessmentView
              assessment={{
                applicable: data.assessmentApplicable,
                skipReason: data.assessmentSkipReason,
                templateId: data.assessmentTemplateId,
                snapshot: data.assessmentSnapshot || undefined,
                templateTitle: data.assessmentSnapshot?.title,
                infoValues: data.assessmentInfoValues,
                ratings: data.assessmentRatings,
                remarks: data.assessmentRemarks,
                goals: data.assessmentGoals,
                assessedBy: data.assessmentAssessedBy,
              }}
              compact
            />
          </Section>
        )}
      </div>

      <div className="p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 rounded-lg flex gap-2 text-xs text-blue-800 dark:text-blue-300">
        <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5 text-blue-500" />
        By submitting, you confirm all information is accurate and you have accepted the Participation Agreement.
        You will receive a confirmation email with your Enrollment ID.
      </div>

      <div className="flex items-center justify-between pt-4 border-t border-border">
        <Button variant="outline" onClick={onBack} disabled={submitting} className="gap-1">Back</Button>
        <Button
          onClick={handleSubmit} disabled={submitting}
          className="gap-2 bg-amber-500 hover:bg-amber-600 text-white min-w-[180px]"
        >
          {submitting ? <><Loader2 className="h-4 w-4 animate-spin" /> Submitting…</> : <><Send className="h-4 w-4" /> Submit Enrollment</>}
        </Button>
      </div>
    </div>
  );
}
