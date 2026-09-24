import { useEffect, useState, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { formatAge } from "@/components/enrollment/wizard-types";
import { checkProgramEligibility } from "@/components/enrollment/wizard-types";
import { PROGRAM_LABELS } from "@/constants/programs";
import DocUploadField from "@/components/enrollment/DocUploadField";
import {
  validateFullName, validateBirthdate, birthdateMin, birthdateMax, toTitleCase, computeAgeYears,
} from "@/lib/enrollmentValidation";
import {
  BookOpen,
  Calendar,
  Clock,
  CheckCircle,
  Award,
  ChevronLeft,
  ChevronRight,
  Video,
  FileText,
  Loader2,
  Download,
  Link as LinkIcon,
  Image as ImageIcon,
} from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { MyRequestsBell } from "@/components/notifications/MyRequestsBell";
import { StatCard } from "@/components/ui/stat-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StarRating } from "@/components/ui/star-rating";
import FilePreview from "@/components/enrollment/FilePreview";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { UserAvatar } from "@/components/UserAvatar";
import { enrollmentService, assessmentService, scheduleService, gradeService, remarkService, announcementService, auditLogService, uploadsBaseUrl, type GradeItem, type RemarkItem, type AnnouncementItem, type AuditLogItem } from "@/services/api";
import { EnrollmentAssessmentView } from "@/components/enrollment/EnrollmentAssessmentView";
import type { PreEnrollmentAssessment } from "@/components/enrollment/assessment-types";
import RenewProgramModal, { type RenewChildInfo } from "@/components/enrollment/RenewProgramModal";
import { ContactTutorPanel } from "@/components/dashboard/ContactTutorPanel";
import { useSelectedChild } from "@/hooks/useSelectedChild";
import { resolveUploadUrl, displayStudentId } from "@/lib/children";
import { remainingBalanceOf, expectedRemainingAfterDown, peso, type BalanceEnrollment } from "@/lib/balance";
import { notifyBadgesChanged } from "@/lib/navBadges";

function formatTime12h(hhmm: string) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const h12 = h % 12 || 12;
  const ampm = h < 12 ? "AM" : "PM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatSlotTime(hhmm: string) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const h12 = h % 12 || 12;
  const ampm = h < 12 ? "AM" : "PM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatClassTutorNames(session: {
  tutor?: { firstName?: string; lastName?: string; middleName?: string } | null;
  tutors?: Array<{ firstName?: string; lastName?: string; middleName?: string }>;
}) {
  const tutors = Array.isArray(session.tutors) && session.tutors.length > 0
    ? session.tutors
    : session.tutor
      ? [session.tutor]
      : [];
  const names = tutors
    .map((tutor) => [tutor.firstName, tutor.lastName].filter(Boolean).join(" "))
    .filter(Boolean);
  return names.length ? names.join(", ") : "—";
}

const SCHOOL_WEEK_DAYS = [
  { label: "Mon", offset: 0 },
  { label: "Tue", offset: 1 },
  { label: "Wed", offset: 2 },
  { label: "Thu", offset: 3 },
  { label: "Fri", offset: 4 },
  { label: "Sat", offset: 5 },
];

function addDays(baseDate: Date, days: number) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfSchoolWeek(input: Date) {
  const d = new Date(input);
  d.setHours(0, 0, 0, 0);
  const mondayOffset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - mondayOffset);
  return d;
}

function toDateKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toStableDateKey(dateLike: string) {
  if (!dateLike) return "";
  const trimmed = String(dateLike).trim();
  const isoDay = trimmed.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDay) return isoDay;
  const d = new Date(trimmed);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function toMinutes(hhmm: string) {
  const [h, m] = String(hhmm || "00:00").split(":").map(Number);
  const hh = Number.isFinite(h) ? h : 0;
  const mm = Number.isFinite(m) ? m : 0;
  return hh * 60 + mm;
}

function announcementCategoryLabel(category: string) {
  return {
    sick_leave: "Sick Leave",
    exam: "Exam",
    quiz: "Quiz",
    exam_quiz: "Exam / Quiz",
    materials: "Materials to Bring",
    reschedule: "Reschedule",
    reminder: "Reminder",
    suspension: "Class Suspension",
    maintenance: "Maintenance",
    holiday: "Holiday",
    general: "Announcement",
  }[category] || category;
}

/** Center announcements always read "Bee Bright Admin" (whether an Admin or Super Admin posted it); tutor announcements keep the tutor's name. */
function announcementAuthorLabel(a: Pick<AnnouncementItem, "author" | "authorRole">) {
  if (a.authorRole === "admin") return "Bee Bright Admin";
  const name = a.author ? [a.author.firstName, a.author.lastName].filter(Boolean).join(" ") : "";
  return name || "Tutor";
}

function summarizeAnnouncement(body: string) {
  const trimmed = body.trim();
  return trimmed.length > 110 ? `${trimmed.slice(0, 107)}...` : trimmed;
}

