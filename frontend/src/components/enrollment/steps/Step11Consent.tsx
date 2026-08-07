import { useState } from 'react';
import { ShieldCheck, ExternalLink, CheckCheck } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';

interface Props { data: WizardData; update: (p: Partial<WizardData>) => void; onNext: () => void; onBack: () => void; toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']; }

const FULL_AGREEMENT = `
BEE BRIGHT TUTORIAL CENTER — PARTICIPATION AGREEMENT

1. PARTICIPATION AGREEMENT
The parent/guardian agrees to the rules and conduct expected of students during all tutorial sessions, including adherence to center policies and respectful behavior toward tutors and staff.

2. DATA PRIVACY
Bee Bright Tutorial Center collects personal information (student name, age, contact details, health info) solely for enrollment, scheduling, and communication purposes. Data is kept confidential and not shared with third parties without consent.

3. MEDICAL CONSENT
In the event of a medical emergency during a session, the parent/guardian authorizes the center to administer basic first aid and, if necessary, contact emergency services. The center is not liable for any medical conditions not disclosed during enrollment.

4. PARENT RESPONSIBILITIES
• Ensure the student attends scheduled sessions on time.
• Notify the center at least 24 hours in advance for absences.
• Monthly fees are due on or before the 1st of each month.
• Down payment reservations are non-refundable unless enrollment is rejected by the center.

5. INFORMATION ACCURACY
The parent/guardian confirms that all information provided during enrollment is accurate and complete. Providing false information may result in cancellation of enrollment.

Effective Date: Version 1.0
`;

export default function Step11Consent({ data, update, onNext, onBack, toast }: Props) {
  const [open, setOpen] = useState(false);

  const toggleConsent = (index: number, accepted: boolean) => {
    const updated = data.consentItems.map((item, i) => i === index ? { ...item, accepted } : item);
    update({ consentItems: updated });
  };

  const acceptAll = () => {
    update({ consentItems: data.consentItems.map((item) => ({ ...item, accepted: true })) });
  };

  const allAccepted = data.consentItems.length > 0 && data.consentItems.every((c) => c.accepted);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-emerald-600" /> Participation Agreement
        </h2>
        <p className="text-muted-foreground text-sm mt-1">
          Please review and accept all items below. You can read the full agreement before agreeing.
        </p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <ExternalLink className="h-4 w-4" /> Read Full Agreement
            </Button>
          </DialogTrigger>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Bee Bright Participation Agreement</DialogTitle>
          </DialogHeader>
          <pre className="whitespace-pre-wrap text-sm text-muted-foreground font-sans leading-relaxed">{FULL_AGREEMENT}</pre>
        </DialogContent>
      </Dialog>

        {/* Accept All button */}
        {!allAccepted && (
          <Button
            variant="default"
            size="sm"
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={acceptAll}
          >
            <CheckCheck className="h-4 w-4" /> Accept All
          </Button>
        )}
      </div>{/* end flex row */}

      <div className="space-y-3">
        {data.consentItems.map((item, i) => (
          <div key={item.name} className={`flex items-start gap-3 p-4 rounded-xl border-2 transition-colors ${item.accepted ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/20' : 'border-border'}`}>
            <Checkbox id={`consent-${i}`} checked={item.accepted}
              onCheckedChange={(v) => toggleConsent(i, Boolean(v))}
              className="mt-0.5 flex-shrink-0" />
            <Label htmlFor={`consent-${i}`} className="text-sm font-normal cursor-pointer leading-relaxed">
              {item.label}
            </Label>
          </div>
        ))}
      </div>

      {!allAccepted && (
        <p className="text-xs text-amber-600">Please accept all items above to continue.</p>
      )}

      <StepNav onBack={onBack}
        onNext={() => {
          if (!allAccepted) {
            toast({ title: 'Agreement required', description: 'Please accept all consent items to continue.', variant: 'destructive' });
            return;
          }
          update({ consentAcceptedAt: new Date().toISOString() } as unknown as Partial<WizardData>);
          onNext();
        }}
      />
    </div>
  );
}
