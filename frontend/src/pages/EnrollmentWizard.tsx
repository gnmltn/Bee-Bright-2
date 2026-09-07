/**
 * Bee Bright Enrollment Wizard — guided enrollment.
 * Route: /enroll
 * Assessment is inserted after program selection only when the selected programs
 * have an active assessment template in the database (Academic Tutorial K / Grade 1).
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { Layout } from '@/components/layout/Layout';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import {
  INITIAL_WIZARD_DATA, WizardData,
} from '@/components/enrollment/wizard-types';
import { assessmentService, enrollmentService } from '@/services/api';

import Step1Requirements   from '@/components/enrollment/steps/Step1Requirements';
import Step2ParentAccount  from '@/components/enrollment/steps/Step2ParentAccount';
import Step3OtpVerify      from '@/components/enrollment/steps/Step3OtpVerify';
import Step4Welcome        from '@/components/enrollment/steps/Step4Welcome';
import Step5StudentInfo    from '@/components/enrollment/steps/Step5StudentInfo';
import Step6Programs       from '@/components/enrollment/steps/Step6Programs';
import StepAssessment      from '@/components/enrollment/steps/StepAssessment';
import Step7Schedule       from '@/components/enrollment/steps/Step7Schedule';
import Step8Guardian       from '@/components/enrollment/steps/Step8Guardian';
import Step9Health         from '@/components/enrollment/steps/Step9Health';
import Step10Billing       from '@/components/enrollment/steps/Step10Billing';
import Step11Consent       from '@/components/enrollment/steps/Step11Consent';
import Step12Review        from '@/components/enrollment/steps/Step12Review';

const STORAGE_KEY = 'bb-enrollment-wizard-v1';

type StoredDraft = Partial<WizardData> & { step?: number; _serverInstanceId?: string | null };

// sessionStorage (NOT localStorage): a plain in-tab refresh keeps the parent on
// their step with data intact, but closing the tab/window — or restarting the
// dev server / machine (detected via the backend instanceId) — wipes the draft
// so they come back to a clean Step 1. Nothing is persisted server-side.
const wizardStore = {
  read(): StoredDraft | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  write(value: unknown) {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* quota */ }
  },
  clear() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY); // clean up any draft left by the old localStorage version
    } catch { /* ignore */ }
  },
};

type StepDef = { id: string; label: string };

const BASE_STEPS: StepDef[] = [
  { id: 'requirements', label: 'Requirements' },
  { id: 'account', label: 'Account' },
  { id: 'verify', label: 'Verify Email' },
  { id: 'welcome', label: 'Welcome' },
  { id: 'student', label: 'Student Info' },
  { id: 'programs', label: 'Programs' },
  { id: 'schedule', label: 'Schedule Pref' },
  { id: 'guardian', label: 'Guardian' },
  { id: 'health', label: 'Health' },
  { id: 'billing', label: 'Billing' },
  { id: 'agreement', label: 'Agreement' },
  { id: 'review', label: 'Final Review' },
];

