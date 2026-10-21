import { useEffect, useMemo, useState } from "react";
import { Loader2, Calendar, Info, X, Users, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  scheduleService,
  type AdminEnrollment,
  type AdminSchedule,
  type WeeklyScheduleSubjectOption,
  type WeeklyScheduleTutorOption,
  type PricingPackage,
  type MonthlyScheduleCheck,
  type MonthlySlotGridEntry,
} from "@/services/api";
import { REALTIME_EVENTS } from "@/lib/realtimeBridge";
import { StudentSearchSelect } from "./StudentSearchSelect";
import { isEnrollmentSchedulable, enrollmentAlreadyScheduledForProgram } from "@/utils/enrollmentEligibility";
import { getRequiredDaysForPackage } from "@/constants/programs";

// BeeBright Scheduling Spec, Section 1 — student-first 1-on-1 scheduling wizard.
// Replaces the old slot-first "create a tutor slot, assign a child later" flow for
// Academic Tutorial (ACT102) / Examination Preparation (EXP106): pick the student
// first (their enrollment already says which program), then days/time, then a tutor
// with real availability, then generate a month of 1-hour sessions in one step via
// the existing createMonthlySchedules backend primitive.
//
// Calendar-first / slot-first tutor step (follow-up fix): the OLD flow made the admin
// pick ONE tutor first and only then see that tutor's own calendar — finding an open
// slot meant trying tutors one at a time. Step 3 is now a REAL monthly calendar grid
// (Sun-Sat columns, weeks as rows, prev/next month navigable — the same hand-rolled
// calendar pattern already used by AdminDashboard.tsx/StudentDashboard.tsx/
// TutorDashboard.tsx's own Schedule tabs), fed by scheduleService.getMonthlySlotGrid —
// every REAL calendar date within the student's one-month generation window that
// matches a chosen weekday, each with all 8 standard hourly slots' cross-tutor
// availability. Only those dates are clickable; every other day is grayed out,
// including anything in the past. Clicking an eligible day opens its slot detail
// (compact in the cell, full detail in the panel below the calendar); clicking an open
// slot there reveals exactly the tutors free for it — the admin still picks one
// explicitly. Nothing is auto-assigned. The underlying rule composition
// (canTutorHandleSchedule, tutor availability windows, ghost-session filtering, the
// 12-per-hour cap) is unchanged — see scheduleController.js's
// getAvailableTutorsGridForWindow.

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

interface CalendarCell { date: Date; dateKey: string; isCurrentMonth: boolean; isToday: boolean }

/** Same 42-cell month-grid shape AdminDashboard.tsx/StudentDashboard.tsx/
 *  TutorDashboard.tsx's own "Schedule" tab calendars already use (calendarDays) —
 *  reused here so Step 3 is a real monthly calendar, not a bespoke widget. */
function buildMonthCalendarCells(monthDate: Date, todayKey: string): CalendarCell[] {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const prevMonthDays = first.getDay();
  const totalCells = Math.ceil((prevMonthDays + last.getDate()) / 7) * 7 || 42;
  const start = new Date(first);
  start.setDate(start.getDate() - prevMonthDays);
  const cells: CalendarCell[] = [];
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const dateKey = toDateKey(d);
    cells.push({ date: d, dateKey, isCurrentMonth: d.getMonth() === month, isToday: dateKey === todayKey });
  }
  return cells;
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

/** One chosen day's final slot+tutor pick — set only once the admin clicks an open
 *  slot and picks a tutor for it; replaces the old shared selectedTime + dayTutors
 *  override map with one per-day assignment, matching the new "pick per day" flow. */