export default function StudentDashboard() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isParent = user?.role === "parent";

  // ONE shared "Viewing child" selection + enrollment list for the whole parent
  // dashboard (Overview, Progress, Payments, Settings, sidebar badges…). See
  // contexts/SelectedChildContext.tsx — no page keeps its own copy.
  const {
    enrollments,
    setEnrollments,
    loading: enrollmentsLoading,
    refresh: fetchEnrollments,
    childList: children,
    activeChildId,
    setActiveChildId,
  } = useSelectedChild();

  // Payment reminder popup: shown right after a child is added / a program is renewed
  // or added, and once per browser session while a remaining 50% balance is still owed.
  const [balancePopup, setBalancePopup] = useState<{ heading: string; lines: string[] } | null>(null);
  const [schedules, setSchedules] = useState<{
    _id: string;
    date: string;
    startTime: string;
    endTime: string;
    attendanceStatus?: 'unmarked' | 'present' | 'absent';
    sessionType?: 'one-on-one' | 'small-group' | 'playgroup';
    subject?: { name: string };
    tutor?: { _id?: string; firstName?: string; lastName?: string; middleName?: string; email?: string; phone?: string };
    tutors?: Array<{ _id?: string; firstName?: string; lastName?: string; middleName?: string; email?: string; phone?: string }>;
  }[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(true);
  const [progressGrades, setProgressGrades] = useState<GradeItem[]>([]);
  const [progressGradesLoading, setProgressGradesLoading] = useState(false);
  const [progressRemarks, setProgressRemarks] = useState<RemarkItem[]>([]);
  const [progressRemarksLoading, setProgressRemarksLoading] = useState(false);
  const [remarkAttachmentUrls, setRemarkAttachmentUrls] = useState<Record<string, string>>({});
  const [remarkProgramFilter, setRemarkProgramFilter] = useState("all");
  const [remarkTutorFilter, setRemarkTutorFilter] = useState("all");
  const [remarkActivityFilter, setRemarkActivityFilter] = useState("");
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [announcementsLoading, setAnnouncementsLoading] = useState(false);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<AnnouncementItem | null>(null);
  const [activityLogs, setActivityLogs] = useState<AuditLogItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [weekStart, setWeekStart] = useState<Date>(() => startOfSchoolWeek(new Date()));
  const [isAddChildOpen, setIsAddChildOpen] = useState(false);
  const [isRenewModalOpen, setIsRenewModalOpen] = useState(false);
  const [renewChildInfo, setRenewChildInfo] = useState<RenewChildInfo | null>(null);
  const [isAddingChild, setIsAddingChild] = useState(false);
  const [addChildStep, setAddChildStep] = useState(1);
  const [expandedPrograms, setExpandedPrograms] = useState<string[]>([]);
  const [pricing, setPricing] = useState<{ programCode: string; packageSlug: string; displayName: string; durationDesc?: string; priceFull: number; priceDown?: number | null; ageMin?: number | null; ageMax?: number | null }[]>([]);
  const [assessmentTemplates, setAssessmentTemplates] = useState<{ _id: string; title: string; sections?: { title?: string; items?: { key: string; label: string }[] }[]; ratingScale?: { value: string; label: string }[]; infoFields?: { key: string; label: string }[] }[]>([]);
  const [assessmentRatings, setAssessmentRatings] = useState<Record<string, string>>({});
  const [assessmentInfo, setAssessmentInfo] = useState<Record<string, string>>({});
  const [assessmentTemplateId, setAssessmentTemplateId] = useState("");
  const [paymentProofFile, setPaymentProofFile] = useState<File | null>(null);
  const [paymentReference, setPaymentReference] = useState("");
  const [hasAllergies, setHasAllergies] = useState<"yes" | "no" | "">("");
  const [hasMedicalConditions, setHasMedicalConditions] = useState<"yes" | "no" | "">("");
  const [newChild, setNewChild] = useState({ firstName: "", middleName: "", lastName: "", birthdate: "", packageKey: "", preferredStartDate: "", paymentMethod: "gcash", allergies: "", medications: "", specialNeeds: false, specialNeedsDetails: "", assessmentApplicable: false, assessmentRemarks: "" });
  const [newChildConsent, setNewChildConsent] = useState(false);
  type ChildDoc = { dataUrl: string; fileName: string; fileSize: number } | null;
  const [childDocs, setChildDocs] = useState<{ birthCert: ChildDoc; photo: ChildDoc; guardianId: ChildDoc }>({ birthCert: null, photo: null, guardianId: null });
  const [childErrors, setChildErrors] = useState<Record<string, string>>({});
  const childDocsComplete = Boolean(childDocs.birthCert && childDocs.photo && childDocs.guardianId);

  // ─── Schedule view controls ────────────────────────────────────────────────────
  const [scheduleViewMode, setScheduleViewMode] = useState<"monthly" | "weekly" | "daily">("monthly");
  const [calendarMonth, setCalendarMonth] = useState(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [scheduleDailyDate, setScheduleDailyDate] = useState(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  });
  const [scheduleWeekStart, setScheduleWeekStart] = useState<Date>(() => startOfSchoolWeek(new Date()));

  // Once per browser session, if any remaining 50% balance is outstanding, say so.
  useEffect(() => {
    if (!isParent || enrollmentsLoading) return;
    const owed = enrollments.map((e) => remainingBalanceOf(e as BalanceEnrollment)).filter((r) => r > 0);
    if (owed.length === 0) return;
    try {
      if (sessionStorage.getItem("bb-balance-popup-shown")) return;
      sessionStorage.setItem("bb-balance-popup-shown", "1");
    } catch {
      /* storage unavailable — show it anyway */
    }
    const total = owed.reduce((a, b) => a + b, 0);
    setBalancePopup((current) => current ?? {
      heading: "Remaining balance due",
      lines: [
        `You have ${owed.length} enrollment${owed.length === 1 ? "" : "s"} with a remaining 50% balance, ${peso(total)} in total.`,
        "Open Payments to review and pay it.",
      ],
    });
  }, [isParent, enrollmentsLoading, enrollments]);

  const activeChild = isParent ? children.find((c) => c.key === activeChildId) : undefined;
  // For a parent, the child's real User._id (needed by the schedule/grades/
  // materials endpoints) may not exist yet if no class has ever been scheduled
  // for them — that's a legitimate "nothing to show yet" state, not an error.
  const activeChildUserId = isParent ? activeChild?.studentUserId ?? null : user?.id ?? null;
  const readyToFetchChildData = isParent ? Boolean(activeChild) : true;

  useEffect(() => {
    if (!readyToFetchChildData) return;
    if (isParent && !activeChildUserId) {
      // Selected child has no linked User yet — nothing to fetch, but not loading forever.
      setProgressGrades([]);
      setProgressGradesLoading(false);
      return;
    }
    setProgressGradesLoading(true);
    gradeService
      .getMyProgress(isParent ? activeChildUserId ?? undefined : undefined)
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.grades)) {
          setProgressGrades(res.data.grades);
        } else {
          setProgressGrades([]);
        }
      })
      .catch(() => setProgressGrades([]))
      .finally(() => setProgressGradesLoading(false));
  }, [isParent, activeChildUserId, readyToFetchChildData]);

  useEffect(() => {
    if (!readyToFetchChildData) return;
    if (isParent && !activeChildUserId) {
      setProgressRemarks([]);
      setProgressRemarksLoading(false);
      return;
    }
    setProgressRemarksLoading(true);
    remarkService
      .getMyProgress(isParent ? activeChildUserId ?? undefined : undefined)
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.remarks)) {
          setProgressRemarks(res.data.remarks);
        } else {
          setProgressRemarks([]);
        }
      })
      .catch(() => setProgressRemarks([]))
      .finally(() => setProgressRemarksLoading(false));
  }, [isParent, activeChildUserId, readyToFetchChildData]);

  useEffect(() => {
    const withAttachments = progressRemarks.filter((r) => r.attachment?.path);
    if (withAttachments.length === 0) { setRemarkAttachmentUrls({}); return; }
    let cancelled = false;
    Promise.all(withAttachments.map(async (r) => {
      try {
        const url = await remarkService.getAttachmentObjectUrl(r._id);
        return [r._id, url] as const;
      } catch {
        return null;
      }
    })).then((results) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      results.forEach((entry) => { if (entry) map[entry[0]] = entry[1]; });
      setRemarkAttachmentUrls(map);
    });
    return () => { cancelled = true; };
  }, [progressRemarks]);

  const filteredProgressRemarks = useMemo(() => {
    return progressRemarks.filter((r) => {
      if (remarkProgramFilter !== "all" && r.programCode !== remarkProgramFilter) return false;
      if (remarkTutorFilter !== "all" && r.tutor?._id !== remarkTutorFilter) return false;
      if (remarkActivityFilter.trim() && !r.activities.some((a) => a.toLowerCase().includes(remarkActivityFilter.trim().toLowerCase()))) return false;
      return true;
    });
  }, [progressRemarks, remarkProgramFilter, remarkTutorFilter, remarkActivityFilter]);

  const remarkTutorFilterOptions = useMemo(() => {
    const seen = new Map<string, string>();
    progressRemarks.forEach((r) => {
      if (r.tutor?._id) seen.set(r.tutor._id, [r.tutor.firstName, r.tutor.lastName].filter(Boolean).join(" "));
    });
    return [...seen.entries()];
  }, [progressRemarks]);

  useEffect(() => {
    if (!readyToFetchChildData) return;
    if (isParent && !activeChildUserId) {
      setSchedules([]);
      setSchedulesLoading(false);
      return;
    }
    setSchedulesLoading(true);
    scheduleService
      .getMyClasses(isParent ? activeChildUserId ?? undefined : undefined)
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.schedules)) {
          setSchedules(res.data.schedules);
        } else {
          setSchedules([]);
        }
      })
      .catch(() => setSchedules([]))
      .finally(() => setSchedulesLoading(false));
  }, [isParent, activeChildUserId, readyToFetchChildData]);

  const fetchAnnouncements = () => {
    if (isParent && !readyToFetchChildData) return;
    setAnnouncementsLoading(true);
    announcementService
      .getForStudent(isParent ? activeChildUserId ?? undefined : undefined)
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.announcements)) {
          setAnnouncements(res.data.announcements);
        } else {
          setAnnouncements([]);
        }
      })
      .catch(() => setAnnouncements([]))
      .finally(() => setAnnouncementsLoading(false));
  };

  // Re-fetch whenever the active child changes — student-specific announcements
  // (targetStudentIds) must reflect whichever child is currently selected, not the
  // parent's own account. See ChildSelector_AddChildModal_TutorRemarksView.pdf A.
  useEffect(() => {
    fetchAnnouncements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isParent, activeChildUserId, readyToFetchChildData]);

  useEffect(() => {
    if (location.hash === "#announcements") fetchAnnouncements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash]);

  const fetchActivity = () => {
    setActivityLoading(true);
    auditLogService
      .getMyActivity(50)
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.logs)) {
          setActivityLogs(res.data.logs);
        } else {
          setActivityLogs([]);
        }
      })
      .catch(() => setActivityLogs([]))
      .finally(() => setActivityLoading(false));
  };

  useEffect(() => {
    if (location.hash === "#activity") fetchActivity();
  }, [location.hash]);

  const childEntries = useMemo(() => {
    const map = new Map<string, {
      childName: string;
      birthdate?: string;
      statuses: string[];
      programs: string[];
      enrollments: typeof enrollments;
    }>();

    for (const enrollment of enrollments) {
      const snap = enrollment.studentSnapshot;
      const childName = snap ? `${snap.firstName || ""} ${snap.lastName || ""}`.trim() : "Child";
      const key = childName || `child-${enrollment._id}`;

      if (!map.has(key)) {
        map.set(key, {
          childName,
          birthdate: snap?.birthdate,
          statuses: [],
          programs: [],
          enrollments: [],
        });
      }

      const entry = map.get(key)!;
      entry.enrollments.push(enrollment);
      if (enrollment.status && !entry.statuses.includes(enrollment.status)) {
        entry.statuses.push(enrollment.status);
      }

      for (const pkg of enrollment.packages || []) {
        if (pkg.displayName && !entry.programs.includes(pkg.displayName)) {
          entry.programs.push(pkg.displayName);
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => a.childName.localeCompare(b.childName));
  }, [enrollments]);

  const uniqueSchedules = useMemo(() => {
    const seen = new Map<string, (typeof schedules)[number]>();
    const statusRank = (value?: "unmarked" | "present" | "absent") => (value === "present" || value === "absent" ? 1 : 0);

    for (const s of schedules) {
      const key = [
        toStableDateKey(s.date),
        s.startTime || "",
        s.endTime || "",
        s.subject?.name || "",
        s.tutor?.email || "",
      ].join("|");
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, s);
        continue;
      }
      if (statusRank(s.attendanceStatus) > statusRank(existing.attendanceStatus)) {
        seen.set(key, s);
      }
    }

    return Array.from(seen.values());
  }, [schedules]);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);

  const upcomingClasses = useMemo(() => {
    return uniqueSchedules
      .filter((s) => new Date(s.date).getTime() >= today)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .slice(0, 10)
      .map((s) => {
        const d = new Date(s.date);
        const dateLabel = d.toDateString() === new Date().toDateString()
          ? "Today"
          : d.toDateString() === new Date(Date.now() + 86400000).toDateString()
            ? "Tomorrow"
            : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        const tutorName = formatClassTutorNames(s);
        return {
          _id: s._id,
          subject: s.subject?.name ?? "—",
          time: `${formatTime12h(s.startTime)} – ${formatTime12h(s.endTime)}`,
          date: dateLabel,
          tutor: tutorName,
          isPlaygroup: s.sessionType === "playgroup",
        };
      });
  }, [uniqueSchedules, today]);

  const weekDays = useMemo(() => {
    return SCHOOL_WEEK_DAYS.map((day) => {
      const date = addDays(weekStart, day.offset);
      return {
        ...day,
        date,
        dateKey: toDateKey(date),
      };
    });
  }, [weekStart]);

  const weekSchedule = useMemo(() => {
    const slotSet = new Set<string>();
    const map = new Map<string, { subject: string; tutor: string; isPlaygroup?: boolean }[]>();

    uniqueSchedules.forEach((s) => {
      const sessionDate = new Date(s.date);
      sessionDate.setHours(0, 0, 0, 0);
      const dayOffset = Math.floor((sessionDate.getTime() - weekStart.getTime()) / 86400000);
      if (dayOffset < 0 || dayOffset > 5) return;

      const start = s.startTime || "00:00";
      const end = s.endTime || start;
      const slotKey = `${start}|${end}`;
      slotSet.add(slotKey);

      const tutor = formatClassTutorNames(s);
      const cellKey = `${dayOffset}|${slotKey}`;
      const list = map.get(cellKey) || [];
      list.push({ subject: s.subject?.name ?? "—", tutor, isPlaygroup: s.sessionType === "playgroup" });
      map.set(cellKey, list);
    });

    const slots = Array.from(slotSet).sort((a, b) => {
      const [aStart, aEnd] = a.split("|");
      const [bStart, bEnd] = b.split("|");
      if (aStart === bStart) return aEnd.localeCompare(bEnd);
      return aStart.localeCompare(bStart);
    });

    return {
      slots,
      getSessions: (dayOffset: number, slotKey: string) => map.get(`${dayOffset}|${slotKey}`) || [],
    };
  }, [uniqueSchedules, weekStart]);

  const weekRangeLabel = useMemo(() => {
    const endOfWeek = addDays(weekStart, 5);
    const left = weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const right = endOfWeek.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${left} - ${right}`;
  }, [weekStart]);

  // ─── Schedule view computed values ─────────────────────────────────────────────
  const todayStrLocal = useMemo(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  }, []);

  const calendarDays = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const startDay = first.getDay();
    const daysInMonth = last.getDate();
    const prevMonthDays = startDay;
    const totalCells = Math.ceil((prevMonthDays + daysInMonth) / 7) * 7 || 42;
    const result: { date: Date; dateStr: string; isCurrentMonth: boolean; isToday: boolean }[] = [];
    const start = new Date(first);
    start.setDate(start.getDate() - prevMonthDays);
    for (let i = 0; i < totalCells; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      result.push({
        date: d,
        dateStr,
        isCurrentMonth: d.getMonth() === month,
        isToday: dateStr === todayStrLocal,
      });
    }
    return result;
  }, [calendarMonth, todayStrLocal]);

  const schedulesByDate = useMemo(() => {
    const map: Record<string, typeof schedules> = {};
    for (const s of uniqueSchedules) {
      const key = toStableDateKey(s.date);
      if (!map[key]) map[key] = [];
      map[key].push(s);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
    }
    return map;
  }, [uniqueSchedules]);

  const schedulesInDailyView = useMemo(() => {
    return (schedulesByDate[scheduleDailyDate] || []).slice().sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
  }, [scheduleDailyDate, schedulesByDate]);

  const weeklyDaysForSchedule = useMemo(() => ([
    { key: 1, label: "Mon" },
    { key: 2, label: "Tue" },
    { key: 3, label: "Wed" },
    { key: 4, label: "Thu" },
    { key: 5, label: "Fri" },
    { key: 6, label: "Sat" },
  ]), []);

  const scheduleWeekRangeLabel = useMemo(() => {
    const start = scheduleWeekStart;
    const end = addDays(start, 5);
    return `${start.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} - ${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  }, [scheduleWeekStart]);

  const weeklyDateKeys = useMemo(() => {
    return weeklyDaysForSchedule.map((day) => {
      const date = addDays(scheduleWeekStart, day.key - 1);
      return { dayKey: day.key, dateKey: toDateKey(date), date };
    });
  }, [scheduleWeekStart, weeklyDaysForSchedule]);

  const schedulesInWeeklyView = useMemo(() => {
    const weekKeys = new Set(weeklyDateKeys.map((entry) => entry.dateKey));
    return uniqueSchedules.filter((s) => weekKeys.has(toStableDateKey(s.date)));
  }, [uniqueSchedules, weeklyDateKeys]);

  const schedulesByWeeklyDay = useMemo(() => {
    const map: Record<number, typeof schedules> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    weeklyDateKeys.forEach((entry) => {
      map[entry.dayKey] = (schedulesByDate[entry.dateKey] || []).slice().sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
    });
    return map;
  }, [weeklyDateKeys, schedulesByDate]);

  const weeklyTimeSlots = useMemo(() => {
    const seen = new Set<string>();
    const slots: { startTime: string; endTime: string }[] = [];
    schedulesInWeeklyView.forEach((session) => {
      const key = `${session.startTime || ""}-${session.endTime || ""}`;
      if (!key || seen.has(key)) return;
      seen.add(key);
      slots.push({ startTime: session.startTime, endTime: session.endTime });
    });
    return slots.sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
  }, [schedulesInWeeklyView]);

  const calendarMonthLabel = calendarMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const thisMonthStart = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, "0")}-01`;
  const thisMonthEnd = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, "0")}-${String(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;
  const schedulesInCalendarMonth = useMemo(() => {
    return uniqueSchedules.filter((s) => {
      const d = toStableDateKey(s.date);
      return d >= thisMonthStart && d <= thisMonthEnd;
    });
  }, [uniqueSchedules, thisMonthStart, thisMonthEnd]);

  const schedulesThisMonth = schedulesInCalendarMonth.length;
  const weekStart2 = new Date();
  weekStart2.setDate(weekStart2.getDate() - weekStart2.getDay());
  const weekEnd = new Date(weekStart2);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekStartStr = `${weekStart2.getFullYear()}-${String(weekStart2.getMonth() + 1).padStart(2, "0")}-${String(weekStart2.getDate()).padStart(2, "0")}`;
  const weekEndStr = `${weekEnd.getFullYear()}-${String(weekEnd.getMonth() + 1).padStart(2, "0")}-${String(weekEnd.getDate()).padStart(2, "0")}`;
  const schedulesThisWeek = uniqueSchedules.filter((s) => {
    const d = toStableDateKey(s.date);
    return d >= weekStartStr && d <= weekEndStr;
  }).length;

  const overviewAnnouncements = announcements.slice(0, 3);

  const openAnnouncementDetails = (announcement: AnnouncementItem) => {
    setSelectedAnnouncement(announcement);
  };

  const handleAnnouncementKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, announcement: AnnouncementItem) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAnnouncementDetails(announcement);
    }
  };

  /** Group grades by program category for Progress tab */
  const gradesByProgram = useMemo(() => {
    const map = new Map<string, GradeItem[]>();
    progressGrades.forEach((g) => {
      const cat = g.programCategory || "Other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(g);
    });
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [progressGrades]);

  const overallProgressPercent = useMemo(() => {
    if (progressGrades.length === 0) return null;
    const total = progressGrades.reduce((sum, g) => sum + (g.percentage ?? Math.round((g.score / g.maxScore) * 100)), 0);
    return Math.round(total / progressGrades.length);
  }, [progressGrades]);

  const attendanceStats = useMemo(() => {
    const now = new Date();
    const todayKey = toDateKey(now);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const total = uniqueSchedules.length;
    const present = uniqueSchedules.filter((s) => {
      if (s.attendanceStatus !== "present") return false;
      const sessionDay = toStableDateKey(s.date);
      if (sessionDay < todayKey) return true;
      if (sessionDay > todayKey) return false;
      return nowMinutes >= toMinutes(s.endTime || "00:00");
    }).length;
    const percent = total > 0 ? Math.round((present / total) * 100) : null;
    return { total, present, percent };
  }, [uniqueSchedules]);

  const attendanceByProgram = useMemo(() => {
    const now = new Date();
    const todayKey = toDateKey(now);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const byProgram = new Map<string, { label: string; total: number; present: number; percent: number }>();

    uniqueSchedules.forEach((s) => {
      const label = (s.subject?.name || "Unassigned Program").trim();
      if (!byProgram.has(label)) {
        byProgram.set(label, { label, total: 0, present: 0, percent: 0 });
      }
      const rec = byProgram.get(label)!;
      rec.total += 1;

      if (s.attendanceStatus === "present") {
        const sessionDay = toStableDateKey(s.date);
        const isCompleted = sessionDay < todayKey || (sessionDay === todayKey && nowMinutes >= toMinutes(s.endTime || "00:00"));
        if (isCompleted) rec.present += 1;
      }
    });

    return Array.from(byProgram.values())
      .map((rec) => ({ ...rec, percent: rec.total > 0 ? Math.round((rec.present / rec.total) * 100) : 0 }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [uniqueSchedules]);

  const hashToTab: Record<string, string> = {
    "#subjects": "subjects",
    "#schedule": "schedule",
    "#progress": "progress",
    "#assessment": "assessment",
    "#announcements": "announcements",
    "#activity": "activity",
  };
  const activeTab = hashToTab[location.hash] || "overview";

  const handleTabChange = (value: string) => {
    const tabToHash: Record<string, string> = {
      overview: "",
      subjects: "subjects",
      schedule: "schedule",
      progress: "progress",
      assessment: "assessment",
      announcements: "announcements",
      activity: "activity",
    };
    const nextHash = tabToHash[value] ?? value;
    navigate(nextHash ? `/student-dashboard#${nextHash}` : "/student-dashboard", { replace: true });
  };

  const handleAddChild = (resubmission?: typeof enrollments[number]) => {
    if (!resubmission) {
      // A plain "+ Add Child" click must start from a blank form — Cancel on this
      // dialog doesn't itself clear `newChild`, so without this a child/program picked
      // during an abandoned resubmission would otherwise leak into the next "new child"
      // attempt.
      setNewChild((current) => ({
        ...current,
        firstName: "",
        lastName: "",
        birthdate: "",
        packageKey: "",
      }));
    }
    if (pricing.length === 0) {
      enrollmentService.getPricing().then((response) => {
        if (response.data?.success) {
          setPricing(response.data.pricing);
          if (resubmission) {
            const packageItem = resubmission.packages?.[0];
            const matchingPackage = response.data.pricing.find((item) => item.displayName === packageItem?.displayName);
            setNewChild((current) => ({
              ...current,
              firstName: resubmission.studentSnapshot?.firstName || "",
              lastName: resubmission.studentSnapshot?.lastName || "",
              birthdate: resubmission.studentSnapshot?.birthdate?.slice(0, 10) || "",
              packageKey: matchingPackage ? `${matchingPackage.programCode}:${matchingPackage.packageSlug}` : "",
            }));
          }
        }
      }).catch(() => toast.error("Unable to load programs. Please try again."));
    } else if (resubmission) {
      const packageItem = resubmission.packages?.[0];
      const matchingPackage = pricing.find((item) => item.displayName === packageItem?.displayName);
      setNewChild((current) => ({
        ...current,
        firstName: resubmission.studentSnapshot?.firstName || "",
        lastName: resubmission.studentSnapshot?.lastName || "",
        birthdate: resubmission.studentSnapshot?.birthdate?.slice(0, 10) || "",
        packageKey: matchingPackage ? `${matchingPackage.programCode}:${matchingPackage.packageSlug}` : "",
      }));
    }
    assessmentService.getTemplates(["ACT102"]).then((response) => {
      if (response.data?.success) setAssessmentTemplates(response.data.templates);
    }).catch(() => setAssessmentTemplates([]));
    setAddChildStep(1);
    setExpandedPrograms([]);
    setIsAddChildOpen(true);
  };

  // "Renew / Add Program" — an EXISTING child enrolling in another program.
  // Skips straight to Programs & Packages -> Schedule -> Billing -> Review by
  // reusing the same enrollment wizard components, pre-filled with the child's
  // already-known info so it's never re-collected.
  const handleRenewChild = (child: (typeof childEntries)[number]) => {
    const latest = child.enrollments[0];
    const snap = latest?.studentSnapshot;
    const health = latest?.healthInfo;

    // Block re-enrolling in a program the child already has an active/approved
    // enrollment for (unfinished sessions) — a DIFFERENT program is unaffected.
    // Payments_FullyPaid_NewProgramRefinements_AdminWalkIn.pdf D.
    const blockedPrograms: Record<string, string> = {};
    for (const enrollment of child.enrollments) {
      if (enrollment.status !== 'approved' && enrollment.status !== 'active') continue;
      for (const pkg of enrollment.packages || []) {
        if (pkg.programCode && !blockedPrograms[pkg.programCode]) {
          blockedPrograms[pkg.programCode] = `Already enrolled in ${PROGRAM_LABELS[pkg.programCode] || pkg.programCode} with unfinished sessions. Ask an admin to clear the existing schedule first.`;
        }
      }
    }

    setRenewChildInfo({
      renewalOfEnrollmentId: latest._id,
      studentFirstName: snap?.firstName || '',
      studentMiddleName: snap?.middleName || '',
      studentLastName: snap?.lastName || '',
      birthdate: snap?.birthdate ? snap.birthdate.slice(0, 10) : '',
      allergies: health?.allergies || '',
      medications: health?.medications || '',
      specialNeeds: health?.specialNeeds || false,
      specialNeedsDetails: health?.specialNeedsDetails || '',
      emergencyContact: health?.emergencyContact || '',
      blockedPrograms,
    });
    setIsRenewModalOpen(true);
  };

  // After an enrollment is submitted, remind the parent what the remaining 50% will be.
  const announceRemainingBalance = (enrollmentId: string, list: typeof enrollments) => {
    const created = list.find((e) => e.enrollmentId === enrollmentId);
    if (!created) return;
    const remaining = expectedRemainingAfterDown(created);
    if (remaining <= 0) return;
    const childName = [created.studentSnapshot?.firstName, created.studentSnapshot?.lastName].filter(Boolean).join(" ") || "your child";
    const programs = (created.packages || []).map((p) => p.displayName).filter(Boolean).join(", ");
    setBalancePopup({
      heading: "Remaining balance for this enrollment",
      lines: [
        `${childName}${programs ? ` — ${programs}` : ""}`,
        `The remaining 50% (${peso(remaining)}) is due after half of the sessions are completed.`,
        "You can pay it any time from the Payments page once your down payment is verified.",
      ],
    });
    notifyBadgesChanged();
  };

  const handleRenewEnrolled = (enrollmentId: string) => {
    setRenewChildInfo(null);
    fetchEnrollments().then((list) => {
      const created = list.find((e) => e.enrollmentId === enrollmentId);
      toast.success("Enrollment submitted", { description: `Student ID: ${created ? displayStudentId(created) : enrollmentId}. Check your email for confirmation.` });
      announceRemainingBalance(enrollmentId, list);
    });
  };

  const statusBadgeClass = (status: string) => {
    if (status === "approved" || status === "active") return "bg-emerald-100 text-emerald-700";
    if (status === "rejected" || status === "cancelled") return "bg-red-100 text-red-700";
    if (status === "pending_approval" || status === "payment_under_verification") return "bg-amber-100 text-amber-800";
    return "bg-muted text-muted-foreground";
  };

  // One human-readable summary per CHILD (never raw enum text like payment_under_verification):
  // a single primary badge, plus small notes for programs that are still in progress.
  const IN_PROGRESS_NOTES: Record<string, string> = {
    payment_under_verification: "Payment under verification in this program",
    pending_approval: "Awaiting approval in this program",
    submitted: "Awaiting payment in this program",
    rejected: "Rejected in this program",
    cancelled: "Cancelled in this program",
  };
  const childStatusSummary = (statuses: string[]) => {
    const hasActive = statuses.some((st) => st === "approved" || st === "active");
    let badge = { label: "Pending", value: "pending" };
    if (hasActive) badge = { label: "Active", value: "active" };
    else if (statuses.includes("rejected")) badge = { label: "Rejected", value: "rejected" };
    else if (statuses.length > 0 && statuses.every((st) => st === "cancelled")) badge = { label: "Cancelled", value: "cancelled" };
    const notes = statuses
      .filter((st) => IN_PROGRESS_NOTES[st] && !(st === badge.value))
      .map((st) => IN_PROGRESS_NOTES[st]);
    return { badge, notes };
  };

  const handleAddChildSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!validateChildStep1() || !newChild.packageKey || !newChildConsent) {
      toast.error("Please complete the child information, required documents and accept the agreement.");
      return;
    }

    const selectedProgram = pricing.find((item) => `${item.programCode}:${item.packageSlug}` === newChild.packageKey);
    if (!selectedProgram) { toast.error("Please select an available package."); return; }
    setIsAddingChild(true);
    try {
      const submission = await enrollmentService.submitWizard({
          packages: [{
          programCode: selectedProgram.programCode,
          packageSlug: selectedProgram.packageSlug,
          displayName: selectedProgram.displayName,
          price: selectedProgram.priceFull,
          paymentOption: "down",
        }],
        paymentOption: "down",
        paymentMethod: newChild.paymentMethod as "gcash" | "maribank" | "bdo",
        studentFirstName: toTitleCase(newChild.firstName),
        studentMiddleName: newChild.middleName.trim() ? toTitleCase(newChild.middleName) : "",
        studentLastName: toTitleCase(newChild.lastName),
        birthdate: newChild.birthdate,
        requirementDocuments: {
          birthCertificate: childDocs.birthCert ? { dataUrl: childDocs.birthCert.dataUrl, fileName: childDocs.birthCert.fileName } : undefined,
          studentPhoto: childDocs.photo ? { dataUrl: childDocs.photo.dataUrl, fileName: childDocs.photo.fileName } : undefined,
          guardianId: childDocs.guardianId ? { dataUrl: childDocs.guardianId.dataUrl, fileName: childDocs.guardianId.fileName } : undefined,
        },
        preferredStartDate: newChild.preferredStartDate || undefined,
        // preferredDays not collected in the quick add-child flow — defaults to no preference
        allergies: hasAllergies === "no" ? "None" : newChild.allergies.trim(),
        medications: hasMedicalConditions === "no" ? "None" : newChild.medications.trim(),
        specialNeeds: newChild.specialNeeds,
        specialNeedsDetails: newChild.specialNeedsDetails.trim(),
        // No separate Emergency Contact step — the parent's own registered phone
        // already serves this purpose (ChildSelector_AddChildModal_TutorRemarksView.pdf B2).
        emergencyContact: user?.phone || "",
        consentVersion: "1.0",
        consentItems: [{ name: "participation_agreement", accepted: true, version: "1.0" }],
        assessment: newChild.assessmentApplicable && assessmentTemplateId ? { applicable: true, templateId: assessmentTemplateId, ratings: assessmentRatings, infoValues: assessmentInfo, remarks: newChild.assessmentRemarks.trim() } : { applicable: false, skipReason: "Not applicable" },
      });
      if (paymentProofFile && submission?.data?.enrollmentId) {
        const proofDataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(paymentProofFile); });
        // Wizard-created Payment docs are parent-keyed (student: null) — the legacy
        // student-keyed paymentService.submitPaymentProof never matches them and
        // fails with "Payment record not found." Use the enrollment-keyed endpoint
        // instead, same as Step12Review.tsx's working submission flow.
        await enrollmentService.submitPaymentProof(submission.data.enrollmentId, { proofDataUrl, payerReference: paymentReference.trim(), paymentMethod: newChild.paymentMethod });
      }
      toast.success("Child added", { description: "The enrollment was submitted for admin review." });
      setNewChild({ firstName: "", middleName: "", lastName: "", birthdate: "", packageKey: "", preferredStartDate: "", paymentMethod: "gcash", allergies: "", medications: "", specialNeeds: false, specialNeedsDetails: "", assessmentApplicable: false, assessmentRemarks: "" });
      setNewChildConsent(false);
      setHasAllergies("");
      setHasMedicalConditions("");
      setAssessmentTemplateId("");
      setAssessmentRatings({});
      setAssessmentInfo({});
      setPaymentProofFile(null);
      setPaymentReference("");
      setChildDocs({ birthCert: null, photo: null, guardianId: null });
      setChildErrors({});
      setAddChildStep(1);
      setIsAddChildOpen(false);
      const response = await enrollmentService.getMyEnrollments();
      if (response.data?.success && Array.isArray(response.data.enrollments)) {
        setEnrollments(response.data.enrollments);
        if (submission?.data?.enrollmentId) announceRemainingBalance(submission.data.enrollmentId, response.data.enrollments);
      }
    } catch (error) {
      const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(message || "Unable to add child. Please try again.");
    } finally {
      setIsAddingChild(false);
    }
  };

  const validateChildStep1 = () => {
    const e: Record<string, string> = {};
    const fn = validateFullName(newChild.firstName, "First name", { minParts: 1 });
    if (!fn.valid) e.firstName = fn.error!;
    if (newChild.middleName.trim()) {
      const mn = validateFullName(newChild.middleName, "Middle name", { minParts: 1, required: false });
      if (!mn.valid) e.middleName = mn.error!;
    }
    const ln = validateFullName(newChild.lastName, "Last name", { minParts: 1 });
    if (!ln.valid) e.lastName = ln.error!;
    const bd = validateBirthdate(newChild.birthdate);
    if (!bd.valid) e.birthdate = bd.error!;
    if (!childDocsComplete) e.docs = "Upload all three required documents (Birth Certificate, 2×2 Photo, Guardian ID).";
    setChildErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleAddChildNext = () => {
    if (addChildStep === 1 && !validateChildStep1()) {
      toast.error("Please complete the child information, birthdate and required documents.");
      return;
    }
    const requiredByStep: Record<number, boolean> = {
      1: true,
      2: Boolean(newChild.packageKey),
      3: true,
      4: Boolean(hasAllergies && hasMedicalConditions && (hasAllergies === "no" || newChild.allergies.trim()) && (hasMedicalConditions === "no" || newChild.medications.trim())),
      7: Boolean(newChild.paymentMethod && paymentProofFile),
      8: newChildConsent,
    };
    if (addChildStep === 2) {
      const selectedPackage = pricing.find((item) => `${item.programCode}:${item.packageSlug}` === newChild.packageKey);
      if (!selectedPackage || !isPackageEligible(selectedPackage)) {
        toast.error("Please choose a package that is available for the child’s age.");
        return;
      }
    }
    if (requiredByStep[addChildStep] === false) {
      toast.error(addChildStep === 7 ? "Choose a payment method and upload your payment proof." : addChildStep === 8 ? "Please accept the agreement." : "Please complete the required fields before continuing.");
      return;
    }
    if (addChildStep === 6 && newChild.assessmentApplicable) {
      const assessmentItems = (activeAssessmentTemplate?.sections || []).flatMap((section) => section.items || []);
      if (!activeAssessmentTemplate || assessmentItems.some((item) => !assessmentRatings[item.key])) {
        toast.error("Please complete every assessment rating.");
        return;
      }
    }
    setAddChildStep((step) => Math.min(9, step + 1));
  };

  // Shared calendar-exact age maths — a local 365.25-day approximation here used
  // to compute 1.9997 for a child on their exact 2nd birthday, locking them out.
  const childAge = newChild.birthdate ? computeAgeYears(newChild.birthdate) : null;
  // Use the shared program eligibility rules (Toddlers Playgroup 2–4, etc.) rather than
  // the raw Pricing ageMin/ageMax so this matches the main enrollment wizard.
  const isPackageEligible = (item: { programCode?: string }) =>
    childAge !== null && !!item.programCode && checkProgramEligibility(item.programCode, childAge).eligible;
  const activeAssessmentTemplate = assessmentTemplates.find((template) => template._id === assessmentTemplateId);

  const handleQuickAction = (action: string) => {
    switch (action) {
      case "Progress":
        navigate("/student-dashboard#progress", { replace: true });
        break;
      default:
        toast(action);
    }
  };

  const childInitials = (activeChild?.name || "")
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "ST";
  const avatarInitials = user?.firstName && user?.lastName
    ? `${user.firstName[0]}${user.lastName[0]}`.toUpperCase()
    : "ST";

  return (
    <DashboardLayout>
      <div className="min-h-screen bg-muted">
        <div className="container mx-auto px-4 py-8">
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8"
          >
            <div>
              <h1 className="font-display text-2xl md:text-3xl font-bold text-foreground">
                {isParent ? "Parent Dashboard" : "Student Dashboard"}
              </h1>
              <p className="text-muted-foreground">
                {isParent
                  ? `Welcome back, ${user?.name || "Parent"}! Here's an overview of ${activeChild?.name || "your child"}'s progress.`
                  : `Welcome back, ${user?.name || "Student"}!`}
              </p>
            </div>
            {isParent && children.length > 1 && (
              <div className="flex items-center gap-2">
                <Label htmlFor="active-child-select" className="text-sm text-muted-foreground whitespace-nowrap">
                  Viewing child:
                </Label>
                <select
                  id="active-child-select"
                  value={activeChildId}
                  onChange={(e) => setActiveChildId(e.target.value)}
                  className="h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground"
                >
                  {children.map((child) => (
                    <option key={child.key} value={child.key}>
                      {child.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </motion.div>

          <div className="grid items-start lg:grid-cols-4 gap-6">
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              className="self-start lg:col-span-1 space-y-6"
            >
              <div className="bg-card rounded-xl p-6 border border-border">
                <div className="text-center">
                  <div className="flex justify-center mb-4">
                    {/* Parent: this card is the SELECTED CHILD's — its picture is the one
                        uploaded under Settings → Student Information, never the parent's own. */}
                    <UserAvatar
                      src={isParent ? resolveUploadUrl(activeChild?.photoPath) : user?.profileImageUrl}
                      fallback={isParent ? childInitials : avatarInitials}
                      size={20}
                    />
                  </div>
                  <h3 className="font-display font-bold text-lg text-foreground">
                    {isParent ? (activeChild?.name || "Your child") : (user?.name || "Student")}
                  </h3>
                  {!isParent && <p className="text-sm text-muted-foreground">{user?.email ?? "—"}</p>}
                  {!isParent && user?.phone && (
                    <p className="text-sm text-muted-foreground">Phone: {user.phone}</p>
                  )}
                  {!isParent && (
                    <span className="inline-block mt-2 px-3 py-1 bg-primary/10 text-primary text-sm rounded-full font-medium">
                      {user?.gradeLevel ?? "—"}
                    </span>
                  )}
                </div>
                <div className="mt-6 pt-6 border-t border-border space-y-1">
                  {isParent ? (
                    <>
                      <p className="text-sm text-muted-foreground text-center">Parent account: {user?.name ?? "—"}</p>
                      <p className="text-sm text-muted-foreground text-center">{user?.email ?? "—"}</p>
                    </>
                  ) : (
                    (user?.guardianName || user?.guardianPhone) && (
                      <>
                        <p className="text-sm text-muted-foreground text-center">Guardian: {user?.guardianName ?? "—"}</p>
                        <p className="text-sm text-muted-foreground text-center">Guardian phone: {user?.guardianPhone ?? "—"}</p>
                      </>
                    )
                  )}
                </div>
              </div>

              <div className="bg-card rounded-xl p-4 border border-border space-y-2">
                <h4 className="font-semibold text-sm text-foreground mb-3">Quick Actions</h4>
                <ContactTutorPanel schedules={schedules} />
                {[
                  { label: "Progress", icon: Award },
                ].map((action) => (
                  <button
                    key={action.label}
                    onClick={() => handleQuickAction(action.label)}
                    className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-muted transition-colors text-left"
                  >
                    <div className="flex items-center gap-3">
                      <action.icon className="h-4 w-4 text-primary" />
                      <span className="text-sm text-muted-foreground">{action.label}</span>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </button>
                ))}
                <MyRequestsBell asRow />
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="self-start lg:col-span-3 space-y-6"
            >
              <div className="grid sm:grid-cols-3 gap-4">
                <StatCard title="Classes This Week" value={schedulesLoading ? "—" : uniqueSchedules.filter((s) => {
                  const d = new Date(s.date).getTime();
                  const weekStart = new Date();
                  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
                  weekStart.setHours(0, 0, 0, 0);
                  const weekEnd = weekStart.getTime() + 7 * 86400000;
                  return d >= weekStart.getTime() && d < weekEnd;
                }).length} icon={Calendar} variant="info" />
                <StatCard title="Total Sessions" value={schedulesLoading ? "—" : uniqueSchedules.length} icon={CheckCircle} variant="success" />
                <StatCard title="Upcoming" value={upcomingClasses.length} icon={Award} variant="warning" />
              </div>

              <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
                <TabsContent value="overview" className="space-y-6">
                  <div className="bg-card rounded-xl border border-border overflow-hidden">
                    <div className="p-4 border-b border-border flex items-center justify-between gap-3">
                      <div>
                        <h3 className="font-display font-bold text-lg text-foreground">Announcements Preview</h3>
                        <p className="text-sm text-muted-foreground">Quick updates below your progress summary.</p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleTabChange("announcements")}>View All <ChevronRight className="h-4 w-4 ml-1" /></Button>
                    </div>
                    <div className="divide-y divide-border">
                      {announcementsLoading ? (
                        <div className="flex items-center justify-center py-10">
                          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                      ) : overviewAnnouncements.length === 0 ? (
                        <p className="p-6 text-center text-muted-foreground">No announcements yet.</p>
                      ) : (
                        overviewAnnouncements.map((announcement) => (
                          <div
                            key={announcement._id}
                            role="button"
                            tabIndex={0}
                            onClick={() => openAnnouncementDetails(announcement)}
                            onKeyDown={(event) => handleAnnouncementKeyDown(event, announcement)}
                            className="p-4 flex items-start justify-between gap-4 cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <div className="min-w-0 space-y-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">{announcementCategoryLabel(announcement.category)}</span>
                              </div>
                              <p className="font-semibold text-foreground">{announcement.title}</p>
                              <p className="text-sm text-muted-foreground">{summarizeAnnouncement(announcement.body)}</p>
                            </div>
                            {announcement.scheduledDate ? (
                              <span className="shrink-0 text-xs text-muted-foreground">{new Date(announcement.scheduledDate).toLocaleDateString("en-US", { dateStyle: "medium" })}</span>
                            ) : null}
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="bg-card rounded-xl border border-border overflow-hidden">
                    <div className="p-4 border-b border-border flex items-center justify-between gap-3">
                      <div>
                        <h3 className="font-display font-bold text-lg text-foreground">Upcoming Classes</h3>
                        <p className="text-sm text-muted-foreground">Your next scheduled sessions are shown here.</p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleTabChange("schedule")}>View All <ChevronRight className="h-4 w-4 ml-1" /></Button>
                    </div>
                    {schedulesLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : upcomingClasses.length === 0 ? (
                      <p className="text-center text-muted-foreground py-8">No upcoming classes. Your schedule will appear here once the admin assigns you to sessions.</p>
                    ) : (
                      <div className="divide-y divide-border">
                        {upcomingClasses.slice(0, 5).map((cls) => (
                          <div key={cls._id} className="p-4 flex items-center justify-between gap-4 transition-colors hover:bg-muted/40">
                            <div className="flex items-center gap-4">
                              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                                <BookOpen className="h-5 w-5 text-primary" />
                              </div>
                              <div className="min-w-0">
                                <p className="font-semibold text-foreground">{cls.subject}</p>
                                <p className="text-sm text-muted-foreground">with {cls.tutor}</p>
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="font-semibold text-foreground">{cls.time}</p>
                              <p className="text-sm text-muted-foreground">{cls.date}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="subjects" className="space-y-6">
                  <div className="bg-card rounded-xl border border-border overflow-hidden h-full">
                    <div className="p-4 border-b border-border flex items-center justify-between gap-3">
                      <div>
                        <h3 className="font-display font-bold text-lg text-foreground">My Child</h3>
                        <p className="text-sm text-muted-foreground">Manage each child and keep their enrollment details separate.</p>
                      </div>
                      <Button onClick={() => handleAddChild()} className="bg-amber-500 hover:bg-amber-600 text-white">
                        + Add Child
                      </Button>
                    </div>

                    <div className="p-4 space-y-4">
                      {enrollmentsLoading ? (
                        <div className="flex items-center justify-center py-12">
                          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                      ) : childEntries.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center">
                          <p className="font-semibold text-foreground">No child enrolled yet.</p>
                          <p className="mt-2 text-sm text-muted-foreground">Add your first child to begin the enrollment process.</p>
                          <Button onClick={() => handleAddChild()} className="mt-4 bg-amber-500 hover:bg-amber-600 text-white">
                            Add Child
                          </Button>
                        </div>
                      ) : (
                        childEntries.map((child) => (
                          <div key={child.childName} className="rounded-2xl border border-border bg-muted/20 p-4 shadow-sm">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                              <div>
                                <p className="text-lg font-bold text-foreground">{child.childName}</p>
                                {child.birthdate && (
                                  <p className="text-sm text-muted-foreground">Age: {formatAge(child.birthdate)}</p>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                {(() => {
                                  const { badge, notes } = childStatusSummary(child.statuses);
                                  return (
                                    <div className="flex flex-col items-start gap-1 sm:items-end">
                                      <span className={`rounded-full px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${statusBadgeClass(badge.value)}`}>
                                        {badge.label}
                                      </span>
                                      {notes.map((note) => (
                                        <span key={note} className="text-[10px] leading-tight text-muted-foreground">{note}</span>
                                      ))}
                                    </div>
                                  );
                                })()}
                                <Button type="button" size="sm" variant="outline" onClick={() => handleRenewChild(child)}>
                                  Renew / Add Program
                                </Button>
                              </div>
                            </div>

                            <div className="mt-4 grid gap-3 md:grid-cols-2">
                              <div className="rounded-xl border border-border bg-background p-3">
                                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Programs</p>
                                <div className="mt-2 space-y-1">
                                  {child.programs.length > 0 ? child.programs.map((program) => (
                                    <div key={`${child.childName}-${program}`} className="text-sm text-foreground">• {program}</div>
                                  )) : (
                                    <p className="text-sm text-muted-foreground">No program selected yet.</p>
                                  )}
                                </div>
                              </div>

                              <div className="rounded-xl border border-border bg-background p-3">
                                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Enrollment Record</p>
                                <div className="mt-2 space-y-2">
                                  {/* ONE record per child: the original enrollment's permanent Student ID, shown once.
                                      Renewing / adding a program never adds a row — it only changes the Programs + status. */}
                                  <div className="rounded-lg border border-dashed border-border bg-muted/30 p-2" data-testid="enrollment-record-row">
                                    <div className="flex items-center justify-between gap-2">
                                      <p className="text-sm font-medium text-foreground">{displayStudentId(child.enrollments[child.enrollments.length - 1]) || "Enrollment"}</p>
                                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${statusBadgeClass(childStatusSummary(child.statuses).badge.value)}`}>{childStatusSummary(child.statuses).badge.label}</span>
                                    </div>
                                  </div>
                                  {child.enrollments.filter((enrollment) => enrollment.status === "rejected").map((enrollment) => (
                                    <div key={enrollment._id}>
                                      {enrollment.rejectionReason && (
                                        <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                                          <p className="font-semibold">Admin feedback</p>
                                          <p>{enrollment.rejectionReason}</p>
                                        </div>
                                      )}
                                      {enrollment.allowResubmission && (
                                        <Button type="button" size="sm" variant="outline" className="mt-2 w-full border-red-200 text-red-700 hover:bg-red-50" onClick={() => handleAddChild(enrollment)}>
                                          Review and Resubmit
                                        </Button>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="schedule" className="space-y-6">
                  {/* Summary cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="bg-muted/50 rounded-xl p-4 border border-border">
                      <p className="text-sm text-muted-foreground">All Classes</p>
                      <p className="text-2xl font-bold text-foreground">{schedulesLoading ? "—" : uniqueSchedules.length}</p>
                      <p className="text-xs text-muted-foreground">sessions total</p>
                    </div>
                    <div className="bg-primary/5 rounded-xl p-4 border border-border">
                      <p className="text-sm text-muted-foreground">This Week</p>
                      <p className="text-2xl font-bold text-foreground">{schedulesLoading ? "—" : schedulesThisWeek}</p>
                      <p className="text-xs text-muted-foreground">sessions</p>
                    </div>
                    <div className="bg-info/5 rounded-xl p-4 border border-border">
                      <p className="text-sm text-muted-foreground">This Month</p>
                      <p className="text-2xl font-bold text-foreground">{schedulesLoading ? "—" : schedulesThisMonth}</p>
                      <p className="text-xs text-muted-foreground">{calendarMonthLabel}</p>
                    </div>
                  </div>

                  {/* Schedule toolbar */}
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      {scheduleViewMode === "monthly" ? (
                        <>
                          <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <span className="min-w-[160px] text-center font-semibold text-foreground">{calendarMonthLabel}</span>
                          <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </>
                      ) : scheduleViewMode === "weekly" ? (
                        <>
                          <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setScheduleWeekStart((prev) => addDays(prev, -7))}>
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <span className="min-w-[220px] text-center font-semibold text-foreground">{scheduleWeekRangeLabel}</span>
                          <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setScheduleWeekStart((prev) => addDays(prev, 7))}>
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Day</span>
                          <Input
                            type="date"
                            value={scheduleDailyDate}
                            onChange={(e) => setScheduleDailyDate(e.target.value)}
                            className="w-[170px] h-9"
                          />
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="flex items-center rounded-md border border-border p-1 gap-1">
                        <Button
                          variant={scheduleViewMode === "weekly" ? "default" : "ghost"}
                          size="sm"
                          className="h-7"
                          onClick={() => setScheduleViewMode("weekly")}
                        >
                          Weekly
                        </Button>
                        <Button
                          variant={scheduleViewMode === "daily" ? "default" : "ghost"}
                          size="sm"
                          className="h-7"
                          onClick={() => setScheduleViewMode("daily")}
                        >
                          Daily
                        </Button>
                        <Button
                          variant={scheduleViewMode === "monthly" ? "default" : "ghost"}
                          size="sm"
                          className="h-7"
                          onClick={() => setScheduleViewMode("monthly")}
                        >
                          Monthly
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* Schedule grid/list */}
                  <div className="bg-card rounded-xl border border-border overflow-hidden">
                    {schedulesLoading ? (
                      <div className="flex items-center justify-center py-24">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                      </div>
                    ) : scheduleViewMode === "monthly" ? (
                      <div className="p-2">
                        <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden">
                          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                            <div key={day} className="bg-muted/50 p-2 text-center text-xs font-semibold text-muted-foreground">
                              {day}
                            </div>
                          ))}
                          {calendarDays.map((cell) => {
                            const daySchedules = schedulesByDate[cell.dateStr] || [];
                            return (
                              <div
                                key={cell.dateStr}
                                className={`min-h-[100px] p-2 flex flex-col bg-card ${!cell.isCurrentMonth ? "opacity-50" : ""} ${cell.isToday ? "ring-2 ring-primary rounded-md" : ""}`}
                              >
                                <span className={`text-sm font-medium ${cell.isToday ? "text-primary" : "text-foreground"}`}>{cell.date.getDate()}</span>
                                <div className="mt-1 space-y-1 flex-1 overflow-auto">
                                  {daySchedules.map((s) => {
                                    const tutorName = formatClassTutorNames(s);
                                    return (
                                      <div
                                        key={s._id}
                                        className="w-full text-left p-2 rounded text-xs truncate transition-colors bg-primary/10 text-primary hover:bg-primary/20"
                                      >
                                        <span className="font-medium block">{s.subject?.name ?? "—"}</span>
                                        <span className="opacity-90">{formatSlotTime(s.startTime)}</span>
                                        <span className="opacity-75 block truncate">{tutorName}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : scheduleViewMode === "weekly" ? (
                      <div className="p-4">
                        <div className="rounded-lg border border-border overflow-hidden">
                          <div className="grid grid-cols-7 bg-muted/50 text-xs font-semibold text-muted-foreground">
                            <div className="p-3 border-r border-border">Time</div>
                            {weeklyDateKeys.map((entry) => {
                              const dayLabel = entry.date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                              const dayName = weeklyDaysForSchedule.find((day) => day.key === entry.dayKey)?.label ?? "";
                              return (
                                <div key={entry.dateKey} className="p-3 border-r border-border last:border-r-0 text-center">
                                  <p>{dayName}</p>
                                  <p className="text-[11px] opacity-80">{dayLabel}</p>
                                </div>
                              );
                            })}
                          </div>

                          {weeklyTimeSlots.length === 0 ? (
                            <div className="p-8 text-center text-sm text-muted-foreground">No sessions in this week.</div>
                          ) : (
                            <div className="divide-y divide-border">
                              {weeklyTimeSlots.map((slot) => {
                                const slotKey = `${slot.startTime}-${slot.endTime}`;
                                return (
                                  <div key={slotKey} className="grid grid-cols-7 min-h-[86px]">
                                    <div className="p-3 border-r border-border text-xs text-muted-foreground">
                                      <p>{formatSlotTime(slot.startTime)}</p>
                                      <p>{formatSlotTime(slot.endTime)}</p>
                                    </div>

                                    {weeklyDaysForSchedule.map((day) => {
                                      const schedulesSessions = (schedulesByWeeklyDay[day.key] || []).filter((session) => {
                                        return `${session.startTime}-${session.endTime}` === slotKey;
                                      });

                                      return (
                                        <div key={`${slotKey}-${day.key}`} className="p-2 border-r border-border last:border-r-0 space-y-1">
                                          {schedulesSessions.length === 0 ? null : schedulesSessions.map((session) => {
                                            const tutorName = formatClassTutorNames(session);
                                            return (
                                              <div
                                                key={session._id}
                                                className="w-full text-left p-2 rounded text-xs truncate transition-colors bg-primary/10 text-primary hover:bg-primary/20"
                                              >
                                                <span className="font-medium block">{session.subject?.name ?? "—"}</span>
                                                <span className="opacity-75 block truncate">with {tutorName}</span>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="p-4 space-y-3">
                        <p className="text-sm text-muted-foreground">
                          {new Date(`${scheduleDailyDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}
                        </p>
                        {schedulesInDailyView.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No sessions for this day.</p>
                        ) : (
                          schedulesInDailyView.map((s) => {
                            const tutorName = formatClassTutorNames(s);
                            return (
                              <div
                                key={s._id}
                                className="p-3 rounded-md border border-border transition-colors bg-card hover:bg-muted/40"
                              >
                                <div className="flex items-start gap-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="font-medium text-foreground">{s.subject?.name ?? "—"}</p>
                                    <p className="text-sm text-muted-foreground">{formatSlotTime(s.startTime)} - {formatSlotTime(s.endTime)}</p>
                                    <p className="text-xs text-muted-foreground">{s.sessionType === "playgroup" ? "Tutors" : "Tutor"}: {tutorName}</p>
                                  </div>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="assessment" className="space-y-6">
                  <div className="bg-card rounded-xl border border-border overflow-hidden">
                    <div className="p-4 border-b border-border">
                      <h3 className="font-display font-bold text-lg text-foreground">Pre-Enrollment Assessment</h3>
                      <p className="text-sm text-muted-foreground">Results saved with your child&apos;s enrollment record.</p>
                    </div>
                    <div className="p-4 space-y-6">
                      {enrollmentsLoading ? (
                        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
                      ) : enrollments.filter((en) => en.preEnrollmentAssessment?.completedAt).length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-8">No assessment on file yet.</p>
                      ) : (
                        enrollments.filter((en) => en.preEnrollmentAssessment?.completedAt).map((en) => {
                          const childName = [en.studentSnapshot?.firstName, en.studentSnapshot?.lastName].filter(Boolean).join(" ") || "Child";
                          return (
                            <div key={en._id} className="rounded-lg border border-border p-4 space-y-3">
                              <div className="flex flex-wrap justify-between gap-2 text-sm">
                                <p className="font-semibold">{childName}</p>
                                <p className="text-muted-foreground">{displayStudentId(en)} · {en.status}</p>
                              </div>
                              <EnrollmentAssessmentView assessment={en.preEnrollmentAssessment} />
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="progress" className="space-y-6">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/5 via-card to-primary/10 p-6 md:p-8"
                  >
                    <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                    <div className="relative flex flex-col sm:flex-row sm:items-center gap-4">
                      <div className="h-14 w-14 rounded-2xl bg-primary/15 flex items-center justify-center shrink-0">
                        <Award className="h-7 w-7 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-display text-xl md:text-2xl font-bold text-foreground">{isParent ? "My Child's Progress" : "My Progress"}</h3>
                        <p className="text-sm text-muted-foreground mt-1">Session remarks published by your tutors.</p>
                      </div>
                    </div>
                  </motion.div>

                  {attendanceStats.percent != null && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="rounded-2xl border border-border bg-card p-6"
                    >
                      <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Attendance</h4>

                      <div className="flex items-center gap-4 mb-5">
                        <div className="relative h-24 w-24 rounded-full bg-muted flex items-center justify-center">
                          <svg className="h-24 w-24 -rotate-90" viewBox="0 0 36 36">
                            <path className="text-muted stroke-current" strokeWidth="3" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                            <path
                              className="text-primary stroke-current transition-all duration-700"
                              strokeWidth="3"
                              strokeDasharray={`${attendanceStats.percent}, 100`}
                              fill="none"
                              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                            />
                          </svg>
                          <span className="absolute text-2xl font-bold text-foreground">{attendanceStats.percent}%</span>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">Overall: present at {attendanceStats.present} of {attendanceStats.total} sessions</p>
                          <p className="text-xs text-muted-foreground mt-1">Attendance is also separated by program below.</p>
                        </div>
                      </div>

                      <div className="space-y-3">
                        {attendanceByProgram.map((program) => (
                          <div key={program.label} className="rounded-lg border border-border p-3 bg-muted/20">
                            <div className="flex items-center justify-between gap-3 mb-2">
                              <p className="text-sm font-semibold text-foreground">{program.label}</p>
                              <p className="text-xs text-muted-foreground">{program.present} / {program.total} present</p>
                            </div>
                            <div className="h-2 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full rounded-full bg-primary transition-all duration-500"
                                style={{ width: `${Math.max(0, Math.min(100, program.percent))}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {/* Student Remarks — replaces the old grading display (BeeBright Student Remarks Spec v2) */}
                  <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
                    <div className="flex flex-wrap gap-3">
                      {isParent && (
                        <Select value={activeChildId} onValueChange={setActiveChildId}>
                          <SelectTrigger className="w-full sm:w-48"><SelectValue placeholder="Choose child" /></SelectTrigger>
                          <SelectContent>
                            {children.map((child) => (
                              <SelectItem key={child.key} value={child.key}>{child.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <Select value={remarkProgramFilter} onValueChange={setRemarkProgramFilter}>
                        <SelectTrigger className="w-full sm:w-48"><SelectValue placeholder="All programs" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All programs</SelectItem>
                          <SelectItem value="TPG101">Toddlers Playgroup</SelectItem>
                          <SelectItem value="ACT102">Academic Tutorial</SelectItem>
                          <SelectItem value="EXP106">Examination Preparation</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select value={remarkTutorFilter} onValueChange={setRemarkTutorFilter}>
                        <SelectTrigger className="w-full sm:w-48"><SelectValue placeholder="All tutors" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All tutors</SelectItem>
                          {remarkTutorFilterOptions.map(([id, name]) => (
                            <SelectItem key={id} value={id}>{name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        value={remarkActivityFilter}
                        onChange={(e) => setRemarkActivityFilter(e.target.value)}
                        placeholder="Filter by activity/topic…"
                        className="w-full sm:w-56"
                      />
                    </div>
                  </div>

                  {progressRemarksLoading ? (
                    <div className="flex justify-center py-16">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                  ) : filteredProgressRemarks.length === 0 ? (
                    <div className="rounded-2xl border border-border bg-card p-12 text-center">
                      <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-4">
                        <Award className="h-8 w-8 text-muted-foreground" />
                      </div>
                      <p className="font-medium text-foreground">No remarks yet</p>
                      <p className="text-sm text-muted-foreground mt-1">Your tutors will publish session remarks here.</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {filteredProgressRemarks.map((r, idx) => {
                        const tutorName = r.tutor ? [r.tutor.firstName, r.tutor.lastName].filter(Boolean).join(" ") : "";
                        return (
                          <motion.div
                            key={r._id}
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: Math.min(idx, 8) * 0.04 }}
                            className="rounded-2xl border border-border bg-card overflow-hidden"
                          >
                            <div className="p-4 border-b border-border bg-primary/5 flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <h4 className="font-display font-bold text-foreground">
                                  {r.templateType === "toddler_observation" ? "Toddler Observation" : r.templateType === "examination_progress" ? "Examination Preparedness" : "Academic Tutorial"}
                                </h4>
                                <p className="text-sm text-muted-foreground mt-0.5">
                                  {new Date(r.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                  {tutorName && ` · ${tutorName}`}
                                </p>
                              </div>
                            </div>
                            <div className="p-4 space-y-3">
                              {r.activities.length > 0 && (
                                <p className="text-sm text-foreground"><span className="font-medium">Activities:</span> {r.activities.join(", ")}</p>
                              )}
                              {r.templateType === "toddler_observation" && r.ratings && (
                                <div className="grid grid-cols-2 gap-2">
                                  {([
                                    ["participationEngagement", "Participation"],
                                    ["socialInteraction", "Social Interaction"],
                                    ["followingDirections", "Following Directions"],
                                    ["overallBehavior", "Overall Behavior"],
                                  ] as const).map(([key, label]) => (
                                    <div key={key} className="flex items-center justify-between text-xs">
                                      <span className="text-muted-foreground">{label}</span>
                                      <StarRating value={r.ratings?.[key] ?? null} onChange={() => {}} disabled max={3} />
                                    </div>
                                  ))}
                                </div>
                              )}
                              {r.remarkBullets.length > 0 && (
                                <ul className="list-disc pl-5 text-sm text-foreground space-y-1">
                                  {r.remarkBullets.map((b, i) => <li key={i}>{b}</li>)}
                                </ul>
                              )}
                              {r.nextFocus && <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Next Focus:</span> {r.nextFocus}</p>}
                              {r.parentSupportSuggestion && <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Parent support:</span> {r.parentSupportSuggestion}</p>}
                              {r.templateType === "examination_progress" && r.examInfo && (r.examInfo.topic || r.examInfo.scoreResult || r.examInfo.mistakesToReview || r.examInfo.studyGoal) && (
                                <div className="rounded-md bg-muted/40 p-3 text-sm space-y-1">
                                  {r.examInfo.topic && <p><span className="font-medium">Topic:</span> {r.examInfo.topic}</p>}
                                  {r.examInfo.scoreResult && <p><span className="font-medium">Score:</span> {r.examInfo.scoreResult}</p>}
                                  {r.examInfo.mistakesToReview && <p><span className="font-medium">To review:</span> {r.examInfo.mistakesToReview}</p>}
                                  {r.examInfo.studyGoal && <p><span className="font-medium">Study goal:</span> {r.examInfo.studyGoal}</p>}
                                </div>
                              )}
                              {r.attachment && (
                                <FilePreview
                                  src={remarkAttachmentUrls[r._id] ? { dataUrl: remarkAttachmentUrls[r._id], fileName: r.attachment.fileName || "attachment", fileSize: r.attachment.size } : undefined}
                                  label="Attachment"
                                />
                              )}
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="announcements" className="space-y-6">
                  <div className="bg-card rounded-xl p-6 border border-border">
                    <h3 className="font-display font-bold text-lg text-foreground mb-4">Announcements</h3>
                    <p className="text-sm text-muted-foreground mb-4">Updates from your tutors and the center (you are also notified by email). Click any card to read the full announcement.</p>
                    {announcementsLoading ? (
                      <div className="flex justify-center py-12">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                      </div>
                    ) : announcements.length === 0 ? (
                      <div className="py-8 text-center text-muted-foreground">No announcements yet.</div>
                    ) : (
                      <div className="space-y-4">
                        {announcements.map((a) => {
                          const authorName = announcementAuthorLabel(a);
                          const categoryLabel = { sick_leave: "Sick Leave", exam: "Exam", quiz: "Quiz", exam_quiz: "Exam / Quiz", materials: "Materials to Bring", reschedule: "Reschedule", reminder: "Reminder", suspension: "Class Suspension", maintenance: "Maintenance", holiday: "Holiday", general: "Announcement" }[a.category] || a.category;
                          const dateStr = a.approvedAt || a.createdAt ? new Date(a.approvedAt || a.createdAt).toLocaleDateString("en-US", { dateStyle: "medium" }) : "";
                          return (
                            <div
                              key={a._id}
                              role="button"
                              tabIndex={0}
                              onClick={() => openAnnouncementDetails(a)}
                              onKeyDown={(event) => handleAnnouncementKeyDown(event, a)}
                              className="p-4 rounded-lg border border-border bg-muted/30 cursor-pointer transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                                <span className="px-2 py-0.5 rounded bg-primary/10 text-primary font-medium">{categoryLabel}</span>
                                <span>{authorName}</span>
                                {dateStr && <span> · {dateStr}</span>}
                              </div>
                              <h4 className="font-semibold text-foreground mb-1">{a.title}</h4>
                              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{a.body}</p>
                              {a.scheduledDate && (
                                <p className="text-xs text-muted-foreground mt-2">When: {new Date(a.scheduledDate).toLocaleDateString("en-US", { dateStyle: "medium" })}</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="activity" className="space-y-6">
                  <div className="bg-card rounded-xl p-6 border border-border">
                    <h3 className="font-display font-bold text-lg text-foreground mb-4">My Activity</h3>
                    <p className="text-sm text-muted-foreground mb-4">Your recent login and account activity.</p>
                    {activityLoading ? (
                      <div className="flex justify-center py-12">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                      </div>
                    ) : activityLogs.length === 0 ? (
                      <div className="py-8 text-center text-muted-foreground">No activity yet.</div>
                    ) : (
                      <div className="space-y-2">
                        {activityLogs.map((log) => (
                          <div key={log._id} className="flex items-center justify-between gap-4 py-3 border-b border-border last:border-0">
                            <div>
                              <span className="font-medium text-foreground">{log.action}</span>
                              <span className="text-muted-foreground"> — {log.description || log.module}</span>
                            </div>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                              <span className={log.status === "SUCCESS" ? "text-success" : "text-destructive"}>{log.status}</span>
                              <span>{new Date(log.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </TabsContent>

              </Tabs>
            </motion.div>
          </div>
        </div>
      </div>
      <Dialog open={isAddChildOpen} onOpenChange={setIsAddChildOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Child</DialogTitle>
            <DialogDescription>Step {addChildStep + 3} of 12. This creates an enrollment under your account, not another login account.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddChildSubmit} className="space-y-4">
            {addChildStep === 1 && <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="child-first-name">First name</Label>
                <Input id="child-first-name" value={newChild.firstName}
                  className={childErrors.firstName ? "border-destructive" : ""}
                  onChange={(event) => { setNewChild((current) => ({ ...current, firstName: event.target.value })); setChildErrors((p) => ({ ...p, firstName: "" })); }}
                  onBlur={(event) => { const c = toTitleCase(event.target.value); if (c && c !== event.target.value) setNewChild((cur) => ({ ...cur, firstName: c })); const r = validateFullName(c || event.target.value, "First name", { minParts: 1 }); setChildErrors((p) => ({ ...p, firstName: r.valid ? "" : r.error! })); }}
                  required />
                {childErrors.firstName && <p className="text-xs text-destructive">{childErrors.firstName}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="child-middle-name">Middle name</Label>
                <Input id="child-middle-name" value={newChild.middleName}
                  className={childErrors.middleName ? "border-destructive" : ""}
                  onChange={(event) => { setNewChild((current) => ({ ...current, middleName: event.target.value })); setChildErrors((p) => ({ ...p, middleName: "" })); }}
                  onBlur={(event) => { if (!event.target.value.trim()) { setChildErrors((p) => ({ ...p, middleName: "" })); return; } const c = toTitleCase(event.target.value); if (c !== event.target.value) setNewChild((cur) => ({ ...cur, middleName: c })); const r = validateFullName(c, "Middle name", { minParts: 1, required: false }); setChildErrors((p) => ({ ...p, middleName: r.valid ? "" : r.error! })); }} />
                {childErrors.middleName && <p className="text-xs text-destructive">{childErrors.middleName}</p>}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="child-last-name">Last name</Label>
                <Input id="child-last-name" value={newChild.lastName}
                  className={childErrors.lastName ? "border-destructive" : ""}
                  onChange={(event) => { setNewChild((current) => ({ ...current, lastName: event.target.value })); setChildErrors((p) => ({ ...p, lastName: "" })); }}
                  onBlur={(event) => { const c = toTitleCase(event.target.value); if (c && c !== event.target.value) setNewChild((cur) => ({ ...cur, lastName: c })); const r = validateFullName(c || event.target.value, "Last name", { minParts: 1 }); setChildErrors((p) => ({ ...p, lastName: r.valid ? "" : r.error! })); }}
                  required />
                {childErrors.lastName && <p className="text-xs text-destructive">{childErrors.lastName}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="child-birthdate">Birthdate</Label>
                <Input id="child-birthdate" type="date" min={birthdateMin()} max={birthdateMax()} value={newChild.birthdate}
                  className={childErrors.birthdate ? "border-destructive" : ""}
                  onChange={(event) => { setNewChild((current) => ({ ...current, birthdate: event.target.value })); setChildErrors((p) => ({ ...p, birthdate: "" })); }}
                  required />
                {childErrors.birthdate && <p className="text-xs text-destructive">{childErrors.birthdate}</p>}
                {!childErrors.birthdate && newChild.birthdate && (
                  <p className="text-xs text-muted-foreground">Age: <span className="font-medium text-foreground">{formatAge(newChild.birthdate)}</span></p>
                )}
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Enrollment Requirements</p>
                <span className="text-xs text-muted-foreground">{[childDocs.birthCert, childDocs.photo, childDocs.guardianId].filter(Boolean).length}/3</span>
              </div>
              <DocUploadField label="Student Birth Certificate" desc="Used for age verification." value={childDocs.birthCert}
                onChange={(doc) => { setChildDocs((c) => ({ ...c, birthCert: doc })); setChildErrors((p) => ({ ...p, docs: "" })); }}
                onRemove={() => setChildDocs((c) => ({ ...c, birthCert: null }))} />
              <DocUploadField label="Recent 2×2 Photo of Student" desc="Clear, recent photo." value={childDocs.photo}
                accept=".jpg,.jpeg,.png,image/jpeg,image/png"
                onChange={(doc) => { setChildDocs((c) => ({ ...c, photo: doc })); setChildErrors((p) => ({ ...p, docs: "" })); }}
                onRemove={() => setChildDocs((c) => ({ ...c, photo: null }))} />
              <DocUploadField label="Guardian Valid ID" desc="Government-issued ID of the parent/guardian." value={childDocs.guardianId}
                onChange={(doc) => { setChildDocs((c) => ({ ...c, guardianId: doc })); setChildErrors((p) => ({ ...p, docs: "" })); }}
                onRemove={() => setChildDocs((c) => ({ ...c, guardianId: null }))} />
              {childErrors.docs && <p className="text-xs text-destructive">{childErrors.docs}</p>}
            </div>
            </div>}
            {addChildStep === 2 && <div className="space-y-2"><Label>Choose a program package</Label><p className="text-xs text-muted-foreground">Enter the birthdate first. Programs outside the child&apos;s age range are disabled.</p><div className="max-h-64 space-y-2 overflow-y-auto">{["TPG101", "ACT102", "EXP106"].map((programCode) => { const items = pricing.filter((item) => item.programCode === programCode); if (!items.length) return null; const eligibleItems = items.filter(isPackageEligible); const expanded = expandedPrograms.includes(programCode); const programName = programCode === "TPG101" ? "Toddlers Playgroup" : programCode === "ACT102" ? "Academic Tutorial" : "Examination Preparation"; return <div key={programCode} className="rounded-lg border border-border"><button type="button" disabled={eligibleItems.length === 0} onClick={() => setExpandedPrograms((current) => current.includes(programCode) ? current.filter((code) => code !== programCode) : [...current, programCode])} className={`flex w-full items-center justify-between p-3 text-left ${eligibleItems.length === 0 ? "cursor-not-allowed opacity-50" : "hover:bg-muted/50"}`}><span><span className="block text-sm font-semibold">{programName}</span><span className="text-xs text-muted-foreground">{eligibleItems.length === 0 ? (childAge === null ? "Enter birthdate to check eligibility" : "Not available for this age") : `${items.length} package${items.length === 1 ? "" : "s"}`}</span></span><span className="text-muted-foreground">{expanded ? "−" : "+"}</span></button>{expanded && eligibleItems.length > 0 && <div className="space-y-2 border-t border-border p-2">{eligibleItems.map((item) => { const down = item.priceDown ?? Math.ceil(item.priceFull * 0.5); return <button type="button" key={`${item.programCode}:${item.packageSlug}`} onClick={() => setNewChild((current) => ({ ...current, packageKey: `${item.programCode}:${item.packageSlug}` }))} className={`w-full rounded-lg border p-3 text-left ${newChild.packageKey === `${item.programCode}:${item.packageSlug}` ? "border-primary bg-primary/5" : "border-border"}`}><span className="block text-sm font-medium">{item.displayName}</span><span className="text-xs text-muted-foreground block">{item.durationDesc || "Package"}</span><span className="text-xs text-muted-foreground">Full price: PHP {item.priceFull.toLocaleString()}</span><span className="text-xs font-semibold text-primary block">50% down: PHP {down.toLocaleString()}</span></button>; })}</div>}</div>; })}</div></div>}
            {addChildStep === 3 && <div className="space-y-2"><Label htmlFor="child-start-date">Preferred start date <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="child-start-date" type="date" value={newChild.preferredStartDate} onChange={(event) => setNewChild((current) => ({ ...current, preferredStartDate: event.target.value }))} /></div>}
            {addChildStep === 4 && <div className="space-y-4"><div className="space-y-2"><Label>Does the child have allergies?</Label><div className="flex gap-2"><Button type="button" variant={hasAllergies === "yes" ? "default" : "outline"} onClick={() => setHasAllergies("yes")}>Yes</Button><Button type="button" variant={hasAllergies === "no" ? "default" : "outline"} onClick={() => { setHasAllergies("no"); setNewChild((current) => ({ ...current, allergies: "" })); }}>No</Button></div>{hasAllergies === "yes" && <Input aria-label="Allergy details" value={newChild.allergies} onChange={(event) => setNewChild((current) => ({ ...current, allergies: event.target.value }))} placeholder="List allergies" required />}</div><div className="space-y-2"><Label>Does the child have medical conditions or take medication?</Label><div className="flex gap-2"><Button type="button" variant={hasMedicalConditions === "yes" ? "default" : "outline"} onClick={() => setHasMedicalConditions("yes")}>Yes</Button><Button type="button" variant={hasMedicalConditions === "no" ? "default" : "outline"} onClick={() => { setHasMedicalConditions("no"); setNewChild((current) => ({ ...current, medications: "" })); }}>No</Button></div>{hasMedicalConditions === "yes" && <Input aria-label="Medical condition details" value={newChild.medications} onChange={(event) => setNewChild((current) => ({ ...current, medications: event.target.value }))} placeholder="List conditions or medications" required />}</div></div>}
            {addChildStep === 5 && <div className="space-y-3"><Label className="flex items-center gap-3"><Checkbox checked={newChild.specialNeeds} onCheckedChange={(checked) => setNewChild((current) => ({ ...current, specialNeeds: checked === true }))} /> Does the child have special learning or medical needs?</Label>{newChild.specialNeeds && <Input value={newChild.specialNeedsDetails} onChange={(event) => setNewChild((current) => ({ ...current, specialNeedsDetails: event.target.value }))} placeholder="Please provide details" />}</div>}
            {addChildStep === 6 && <div className="max-h-72 space-y-3 overflow-y-auto"><p className="text-sm text-muted-foreground">Complete the assessment when it applies to the child. If it does not apply, leave this unchecked.</p><Label className="flex items-center gap-3"><Checkbox checked={newChild.assessmentApplicable} onCheckedChange={(checked) => setNewChild((current) => ({ ...current, assessmentApplicable: checked === true }))} /> Assessment is applicable</Label>{newChild.assessmentApplicable && assessmentTemplates.length > 0 && <><Label htmlFor="assessment-template">Assessment form</Label><select id="assessment-template" value={assessmentTemplateId} onChange={(event) => { setAssessmentTemplateId(event.target.value); setAssessmentRatings({}); setAssessmentInfo({}); }} className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" required><option value="">Select assessment form</option>{assessmentTemplates.map((template) => <option key={template._id} value={template._id}>{template.title}</option>)}</select>{activeAssessmentTemplate && <><p className="font-medium">{activeAssessmentTemplate.title}</p>{(activeAssessmentTemplate.infoFields || []).map((field) => <div key={field.key} className="space-y-1"><Label htmlFor={`assessment-info-${field.key}`}>{field.label}</Label><Input id={`assessment-info-${field.key}`} value={assessmentInfo[field.key] || ""} onChange={(event) => setAssessmentInfo((current) => ({ ...current, [field.key]: event.target.value }))} /></div>)}{(activeAssessmentTemplate.sections || []).map((section) => <div key={section.title} className="space-y-2"><p className="text-sm font-semibold">{section.title}</p>{(section.items || []).map((item) => <div key={item.key} className="space-y-1"><Label htmlFor={`assessment-rating-${item.key}`}>{item.label}</Label><select id={`assessment-rating-${item.key}`} value={assessmentRatings[item.key] || ""} onChange={(event) => setAssessmentRatings((current) => ({ ...current, [item.key]: event.target.value }))} className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" required><option value="">Select rating</option>{(activeAssessmentTemplate.ratingScale || []).map((rating) => <option key={rating.value} value={rating.value}>{rating.label}</option>)}</select></div>)}</div>)}<Input value={newChild.assessmentRemarks} onChange={(event) => setNewChild((current) => ({ ...current, assessmentRemarks: event.target.value }))} placeholder="Assessment remarks" /></>}</>}{newChild.assessmentApplicable && assessmentTemplates.length === 0 && <p className="text-sm text-muted-foreground">No assessment is configured for this program.</p>}</div>}
            {addChildStep === 7 && <div className="space-y-3"><Label>Billing and payment method</Label>{(() => { const selected = pricing.find((item) => `${item.programCode}:${item.packageSlug}` === newChild.packageKey); const down = selected?.priceDown ?? Math.ceil((selected?.priceFull || 0) * 0.5); return <div className="rounded-lg bg-muted p-3 text-sm"><p className="font-medium">{selected?.displayName || "Select a package first"}</p><p>Full price: PHP {(selected?.priceFull || 0).toLocaleString()}</p><p className="font-semibold text-primary">Amount due now (50%): PHP {down.toLocaleString()}</p></div>; })()}<Label htmlFor="child-payment-method">Payment method</Label><select id="child-payment-method" value={newChild.paymentMethod} onChange={(event) => setNewChild((current) => ({ ...current, paymentMethod: event.target.value }))} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" required><option value="gcash">GCash</option><option value="maribank">MariBank</option><option value="bdo">BDO</option></select><Label htmlFor="child-payment-proof">Payment proof</Label><Input id="child-payment-proof" type="file" accept="image/jpeg,image/png,application/pdf" onChange={(event) => setPaymentProofFile(event.target.files?.[0] || null)} required /><Input aria-label="Payment reference" value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} placeholder="Payment reference number (optional)" /><p className="text-xs text-muted-foreground">Upload a screenshot or PDF showing the 50% payment.</p></div>}
            {addChildStep === 8 && <label className="flex items-start gap-3 text-sm text-muted-foreground"><Checkbox checked={newChildConsent} onCheckedChange={(checked) => setNewChildConsent(checked === true)} /><span>I confirm that the child information is accurate and agree to submit this enrollment for admin review.</span></label>}
            {addChildStep === 9 && <div className="space-y-2 rounded-lg bg-muted p-4 text-sm"><p className="font-semibold">Ready to submit</p><p>{[newChild.firstName, newChild.middleName, newChild.lastName].filter(Boolean).join(" ")} - {pricing.find((item) => `${item.programCode}:${item.packageSlug}` === newChild.packageKey)?.displayName || "No package selected"}</p><p className="text-muted-foreground">Payment instructions will be provided after submission.</p></div>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setIsAddChildOpen(false)}>Cancel</Button>
              {addChildStep > 1 && <Button type="button" variant="outline" onClick={() => setAddChildStep((step) => step - 1)}>Back</Button>}
              {addChildStep < 9 ? <Button type="button" onClick={handleAddChildNext}>Next</Button> : <Button type="submit" disabled={isAddingChild || !newChildConsent}>{isAddingChild ? "Submitting..." : "Submit Enrollment"}</Button>}
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!selectedAnnouncement} onOpenChange={(open) => { if (!open) setSelectedAnnouncement(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          {selectedAnnouncement && (
            <>
              <DialogHeader>
                <DialogTitle>{selectedAnnouncement.title}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                  <span className="px-2 py-0.5 rounded bg-primary/10 text-primary font-medium">{announcementCategoryLabel(selectedAnnouncement.category)}</span>
                  <span>{announcementAuthorLabel(selectedAnnouncement)}</span>
                  {(selectedAnnouncement.approvedAt || selectedAnnouncement.createdAt) && (
                    <span>{new Date(selectedAnnouncement.approvedAt || selectedAnnouncement.createdAt).toLocaleDateString("en-US", { dateStyle: "medium" })}</span>
                  )}
                </div>
                <p className="text-sm leading-7 text-foreground whitespace-pre-wrap">{selectedAnnouncement.body}</p>
                {selectedAnnouncement.scheduledDate && (
                  <p className="text-sm text-muted-foreground">When: {new Date(selectedAnnouncement.scheduledDate).toLocaleDateString("en-US", { dateStyle: "medium" })}</p>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={balancePopup !== null} onOpenChange={(open) => { if (!open) setBalancePopup(null); }}>
        <DialogContent className="sm:max-w-md" data-testid="balance-popup">
          <DialogHeader>
            <DialogTitle>{balancePopup?.heading}</DialogTitle>
            <DialogDescription>Payment reminder</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm text-foreground">
            {balancePopup?.lines.map((line, i) => <p key={i}>{line}</p>)}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setBalancePopup(null)}>Later</Button>
            <Button type="button" onClick={() => { setBalancePopup(null); navigate("/student-dashboard/payments"); }}>Go to Payments</Button>
          </div>
        </DialogContent>
      </Dialog>
      <RenewProgramModal
        open={isRenewModalOpen}
        onOpenChange={setIsRenewModalOpen}
        child={renewChildInfo}
        onEnrolled={handleRenewEnrolled}
      />
    </DashboardLayout>
  );
}
