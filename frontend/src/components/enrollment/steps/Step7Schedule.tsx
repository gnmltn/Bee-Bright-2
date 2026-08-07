import { CalendarDays, Sun, Sunset, Clock } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';

interface Props { data: WizardData; update: (p: Partial<WizardData>) => void; onNext: () => void; onBack: () => void; }

const TIME_OPTIONS = [
  { value: 'morning'      as const, label: 'Morning',        desc: '8:00 AM – 12:00 PM', icon: Sun },
  { value: 'afternoon'    as const, label: 'Afternoon',       desc: '12:00 PM – 6:00 PM', icon: Sunset },
  { value: 'no_preference' as const, label: 'No Preference',  desc: 'Any available time',  icon: Clock },
];

export default function Step7Schedule({ data, update, onNext, onBack }: Props) {
  const today = new Date().toISOString().split('T')[0];
  const maxDate = new Date();
  maxDate.setMonth(maxDate.getMonth() + 6);
  const maxDateStr = maxDate.toISOString().split('T')[0];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Schedule Preference</h2>
        <p className="text-muted-foreground text-sm mt-1">
          Let us know when you'd like your child to start. The actual class schedule will be assigned by the admin after approval.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="preferredStartDate" className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-amber-500" /> Preferred Start Date *
        </Label>
        <Input id="preferredStartDate" type="date" min={today} max={maxDateStr}
          value={data.preferredStartDate}
          onChange={(e) => update({ preferredStartDate: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">Choose a date within the next 6 months.</p>
      </div>

      <div className="space-y-2">
        <Label>Preferred Time Slot *</Label>
        <div className="grid gap-3">
          {TIME_OPTIONS.map((opt) => (
            <button key={opt.value} onClick={() => update({ preferredTime: opt.value })}
              className={`flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${data.preferredTime === opt.value ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/20' : 'border-border hover:border-amber-300'}`}>
              <div className={`h-10 w-10 rounded-full flex items-center justify-center flex-shrink-0 ${data.preferredTime === opt.value ? 'bg-amber-500 text-white' : 'bg-muted text-muted-foreground'}`}>
                <opt.icon className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold text-foreground">{opt.label}</p>
                <p className="text-xs text-muted-foreground">{opt.desc}</p>
              </div>
              <div className={`ml-auto h-5 w-5 rounded-full border-2 flex items-center justify-center ${data.preferredTime === opt.value ? 'border-amber-500' : 'border-muted-foreground'}`}>
                {data.preferredTime === opt.value && <div className="h-2.5 w-2.5 rounded-full bg-amber-500" />}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 rounded-lg text-xs text-blue-800 dark:text-blue-300">
        <strong>Important:</strong> These are preferences only. The admin will assign the final schedule after your enrollment is approved and will contact you to confirm.
      </div>

      <StepNav onBack={onBack} onNext={onNext} />
    </div>
  );
}