export default function EnrollmentWizard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const { user } = useAuth();
  const addChildMode = searchParams.get('mode') === 'add-child';
  // Restore both the saved data AND the step the user last left off on (was resetting
  // to Step 1 on every refresh). Skipped for a fresh "add child" flow.
  const restored = addChildMode ? null : wizardStore.read();
  const [step, setStep] = useState(() => {
    const s = Number(restored?.step);
    return Number.isFinite(s) && s >= 1 ? s : 1;
  });
  const [includeAssessment, setIncludeAssessment] = useState(false);
  const [data, setData] = useState<WizardData>(() =>
    restored ? { ...INITIAL_WIZARD_DATA, ...restored } : INITIAL_WIZARD_DATA,
  );
  const [submitting, setSubmitting] = useState(false);
  const latestStep = useRef(step);
  latestStep.current = step;

  // Backend process id — a full server/machine restart changes it. Carried over
  // from the saved draft so a plain refresh (same id) keeps progress.
  const serverInstanceIdRef = useRef<string | null>(restored?._serverInstanceId ?? null);

  useEffect(() => {
    if (addChildMode) return;
    const savedId = wizardStore.read()?._serverInstanceId;
    let cancelled = false;
    enrollmentService.getServerInstanceId()
      .then((res) => {
        const live = res.data?.instanceId || null;
        if (cancelled || !live) return;
        serverInstanceIdRef.current = live;
        if (savedId && savedId !== live) {
          // Server was restarted since this draft was saved → start fresh.
          wizardStore.clear();
          setData(INITIAL_WIZARD_DATA);
          setStep(1);
          setIncludeAssessment(false);
        }
      })
      .catch(() => { /* server unreachable — keep the draft; close still wipes it */ });
    return () => { cancelled = true; };
  }, [addChildMode]);

  const flowSteps = useMemo<StepDef[]>(() => {
    const base = addChildMode
      ? BASE_STEPS.filter((s) => !['account', 'verify', 'welcome'].includes(s.id))
      : BASE_STEPS;

    if (!includeAssessment) return base;
    const copy = [...base];
    const programsIndex = copy.findIndex((s) => s.id === 'programs');
    if (programsIndex >= 0 && !copy.some((s) => s.id === 'assessment')) {
      copy.splice(programsIndex + 1, 0, { id: 'assessment', label: 'Assessment' });
    }
    return copy;
  }, [addChildMode, includeAssessment]);

  const steps = flowSteps;

  useEffect(() => {
    if (!addChildMode) return;
    if (!user) {
      navigate('/login', { replace: true });
      return;
    }

    const parentName = [user.firstName, user.middleName, user.lastName].filter(Boolean).join(' ').trim();
    const parentEmail = user.email || '';
    const parentPhone = user.phone || '';

    setData((prev) => {
      const next = {
        ...INITIAL_WIZARD_DATA,
        parentName: prev.parentName || parentName,
        parentEmail: prev.parentEmail || parentEmail,
        parentMobile: prev.parentMobile || parentPhone,
        guardianName: prev.guardianName || user.guardianName || parentName,
        guardianPhone: prev.guardianPhone || user.guardianPhone || parentPhone,
        guardianEmail: prev.guardianEmail || parentEmail,
      };
      return prev.parentName === next.parentName && prev.parentEmail === next.parentEmail && prev.parentMobile === next.parentMobile && prev.guardianName === next.guardianName && prev.guardianPhone === next.guardianPhone && prev.guardianEmail === next.guardianEmail ? prev : next;
    });
    setStep(1);
    wizardStore.clear();
  }, [addChildMode, navigate, user]);

  const currentStepId = steps[step - 1]?.id || 'requirements';

  const selectedProgramCodes = data.selectedPackages.map((p) => p.programCode);
  const relevantAssessmentCodes = new Set(['ACT102', 'EXP106']);
  const programCodesKey = selectedProgramCodes.sort().join(',');

  useEffect(() => {
    const applicableCodes = selectedProgramCodes.filter((code) => relevantAssessmentCodes.has(code));
    if (applicableCodes.length === 0) {
      setIncludeAssessment(false);
      setData((prev) => {
        const next = {
          ...prev,
          assessmentApplicable: false,
          assessmentTemplateId: null,
          assessmentSkipReason: 'The selected program does not require a pre-enrollment assessment.',
          assessmentInfoValues: {},
          assessmentRatings: {},
          assessmentRemarks: '',
          assessmentGoals: [],
          assessmentAssessedBy: '',
          assessmentSnapshot: null,
        };
        const changed =
          prev.assessmentApplicable !== false ||
          prev.assessmentTemplateId !== null ||
          prev.assessmentSkipReason !== next.assessmentSkipReason ||
          Object.keys(prev.assessmentRatings || {}).length > 0 ||
          Object.keys(prev.assessmentInfoValues || {}).length > 0 ||
          (prev.assessmentGoals || []).length > 0 ||
          prev.assessmentAssessedBy ||
          prev.assessmentSnapshot;
        return changed ? next : prev;
      });
      return;
    }

    assessmentService
      .getTemplates(applicableCodes)
      .then((res) => {
        const needed = (res.data?.templates?.length || 0) > 0;
        setIncludeAssessment(needed);
        if (!needed) {
          setData((prev) => {
            const next = {
              ...prev,
              assessmentApplicable: false,
              assessmentTemplateId: null,
              assessmentSkipReason: 'This program does not require a pre-enrollment assessment.',
              assessmentInfoValues: {},
              assessmentRatings: {},
              assessmentRemarks: '',
              assessmentGoals: [],
              assessmentAssessedBy: '',
              assessmentSnapshot: null,
            };
            const changed =
              prev.assessmentApplicable !== false ||
              prev.assessmentTemplateId !== null ||
              prev.assessmentSkipReason !== next.assessmentSkipReason ||
              Object.keys(prev.assessmentRatings || {}).length > 0 ||
              Object.keys(prev.assessmentInfoValues || {}).length > 0 ||
              (prev.assessmentGoals || []).length > 0 ||
              prev.assessmentAssessedBy ||
              prev.assessmentSnapshot;
            return changed ? next : prev;
          });
        }
      })
      .catch(() => setIncludeAssessment(false));
  }, [programCodesKey]);

  useEffect(() => {
    if (step > steps.length) setStep(steps.length);
  }, [steps.length, step]);

  useEffect(() => {
    // The "add child" flow uses a separate modal — never write to the shared draft here.
    if (addChildMode) return;
    // Persist everything except the large base64 file blobs (proof + requirement docs),
    // which would blow the sessionStorage quota and make the whole draft fail to save.
    // Everything else — including the current step — is kept so a refresh resumes here.
    wizardStore.write({
      ...data,
      step,
      _serverInstanceId: serverInstanceIdRef.current,
      proofDataUrl: null,
      docBirthCertificate: null,
      docStudentPhoto: null,
      docGuardianId: null,
    });
  }, [data, step, addChildMode]);

  const update = useCallback((partial: Partial<WizardData>) => {
    setData((prev) => ({ ...prev, ...partial }));
  }, []);

  const goNext = useCallback(() => setStep((s) => Math.min(s + 1, steps.length)), [steps.length]);

  // Section 9 — confirm before navigating back INTO the Account step once the email
  // has been verified, since that step can change the already-verified email.
  const [confirmBackToAccount, setConfirmBackToAccount] = useState(false);
  const emailVerified = Boolean(data.enrollmentToken);

  const goPrev = useCallback(() => {
    setStep((s) => {
      const target = Math.max(s - 1, 1);
      if (!addChildMode && emailVerified && steps[target - 1]?.id === 'account') {
        setConfirmBackToAccount(true);
        return s; // hold — the dialog decides
      }
      return target;
    });
  }, [addChildMode, emailVerified, steps]);

  const clearDraft = useCallback(() => {
    wizardStore.clear();
  }, []);

  const onEnrolled = useCallback((enrollmentId: string) => {
    clearDraft();
    navigate(`/enrollment-success?id=${enrollmentId}`, { replace: true });
  }, [clearDraft, navigate]);

  const progressPct = Math.round(((step - 1) / Math.max(1, steps.length - 1)) * 100);
  const stepProps = { data, update, onNext: goNext, onBack: goPrev, submitting, setSubmitting, onEnrolled, toast };

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-amber-50 via-background to-amber-50 py-8">
        <div className="container mx-auto px-4 max-w-4xl">

          <div className="text-center mb-6">
            <span className="text-amber-600 font-semibold text-sm uppercase tracking-wider">Bee Bright Tutorial Center</span>
            <h1 className="font-bold text-2xl md:text-3xl mt-1">
              Student <span className="text-amber-500">Enrollment</span>
            </h1>
            <p className="text-muted-foreground text-sm mt-1">Complete all steps to enroll your child.</p>
          </div>

          <div className="mb-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
              <span>Step {step} of {steps.length}: <strong>{steps[step - 1]?.label}</strong></span>
              <span>{progressPct}% complete</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-amber-500 rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${progressPct}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          </div>

          <div className="flex gap-1.5 overflow-x-auto pb-2 mb-6 scrollbar-none">
            {steps.map((s, index) => {
              const num = index + 1;
              return (
                <div
                  key={s.id}
                  className={`flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium transition-colors ${
                    step === num
                      ? 'bg-amber-500 text-white'
                      : step > num
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {step > num
                    ? <CheckCircle className="h-3 w-3" />
                    : <span className="h-4 w-4 flex items-center justify-center rounded-full border border-current text-[10px]">{num}</span>
                  }
                  <span className="hidden sm:inline">{s.label}</span>
                </div>
              );
            })}
          </div>

          <div className="bg-card border border-border rounded-2xl shadow-md overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.div
                key={currentStepId}
                initial={{ opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -24 }}
                transition={{ duration: 0.2 }}
                className="p-6 md:p-8"
              >
                {currentStepId === 'requirements' && <Step1Requirements  {...stepProps} />}
                {currentStepId === 'account' && <Step2ParentAccount {...stepProps} />}
                {currentStepId === 'verify' && <Step3OtpVerify     {...stepProps} />}
                {currentStepId === 'welcome' && <Step4Welcome        {...stepProps} />}
                {currentStepId === 'student' && <Step5StudentInfo    {...stepProps} />}
                {currentStepId === 'programs' && <Step6Programs       {...stepProps} />}
                {currentStepId === 'assessment' && <StepAssessment      {...stepProps} />}
                {currentStepId === 'schedule' && <Step7Schedule       {...stepProps} />}
                {currentStepId === 'guardian' && <Step8Guardian       {...stepProps} />}
                {currentStepId === 'health' && <Step9Health         {...stepProps} />}
                {currentStepId === 'billing' && <Step10Billing       {...stepProps} />}
                {currentStepId === 'agreement' && <Step11Consent       {...stepProps} />}
                {currentStepId === 'review' && <Step12Review        {...stepProps} />}
              </motion.div>
            </AnimatePresence>
          </div>

          <p className="text-center text-xs text-muted-foreground mt-4">
            Your progress is automatically saved. You can close this page and resume later.
          </p>
        </div>

      </div>

      <AlertDialog open={confirmBackToAccount} onOpenChange={setConfirmBackToAccount}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Go back to Account details?</AlertDialogTitle>
            <AlertDialogDescription>
              Your email is already verified. Going back to the Account step lets you edit your
              Full Name, Email, Mobile Number and Password — changing the email may require
              verifying it again. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No, stay here</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const idx = steps.findIndex((s) => s.id === 'account');
                if (idx >= 0) setStep(idx + 1);
              }}
            >
              Yes, go to Account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
