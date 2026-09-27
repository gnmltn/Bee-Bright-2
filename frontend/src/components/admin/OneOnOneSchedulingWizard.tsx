import { useEffect, useMemo, useState } from "react";
import { Loader2, Calendar, Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  scheduleService,
  type AdminEnrollment,
  type AdminSchedule,
  type WeeklyScheduleSubjectOption,
  type WeeklyScheduleTutorOption,
  type PricingPackage,
  type MonthlyScheduleCheck,
} from "@/services/api";
import { StudentSearchSelect } from "./StudentSearchSelect";
import { isEnrollmentSchedulable } from "@/utils/enrollmentEligibility";
import { getRequiredDaysForPackage } from "@/constants/programs";

// BeeBright Scheduling Spec, Section 1 — student-first 1-on-1 scheduling wizard.
// Replaces the old slot-first "create a tutor slot, assign a child later" flow for
// Academic Tutorial (ACT102) / Examination Preparation (EXP106): pick the student
// first (their enrollment already says which program), then days/time, then a tutor
// with real availability, then generate a month of 1-hour sessions in one step via
// the existing createMonthlySchedules backend primitive.

const ONE_ON_ONE_CODES = new Set(["ACT102", "EXP106"]);

const DAY_OPTIONS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

// No day is pre-selected — the admin must actively pick each day (BeeBright Scheduling
// Spec follow-up, 2026-09-14: supersedes the earlier Mon/Wed/Fri-default requirement).
const DEFAULT_DAYS: number[] = [];

// 1-hour blocks across the 8:00-17:00 operating window, skipping the 12:00-13:00 lunch break.
const TIME_BLOCKS = ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];

function personDisplayName(person?: { firstName?: string; middleName?: string; lastName?: string } | null) {
  if (!person) return "";
  return [person.firstName, person.middleName, person.lastName].filter(Boolean).join(" ");
}

function childNameFromEnrollment(enrollment: AdminEnrollment) {
  if (enrollment.student) return personDisplayName(enrollment.student);
  const snap = enrollment.studentSnapshot;
  const snapshotName = [snap?.firstName, snap?.middleName, snap?.lastName].filter(Boolean).join(" ");
  return snapshotName || enrollment.studentId || "Child";
}

function enrollmentCoveredOneOnOneSubjects(
  enrollment: AdminEnrollment,
  subjects: WeeklyScheduleSubjectOption[]
): WeeklyScheduleSubjectOption[] {
  const codes = new Set<string>();
  (enrollment.packages || []).forEach((pkg) => {
    const code = (pkg.programCode || "").toUpperCase();
    if (ONE_ON_ONE_CODES.has(code)) codes.add(code);
  });
  (enrollment.selectedSubjects || []).forEach((subject) => {
    const code = (subject.code || "").toUpperCase();
    if (ONE_ON_ONE_CODES.has(code)) codes.add(code);
  });
  return subjects.filter((subject) => codes.has((subject.code || "").toUpperCase()));
}