interface DayAssignment {
  startTime: string;
  endTime: string;
  tutorId: string;
  tutorName: string;
  // The real calendar date the admin actually clicked to make this assignment — used
  // only to keep the "Starting date" field in sync with the earliest assigned day; the
  // RECURRING pattern sent to the backend still keys off dayOfWeek, unchanged.
  assignedDateKey: string;
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
        // Admin_Schedule_and_MultiProgram_Days_Fixes.pdf #1 — once a student already has
        // a schedule generated for THIS enrollment's own cycle of the program, they must
        // stop appearing as selectable for it (they've already been scheduled). Cycle-
        // aware (not just student+program) so a brand-new Renew/Add Program enrollment
        // isn't wrongly excluded just because an older, already-scheduled cycle of the
        // same program still has schedule rows on file.
        if (enrollmentAlreadyScheduledForProgram(enrollment, subject.code || "", enrollments, schedules)) continue;
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
  // The date the month of sessions starts on — lets the admin stagger new enrollees who share the
  // same preferred day/time instead of everyone landing on the same day. Also auto-synced to the
  // earliest real date that currently has a tutor assigned (see earliestAssignedDateKey below) —
  // it stays exactly as the admin left it until the first assignment exists.
  const [startDate, setStartDate] = useState("");
  // The anchor actually sent to getMonthlySlotGrid — deliberately NOT the same value as
  // startDate once assignments exist. startDate can auto-advance/retreat to track the earliest
  // assignment, but the grid's fetch window must stay put so a day the admin already looked at
  // (e.g. an earlier day they want to assign AFTER a later one) never gets silently excluded from
  // the calendar just because startDate moved. Only a real student switch or the admin directly
  // editing the date field (or picking a "try a different starting date" suggestion) moves this.
  const [gridAnchorDate, setGridAnchorDate] = useState("");
  // Per-day final pick (slot + tutor) — the admin may assign a DIFFERENT tutor (and
  // time) to each chosen weekday, e.g. Tutor A Mon/Wed, Tutor B Thu. Keyed by
  // dayOfWeek: the pick is a RECURRING weekly pattern (same as the backend's own
  // daySlots shape), even though the admin reaches it by clicking one specific real
  // date in the calendar below.
  const [dayAssignments, setDayAssignments] = useState<Record<number, DayAssignment>>({});
  // The one real calendar date currently expanded for slot/tutor picking.
  const [focusedDateKey, setFocusedDateKey] = useState<string | null>(null);
  // Which specific slot within the focused date has its tutor list expanded.
  const [expandedSlotTime, setExpandedSlotTime] = useState<string | null>(null);
  // The month currently shown — purely a client-side view window into the already-
  // fetched grid (see below); switching months never re-fetches by itself.
  const [calendarMonth, setCalendarMonth] = useState(new Date());

