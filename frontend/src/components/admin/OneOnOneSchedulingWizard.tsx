import { useEffect, useMemo, useState } from "react";
import { Loader2, Calendar, Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
  type WeeklyScheduleSubjectOption,
  type WeeklyScheduleTutorOption,
} from "@/services/api";
import { StudentSearchSelect } from "./StudentSearchSelect";

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

function enrollmentIsSchedulable(enrollment: AdminEnrollment) {
  const status = enrollment.status || "";
  return (
    ["active", "approved"].includes(status) ||
    (enrollment.paymentStatus === "paid" && status !== "cancelled" && status !== "rejected")
  );
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

function toMonthStartKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

function preferredTimeLabel(preferredTime?: string | null) {
  if (preferredTime === "morning") return "Morning";
  if (preferredTime === "afternoon") return "Afternoon";
  return "No time preference";
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
  onCreated: () => void;
}

export function OneOnOneSchedulingWizard({ subjects, enrollments, tutors, onCreated }: OneOnOneSchedulingWizardProps) {
  const oneOnOneSubjects = useMemo(
    () => subjects.filter((subject) => ONE_ON_ONE_CODES.has((subject.code || "").toUpperCase())),
    [subjects]
  );

  const studentOptions = useMemo<StudentSubjectOption[]>(() => {
    const options: StudentSubjectOption[] = [];
    for (const enrollment of enrollments) {
      if (!enrollmentIsSchedulable(enrollment)) continue;
      const covered = enrollmentCoveredOneOnOneSubjects(enrollment, oneOnOneSubjects);
      for (const subject of covered) {
        options.push({
          key: `${enrollment._id}::${subject._id}`,
          enrollment,
          subject,
          label: `${childNameFromEnrollment(enrollment)} — ${subject.name}`,
        });
      }
    }
    return options;
  }, [enrollments, oneOnOneSubjects]);

  const [selectedKey, setSelectedKey] = useState("");
  // Bumped on reset to force StudentSearchSelect to remount and clear its own search text.
  const [studentPickerResetKey, setStudentPickerResetKey] = useState(0);
  const [selectedDays, setSelectedDays] = useState<number[]>(DEFAULT_DAYS);
  const [selectedTime, setSelectedTime] = useState(TIME_BLOCKS[0]);
  const [selectedTutorId, setSelectedTutorId] = useState("");
  const [slotsByDay, setSlotsByDay] = useState<Record<string, { startTime: string; endTime: string }[]> | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedOption = studentOptions.find((option) => option.key === selectedKey) || null;

  // Reset downstream steps whenever the student/program changes.
  useEffect(() => {
    setSelectedTutorId("");
    setSlotsByDay(null);
    setError(null);
  }, [selectedKey]);

  useEffect(() => {
    if (!selectedTutorId) {
      setSlotsByDay(null);
      return;
    }
    let cancelled = false;
    setLoadingSlots(true);
    setError(null);
    scheduleService
      .getAvailableSlotsByDay(selectedTutorId, toMonthStartKey(new Date()))
      .then((res) => {
        if (cancelled) return;
        setSlotsByDay(res.data?.slotsByDay || {});
      })
      .catch(() => {
        if (!cancelled) setSlotsByDay({});
      })
      .finally(() => {
        if (!cancelled) setLoadingSlots(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTutorId]);

  const dayAvailability = useMemo(
    () =>
      selectedDays.map((day) => {
        const free = slotsByDay?.[String(day)] || [];
        const match = free.find((slot) => slot.startTime === selectedTime);
        return { day, available: Boolean(match) };
      }),
    [selectedDays, selectedTime, slotsByDay]
  );

  const allDaysAvailable =
    Boolean(selectedTutorId) && Boolean(slotsByDay) && dayAvailability.length > 0 && dayAvailability.every((d) => d.available);

  const toggleDay = (day: number) => {
    setSelectedDays((prev) => {
      if (prev.includes(day)) {
        if (prev.length === 1) return prev; // at least one day required
        return prev.filter((value) => value !== day);
      }
      return [...prev, day].sort((a, b) => a - b);
    });
  };

  const resetWizard = () => {
    setSelectedKey("");
    setStudentPickerResetKey((k) => k + 1);
    setSelectedDays(DEFAULT_DAYS);
    setSelectedTime(TIME_BLOCKS[0]);
    setSelectedTutorId("");
    setSlotsByDay(null);
    setError(null);
  };

  const handleGenerate = async () => {
    if (!selectedOption || !selectedTutorId || !allDaysAvailable) return;
    setSubmitting(true);
    setError(null);
    try {
      const endTime = addOneHour(selectedTime);
      const daySlots = selectedDays.map((dayOfWeek) => ({ dayOfWeek, startTime: selectedTime, endTime }));
      const res = await scheduleService.createMonthly({
        enrollmentId: selectedOption.enrollment._id,
        tutorId: selectedTutorId,
        subjectId: selectedOption.subject._id,
        daySlots,
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
            <p>Program: {selectedOption.subject.name}</p>
            <p>
              Preferred start:{" "}
              {selectedOption.enrollment.preferredStartDate
                ? new Date(selectedOption.enrollment.preferredStartDate).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : "Any date"}{" "}
              • {preferredTimeLabel(selectedOption.enrollment.preferredTime)}
            </p>
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
        <Label>Step 2: Days &amp; time</Label>
        <div className="flex flex-wrap gap-1.5">
          {DAY_OPTIONS.map((day) => (
            <Button
              key={day.value}
              type="button"
              size="sm"
              variant={selectedDays.includes(day.value) ? "default" : "outline"}
              onClick={() => toggleDay(day.value)}
            >
              {day.label}
            </Button>
          ))}
        </div>
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
          <div className="mt-2 rounded-md border border-border bg-background p-2 space-y-1">
            {loadingSlots ? (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Checking tutor availability…
              </p>
            ) : (
              dayAvailability.map(({ day, available }) => (
                <p key={day} className={`text-xs ${available ? "text-emerald-600" : "text-destructive"}`}>
                  {DAY_OPTIONS.find((d) => d.value === day)?.label} {formatSlotTime(selectedTime)}:{" "}
                  {available ? "Available" : "Not available — choose a different tutor or time"}
                </p>
              ))
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
