import { useEffect, useMemo, useState } from "react";
import { Loader2, Calendar, Info, Users, Plus, X } from "lucide-react";
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
  type PlaygroupGroupOption,
  type WeeklyScheduleSubjectOption,
  type WeeklyScheduleTutorOption,
} from "@/services/api";
import { StudentSearchSelect } from "./StudentSearchSelect";
import { isEnrollmentSchedulable } from "@/utils/enrollmentEligibility";

// BeeBright Scheduling Spec, Section 2 — group-based Toddlers Playgroup scheduling.
// Replaces the old slot-first panel: pick the student first, then days + a fixed time
// window (8-10 AM or 1-3 PM only), then either join an existing group (same day
// pattern + window, ratio status shown) or create a new one with a tutor picker, then
// generate a month of sessions via createOrJoinPlaygroupGroup.

const PLAYGROUP_CODE = "TPG101";

const DAY_OPTIONS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

const TIME_WINDOWS = [
  { startTime: "08:00", endTime: "10:00", label: "8:00 AM - 10:00 AM" },
  { startTime: "13:00", endTime: "15:00", label: "1:00 PM - 3:00 PM" },
];

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

function enrollmentCoversPlaygroup(enrollment: AdminEnrollment): boolean {
  if ((enrollment.packages || []).some((pkg) => (pkg.programCode || "").toUpperCase() === PLAYGROUP_CODE)) return true;
  return (enrollment.selectedSubjects || []).some((subject) => (subject.code || "").toUpperCase() === PLAYGROUP_CODE);
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

interface StudentOption {
  key: string;
  enrollment: AdminEnrollment;
  label: string;
}

interface PlaygroupSchedulingWizardProps {
  subjects: WeeklyScheduleSubjectOption[];
  enrollments: AdminEnrollment[];
  tutors: WeeklyScheduleTutorOption[];
  onCreated: () => void;
}

export function PlaygroupSchedulingWizard({ subjects, enrollments, tutors, onCreated }: PlaygroupSchedulingWizardProps) {
  const playgroupSubject = useMemo(
    () => subjects.find((subject) => (subject.code || "").toUpperCase() === PLAYGROUP_CODE) || null,
    [subjects]
  );

  const studentOptions = useMemo<StudentOption[]>(() => {
    return enrollments
      .filter((enrollment) => isEnrollmentSchedulable(enrollment) && enrollmentCoversPlaygroup(enrollment))
      .map((enrollment) => ({
        key: enrollment._id,
        enrollment,
        label: childNameFromEnrollment(enrollment),
      }));
  }, [enrollments]);

  const [selectedKey, setSelectedKey] = useState("");
  // Bumped on reset to force StudentSearchSelect to remount and clear its own search text.
  const [studentPickerResetKey, setStudentPickerResetKey] = useState(0);
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [selectedWindow, setSelectedWindow] = useState(TIME_WINDOWS[0]);
  const [groups, setGroups] = useState<PlaygroupGroupOption[] | null>(null);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [creatingNewGroup, setCreatingNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupTutorIds, setNewGroupTutorIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedOption = studentOptions.find((option) => option.key === selectedKey) || null;

  useEffect(() => {
    setError(null);
  }, [selectedKey]);

  // Whenever the day pattern or time window changes, look up matching groups.
  useEffect(() => {
    if (selectedDays.length === 0) {
      setGroups(null);
      setSelectedGroupId("");
      setCreatingNewGroup(false);
      return;
    }
    let cancelled = false;
    setLoadingGroups(true);
    setError(null);
    scheduleService
      .listPlaygroupGroups({ daysOfWeek: selectedDays, startTime: selectedWindow.startTime, endTime: selectedWindow.endTime })
      .then((res) => {
        if (cancelled) return;
        setGroups(res.data?.groups || []);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingGroups(false);
      });
    setSelectedGroupId("");
    setCreatingNewGroup(false);
    return () => {
      cancelled = true;
    };
  }, [selectedDays, selectedWindow]);

  const toggleDay = (day: number) => {
    setSelectedDays((prev) => (prev.includes(day) ? prev.filter((value) => value !== day) : [...prev, day].sort((a, b) => a - b)));
  };

  const toggleNewGroupTutor = (tutorId: string) => {
    setNewGroupTutorIds((prev) => (prev.includes(tutorId) ? prev.filter((id) => id !== tutorId) : [...prev, tutorId]));
  };

  const resetWizard = () => {
    setSelectedKey("");
    setStudentPickerResetKey((k) => k + 1);
    setSelectedDays([]);
    setSelectedWindow(TIME_WINDOWS[0]);
    setGroups(null);
    setSelectedGroupId("");
    setCreatingNewGroup(false);
    setNewGroupName("");
    setNewGroupTutorIds([]);
    setError(null);
  };

  const canGenerate =
    Boolean(selectedOption) &&
    Boolean(playgroupSubject) &&
    selectedDays.length > 0 &&
    ((Boolean(selectedGroupId)) || (creatingNewGroup && newGroupTutorIds.length > 0));

  const handleGenerate = async () => {
    if (!selectedOption || !playgroupSubject || !canGenerate) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await scheduleService.createOrJoinPlaygroupGroup({
        enrollmentId: selectedOption.enrollment._id,
        subjectId: playgroupSubject._id,
        ...(selectedGroupId
          ? { groupId: selectedGroupId }
          : {
              tutorIds: newGroupTutorIds,
              daysOfWeek: selectedDays,
              startTime: selectedWindow.startTime,
              endTime: selectedWindow.endTime,
              name: newGroupName,
            }),
      });
      if (res.data?.success) {
        toast.success(res.data.message || "Playgroup sessions generated.");
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
        <h4 className="font-semibold text-foreground">Toddlers Playgroup Scheduling</h4>
        <p className="text-xs text-muted-foreground">
          Group sessions — 1 tutor per 2 children minimum (more always allowed), 2-12 children, 8-10 AM or 1-3 PM only.
        </p>
      </div>

      {/* Step 1: Choose Student */}
      <div className="space-y-1 w-fit">
        <Label>Step 1: Student</Label>
        <StudentSearchSelect
          key={studentPickerResetKey}
          options={studentOptions}
          value={selectedKey}
          onChange={setSelectedKey}
          placeholder="Select a student"
          emptyMessage="No schedulable Playgroup enrollments yet"
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
            <p>Program: Toddlers Playgroup</p>
            <p>
              Preferred start:{" "}
              {selectedOption.enrollment.preferredStartDate
                ? new Date(selectedOption.enrollment.preferredStartDate).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : "Any date"}
              {selectedOption.enrollment.preferredDays && selectedOption.enrollment.preferredDays.length > 0
                ? ` • Preferred days: ${selectedOption.enrollment.preferredDays.map((d) => d.slice(0, 3)).join("/")}`
                : ""}
            </p>
            <p>
              Guardian: {personDisplayName(selectedOption.enrollment.parent) || "—"}
              {selectedOption.enrollment.parent?.email ? ` • ${selectedOption.enrollment.parent.email}` : ""}
              {selectedOption.enrollment.parent?.phone ? ` • ${selectedOption.enrollment.parent.phone}` : ""}
            </p>
          </div>
        )}
      </div>

      {/* Step 2: Choose Days + fixed time window */}
      <div className="space-y-1">
        <Label>Step 2: Days &amp; time window</Label>
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
        <Select
          value={`${selectedWindow.startTime}-${selectedWindow.endTime}`}
          onValueChange={(value) => {
            const match = TIME_WINDOWS.find((w) => `${w.startTime}-${w.endTime}` === value);
            if (match) setSelectedWindow(match);
          }}
        >
          <SelectTrigger className="mt-2 w-56">
            <SelectValue placeholder="Select time window" />
          </SelectTrigger>
          <SelectContent>
            {TIME_WINDOWS.map((window) => (
              <SelectItem key={`${window.startTime}-${window.endTime}`} value={`${window.startTime}-${window.endTime}`}>
                {window.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Step 3: Group Assignment */}
      {selectedDays.length > 0 && (
        <div className="space-y-2">
          <Label>Step 3: Group assignment</Label>
          {loadingGroups ? (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Looking for matching groups…
            </p>
          ) : (
            <>
              {(groups || []).length > 0 && (
                <div className="space-y-2">
                  {(groups || []).map((group) => (
                    <div
                      key={group._id}
                      className={`rounded-md border p-2 flex items-center justify-between gap-2 ${
                        selectedGroupId === group._id ? "border-primary bg-primary/5" : "border-border bg-background"
                      }`}
                    >
                      <div className="text-xs">
                        <p className="font-medium text-foreground flex items-center gap-1">
                          <Users className="h-3.5 w-3.5" /> {group.name || "Playgroup Group"}
                        </p>
                        <p className="text-muted-foreground">
                          {group.tutors.map((t) => personDisplayName(t)).join(", ") || "No tutors"} • {group.childCount}/{group.maxChildren} children
                        </p>
                        {!group.hasRoom && <p className="text-destructive">At capacity for this ratio — add tutors before joining.</p>}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant={selectedGroupId === group._id ? "default" : "outline"}
                        disabled={!group.hasRoom}
                        onClick={() => {
                          setSelectedGroupId(group._id);
                          setCreatingNewGroup(false);
                        }}
                      >
                        {selectedGroupId === group._id ? "Selected" : "Join"}
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {!creatingNewGroup ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setCreatingNewGroup(true);
                    setSelectedGroupId("");
                  }}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Create New Group
                </Button>
              ) : (
                <div className="rounded-md border border-border bg-background p-3 space-y-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Group name (optional)</Label>
                    <Input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} placeholder="e.g. Morning Toddlers" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Tutors ({newGroupTutorIds.length} selected)</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {tutors.map((tutor) => {
                        const selected = newGroupTutorIds.includes(tutor._id);
                        return (
                          <Button
                            key={tutor._id}
                            type="button"
                            size="sm"
                            variant={selected ? "default" : "outline"}
                            onClick={() => toggleNewGroupTutor(tutor._id)}
                          >
                            {personDisplayName(tutor)}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Step 4: Generate */}
      <div className="flex justify-end">
        <Button type="button" className="btn-glow" disabled={!canGenerate || submitting} onClick={handleGenerate}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Calendar className="h-4 w-4 mr-2" />}
          Step 4: Generate Session Slots
        </Button>
      </div>
    </div>
  );
}