  const [check, setCheck] = useState<MonthlyScheduleCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The new calendar-first/slot-first grid — keyed by REAL calendar date (YYYY-MM-DD),
  // one entry per actual date within the generation window matching a chosen weekday,
  // fetched as soon as at least one day is chosen (doesn't wait for the full required
  // day count, so the admin can use it to BUILD UP their day selection).
  const [grid, setGrid] = useState<Record<string, MonthlySlotGridEntry[]>>({});
  const [gridLoading, setGridLoading] = useState(false);
  const [gridError, setGridError] = useState<string | null>(null);

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
    setDayAssignments({});
    setFocusedDateKey(null);
    setExpandedSlotTime(null);
    setGrid({});
    setGridError(null);
    setCheck(null);
    setError(null);
    // Default the starting date to the parent's preferred start date (never in the past).
    const preferred = selectedOption?.enrollment.preferredStartDate ? toDateKey(new Date(selectedOption.enrollment.preferredStartDate)) : "";
    const resolvedStart = selectedOption ? (preferred && preferred >= todayKey ? preferred : todayKey) : "";
    setStartDate(resolvedStart);
    setGridAnchorDate(resolvedStart);
    setCalendarMonth(resolvedStart ? new Date(`${resolvedStart}T00:00:00`) : new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // Keep the visible month in sync with the grid's own anchor (student switch, a manual
  // date-field edit, or picking a "try a different starting date" suggestion) — not with
  // startDate's auto-sync to the earliest assignment, which must never yank the calendar
  // away from whatever month the admin is actively assigning days in.
  useEffect(() => {
    if (gridAnchorDate) setCalendarMonth(new Date(`${gridAnchorDate}T00:00:00`));
  }, [gridAnchorDate]);

  // Starting date always reflects the earliest real day that currently has a tutor
  // assigned — moving forward on the first assignment, and back again if an earlier day
  // is assigned afterward. Before any assignment exists, startDate is left completely
  // alone (its value comes only from the reset effect above or a direct admin edit).
  const earliestAssignedDateKey = useMemo(() => {
    const keys = Object.values(dayAssignments)
      .map((assignment) => assignment.assignedDateKey)
      .filter((key): key is string => Boolean(key));
    if (keys.length === 0) return null;
    return keys.slice().sort()[0];
  }, [dayAssignments]);

  useEffect(() => {
    if (earliestAssignedDateKey && earliestAssignedDateKey !== startDate) {
      setStartDate(earliestAssignedDateKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [earliestAssignedDateKey]);

  // Drop any per-day assignment for a day that's no longer selected.
  useEffect(() => {
    setDayAssignments((prev) => {
      const next: Record<number, DayAssignment> = {};
      for (const day of selectedDays) if (prev[day]) next[day] = prev[day];
      return next;
    });
  }, [selectedDays]);

  const daySlotsPayload = useMemo(
    () => selectedDays
      .filter((day) => dayAssignments[day])
      .map((day) => ({ dayOfWeek: day, startTime: dayAssignments[day].startTime, endTime: dayAssignments[day].endTime, tutorId: dayAssignments[day].tutorId })),
    [selectedDays, dayAssignments]
  );

  const dayCountMatchesLock = requiredDays === null || selectedDays.length === requiredDays;
  const allDaysAssigned = selectedDays.length > 0 && selectedDays.every((day) => dayAssignments[day]);
  const readyToCheck = Boolean(selectedOption && allDaysAssigned && dayCountMatchesLock && startDate && startDate >= todayKey);

  // Fetch the cross-tutor slot grid as soon as there's at least one chosen day — this
  // is what lets the admin SEE which slots to pick, so it's deliberately NOT gated on
  // the full required-day-count or on every day already being assigned. Anchored on
  // gridAnchorDate (not startDate) so the fetched window never shrinks/shifts just
  // because startDate auto-advanced to track an assignment.
  const gridReady = Boolean(selectedOption && selectedDays.length > 0 && gridAnchorDate && gridAnchorDate >= todayKey);
  useEffect(() => {
    if (!gridReady || !selectedOption) {
      setGrid({});
      setGridLoading(false);
      return;
    }
    let cancelled = false;
    setGridLoading(true);
    setGridError(null);
    const timer = setTimeout(() => {
      scheduleService
        .getMonthlySlotGrid({ enrollmentId: selectedOption.enrollment._id, subjectId: selectedOption.subject._id, days: selectedDays, startDate: gridAnchorDate })
        .then((res) => { if (!cancelled) setGrid(res.data.grid || {}); })
        .catch((err: unknown) => {
          if (cancelled) return;
          setGrid({});
          setGridError((err as { response?: { data?: { message?: string } } })?.response?.data?.message || "Could not load tutor availability.");
        })
        .finally(() => { if (!cancelled) setGridLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridReady, selectedKey, gridAnchorDate, JSON.stringify(selectedDays)]);

  // Must stay live, per spec: if another admin books a tutor or deletes a session
  // while this grid is open, the slot states refresh through the existing Socket.io
  // 'schedule:changed' event — no manual refresh. Re-fetch is just the same effect's
  // query re-run; the dependency re-fetch above still runs through the same debounce.
  useEffect(() => {
    if (!gridReady || !selectedOption) return;
    const onScheduleChanged = () => {
      scheduleService
        .getMonthlySlotGrid({ enrollmentId: selectedOption.enrollment._id, subjectId: selectedOption.subject._id, days: selectedDays, startDate: gridAnchorDate })
        .then((res) => setGrid(res.data.grid || {}))
        .catch(() => { /* best-effort live refresh; the debounced effect above will retry on the next relevant change */ });
    };
    window.addEventListener(REALTIME_EVENTS.SCHEDULE_CHANGED, onScheduleChanged);
    return () => window.removeEventListener(REALTIME_EVENTS.SCHEDULE_CHANGED, onScheduleChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridReady, selectedKey, gridAnchorDate, JSON.stringify(selectedDays)]);

  // Authoritative, date-aware availability: asks the server about every session of the
  // month for this starting date, per day and per tutor — and, when something is
  // blocked, which other starting dates work — instead of silently blocking. Unchanged
  // from before except that daySlotsPayload now always carries its own tutorId per day.
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
        .checkMonthly({ enrollmentId: selectedOption.enrollment._id, subjectId: selectedOption.subject._id, startDate, daySlots: daySlotsPayload })
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
  }, [readyToCheck, selectedKey, startDate, JSON.stringify(daySlotsPayload)]);

  const conflictForDay = (day: number) => check?.conflicts.find((c) => c.dayOfWeek === day) || null;
  const allDaysAvailable = readyToCheck && !checking && Boolean(check?.ok);

  const calendarCells = useMemo(() => buildMonthCalendarCells(calendarMonth, todayKey), [calendarMonth, todayKey]);
  const focusedDateSlots = focusedDateKey ? grid[focusedDateKey] || [] : [];
  const focusedDayOfWeek = focusedDateKey ? new Date(`${focusedDateKey}T00:00:00`).getDay() : null;

  const toggleDay = (day: number) => {
    setSelectedDays((prev) => {
      if (prev.includes(day)) {
        if (prev.length === 1) return prev; // at least one day required
        return prev.filter((value) => value !== day);
      }
      if (requiredDays !== null && prev.length >= requiredDays) return prev; // locked at the package's sessions-per-week
      return [...prev, day].sort((a, b) => a - b);
    });
    setFocusedDateKey(null);
    setExpandedSlotTime(null);
  };

  // Only a REAL date the grid actually returned (within the window, matching a
  // chosen weekday, today or later) AND on/after the current Starting date is ever
  // clickable — every other cell is grayed and ignores clicks. Mirrors the same
  // `eligible` check the calendar cell's `disabled` attribute uses, so a click can
  // never slip through even if something bypasses the disabled button.
  const selectDay = (dateKey: string) => {
    if (!grid[dateKey] || dateKey < startDate) return;
    setFocusedDateKey((prev) => (prev === dateKey ? null : dateKey));
    setExpandedSlotTime(null);
  };

  const pickSlot = (slot: MonthlySlotGridEntry) => {
    if (!slot.available) return;
    setExpandedSlotTime((prev) => (prev === slot.startTime ? null : slot.startTime));
  };

  const pickTutorForSlot = (dayOfWeek: number, dateKey: string, slot: MonthlySlotGridEntry, tutorId: string, tutorName: string) => {
    setDayAssignments((prev) => ({ ...prev, [dayOfWeek]: { startTime: slot.startTime, endTime: slot.endTime, tutorId, tutorName, assignedDateKey: dateKey } }));
    setExpandedSlotTime(null);
  };

  const clearDayAssignment = (day: number) => {
    setDayAssignments((prev) => {
      const next = { ...prev };
      delete next[day];
      return next;
    });
  };

  const resetWizard = () => {
    setSelectedKey("");
    setStudentPickerResetKey((k) => k + 1);
    setSelectedDays(DEFAULT_DAYS);
    setDayAssignments({});
    setFocusedDateKey(null);
    setExpandedSlotTime(null);
    setGrid({});
    setCheck(null);
    setStartDate("");
    setGridAnchorDate("");
    setError(null);
  };

  const handleGenerate = async () => {
    if (!selectedOption || !allDaysAvailable) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await scheduleService.createMonthly({
        enrollmentId: selectedOption.enrollment._id,
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

      {/* Step 2: Choose Days */}
      <div className="space-y-1">
        <Label>
          Step 2: Days
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

        <div className="mt-3 space-y-1">
          <Label htmlFor="one-on-one-start-date">Starting date</Label>
          <Input
            id="one-on-one-start-date"
            type="date"
            min={todayKey}
            value={startDate}
            disabled={!selectedOption}
            onChange={(event) => { setStartDate(event.target.value); setGridAnchorDate(event.target.value); }}
            className="w-56"
          />
          <p className="text-xs text-muted-foreground">
            The month of sessions begins on the first chosen weekday on or after this date. Use different starting dates to stagger new
            enrollees who share the same preferred day and time.
          </p>
        </div>
      </div>

      {/* Step 3: a REAL monthly calendar — only dates covered by the chosen weekdays
          AND on/after the Starting Date are clickable; every other day (wrong
          weekday, outside the window, or in the past) is grayed out. */}
      <div className="space-y-2">
        <Label>Step 3: Pick a time slot for each day</Label>
        {!selectedOption ? (
          <p className="text-xs text-muted-foreground">Select a student first.</p>
        ) : selectedDays.length === 0 ? (
          <p className="text-xs text-muted-foreground">Choose at least one day above to see real tutor availability.</p>
        ) : gridLoading && Object.keys(grid).length === 0 ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading tutor availability…
          </p>
        ) : gridError ? (
          <p className="text-xs text-destructive">{gridError}</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_260px]">
            <div className="rounded-md border border-border bg-background p-2" data-testid="slot-calendar">
              <div className="flex items-center justify-between px-1 pb-1.5">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  aria-label="Previous month"
                  onClick={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <p className="text-xs font-medium text-foreground">
                  {calendarMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
                </p>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  aria-label="Next month"
                  onClick={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="grid grid-cols-7 gap-px bg-border rounded overflow-hidden text-[10px]">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                  <div key={d} className="bg-muted/50 p-1 text-center font-semibold text-muted-foreground">{d}</div>
                ))}
                {calendarCells.map((cell) => {
                  const slots = grid[cell.dateKey];
                  // A day must be in the fetched window AND on/after the CURRENT Starting
                  // date to be selectable — once Starting date advances (tracking the
                  // earliest actual assignment), every earlier day locks out again, exactly
                  // like days before the original starting date always have. It becomes
                  // selectable again the moment Starting date moves back on/before it; this
                  // recomputes on every render since it reads startDate directly, no extra
                  // state to keep in sync. Doesn't touch why a day might already be grayed
                  // out for other reasons (full slots, tutor conflicts, wrong weekday) — those
                  // still come from `slots` being absent, same as before.
                  const eligible = Boolean(slots) && cell.dateKey >= startDate;
                  const openCount = slots?.filter((s) => s.available).length ?? 0;
                  const dayOfWeek = cell.date.getDay();
                  const isAssignedWeekday = Boolean(dayAssignments[dayOfWeek]);
                  const isFocused = focusedDateKey === cell.dateKey;
                  return (
                    <button
                      key={cell.dateKey}
                      type="button"
                      disabled={!eligible}
                      onClick={() => selectDay(cell.dateKey)}
                      data-testid={`calendar-day-${cell.dateKey}`}
                      title={eligible ? `${openCount}/8 slots open` : "Not selectable — outside the chosen days or starting date"}
                      className={`min-h-[52px] p-1 flex flex-col items-start gap-0.5 text-left transition-colors ${
                        !eligible
                          ? "cursor-not-allowed bg-muted/40 opacity-50"
                          : "bg-card hover:bg-primary/5 cursor-pointer"
                      } ${!cell.isCurrentMonth ? "opacity-40" : ""} ${cell.isToday ? "ring-1 ring-primary" : ""} ${
                        isFocused ? "ring-2 ring-primary" : isAssignedWeekday && eligible ? "ring-1 ring-emerald-500" : ""
                      }`}
                    >
                      <span className="text-foreground">{cell.date.getDate()}</span>
                      {eligible && (
                        <span className={`text-[9px] ${openCount > 0 ? "text-emerald-600" : "text-destructive"}`}>
                          {openCount > 0 ? `${openCount}/8 open` : "No available tutor"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="flex items-center gap-3 px-1 pt-1.5 text-[10px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full ring-1 ring-emerald-500" /> day already assigned</span>
                <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full ring-1 ring-primary" /> today / selected</span>
              </p>
            </div>

            {/* Focused day's detail — the primary picking still happens on the
                calendar grid itself (clicking a day, then a slot); this panel is
                just where the compact cell's full slot list/tutor picker lives. */}
            <div className="rounded-md border border-border bg-background p-2" data-testid="day-detail-panel">
              {!focusedDateKey ? (
                <p className="text-xs text-muted-foreground">Click a highlighted day on the calendar to see its hourly slots.</p>
              ) : (
                <>
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-1.5">
                    <p className="text-xs font-semibold text-foreground">{formatDateKey(focusedDateKey)}</p>
                    {focusedDayOfWeek !== null && dayAssignments[focusedDayOfWeek] && (
                      <span className="flex items-center gap-1 text-[11px] text-emerald-600">
                        <Users className="h-3 w-3" />
                        {dayAssignments[focusedDayOfWeek].tutorName}
                        <Button type="button" size="sm" variant="ghost" className="h-5 px-1" onClick={() => clearDayAssignment(focusedDayOfWeek)}>
                          Change
                        </Button>
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {focusedDateSlots.map((slot) => {
                      const isChosenForThisDay = focusedDayOfWeek !== null && dayAssignments[focusedDayOfWeek]?.startTime === slot.startTime;
                      return (
                        <button
                          key={slot.startTime}
                          type="button"
                          disabled={!slot.available}
                          onClick={() => pickSlot(slot)}
                          title={slot.available ? `${slot.tutors.length} tutor${slot.tutors.length === 1 ? "" : "s"} free` : slot.reason || "No available tutor for this time"}
                          data-testid={`slot-${focusedDateKey}-${slot.startTime}`}
                          className={`rounded-md border px-1.5 py-1.5 text-[11px] leading-tight transition-colors ${
                            !slot.available
                              ? "cursor-not-allowed border-border bg-muted text-muted-foreground opacity-60"
                              : isChosenForThisDay
                              ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                              : "border-border bg-card hover:border-primary hover:bg-primary/5 text-foreground"
                          }`}
                        >
                          <span className="block font-medium">{formatSlotTime(slot.startTime)}</span>
                          <span className="block">{slot.available ? `${slot.tutors.length} free` : "No available tutor"}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Eligible tutors for the slot the admin just clicked — the admin
                      still makes the final choice; nothing here auto-assigns. */}
                  {expandedSlotTime && focusedDayOfWeek !== null && (() => {
                    const slot = focusedDateSlots.find((s) => s.startTime === expandedSlotTime);
                    if (!slot) return null;
                    return (
                      <div className="mt-2 rounded-md border border-primary/30 bg-primary/5 p-2" data-testid={`tutor-picker-${focusedDateKey}`}>
                        <p className="text-xs text-muted-foreground mb-1.5">
                          {formatSlotTime(slot.startTime)}-{formatSlotTime(slot.endTime)} — tutors free at this exact day/time:
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {slot.tutors.map((t) => (
                            <Button
                              key={t._id}
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => pickTutorForSlot(focusedDayOfWeek, focusedDateKey as string, slot, t._id, t.name)}
                            >
                              {t.name}
                            </Button>
                          ))}
                        </div>
                        <Button type="button" size="sm" variant="ghost" className="mt-1.5 h-6 px-1.5" onClick={() => setExpandedSlotTime(null)}>
                          Cancel
                        </Button>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          </div>
        )}

        {/* Final, authoritative month-long check — unchanged logic, now fed by the
            per-day assignments made above instead of one shared time + a single
            default tutor. */}
        {allDaysAssigned && (
          <div className="mt-2 rounded-md border border-border bg-background p-2 space-y-1" data-testid="tutor-day-availability">
            {checking && !check ? (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Confirming the full month…
              </p>
            ) : (
              selectedDays.map((day) => {
                const label = DAY_OPTIONS.find((d) => d.value === day)?.label;
                const conflict = conflictForDay(day);
                const assignment = dayAssignments[day];
                return (
                  <p key={day} className={`text-xs ${conflict ? "text-destructive" : check ? "text-emerald-600" : "text-muted-foreground"}`} data-testid={`day-row-${day}`}>
                    {label} {assignment ? formatSlotTime(assignment.startTime) : ""} — {assignment?.tutorName}:{" "}
                    {conflict ? `Not available (${formatDateKey(conflict.date)}: ${conflict.reason})` : check ? "Available" : "…"}
                  </p>
                );
              })
            )}
            {check && !check.ok && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 space-y-1 dark:bg-amber-950/20 dark:text-amber-200" data-testid="start-date-suggestions">
                <p>
                  Some sessions from {formatDateKey(check.startDate)} can&apos;t be booked
                  {check.slotCap ? ` (the center fits at most ${check.slotCap} one-on-one sessions per hour)` : ""}.
                  Pick a different slot above for the blocked day, or try a different starting date:
                </p>
                {check.suggestions.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {check.suggestions.map((date) => (
                      <Button key={date} type="button" size="sm" variant="outline" onClick={() => { setStartDate(date); setGridAnchorDate(date); }}>
                        Start {formatDateKey(date)}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p>No fully open starting date in the next 6 weeks with these picks — try different slots or tutors.</p>
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
