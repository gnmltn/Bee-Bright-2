/**
 * Bee Bright Enrollment Wizard — 12-step guided enrollment.
 * Route: /enroll
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, ChevronRight, ChevronLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Layout } from '@/components/layout/Layout';
import {
  INITIAL_WIZARD_DATA, WizardData,
} from '@/components/enrollment/wizard-types';

// Step components
import Step1Requirements   from '@/components/enrollment/steps/Step1Requirements';
import Step2ParentAccount  from '@/components/enrollment/steps/Step2ParentAccount';
import Step3OtpVerify      from '@/components/enrollment/steps/Step3OtpVerify';
import Step4Welcome        from '@/components/enrollment/steps/Step4Welcome';
import Step5StudentInfo    from '@/components/enrollment/steps/Step5StudentInfo';
import Step6Programs       from '@/components/enrollment/steps/Step6Programs';
import Step7Schedule       from '@/components/enrollment/steps/Step7Schedule';
import Step8Guardian       from '@/components/enrollment/steps/Step8Guardian';
import Step9Health         from '@/components/enrollment/steps/Step9Health';
import Step10Billing       from '@/components/enrollment/steps/Step10Billing';
import Step11Consent       from '@/components/enrollment/steps/Step11Consent';
import Step12Review        from '@/components/enrollment/steps/Step12Review';

const STORAGE_KEY = 'bb-enrollment-wizard-v1';

const STEPS = [
  { num: 1,  label: 'Requirements'   },
  { num: 2,  label: 'Account'        },
  { num: 3,  label: 'Verify Email'   },
  { num: 4,  label: 'Welcome'        },
  { num: 5,  label: 'Student Info'   },
  { num: 6,  label: 'Programs'       },
  { num: 7,  label: 'Schedule Pref'  },
  { num: 8,  label: 'Guardian'       },
  { num: 9,  label: 'Health'         },
  { num: 10, label: 'Billing'        },
  { num: 11, label: 'Agreement'      },
  { num: 12, label: 'Final Review'   },
];

export default function EnrollmentWizard() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [data, setData] = useState<WizardData>(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<WizardData>;
        return { ...INITIAL_WIZARD_DATA, ...parsed };
      }
    } catch { /* ignore */ }
    return INITIAL_WIZARD_DATA;
  });
  const [submitting, setSubmitting] = useState(false);
  const latestStep = useRef(step);
  latestStep.current = step;

  // Auto-save draft to sessionStorage on every change
  useEffect(() => {
    try {
      // Don't persist proof blob – too large; store everything else
      const toStore = { ...data, proofDataUrl: null };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...toStore, step }));
    } catch { /* quota exceeded – ignore */ }
  }, [data, step]);

  const update = useCallback((partial: Partial<WizardData>) => {
    setData((prev) => ({ ...prev, ...partial }));
  }, []);

  const goNext = useCallback(() => setStep((s) => Math.min(s + 1, STEPS.length)), []);
  const goPrev = useCallback(() => setStep((s) => Math.max(s - 1, 1)), []);

  const clearDraft = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  const onEnrolled = useCallback((enrollmentId: string) => {
    clearDraft();
    navigate(`/enrollment-success?id=${enrollmentId}`, { replace: true });
  }, [clearDraft, navigate]);

  const progressPct = Math.round(((step - 1) / (STEPS.length - 1)) * 100);

  const stepProps = { data, update, onNext: goNext, onBack: goPrev, submitting, setSubmitting, onEnrolled, toast };

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-amber-50 via-background to-amber-50 py-8">
        <div className="container mx-auto px-4 max-w-4xl">

          {/* Header */}
          <div className="text-center mb-6">
            <span className="text-amber-600 font-semibold text-sm uppercase tracking-wider">Bee Bright Tutorial Center</span>
            <h1 className="font-bold text-2xl md:text-3xl mt-1">
              Student <span className="text-amber-500">Enrollment</span>
            </h1>
            <p className="text-muted-foreground text-sm mt-1">Complete all steps to enroll your child.</p>
          </div>

          {/* Progress bar */}
          <div className="mb-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
              <span>Step {step} of {STEPS.length}: <strong>{STEPS[step - 1].label}</strong></span>
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

          {/* Step indicator (scrollable on mobile) */}
          <div className="flex gap-1.5 overflow-x-auto pb-2 mb-6 scrollbar-none">
            {STEPS.map((s) => (
              <div
                key={s.num}
                className={`flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium transition-colors ${
                  step === s.num
                    ? 'bg-amber-500 text-white'
                    : step > s.num
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {step > s.num
                  ? <CheckCircle className="h-3 w-3" />
                  : <span className="h-4 w-4 flex items-center justify-center rounded-full border border-current text-[10px]">{s.num}</span>
                }
                <span className="hidden sm:inline">{s.label}</span>
              </div>
            ))}
          </div>

          {/* Step card */}
          <div className="bg-card border border-border rounded-2xl shadow-md overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={{ opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -24 }}
                transition={{ duration: 0.2 }}
                className="p-6 md:p-8"
              >
                {step === 1  && <Step1Requirements  {...stepProps} />}
                {step === 2  && <Step2ParentAccount {...stepProps} />}
                {step === 3  && <Step3OtpVerify     {...stepProps} />}
                {step === 4  && <Step4Welcome        {...stepProps} />}
                {step === 5  && <Step5StudentInfo    {...stepProps} />}
                {step === 6  && <Step6Programs       {...stepProps} />}
                {step === 7  && <Step7Schedule       {...stepProps} />}
                {step === 8  && <Step8Guardian       {...stepProps} />}
                {step === 9  && <Step9Health         {...stepProps} />}
                {step === 10 && <Step10Billing       {...stepProps} />}
                {step === 11 && <Step11Consent       {...stepProps} />}
                {step === 12 && <Step12Review        {...stepProps} />}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Resume note */}
          <p className="text-center text-xs text-muted-foreground mt-4">
            Your progress is automatically saved. You can close this page and resume later.
          </p>
        </div>
      </div>
    </Layout>
  );
}
