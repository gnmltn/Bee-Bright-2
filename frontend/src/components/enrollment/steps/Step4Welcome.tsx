import { Sparkles, CalendarCheck, UserCheck, BookOpen } from 'lucide-react';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';

interface Props { data: WizardData; update: (p: Partial<WizardData>) => void; onNext: () => void; onBack: () => void; }

const nextSteps = [
  { icon: UserCheck,   label: 'Student Info',    desc: "Tell us about your child — name and birthdate." },
  { icon: BookOpen,    label: 'Program Selection', desc: "Choose programs your child is eligible for based on age." },
  { icon: CalendarCheck, label: 'Schedule Preference', desc: "Let us know your preferred start date and time." },
  { icon: Sparkles,    label: 'Billing & Agreement', desc: "Select payment option and upload proof of payment." },
];

export default function Step4Welcome({ data, onNext, onBack }: Props) {
  const firstName = data.parentName.split(' ')[0] || 'there';
  return (
    <div className="space-y-6 max-w-lg mx-auto text-center">
      <div>
        <div className="text-4xl mb-3">🐝</div>
        <h2 className="text-2xl font-bold">Welcome, {firstName}!</h2>
        <p className="text-muted-foreground mt-2">
          Your email has been verified. You're now ready to begin the enrollment process.
          Here's a quick overview of what to expect.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 text-left">
        {nextSteps.map((s) => (
          <div key={s.label} className="p-4 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-xl">
            <s.icon className="h-5 w-5 text-amber-600 mb-2" />
            <p className="font-semibold text-sm text-foreground">{s.label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{s.desc}</p>
          </div>
        ))}
      </div>

      <div className="p-4 bg-muted rounded-xl text-sm text-muted-foreground text-left">
        <strong className="text-foreground">Note:</strong> Your child's class schedule will be assigned by the admin <em>after</em> enrollment is approved.
        In the next steps you will only provide your preferred start date and time — actual scheduling happens post-approval.
      </div>

      <p className="text-xs text-muted-foreground">Verification window: 1–2 business days after payment submission.</p>

      <StepNav onBack={onBack} onNext={onNext} nextLabel="Let's Start" />
    </div>
  );
}
