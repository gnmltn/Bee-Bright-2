import { useState } from 'react';
import { CalendarDays, Sun, Sunset, Clock } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';

interface Props {
  data: WizardData;
  update: (p: Partial<WizardData>) => void;
  onNext: () => void;
  onBack: () => void;
}

const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

// Short display labels
const DAY_SHORT: Record<string, string> = {
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
  Friday: 'Fri',
  Saturday: 'Sat',
};

const TIME_OPTIONS = [
  { value: 'morning'       as const, label: 'Morning',      desc: '8:00 AM – 12:00 PM', icon: Sun },
  { value: 'afternoon'     as const, label: 'Afternoon',    desc: '1:00 PM – 5:00 PM',  icon: Sunset },
  { value: 'no_preference' as const, label: 'No Preference', desc: 'Any available time', icon: Clock },
];

export default function Step7Schedule({ data, update, onNext, onBack }: Props) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  const today = new Date().toISOString().split('T')[0];
  const maxDate = new Date();
  maxDate.setMonth(maxDate.getMonth() + 6);
  const maxDateStr = maxDate.toISOString().split('T')[0];

  const toggleDay = (day: string) => {
    const current = data.preferredDays ?? [];
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day];
    update({ preferredDays: next });
    setErrors((prev) => ({ ...prev, preferredStartDate: '' }));
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!data.preferredStartDate) {
      errs.preferredStartDate = 'Please choose a preferred start date.';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const selectedDays = data.preferredDays ?? [];

  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h2 className="text-xl font-bold">Schedule Preference</h2>
        <p className="text-muted-foreground text-sm mt-1">
          Let us know when your child is available. The admin will assign the final
          schedule after approval and confirm with you.
        </p>
      </div>

      {/* ── Preferred Start Date ── */}
      <div className="space-y-1.5">
        <Label htmlFor="preferredStartDate" className="flex items-center gap-2 font-semibold">
          <CalendarDays className="h-4 w-4 text-amber-500" />
          Preferred Start Date <span className="text-destructive">*</span>
        </Label>
        <Input
          id="preferredStartDate"
          type="date"
          min={today}
          max={maxDateStr}
          value={data.preferredStartDate}
          className={errors.preferredStartDate ? 'border-destructive' : ''}
          onChange={(e) => {
            update({ preferredStartDate: e.target.value });
            setErrors((prev) => ({ ...prev, preferredStartDate: '' }));
          }}
        />
        {errors.preferredStartDate && (
          <p className="text-xs text-destructive">{errors.preferredStartDate}</p>
        )}
        <p className="text-xs text-muted-foreground">
          Choose a date within the next 6 months. Sessions will not start before this date.
        </p>
      </div>

      {/* ── Available Days ── */}
      <div className="space-y-2">
        <Label className="font-semibold">
          Available Days{' '}
          <span className="text-muted-foreground font-normal">(optional — select all that apply)</span>
        </Label>
        <p className="text-xs text-muted-foreground">
          Tap the days your child can attend. Leave all unselected if any weekday is fine.
          Sessions are scheduled Monday through Saturday.
        </p>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-1">
          {WEEKDAYS.map((day) => {
            const selected = selectedDays.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleDay(day)}
                className={`py-2.5 rounded-xl text-sm font-semibold border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selected
                    ? 'border-amber-500 bg-amber-500 text-white shadow-sm'
                    : 'border-border bg-card text-foreground hover:border-amber-400'
                }`}
              >
                {DAY_SHORT[day]}
              </button>
            );
          })}
        </div>
        {selectedDays.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
            Selected: {selectedDays.join(', ')}
          </p>
        )}
        {selectedDays.length === 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            No days selected — any available weekday is acceptable.
          </p>
        )}
      </div>

      {/* ── Preferred Time ── */}
      <div className="space-y-2">
        <Label className="font-semibold">Preferred Time Slot</Label>
        <div className="grid gap-3">
          {TIME_OPTIONS.map((opt) => {
            const active = data.preferredTime === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => update({ preferredTime: opt.value })}
                className={`flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active
                    ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/20'
                    : 'border-border hover:border-amber-300'
                }`}
              >
                <div
                  className={`h-10 w-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                    active ? 'bg-amber-500 text-white' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <opt.icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-semibold text-foreground">{opt.label}</p>
                  <p className="text-xs text-muted-foreground">{opt.desc}</p>
                </div>
                <div
                  className={`ml-auto h-5 w-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                    active ? 'border-amber-500' : 'border-muted-foreground'
                  }`}
                >
                  {active && <div className="h-2.5 w-2.5 rounded-full bg-amber-500" />}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 rounded-lg text-xs text-blue-800 dark:text-blue-300">
        <strong>Important:</strong> These are preferences only. The admin will assign the
        final schedule after your enrollment is approved and will contact you to confirm.
      </div>

      <StepNav onBack={onBack} onNext={() => { if (validate()) onNext(); }} />
    </div>
  );
}