function addOneHour(start: string) {
  const [hourRaw, minuteRaw] = start.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return start;
  const endHour = Math.min(23, hour + 1);
  return `${String(endHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatSlotTime(value: string) {
  const [hourRaw, minuteRaw] = value.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return value;
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

/** Local calendar date as YYYY-MM-DD (never the UTC date, which is "yesterday" early morning in the Philippines). */
function toDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDateKey(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function preferredSlotLabel(enrollment: AdminEnrollment, programCode: string) {
  const slot = (enrollment.preferredSlots || []).find(
    (s) => (s.programCode || "").toUpperCase() === programCode.toUpperCase()
  );
  if (!slot) return "No preference selected";
  return `${formatSlotTime(slot.startTime)} – ${formatSlotTime(slot.endTime)}`;
}

function preferredDaysLabel(enrollment: AdminEnrollment, programCode: string) {
  const perProgram = enrollment.preferredDaysByProgram?.find((p) => p.programCode.toUpperCase() === programCode.toUpperCase());
  const days = perProgram ? perProgram.days : enrollment.preferredDays; // legacy fallback
  if (!days || days.length === 0) return "No preference selected";
  return days.map((d) => d.slice(0, 3)).join("/");
}

// "Academic Tutorial – Premier (Pre-School / Elementary)" -> "Premier"
// "Toddlers Playgroup – 16 Hours" -> "16 Hours"
// "Exam Prep – Bright Package" -> "Bright"
function shortPackageLabel(displayName: string): string {
  const afterDash = displayName.split("–").pop()?.trim() || displayName;
  return afterDash.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+Package$/i, "").trim();
}

/** The Pricing catalog entry (has sessionCount) behind an enrollment's package for a
 * given program — the Enrollment's own stored package snapshot doesn't carry sessionCount. */
function matchedPricing(enrollment: AdminEnrollment, programCode: string, pricing: PricingPackage[]) {
  const pkg = (enrollment.packages || []).find((p) => (p.programCode || "").toUpperCase() === programCode.toUpperCase());
  if (!pkg) return null;
  return pricing.find((p) => p.programCode === pkg.programCode && p.packageSlug === pkg.packageSlug) || null;
}

function packageLabel(enrollment: AdminEnrollment, programCode: string, pricing: PricingPackage[]) {
  const priced = matchedPricing(enrollment, programCode, pricing);
  if (!priced) return null;
  const requiredDays = getRequiredDaysForPackage(priced.programCode, priced.sessionCount);
  const short = shortPackageLabel(priced.displayName);
  return requiredDays !== null ? `${short} (${requiredDays}x per week)` : short;
}

interface StudentSubjectOption {
  key: string;
  enrollment: AdminEnrollment;
  subject: WeeklyScheduleSubjectOption;
  label: string;
}

interface OneOnOneSchedulingWizardProps {
  subjects: WeeklyScheduleSubjectOption[];
  enrollments: AdminEnrollment[];
  tutors: WeeklyScheduleTutorOption[];
  pricing: PricingPackage[];
  schedules: AdminSchedule[];
  onCreated: () => void;
}

// Admin_Schedule_and_MultiProgram_Days_Fixes.pdf #1 — once a student already has a
// schedule generated for a program, they must stop appearing as selectable for that
// same program (they've already been scheduled). Matches on the enrollment's linked
// student User id — an enrollment with no linked student yet has never been
// scheduled, so nothing to match against.
function alreadyScheduled(enrollment: AdminEnrollment, subject: WeeklyScheduleSubjectOption, schedules: AdminSchedule[]): boolean {
  const studentUserId = enrollment.student?._id;
  if (!studentUserId) return false;
  return schedules.some((s) => s.student?._id === studentUserId && (s.subject?._id === subject._id || (s.subject?.code || "").toUpperCase() === (subject.code || "").toUpperCase()));
}

export function OneOnOneSchedulingWizard({ subjects, enrollments, tutors, pricing, schedules, onCreated }: OneOnOneSchedulingWizardProps) {
  const oneOnOneSubjects = useMemo(
    () => subjects.filter((subject) => ONE_ON_ONE_CODES.has((subject.code || "").toUpperCase())),
    [subjects]
  );

  const studentOptions = useMemo<StudentSubjectOption[]>(() => {
    const options: StudentSubjectOption[] = [];
    for (const enrollment of enrollments) {
      if (!isEnrollmentSchedulable(enrollment)) continue;
      const covered = enrollmentCoveredOneOnOneSubjects(enrollment, oneOnOneSubjects);
      for (const subject of covered) {
        if (alreadyScheduled(enrollment, subject, schedules)) continue;
        options.push({
          key: `${enrollment._id}::${subject._id}`,
          enrollment,
          subject,
          label: `${childNameFromEnrollment(enrollment)} — ${subject.name}`,
        });
      }
    }
    return options;
  }, [enrollments, oneOnOneSubjects, schedules]);

  const [selectedKey, setSelectedKey] = useState("");
  // Bumped on reset to force StudentSearchSelect to remount and clear its own search text.
  const [studentPickerResetKey, setStudentPickerResetKey] = useState(0);
  const [selectedDays, setSelectedDays] = useState<number[]>(DEFAULT_DAYS);
  const [selectedTime, setSelectedTime] = useState(TIME_BLOCKS[0]);
  const [selectedTutorId, setSelectedTutorId] = useState("");
  // Tutor overrides per day: a day the first-choice tutor can't cover can go to a different tutor,
  // all under this student's one schedule (e.g. Tutor A Mon/Wed, Tutor B Thu).
  const [dayTutors, setDayTutors] = useState<Record<number, string>>({});
  // The date the month of sessions starts on — lets the admin stagger new enrollees who share the
  // same preferred day/time instead of everyone landing on the same day.
  const [startDate, setStartDate] = useState("");
  const [check, setCheck] = useState<MonthlyScheduleCheck | null>(null);
  const [checking, setChecking] = useState(false);
  // Per blocked day: which other tutors can cover it (loaded on demand).
  const [altTutors, setAltTutors] = useState<Record<number, string[] | "loading">>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedOption = studentOptions.find((option) => option.key === selectedKey) || null;

  // The exact-count day lock (Admin_Popup_Package_and_DayLock_Fix.pdf) — null means no
  // lock applies (e.g. Examination Preparation, or pricing hasn't loaded yet).
  const requiredDays = selectedOption
    ? getRequiredDaysForPackage(
        selectedOption.subject.code || "",
        matchedPricing(selectedOption.enrollment, selectedOption.subject.code || "", pricing)?.sessionCount ?? null
      )
    : null;

  const todayKey = toDateKey(new Date());

  // Reset downstream steps whenever the student/program changes — including any day
  // selection made for a previous student, since it may not fit this one's lock.
  useEffect(() => {
    setSelectedDays(DEFAULT_DAYS);
    setSelectedTutorId("");
    setDayTutors({});
    setAltTutors({});
    setCheck(null);
    setError(null);
    // Default the starting date to the parent's preferred start date (never in the past).
    const preferred = selectedOption?.enrollment.preferredStartDate ? toDateKey(new Date(selectedOption.enrollment.preferredStartDate)) : "";
    setStartDate(selectedOption ? (preferred && preferred >= todayKey ? preferred : todayKey) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  const effectiveTutorId = (day: number) => dayTutors[day] || selectedTutorId;
  const daySlotsPayload = useMemo(
    () => selectedDays.map((day) => ({ dayOfWeek: day, startTime: selectedTime, endTime: addOneHour(selectedTime), tutorId: dayTutors[day] || selectedTutorId })),
    [selectedDays, selectedTime, dayTutors, selectedTutorId]
  );

  const dayCountMatchesLock = requiredDays === null || selectedDays.length === requiredDays;
  const readyToCheck = Boolean(selectedOption && selectedTutorId && selectedDays.length > 0 && dayCountMatchesLock && startDate && startDate >= todayKey);

  // Authoritative, date-aware availability: asks the server about every session of the month for
  // this starting date, per day and per tutor — and, when something is blocked, which other
  // starting dates work — instead of silently blocking.
  useEffect(() => {
    if (!readyToCheck || !selectedOption) {
      setCheck(null);
      setChecking(false);
      return;
    }
    let cancelled = false;
    setChecking(true);
    setError(null);
    const timer = setTimeout(() => {
      scheduleService
        .checkMonthly({ enrollmentId: selectedOption.enrollment._id, subjectId: selectedOption.subject._id, tutorId: selectedTutorId, startDate, daySlots: daySlotsPayload })
        .then((res) => { if (!cancelled) setCheck(res.data); })
        .catch((err: unknown) => {
          if (cancelled) return;
          setCheck(null);
          setError((err as { response?: { data?: { message?: string } } })?.response?.data?.message || "Could not check availability.");
        })
        .finally(() => { if (!cancelled) setChecking(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyToCheck, selectedKey, startDate, selectedTutorId, selectedTime, JSON.stringify(daySlotsPayload)]);

  const conflictForDay = (day: number) => check?.conflicts.find((c) => c.dayOfWeek === day) || null;
  const allDaysAvailable = readyToCheck && !checking && Boolean(check?.ok);

  // Other tutors who could take one blocked day (the whole month of that weekday must be free).
  const loadAlternativeTutors = async (day: number) => {
    if (!selectedOption) return;
    setAltTutors((prev) => ({ ...prev, [day]: "loading" }));
    const current = effectiveTutorId(day);
    const results = await Promise.all(
      tutors.filter((t) => t._id !== current).map(async (t) => {
        try {
          const res = await scheduleService.checkMonthly({
            enrollmentId: selectedOption.enrollment._id,
            subjectId: selectedOption.subject._id,
            startDate,
            daySlots: [{ dayOfWeek: day, startTime: selectedTime, endTime: addOneHour(selectedTime), tutorId: t._id }],
          });
          return res.data.ok ? t._id : null;
        } catch {
          return null;
        }
      })
    );
    setAltTutors((prev) => ({ ...prev, [day]: results.filter((id): id is string => Boolean(id)) }));
  };

  const setTutorForDay = (day: number, tutorId: string) => {
    setDayTutors((prev) => {
      const next = { ...prev };
      if (!tutorId || tutorId === selectedTutorId) delete next[day];
      else next[day] = tutorId;
      return next;
    });
    setAltTutors((prev) => { const next = { ...prev }; delete next[day]; return next; });
  };

  const toggleDay = (day: number) => {
    setSelectedDays((prev) => {
      if (prev.includes(day)) {
        if (prev.length === 1) return prev; // at least one day required
        return prev.filter((value) => value !== day);
      }
      if (requiredDays !== null && prev.length >= requiredDays) return prev; // locked at the package's sessions-per-week
      return [...prev, day].sort((a, b) => a - b);
    });
    setAltTutors({});
  };

  const resetWizard = () => {
    setSelectedKey("");
    setStudentPickerResetKey((k) => k + 1);
    setSelectedDays(DEFAULT_DAYS);
    setSelectedTime(TIME_BLOCKS[0]);
    setSelectedTutorId("");
    setDayTutors({});
    setAltTutors({});
    setCheck(null);
    setStartDate("");
    setError(null);
  };

  const handleGenerate = async () => {
    if (!selectedOption || !selectedTutorId || !allDaysAvailable) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await scheduleService.createMonthly({
        enrollmentId: selectedOption.enrollment._id,
        tutorId: selectedTutorId,
        subjectId: selectedOption.subject._id,
        startDate,
        daySlots: daySlotsPayload,
      });
      if (res.data?.success) {
        toast.success(res.data.message || `Created ${res.data.count} sessions.`);
        resetWizard();
        onCreated();
      } else {
        setError(res.data?.message || "Failed to generate sessions.");
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || "Failed to generate sessions.";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-4">
      <div>
        <h4 className="font-semibold text-foreground">1-on-1 Scheduling Wizard</h4>
        <p className="text-xs text-muted-foreground">
          Academic Tutorial &amp; Examination Preparation — 1 tutor + 1 child, 1 hour per session.
        </p>
      </div>

      {/* Step 1: Select Student */}
      <div className="space-y-1 w-fit">
        <Label>Step 1: Student</Label>
        <StudentSearchSelect
          key={studentPickerResetKey}
          options={studentOptions}
          value={selectedKey}
          onChange={setSelectedKey}
          placeholder="Select a student"
          emptyMessage="No schedulable 1-on-1 enrollments yet"
          disabled={studentOptions.length === 0}
        />

        {selectedOption && (
          <div className="relative w-full mt-2 rounded-md border border-border bg-background p-3 pr-7 text-xs text-muted-foreground space-y-1">
            <button
              type="button"
              onClick={() => setSelectedKey("")}
              className="absolute top-2 right-2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear selected student"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <div className="flex items-center gap-1 text-foreground font-medium">
              <Info className="h-3.5 w-3.5" /> Enrollment details
            </div>
            <p>
              Program: {selectedOption.subject.name}
              {(() => {
                const label = packageLabel(selectedOption.enrollment, selectedOption.subject.code || "", pricing);
                return label ? ` — Package: ${label}` : "";
              })()}
            </p>
            <p>
              Preferred start:{" "}
              {selectedOption.enrollment.preferredStartDate
                ? new Date(selectedOption.enrollment.preferredStartDate).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : "Any date"}
            </p>
            <p>Time Slot Availability: {preferredSlotLabel(selectedOption.enrollment, selectedOption.subject.code || "")}</p>
            <p>Available Days: {preferredDaysLabel(selectedOption.enrollment, selectedOption.subject.code || "")}</p>
            <p>
              Guardian: {personDisplayName(selectedOption.enrollment.parent) || "—"}
              {selectedOption.enrollment.parent?.email ? ` • ${selectedOption.enrollment.parent.email}` : ""}
              {selectedOption.enrollment.parent?.phone ? ` • ${selectedOption.enrollment.parent.phone}` : ""}
            </p>
          </div>
        )}
      </div>

      {/* Step 2: Choose Days + time */}
      <div className="space-y-1">
        <Label>
          Step 2: Days &amp; time
          {requiredDays !== null && (
            <span className="text-muted-foreground font-normal"> (select exactly {requiredDays} day{requiredDays === 1 ? "" : "s"})</span>
          )}
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {DAY_OPTIONS.map((day) => {
            const selected = selectedDays.includes(day.value);
            const disabled = !selected && requiredDays !== null && selectedDays.length >= requiredDays;
            return (
              <Button
                key={day.value}
                type="button"
                size="sm"
                variant={selected ? "default" : "outline"}
                disabled={disabled}
                onClick={() => toggleDay(day.value)}
              >
                {day.label}
              </Button>
            );
          })}
        </div>
        {requiredDays !== null && (
          <p className={`text-xs ${dayCountMatchesLock ? "text-emerald-600" : "text-muted-foreground"}`}>
            {selectedDays.length} of {requiredDays} selected — this package requires exactly {requiredDays} day{requiredDays === 1 ? "" : "s"} per week.
          </p>
        )}
        <Select value={selectedTime} onValueChange={setSelectedTime}>
          <SelectTrigger className="mt-2 w-56">
            <SelectValue placeholder="Select time" />
          </SelectTrigger>
          <SelectContent>
            {TIME_BLOCKS.map((time) => (
              <SelectItem key={time} value={time}>
                {formatSlotTime(time)} - {formatSlotTime(addOneHour(time))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="mt-3 space-y-1">
          <Label htmlFor="one-on-one-start-date">Starting date</Label>
          <Input
            id="one-on-one-start-date"
            type="date"
            min={todayKey}
            value={startDate}
            disabled={!selectedOption}
            onChange={(event) => setStartDate(event.target.value)}
            className="w-56"
          />
          <p className="text-xs text-muted-foreground">
            The month of sessions begins on the first chosen weekday on or after this date. Use different starting dates to stagger new
            enrollees who share the same preferred day and time.
          </p>
        </div>
      </div>

      {/* Step 3: Select Tutor */}
      <div className="space-y-1">
        <Label>Step 3: Tutor</Label>
        <Select value={selectedTutorId} onValueChange={setSelectedTutorId} disabled={!selectedOption}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder={selectedOption ? "Select a tutor" : "Select a student first"} />
          </SelectTrigger>
          <SelectContent>
            {tutors.map((tutor) => (
              <SelectItem key={tutor._id} value={tutor._id}>
                {personDisplayName(tutor)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {selectedTutorId && (
          <div className="mt-2 rounded-md border border-border bg-background p-2 space-y-2" data-testid="tutor-day-availability">
            {checking && !check ? (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Checking tutor availability…
              </p>
            ) : (
              selectedDays.map((day) => {
                const label = DAY_OPTIONS.find((d) => d.value === day)?.label;
                const conflict = conflictForDay(day);
                const tutorId = effectiveTutorId(day);
                const tutorName = personDisplayName(tutors.find((t) => t._id === tutorId)) || "Tutor";
                const alt = altTutors[day];
                return (
                  <div key={day} className="space-y-1" data-testid={`day-row-${day}`}>
                    <p className={`text-xs ${conflict ? "text-destructive" : check ? "text-emerald-600" : "text-muted-foreground"}`}>
                      {label} {formatSlotTime(selectedTime)} — {tutorName}
                      {dayTutors[day] ? " (assigned for this day)" : ""}:{" "}
                      {conflict ? `Not available (${formatDateKey(conflict.date)}: ${conflict.reason})` : check ? "Available" : "…"}
                    </p>
                    {(conflict || dayTutors[day]) && (
                      <div className="flex flex-wrap items-center gap-2 pl-2">
                        {dayTutors[day] ? (
                          <Button type="button" size="sm" variant="ghost" onClick={() => setTutorForDay(day, "")}>
                            Use {personDisplayName(tutors.find((t) => t._id === selectedTutorId)) || "first-choice tutor"} for {label}
                          </Button>
                        ) : null}
                        {conflict && alt === undefined && (
                          <Button type="button" size="sm" variant="outline" onClick={() => void loadAlternativeTutors(day)}>
                            Assign a different tutor for {label}
                          </Button>
                        )}
                        {conflict && alt === "loading" && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Finding tutors who can cover {label}…</span>
                        )}
                        {conflict && Array.isArray(alt) && alt.length === 0 && (
                          <span className="text-xs text-muted-foreground">No other tutor is free on {label} at this time — try another time or starting date.</span>
                        )}
                        {conflict && Array.isArray(alt) && alt.length > 0 && (
                          <Select value="" onValueChange={(value) => setTutorForDay(day, value)}>
                            <SelectTrigger className="w-56 h-8" aria-label={`Tutor for ${label}`}>
                              <SelectValue placeholder={`Tutor for ${label}`} />
                            </SelectTrigger>
                            <SelectContent>
                              {alt.map((id) => (
                                <SelectItem key={id} value={id}>{personDisplayName(tutors.find((t) => t._id === id))}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
            {check && !check.ok && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 space-y-1 dark:bg-amber-950/20 dark:text-amber-200" data-testid="start-date-suggestions">
                <p>
                  Some sessions from {formatDateKey(check.startDate)} can&apos;t be booked
                  {check.slotCap ? ` (the center fits at most ${check.slotCap} one-on-one sessions per hour)` : ""}.
                  Assign a different tutor for the blocked day, or pick a different starting date:
                </p>
                {check.suggestions.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {check.suggestions.map((date) => (
                      <Button key={date} type="button" size="sm" variant="outline" onClick={() => setStartDate(date)}>
                        Start {formatDateKey(date)}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p>No fully open starting date in the next 6 weeks with this tutor and time — try another tutor or time.</p>
                )}
              </div>
            )}
            {check?.ok && (
              <p className="text-xs text-emerald-600">All sessions for the month starting {formatDateKey(check.startDate)} are available.</p>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Step 4: Generate */}
      <div className="flex justify-end">
        <Button type="button" className="btn-glow" disabled={!allDaysAvailable || submitting} onClick={handleGenerate}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Calendar className="h-4 w-4 mr-2" />}
          Step 4: Generate Session Slots
        </Button>
      </div>
    </div>
  );
}
