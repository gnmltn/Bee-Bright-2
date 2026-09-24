import { useEffect, useState } from 'react';
import { CalendarDays, Loader2, CheckCircle2, ChevronLeft, Pencil } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';
import { enrollmentService } from '@/services/api';
import { PROGRAM_LABELS, getRequiredDaysForPackage, type ActiveProgramCode } from '@/constants/programs';

type AvailabilitySlot = { label: string; available: number; total: number };
type AvailabilityResponse = Record<string, AvailabilitySlot>;

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

function daysForProgram(data: WizardData, programCode: string): string[] {
  return data.preferredDaysByProgram.find((p) => p.programCode === programCode)?.days ?? [];
}

export default function Step7Schedule({ data, update, onNext, onBack }: Props) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Which program's Available Days section is the active/editable one, when a parent
  // enrolled in more than one program — each gets its own separate section, revealed
  // in sequence (Admin_Schedule_and_MultiProgram_Days_Fixes.pdf #4b), not all at once.
  const [activeDayStepIndex, setActiveDayStepIndex] = useState(0);

  const today = new Date().toISOString().split('T')[0];
  const maxDate = new Date();
  maxDate.setMonth(maxDate.getMonth() + 6);
  const maxDateStr = maxDate.toISOString().split('T')[0];

  const setDaysForProgram = (programCode: string, days: string[]) => {
    const rest = data.preferredDaysByProgram.filter((p) => p.programCode !== programCode);
    update({ preferredDaysByProgram: [...rest, { programCode, days }] });
    setErrors((prev) => ({ ...prev, [`days:${programCode}`]: '' }));
  };

  const toggleDayForProgram = (programCode: string, requiredDays: number | null, day: string) => {
    const current = daysForProgram(data, programCode);
    if (current.includes(day)) {
      setDaysForProgram(programCode, current.filter((d) => d !== day));
      return;
    }
    if (requiredDays !== null && current.length >= requiredDays) return; // locked at the package's sessions-per-week
    setDaysForProgram(programCode, [...current, day]);
  };

  // ── Live tutor-capacity availability, per enrolled program ──────────────
  // Informational only — helps the parent pick a realistic slot; the admin
  // still manually assigns the specific tutor after approval.
  const selectedProgramCodes = Array.from(
    new Set(
      data.selectedPackages
        .map((p) => p.programCode)
        .filter((code): code is ActiveProgramCode => code === 'TPG101' || code === 'ACT102' || code === 'EXP106')
    )
  );
  const programCodesKey = selectedProgramCodes.join(',');

  // Each program's own exact-count lock (Admin_Schedule_and_MultiProgram_Days_Fixes.pdf
  // #4a) — independent per program now that each gets its own section, no more need to
  // reconcile conflicting counts across programs into a single shared list.
  const requiredDaysForCode = (programCode: string): number | null => {
    const counts = data.selectedPackages
      .filter((p) => p.programCode === programCode)
      .map((p) => getRequiredDaysForPackage(p.programCode, p.sessionCount))
      .filter((n): n is number => n !== null);
    return counts.length > 0 ? Math.max(...counts) : null;
  };

  const programDaysSatisfied = (programCode: string): boolean => {
    const required = requiredDaysForCode(programCode);
    if (required === null) return true; // e.g. Examination Preparation — no lock, always fine
    return daysForProgram(data, programCode).length === required;
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!data.preferredStartDate) {
      errs.preferredStartDate = 'Please choose a preferred start date.';
    }
    const firstUnmetIndex = selectedProgramCodes.findIndex((code) => !programDaysSatisfied(code));
    if (firstUnmetIndex !== -1) {
      const code = selectedProgramCodes[firstUnmetIndex];
      const required = requiredDaysForCode(code);
      errs[`days:${code}`] = `This package requires selecting exactly ${required} day${required === 1 ? '' : 's'}.`;
      // Jump the parent straight to whichever program's Available Days still needs attention.
      setActiveDayStepIndex(firstUnmetIndex);
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const [availability, setAvailability] = useState<Record<string, AvailabilityResponse>>({});
  const [loadingAvailability, setLoadingAvailability] = useState<Record<string, boolean>>({});
  const [availabilityError, setAvailabilityError] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data.preferredStartDate || selectedProgramCodes.length === 0) return;
    let cancelled = false;
    selectedProgramCodes.forEach((code) => {
      setLoadingAvailability((prev) => ({ ...prev, [code]: true }));
      setAvailabilityError((prev) => ({ ...prev, [code]: '' }));
      enrollmentService
        .getAvailability(data.preferredStartDate, code)
        .then((res) => {
          if (cancelled) return;
          setAvailability((prev) => ({ ...prev, [code]: res.data.slots }));
        })
        .catch(() => {
          if (cancelled) return;
          setAvailabilityError((prev) => ({ ...prev, [code]: 'Could not load availability for this date. Please try again.' }));
        })
        .finally(() => {
          if (cancelled) return;
          setLoadingAvailability((prev) => ({ ...prev, [code]: false }));
        });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.preferredStartDate, programCodesKey]);

  const pickSlot = (programCode: string, startTime: string, endTime: string, label: string) => {
    const current = data.preferredSlots ?? [];
    const alreadyPicked = current.some(
      (s) => s.programCode === programCode && s.startTime === startTime && s.endTime === endTime
    );
    const next = alreadyPicked
      ? current.filter((s) => s.programCode !== programCode) // clicking the same slot again deselects it
      : [...current.filter((s) => s.programCode !== programCode), { programCode, startTime, endTime, label }];
    update({ preferredSlots: next });
  };

  const slotStatus = (slot: AvailabilitySlot): { text: string; disabled: boolean } => {
    if (slot.available <= 0) return { text: 'Fully Booked', disabled: true };
    if (slot.available === slot.total) return { text: 'Available', disabled: false };
    return { text: `Available Slots: ${slot.available}`, disabled: false };
  };

  const isMultiProgram = selectedProgramCodes.length > 1;

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

      {/* ── Live Tutor-Capacity Availability (per enrolled program) ── */}
      {selectedProgramCodes.length > 0 && (
        <div className="space-y-4">
          <div>
            <Label className="font-semibold">Time Slot Availability</Label>
            <p className="text-xs text-muted-foreground">
              Optional — pick a slot to tell us your preference. The admin will still confirm
              the final tutor and schedule after your enrollment is approved.
            </p>
          </div>

          {!data.preferredStartDate ? (
            <p className="text-xs text-muted-foreground italic">
              Choose a Preferred Start Date above to see available time slots.
            </p>
          ) : (
            selectedProgramCodes.map((code) => {
              const slots = availability[code];
              const loading = loadingAvailability[code];
              const error = availabilityError[code];
              const pickedForProgram = (data.preferredSlots ?? []).find((s) => s.programCode === code);

              return (
                <div key={code} className="border border-border rounded-xl p-4 space-y-3">
                  <p className="text-sm font-semibold text-foreground">{PROGRAM_LABELS[code]}</p>

                  {loading && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Checking availability…
                    </div>
                  )}

                  {!loading && error && (
                    <p className="text-xs text-destructive">{error}</p>
                  )}

                  {!loading && !error && slots && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {Object.entries(slots)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([key, slot]) => {
                          const [startTime, endTime] = key.split('-');
                          const { text, disabled } = slotStatus(slot);
                          const selected = pickedForProgram?.startTime === startTime && pickedForProgram?.endTime === endTime;
                          return (
                            <button
                              key={key}
                              type="button"
                              disabled={disabled}
                              onClick={() => pickSlot(code, startTime, endTime, slot.label)}
                              className={`flex flex-col items-center justify-center gap-1 rounded-lg border-2 py-2.5 px-2 text-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                                disabled
                                  ? 'border-border bg-muted text-muted-foreground cursor-not-allowed opacity-60'
                                  : selected
                                    ? 'border-amber-500 bg-amber-500 text-white shadow-sm'
                                    : 'border-border bg-card text-foreground hover:border-amber-400'
                              }`}
                            >
                              <span className="text-sm font-semibold flex items-center gap-1">
                                {selected && <CheckCircle2 className="h-3.5 w-3.5" />}
                                {slot.label}
                              </span>
                              <span className="text-[11px]">{text}</span>
                            </button>
                          );
                        })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── Available Days — one section per enrolled program ── */}
      <div className="space-y-3">
        <Label className="font-semibold">Available Days</Label>
        {selectedProgramCodes.map((code, index) => {
          const required = requiredDaysForCode(code);
          const days = daysForProgram(data, code);
          const satisfied = programDaysSatisfied(code);
          const isActive = !isMultiProgram || index === activeDayStepIndex;
          const isPast = isMultiProgram && index < activeDayStepIndex;
          const isFuture = isMultiProgram && index > activeDayStepIndex;
          const isLast = index === selectedProgramCodes.length - 1;

          if (isFuture) return null; // "a new section appears" — not shown until reached

          // Completed section, collapsed to a compact summary the parent can reopen.
          if (isPast) {
            return (
              <button
                key={code}
                type="button"
                onClick={() => setActiveDayStepIndex(index)}
                className="w-full flex items-center justify-between gap-3 rounded-xl border-2 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 p-3 text-left hover:border-emerald-400 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{PROGRAM_LABELS[code]}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {days.length > 0 ? days.map((d) => DAY_SHORT[d]).join(', ') : 'No days selected'}
                    </p>
                  </div>
                </div>
                <span className="flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400 flex-shrink-0">
                  <Pencil className="h-3 w-3" /> Edit
                </span>
              </button>
            );
          }

          return (
            <div key={code} className={`rounded-xl border-2 p-4 space-y-2 ${isActive ? 'border-amber-400' : 'border-border'}`}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-foreground">
                  {PROGRAM_LABELS[code]}
                  {isMultiProgram && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      Program {index + 1} of {selectedProgramCodes.length}
                    </span>
                  )}
                </p>
                <span className="text-xs text-muted-foreground font-normal">
                  {required !== null ? `select exactly ${required} day${required === 1 ? '' : 's'}` : 'optional — select all that apply'}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {required !== null
                  ? `This package meets ${required} time${required === 1 ? '' : 's'} a week — pick exactly ${required} day${required === 1 ? '' : 's'} your child can attend.`
                  : 'Tap the days your child can attend. Leave all unselected if any weekday is fine.'}
                {' '}Sessions are scheduled Monday through Saturday.
              </p>

              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-1">
                {WEEKDAYS.map((day) => {
                  const selected = days.includes(day);
                  const disabled = !selected && required !== null && days.length >= required;
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={selected}
                      disabled={disabled}
                      onClick={() => toggleDayForProgram(code, required, day)}
                      className={`py-2.5 rounded-xl text-sm font-semibold border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        selected
                          ? 'border-amber-500 bg-amber-500 text-white shadow-sm'
                          : disabled
                            ? 'border-border bg-muted text-muted-foreground cursor-not-allowed opacity-60'
                            : 'border-border bg-card text-foreground hover:border-amber-400'
                      }`}
                    >
                      {DAY_SHORT[day]}
                    </button>
                  );
                })}
              </div>

              {errors[`days:${code}`] && (
                <p className="text-xs text-destructive">{errors[`days:${code}`]}</p>
              )}
              {required !== null ? (
                <p className={`text-xs mt-1 ${satisfied ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
                  {days.length} of {required} selected{days.length > 0 ? `: ${days.join(', ')}` : ''}
                </p>
              ) : days.length > 0 ? (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">Selected: {days.join(', ')}</p>
              ) : (
                <p className="text-xs text-muted-foreground mt-1">No days selected — any available weekday is acceptable.</p>
              )}

              {isMultiProgram && (
                <div className="flex items-center justify-between pt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={index === 0}
                    onClick={() => setActiveDayStepIndex((i) => Math.max(0, i - 1))}
                    className="text-muted-foreground"
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" /> Previous Program
                  </Button>
                  {!isLast && (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        if (!satisfied) {
                          setErrors((prev) => ({ ...prev, [`days:${code}`]: required !== null ? `This package requires selecting exactly ${required} day${required === 1 ? '' : 's'}.` : '' }));
                          return;
                        }
                        setActiveDayStepIndex((i) => Math.min(selectedProgramCodes.length - 1, i + 1));
                      }}
                    >
                      Next Program
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 rounded-lg text-xs text-blue-800 dark:text-blue-300">
        <strong>Important:</strong> These are preferences only. The admin will assign the
        final schedule after your enrollment is approved and will contact you to confirm.
      </div>

      <StepNav onBack={onBack} onNext={() => { if (validate()) onNext(); }} />
    </div>
  );
}
