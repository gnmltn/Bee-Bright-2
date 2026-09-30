import { useEffect, useState, useMemo } from "react";
import { motion } from "framer-motion";
import {
  Users,
  Calendar,
  BookOpen,
  FileText,
  ChevronLeft,
  ChevronRight,
  Plus,
  Mail,
  Loader2,
  ExternalLink,
  Trash2,
  Pencil,
  Check,
  X,
  Eye,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { MyRequestsBell } from "@/components/notifications/MyRequestsBell";
import { StatCard } from "@/components/ui/stat-card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { REALTIME_EVENTS } from "@/lib/realtimeBridge";
import { UserAvatar } from "@/components/UserAvatar";
import {
  scheduleService,
  remarkService,
  announcementService,
  auditLogService,
  enrollmentService,
  uploadsBaseUrl,
  type RemarkItem,
  type RemarkTemplateType,
  type RemarkProgramCode,
  type AnnouncementItem,
  type AuditLogItem,
  type TutorStudentCard,
  type TutorAssessmentEnrollment,
} from "@/services/api";
import { EnrollmentAssessmentView } from "@/components/enrollment/EnrollmentAssessmentView";
import { displayStudentId } from "@/lib/children";
import { scheduleEntryBgClass, SCHEDULE_ENTRY_TEXT_CLASS } from "@/lib/scheduleColors";
import { PROGRAM_CATEGORIES, PROGRAM_LABELS, type ActiveProgramCode } from "@/constants/programs";
import { AttendanceTab } from "@/components/tutor/AttendanceTab";
import { RemarkForm } from "@/components/tutor/RemarkForm";
import { RemarkDetailDialog } from "@/components/tutor/RemarkDetailDialog";


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

// Radix UI SelectItem throws a runtime error when value="".
// Use a sentinel that can never collide with a real MongoDB ObjectId.
const ALL_STUDENTS_VALUE = "__all__";

function personDisplayName(person?: { firstName?: string; middleName?: string; lastName?: string } | null) {
  return person ? [person.firstName, person.middleName, person.lastName].filter(Boolean).join(" ") : "";
}

function formatSessionStudentLabel(session: {
  sessionType?: string;
  student?: { firstName?: string; middleName?: string; lastName?: string } | null;
  students?: Array<{ firstName?: string; middleName?: string; lastName?: string }>;
}) {
  const group = Array.isArray(session.students) ? session.students : [];
  if (session.sessionType === "playgroup" || group.length > 0) {
    if (group.length === 0) return "Playgroup (no children enrolled yet)";
    if (group.length <= 2) return group.map((student) => personDisplayName(student)).filter(Boolean).join(", ");
    return `Playgroup (${group.length} children)`;
  }
  return personDisplayName(session.student) || "—";
}

function sessionStudentRecords(session: {
  student?: {
    _id: string;
    firstName: string;
    lastName: string;
    middleName?: string;
    email?: string;
    gradeLevel?: string;
    phone?: string;
    profileImage?: string;
  } | null;
  students?: Array<{
    _id: string;
    firstName: string;
    lastName: string;
    middleName?: string;
    email?: string;
    gradeLevel?: string;
    phone?: string;
    profileImage?: string;
  }>;
}) {
  const records = [
    ...(session.student ? [session.student] : []),
    ...((session.students || [])),
  ];
  return records.filter((item, index, arr) => arr.findIndex((other) => String(other._id) === String(item._id)) === index);
}

function normalizeProgramText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function inferProgramCategoryIdFromSubjectName(subjectName: string): string | null {
  const text = normalizeProgramText(subjectName);
  if (!text) return null;

  // Only the 3 active programs
  if (text.includes("toddler") || text.includes("playgroup")) return "toddlers_playgroup";
  if (
    text.includes("exam") ||
    text.includes("review") ||
    text.includes("entrance") ||
    text.includes("prep") ||
    text.includes("preparedness") ||
    text.includes("preparation")
  ) return "exam_prep";
  if (
    text.includes("academic tutorial") ||
    text.includes("tutorial") ||
    text.includes("math") ||
    text.includes("english") ||
    text.includes("science") ||
    text.includes("filipino") ||
    text.includes("araling") ||
    text.includes("social studies") ||
    text.includes("reading") ||
    text.includes("writing")
  ) return "academic_tutorial";

  return null;
}

export default function TutorDashboard() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // ─── Sessions ────────────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState<
    {
      _id: string;
      date: string;
      startTime: string;
      endTime: string;
      attendanceStatus?: 'unmarked' | 'present' | 'absent';
      sessionType?: 'one-on-one' | 'small-group' | 'playgroup';
      student?: {
        _id: string;
        firstName: string;
        lastName: string;
        middleName?: string;
        email?: string;
        gradeLevel?: string;
        phone?: string;
      };
      students?: Array<{
        _id: string;
        firstName: string;
        lastName: string;
        middleName?: string;
        email?: string;
        gradeLevel?: string;
        phone?: string;
        profileImage?: string;
      }>;
      subject?: { _id: string; name: string; code?: string };
    }[]
  >([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [attendanceDialogSession, setAttendanceDialogSession] = useState<{
    _id: string;
    studentName: string;
    subjectName: string;
    dateStr: string;
    attendanceStatus?: string;
  } | null>(null);
  const [attendanceMarking, setAttendanceMarking] = useState(false);

  // ─── Announcements ─────────────────────────────────────────────────────────────
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [announcementsLoading, setAnnouncementsLoading] = useState(false);
  const [announcementStudents, setAnnouncementStudents] = useState<{ _id: string; name: string; email?: string }[]>([]);
  const [announcementFormOpen, setAnnouncementFormOpen] = useState(false);
  const [announcementForm, setAnnouncementForm] = useState({
    title: "",
    body: "",
    category: "general",
    targetStudentIds: [] as string[],
    scheduledDate: "",
  });
  const [announcementSubmitting, setAnnouncementSubmitting] = useState(false);
  const [editingAnnouncementId, setEditingAnnouncementId] = useState<string | null>(null);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<AnnouncementItem | null>(null);
  // Assessments Preview (Overview / Assessments tab) — completed pre-enrollment assessment forms
  // for this tutor's own Academic Tutorial students (BeeBright backlog item 25).
  const [tutorAssessments, setTutorAssessments] = useState<TutorAssessmentEnrollment[]>([]);
  const [tutorAssessmentsLoading, setTutorAssessmentsLoading] = useState(false);
  const [selectedAssessmentEnrollment, setSelectedAssessmentEnrollment] = useState<TutorAssessmentEnrollment | null>(null);
  const [weekStart, setWeekStart] = useState<Date>(() => startOfSchoolWeek(new Date()));

  // ─── Schedule view controls ────────────────────────────────────────────────────
  const [scheduleViewMode, setScheduleViewMode] = useState<"monthly" | "weekly" | "daily">("monthly");
  const [calendarMonth, setCalendarMonth] = useState(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [scheduleDailyDate, setScheduleDailyDate] = useState(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  });
  const [scheduleWeekStart, setScheduleWeekStart] = useState<Date>(() => startOfSchoolWeek(new Date()));

  const [activityLogs, setActivityLogs] = useState<AuditLogItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  const fetchSessions = () => {
    setSessionsLoading(true);
    scheduleService
      .getMySessions()
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.schedules)) {
          setSessions(res.data.schedules);
        } else {
          setSessions([]);
        }
      })
      .catch(() => setSessions([]))
      .finally(() => setSessionsLoading(false));
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const [studentCards, setStudentCards] = useState<TutorStudentCard[]>([]);
  const [studentCardsLoading, setStudentCardsLoading] = useState(false);
  const fetchStudentCards = () => {
    setStudentCardsLoading(true);
    scheduleService
      .getMyStudentCards()
      .then((res) => setStudentCards(res.data?.success && Array.isArray(res.data.students) ? res.data.students : []))
      .catch(() => setStudentCards([]))
      .finally(() => setStudentCardsLoading(false));
  };
  useEffect(() => {
    // Fetch on both hashes that render the "Assigned Students" panel (renderTeachingPage) —
    // the "#students" tab AND the default "overview" tab ("" or "#assessments") — since the
    // mail icon there also depends on this data (parentEmail/parentName), not just the
    // "My Students" cards grid.
    const showsTeachingPage = location.hash === "#students" || location.hash === "#assessments" || location.hash === "";
    if (!showsTeachingPage) return;
    fetchStudentCards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash]);

  const fetchAnnouncements = () => {
    setAnnouncementsLoading(true);
    announcementService
      .getForTutor()
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

  const fetchTutorAssessments = () => {
    setTutorAssessmentsLoading(true);
    enrollmentService
      .getTutorAssessments()
      .then((res) => setTutorAssessments(res.data?.success && Array.isArray(res.data.enrollments) ? res.data.enrollments : []))
      .catch(() => setTutorAssessments([]))
      .finally(() => setTutorAssessmentsLoading(false));
  };

  const announcementCategoryLabel = (category: string) => {
    return {
      sick_leave: "Sick Leave",
      exam: "Exam",
      quiz: "Quiz",
      exam_quiz: "Exam / Quiz",
      materials: "Materials to Bring",
      reschedule: "Reschedule",
      reminder: "Reminder",
      general: "General",
    }[category] || category;
  };

  const summarizeAnnouncement = (body: string) => {
    const trimmed = body.trim();
    return trimmed.length > 110 ? `${trimmed.slice(0, 107)}...` : trimmed;
  };

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

  useEffect(() => {
    if (!location.hash || location.hash === "#students" || location.hash === "#assessments" || location.hash === "#announcements") {
      fetchAnnouncements();
    }
  }, [location.hash]);

  useEffect(() => {
    if (!location.hash || location.hash === "#assessments") {
      fetchTutorAssessments();
    }
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

  useEffect(() => {
    if (announcementFormOpen) {
      announcementService
        .getMyStudents()
        .then((res) => {
          if (res.data?.success && Array.isArray(res.data.students)) {
            setAnnouncementStudents(res.data.students);
          } else {
            setAnnouncementStudents([]);
          }
        })
        .catch(() => setAnnouncementStudents([]));
    }
  }, [announcementFormOpen]);

  const toDateInputValue = (value?: string | null) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  };

  const openCreateAnnouncement = () => {
    setEditingAnnouncementId(null);
    setAnnouncementForm({ title: "", body: "", category: "general", targetStudentIds: [], scheduledDate: "" });
    setAnnouncementFormOpen(true);
  };

  const openEditAnnouncement = (announcement: AnnouncementItem) => {
    setEditingAnnouncementId(announcement._id);
    setAnnouncementForm({
      title: announcement.title || "",
      body: announcement.body || "",
      category: announcement.category || "general",
      targetStudentIds: Array.isArray(announcement.targetStudentIds) ? announcement.targetStudentIds.map((student) => student._id) : [],
      scheduledDate: toDateInputValue(announcement.scheduledDate),
    });
    setAnnouncementFormOpen(true);
  };

  const handleDeleteAnnouncement = async (announcement: AnnouncementItem) => {
    if (!window.confirm(`Delete announcement "${announcement.title}"?`)) return;
    try {
      const res = await announcementService.delete(announcement._id);
      if (res.data?.success) {
        toast.success("Announcement deleted.");
        if (editingAnnouncementId === announcement._id) {
          setEditingAnnouncementId(null);
          setAnnouncementFormOpen(false);
          setAnnouncementForm({ title: "", body: "", category: "general", targetStudentIds: [], scheduledDate: "" });
        }
        fetchAnnouncements();
      } else {
        toast.error(res.data?.message || "Failed to delete announcement.");
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || "Failed to delete announcement.";
      toast.error(msg);
    }
  };

  const scheduleDateOnly = (d: string) => {
    if (!d) return "";
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  };

  const todayStr = useMemo(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  }, []);

  // ─── Assigned students (Students tab) ────────────────────────────────────────
  const assignedStudents = useMemo(() => {
    const map = new Map<
      string,
      {
        studentId: string;
        name: string;
        grade: string;
        subject: string;
        schedule: string;
        email: string;
        phone: string;
        sessionCount: number;
        profileImage?: string;
      }
    >();
    sessions.forEach((s) => {
      if (!s.subject) return;
      sessionStudentRecords(s).forEach((student) => {
        const key = `${student._id}-${s.subject!._id}`;
        const name = personDisplayName(student);
        const existing = map.get(key);
        if (existing) {
          existing.sessionCount += 1;
          existing.schedule += `; ${new Date(s.date).toLocaleDateString("en-US", {
            weekday: "short",
          })} ${formatTime12h(s.startTime)}`;
        } else {
          map.set(key, {
            studentId: student._id,
            name,
            grade: student.gradeLevel ?? "—",
            subject: s.subject!.name,
            schedule: `${new Date(s.date).toLocaleDateString("en-US", {
              weekday: "short",
            })} ${formatTime12h(s.startTime)}`,
            email: student.email ?? "",
            phone: student.phone ?? "",
            sessionCount: 1,
            profileImage: student.profileImage,
          });
        }
      });
    });
    return Array.from(map.values());
  }, [sessions]);

  // Student User id -> real PARENT contact (via Enrollment, from getMyStudentCards) — the
  // "Assigned Students" mail icon must address the parent, never the student User's own
  // placeholder `child.<id>@students.beebright.internal` email ("bug (14).pdf" Group 2).
  const parentContactByStudentId = useMemo(() => {
    const map = new Map<string, { email: string; name: string }>();
    studentCards.forEach((card) => {
      if (card.studentUserId && card.parentEmail) {
        map.set(String(card.studentUserId), { email: card.parentEmail, name: card.parentName || "the parent" });
      }
    });
    return map;
  }, [studentCards]);

  // ─── Student Remarks state (replaces the grading workflow) ────────────────────
  const [remarks, setRemarks] = useState<RemarkItem[]>([]);
  const [remarksLoading, setRemarksLoading] = useState(false);
  // Spec v3 — "Choose Remark Type" is its own required step, chosen BEFORE the
  // student. Never inferred from the student; always shown, even if the tutor only
  // has one active program.
  const [remarkTypeProgramCode, setRemarkTypeProgramCode] = useState<RemarkProgramCode | "">("");
  const [remarkFormStudentId, setRemarkFormStudentId] = useState("");
  const [remarkFormMode, setRemarkFormMode] = useState<"create" | "edit">("create");
  const [remarkFormTarget, setRemarkFormTarget] = useState<RemarkItem | null>(null);
  const [viewingRemark, setViewingRemark] = useState<RemarkItem | null>(null);
  const [remarkFilterStudentId, setRemarkFilterStudentId] = useState(ALL_STUDENTS_VALUE);

  // ─── Unique students this tutor teaches ──────────────────────────────────────
  const tutorAssignedStudentsList = useMemo(() => {
    const seen = new Set<string>();
    const list: { _id: string; name: string }[] = [];
    sessions.forEach((s) => {
      sessionStudentRecords(s).forEach((student) => {
        const id = student._id != null ? String(student._id) : "";
        if (!id || seen.has(id)) return;
        seen.add(id);
        list.push({
          _id: id,
          name: personDisplayName(student),
        });
      });
    });
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions]);

  // ─── Student Remarks Spec v3: "Choose Remark Type" step ───────────────────────
  // Single source of truth for BOTH the type buttons and the student dropdown: the
  // tutor's actual (program, student) assignment pairs — a Schedule only counts if it
  // actually has a real student attached (sessionStudentRecords), not just a subject.
  // A subject-only "empty slot" Schedule (no student enrolled yet, e.g. an unfilled
  // template-generated session) must never make a remark type look available when
  // there's really nobody to write a remark about — deriving both lists from this one
  // list of pairs is what guarantees they can never disagree.
  const tutorRemarkAssignmentPairs = useMemo(() => {
    const pairs: { categoryId: string; programCode: string; studentId: string; studentName: string }[] = [];
    const seen = new Set<string>();
    sessions.forEach((s) => {
      if (!s.subject) return;
      const inferred = inferProgramCategoryIdFromSubjectName(s.subject.name || "");
      const prog = inferred ? PROGRAM_CATEGORIES.find((p) => p.id === inferred) : undefined;
      if (!prog) return;
      sessionStudentRecords(s).forEach((student) => {
        const studentId = student._id != null ? String(student._id) : "";
        if (!studentId) return;
        const key = `${prog.programCode}:${studentId}`;
        if (seen.has(key)) return;
        seen.add(key);
        pairs.push({ categoryId: prog.id, programCode: prog.programCode, studentId, studentName: personDisplayName(student) });
      });
    });
    return pairs;
  }, [sessions]);

  // Only the program(s) with at least one real (program, student) pair. This step must
  // always be shown, even when only one program is active (never auto-skipped).
  const tutorActiveRemarkPrograms = useMemo(() => {
    const activeIds = new Set(tutorRemarkAssignmentPairs.map((p) => p.categoryId));
    return PROGRAM_CATEGORIES.filter((p) => activeIds.has(p.id));
  }, [tutorRemarkAssignmentPairs]);

  // Students enrolled in the CHOSEN program AND assigned to this tutor specifically
  // for that program — a tutor who teaches a student in only one of several programs
  // they're enrolled in must not see them here for a program not actually taught.
  const studentsForRemarkType = useMemo(() => {
    if (!remarkTypeProgramCode) return [];
    return tutorRemarkAssignmentPairs
      .filter((p) => p.programCode === remarkTypeProgramCode)
      .map((p) => ({ _id: p.studentId, name: p.studentName }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [remarkTypeProgramCode, tutorRemarkAssignmentPairs]);

  function templateTypeForProgramCode(code: string): RemarkTemplateType {
    if (code === "TPG101") return "toddler_observation";
    if (code === "EXP106") return "examination_progress";
    return "academic_progress";
  }

  // Changing the remark type invalidates any student already picked under the old type.
  useEffect(() => {
    setRemarkFormStudentId("");
  }, [remarkTypeProgramCode]);

  // ─── Student Remarks fetchers ─────────────────────────────────────────────────
  const fetchRemarks = () => {
    setRemarksLoading(true);
    const studentIdParam = remarkFilterStudentId === ALL_STUDENTS_VALUE ? undefined : remarkFilterStudentId;
    remarkService
      .listMine(studentIdParam)
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.remarks)) {
          setRemarks(res.data.remarks);
        } else {
          setRemarks([]);
        }
      })
      .catch(() => setRemarks([]))
      .finally(() => setRemarksLoading(false));
  };

  useEffect(() => {
    if (user?.role === "tutor" && location.hash === "#remarks") {
      fetchRemarks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash, user?.role, remarkFilterStudentId]);

  // Real-time push (Socket.io) — Overview/Schedule/My Students/Assessments/Announcements/
  // Remarks refresh live, on top of the existing manual refresh (untouched). Attendance is
  // deliberately NOT wired here — a tutor is the one marking it, there's nothing another
  // user could change underneath them to push. The connection itself lives in App.tsx's
  // RealtimeConnector; this page just listens for the events its own screens care about.
  // `fetchRemarks` closes over `remarkFilterStudentId` (the Remark History dropdown
  // filter) — listed in this effect's deps so a stale closure doesn't keep refetching with
  // whatever filter was selected when the listener was first registered ("bug (18).pdf"
  // Group AV: this exact stale-closure class was the real root cause behind "Approve/Reject
  // don't update the tutor's own Remark History live" — that event wasn't even wired at all
  // before this fix, on top of the closure risk here). Placed AFTER remarkFilterStudentId's
  // own useState (not `[]` deps referencing it — that's a TDZ error, evaluated eagerly at
  // render time, unlike a closure body).
  useEffect(() => {
    const onScheduleChanged = () => { fetchSessions(); fetchStudentCards(); };
    const onAnnouncementNew = () => { fetchAnnouncements(); toast.success("New announcement"); };
    const onAssessmentCompleted = () => { fetchTutorAssessments(); toast.success("New completed assessment"); };
    const onRemarkReviewed = () => {
      fetchRemarks();
      toast.success("Remark reviewed", { description: "Check your Remark History." });
    };
    const onReconnectCatchUp = () => { fetchSessions(); fetchStudentCards(); fetchAnnouncements(); fetchTutorAssessments(); fetchRemarks(); };
    window.addEventListener(REALTIME_EVENTS.SCHEDULE_CHANGED, onScheduleChanged);
    window.addEventListener(REALTIME_EVENTS.ANNOUNCEMENT_NEW, onAnnouncementNew);
    window.addEventListener(REALTIME_EVENTS.ASSESSMENT_COMPLETED, onAssessmentCompleted);
    window.addEventListener(REALTIME_EVENTS.REMARK_REVIEWED, onRemarkReviewed);
    window.addEventListener(REALTIME_EVENTS.RECONNECT_CATCHUP, onReconnectCatchUp);
    return () => {
      window.removeEventListener(REALTIME_EVENTS.SCHEDULE_CHANGED, onScheduleChanged);
      window.removeEventListener(REALTIME_EVENTS.ANNOUNCEMENT_NEW, onAnnouncementNew);
      window.removeEventListener(REALTIME_EVENTS.ASSESSMENT_COMPLETED, onAssessmentCompleted);
      window.removeEventListener(REALTIME_EVENTS.REMARK_REVIEWED, onRemarkReviewed);
      window.removeEventListener(REALTIME_EVENTS.RECONNECT_CATCHUP, onReconnectCatchUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remarkFilterStudentId]);

  // ─── Derived display data ─────────────────────────────────────────────────────
  const todaySchedule = useMemo(() => {
    return sessions
      .filter((s) => scheduleDateOnly(s.date) === todayStr)
      .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""))
      .map((s) => {
        const now = new Date();
        const [h, m] = (s.startTime || "00:00").split(":").map(Number);
        const startDate = new Date(now);
        startDate.setHours(h, m, 0, 0);
        const [eh, em] = (s.endTime || "00:00").split(":").map(Number);
        const endDate = new Date(now);
        endDate.setHours(eh, em, 0, 0);
        let status = "upcoming";
        if (now >= endDate) status = "completed";
        else if (now >= startDate) status = "ongoing";
        return {
          _id: s._id,
          time: formatTime12h(s.startTime),
          endTime: formatTime12h(s.endTime),
          student: formatSessionStudentLabel(s),
          subject: s.subject?.name ?? "—",
          status,
          attendanceStatus: s.attendanceStatus ?? "unmarked",
        };
      });
  }, [sessions, todayStr]);

  const upcomingOverviewSessions = useMemo(() => {
    const now = new Date();

    return sessions
      .map((session) => {
        const startAt = new Date(session.date);
        const [startHour, startMinute] = String(session.startTime || "00:00")
          .split(":")
          .map(Number);
        startAt.setHours(startHour || 0, startMinute || 0, 0, 0);

        return {
          _id: session._id,
          startAt,
          student: formatSessionStudentLabel(session),
          subject: session.subject?.name ?? "—",
          isPlaygroup: session.sessionType === "playgroup",
          time: `${formatTime12h(session.startTime)} - ${formatTime12h(session.endTime)}`,
          date: startAt.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          }),
        };
      })
      .filter((session) => !Number.isNaN(session.startAt.getTime()) && session.startAt >= now)
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
      .slice(0, 5);
  }, [sessions]);

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
    const map = new Map<
      string,
      { student: string; subject: string; subjectCode?: string; scheduleId: string; attendanceStatus?: string }[]
    >();

    sessions.forEach((s) => {
      const sessionDate = new Date(s.date);
      sessionDate.setHours(0, 0, 0, 0);
      const dayOffset = Math.floor((sessionDate.getTime() - weekStart.getTime()) / 86400000);
      if (dayOffset < 0 || dayOffset > 5) return;

      const start = s.startTime || "00:00";
      const end = s.endTime || start;
      const slotKey = `${start}|${end}`;
      slotSet.add(slotKey);

      const student = formatSessionStudentLabel(s);

      const cellKey = `${dayOffset}|${slotKey}`;
      const list = map.get(cellKey) || [];
      list.push({
        student,
        subject: s.subject?.name ?? "—",
        subjectCode: s.subject?.code,
        scheduleId: s._id,
        attendanceStatus: s.attendanceStatus ?? "unmarked",
      });
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
  }, [sessions, weekStart]);

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
    const map: Record<string, typeof sessions> = {};
    for (const s of sessions) {
      const key = scheduleDateOnly(s.date);
      if (!map[key]) map[key] = [];
      map[key].push(s);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
    }
    return map;
  }, [sessions]);

  const schedulesInDailyView = useMemo(() => {
    return (schedulesByDate[scheduleDailyDate] || []).slice().sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
  }, [scheduleDailyDate, schedulesByDate]);

  const weeklyDays = useMemo(() => ([
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
    return weeklyDays.map((day) => {
      const date = addDays(scheduleWeekStart, day.key - 1);
      return { dayKey: day.key, dateKey: toDateKey(date), date };
    });
  }, [scheduleWeekStart, weeklyDays]);

  const schedulesInWeeklyView = useMemo(() => {
    const weekKeys = new Set(weeklyDateKeys.map((entry) => entry.dateKey));
    return sessions.filter((s) => weekKeys.has(scheduleDateOnly(s.date)));
  }, [sessions, weeklyDateKeys]);

  const schedulesByWeeklyDay = useMemo(() => {
    const map: Record<number, typeof sessions> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
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
    return sessions.filter((s) => {
      const d = scheduleDateOnly(s.date);
      return d >= thisMonthStart && d <= thisMonthEnd;
    });
  }, [sessions, thisMonthStart, thisMonthEnd]);

  const schedulesThisMonth = schedulesInCalendarMonth.length;
  const weekStart2 = new Date();
  weekStart2.setDate(weekStart2.getDate() - weekStart2.getDay());
  const weekEnd = new Date(weekStart2);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekStartStr = `${weekStart2.getFullYear()}-${String(weekStart2.getMonth() + 1).padStart(2, "0")}-${String(weekStart2.getDate()).padStart(2, "0")}`;
  const weekEndStr = `${weekEnd.getFullYear()}-${String(weekEnd.getMonth() + 1).padStart(2, "0")}-${String(weekEnd.getDate()).padStart(2, "0")}`;
  const schedulesThisWeek = sessions.filter((s) => {
    const d = scheduleDateOnly(s.date);
    return d >= weekStartStr && d <= weekEndStr;
  }).length;

  const renderScheduleGridCard = (
    title: string,
    description: string,
    emptyMessage: string
  ) => (
    <div className="bg-card rounded-xl p-6 border border-border overflow-x-auto">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="font-display font-bold text-lg text-foreground">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">School-week view (Monday to Saturday).</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setWeekStart((prev) => addDays(prev, -7))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium text-foreground min-w-[180px] text-center">{weekRangeLabel}</span>
          <Button variant="outline" size="sm" onClick={() => setWeekStart((prev) => addDays(prev, 7))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setWeekStart(startOfSchoolWeek(new Date()))}>
            This Week
          </Button>
        </div>
      </div>
      {sessionsLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : weekSchedule.slots.length === 0 ? (
        <p className="text-center text-muted-foreground py-8">{emptyMessage}</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="text-left p-2 border border-border bg-muted/60 font-semibold text-foreground sticky left-0 z-10 min-w-[90px]">
                Period
              </th>
              {weekDays.map((day) => (
                <th
                  key={day.dateKey}
                  className="p-2 border border-border bg-muted/60 font-semibold text-foreground text-center min-w-[120px]"
                >
                  <p>{day.label}</p>
                  <p className="text-xs text-muted-foreground font-medium">
                    {day.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </p>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weekSchedule.slots.map((slotKey) => {
              const [startTime, endTime] = slotKey.split("|");
              return (
              <tr key={slotKey}>
                <td className="p-2 border border-border bg-muted/30 font-medium text-foreground sticky left-0 z-10 whitespace-nowrap">
                  {formatTime12h(startTime)} - {formatTime12h(endTime)}
                </td>
                {weekDays.map((day) => {
                  const sessionsForCell = weekSchedule.getSessions(day.offset, slotKey);
                  return (
                    <td key={day.dateKey} className="p-2 border border-border align-top">
                      {sessionsForCell.length > 0 ? (
                        <div className="space-y-1 min-h-[52px]">
                          {sessionsForCell.map((session) => (
                            <button
                              key={session.scheduleId}
                              type="button"
                              onClick={() =>
                                setAttendanceDialogSession({
                                  _id: session.scheduleId,
                                  studentName: session.student,
                                  subjectName: session.subject,
                                  dateStr: day.dateKey,
                                  attendanceStatus: session.attendanceStatus,
                                })
                              }
                              className={`w-full p-2 rounded-lg text-center cursor-pointer transition-colors hover:opacity-90 hover:ring-2 hover:ring-primary/30 ${scheduleEntryBgClass(session.subjectCode)} ${SCHEDULE_ENTRY_TEXT_CLASS}`}
                            >
                              <p
                                className="text-xs font-medium truncate"
                                title={session.student}
                              >
                                {session.student}
                              </p>
                              <p className="text-[10px] opacity-80">{session.subject}</p>
                              {session.attendanceStatus && session.attendanceStatus !== "unmarked" && (
                                <p className="text-[10px] mt-0.5 opacity-80 capitalize">
                                  {session.attendanceStatus}
                                </p>
                              )}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="min-h-[52px]" />
                      )}
                    </td>
                  );
                })}
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );

  const handleMarkAttendance = (
    scheduleId: string,
    dateStr: string,
    status: "present" | "absent"
  ) => {
    // Allow marking for today and past dates; only future dates are blocked.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [y, m, d] = dateStr.split("-").map((n) => Number(n));
    const sessionDay = new Date(y || today.getFullYear(), (m || 1) - 1, d || 1);
    sessionDay.setHours(0, 0, 0, 0);
    if (sessionDay > today) {
      toast.error("You can only mark attendance for today or past dates.");
      return;
    }

    setAttendanceMarking(true);
    scheduleService
      .markAttendance(scheduleId, status)
      .then(() => {
        toast.success(`Marked as ${status}`);
        setAttendanceDialogSession(null);
        fetchSessions();
      })
      .catch((err) => {
        const msg: string =
          err?.response?.data?.message || "Failed to mark attendance";
        toast.error(msg);
      })
      .finally(() => setAttendanceMarking(false));
  };

  // ─── Tab routing ──────────────────────────────────────────────────────────────
  const hashToTab: Record<string, string> = {
    "#students": "students",
    "#assessments": "overview",
    "#attendance": "attendance",
    "#schedule": "schedule",
    "#remarks": "remarks",
    "#announcements": "announcements",
    "#activity": "activity",
  };
  const activeTab = hashToTab[location.hash] || "overview";
  const handleTabChange = (value: string) => {
    navigate(`/tutor-dashboard#${value}`, { replace: true });
  };

  // The teaching summary page (stats, upcoming sessions, assigned students, calendar). "My Students"
  // shows the student cards in the top slot; Overview / Assessment show the announcements preview.
  const studentCardsSection = (
                  <div className="space-y-3">
                    <div>
                      <h3 className="font-display font-bold text-lg text-foreground">My Students</h3>
                      <p className="text-sm text-muted-foreground">Students assigned to you, and the program(s) you handle for each.</p>
                    </div>
                  {studentCardsLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : studentCards.length === 0 ? (
                    <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
                      No assigned students yet. Admin will assign schedules.
                    </div>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="my-students-cards">
                      {studentCards.map((card) => (
                        <div key={card.studentId || card.studentUserId} className="bg-card rounded-xl border border-border p-5 space-y-1.5" data-testid="student-card">
                          <p className="font-display font-bold text-lg text-foreground">{card.name}</p>
                          <p className="text-sm text-foreground">
                            <span className="text-muted-foreground">Programs: </span>
                            {card.programs.length ? card.programs.join("; ") : "—"}
                          </p>
                          <p className="text-sm text-foreground">
                            <span className="text-muted-foreground">Student ID: </span>
                            <span className="font-mono">{card.studentId || "—"}</span>
                          </p>
                          {card.schedule && (
                            <p className="text-sm text-foreground">
                              <span className="text-muted-foreground">Schedule: </span>
                              {card.schedule}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  </div>
  );
  const assessmentsPreview = (
    <div className="bg-card rounded-xl border border-border overflow-hidden" data-testid="assessments-preview">
      <div className="p-4 border-b border-border">
        <h3 className="font-display font-bold text-lg text-foreground">Assessments Preview</h3>
        <p className="text-sm text-muted-foreground">Pre-enrollment assessment forms parents completed for Academic Tutorial.</p>
      </div>
      <div className="divide-y divide-border">
        {tutorAssessmentsLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : tutorAssessments.length === 0 ? (
          <p className="p-6 text-center text-muted-foreground">No completed assessment forms yet.</p>
        ) : (
          tutorAssessments.map((enrollment) => {
            const studentName = [enrollment.studentSnapshot?.firstName, enrollment.studentSnapshot?.middleName, enrollment.studentSnapshot?.lastName].filter(Boolean).join(" ") || "Student";
            return (
              <div
                key={enrollment._id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedAssessmentEnrollment(enrollment)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedAssessmentEnrollment(enrollment); } }}
                className="p-4 flex items-center justify-between gap-4 cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="assessment-preview-row"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">Academic Tutorial</span>
                    <span className="font-mono text-xs text-muted-foreground">{displayStudentId(enrollment)}</span>
                  </div>
                  <p className="font-semibold text-foreground">{studentName}</p>
                  <p className="text-sm text-muted-foreground">{enrollment.preEnrollmentAssessment.templateTitle || "Assessment Form"}</p>
                </div>
                {enrollment.preEnrollmentAssessment.completedAt ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{new Date(enrollment.preEnrollmentAssessment.completedAt).toLocaleDateString("en-US", { dateStyle: "medium" })}</span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
  const announcementsPreview = (
    <>
                  {assessmentsPreview}
                  {/* Announcements preview — Overview / Assessment */}
                  <div className="bg-card rounded-xl border border-border overflow-hidden">
                    <div className="p-4 border-b border-border flex items-center justify-between gap-3">
                      <div>
                        <h3 className="font-display font-bold text-lg text-foreground">Announcements Preview</h3>
                        <p className="text-sm text-muted-foreground">Recent updates below your teaching summary cards.</p>
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
                                <span className="text-xs text-muted-foreground capitalize">{announcement.status}</span>
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
    </>
  );
  const renderTeachingPage = (topSection: React.ReactNode) => (
    <>
                  {/* Stats — ONLY on this tab (students = overview) */}
                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatCard
                      title="Assigned Students"
                      value={sessionsLoading ? "—" : assignedStudents.length}
                      icon={Users}
                      variant="primary"
                    />
                    <StatCard
                      title="Classes Today"
                      value={sessionsLoading ? "—" : todaySchedule.length}
                      icon={Calendar}
                      variant="info"
                    />
                    <StatCard
                      title="Total Sessions"
                      value={sessionsLoading ? "—" : sessions.length}
                      icon={BookOpen}
                      variant="success"
                    />
                    <StatCard
                      title="Employment"
                      value={(user as { employmentType?: string })?.employmentType === "part-time" ? "Part-time" : "Full-time"}
                      icon={FileText}
                      variant="warning"
                    />
                  </div>

                  {topSection}

                  <div className="bg-card rounded-xl border border-border overflow-hidden">
                    <div className="p-4 border-b border-border flex items-center justify-between gap-3">
                      <div>
                        <h3 className="font-display font-bold text-lg text-foreground">Upcoming Sessions</h3>
                        <p className="text-sm text-muted-foreground">Your next classes are listed here for quick tracking.</p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleTabChange("schedule")}>View All <ChevronRight className="h-4 w-4 ml-1" /></Button>
                    </div>
                    <div className="divide-y divide-border">
                      {sessionsLoading ? (
                        <div className="flex items-center justify-center py-10">
                          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                      ) : upcomingOverviewSessions.length === 0 ? (
                        <p className="p-6 text-center text-muted-foreground">No upcoming sessions yet. Assigned classes will appear here.</p>
                      ) : (
                        upcomingOverviewSessions.map((session) => (
                          <div key={session._id} className="p-4 flex items-center justify-between gap-4 hover:bg-muted/40 transition-colors">
                            <div className="min-w-0">
                              <p className="font-semibold text-foreground">{session.subject}</p>
                              <p className="text-sm text-muted-foreground">{session.isPlaygroup ? "Children" : "Student"}: {session.student}</p>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="text-sm font-medium text-foreground">{session.time}</p>
                              <p className="text-xs text-muted-foreground">{session.date}</p>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="grid gap-6 xl:grid-cols-2 xl:items-start">
                    <div className="bg-card rounded-xl border border-border overflow-hidden h-full">
                      <div className="p-4 border-b border-border flex items-center justify-between">
                        <h3 className="font-display font-bold text-lg text-foreground">
                          Assigned Students
                        </h3>
                        <span className="text-sm text-muted-foreground">
                          {sessionsLoading ? "..." : `${assignedStudents.length} students`}
                        </span>
                      </div>
                      <div className="divide-y divide-border">
                        {sessionsLoading ? (
                          <div className="flex items-center justify-center py-12">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                          </div>
                        ) : assignedStudents.length === 0 ? (
                          <p className="p-6 text-center text-muted-foreground">
                            No assigned students yet. Admin will assign schedules.
                          </p>
                        ) : (
                          assignedStudents.map((student, index) => (
                            <div key={index} className="p-4 hover:bg-muted/50 transition-colors">
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-4">
                                  <UserAvatar
                                    src={
                                      student.profileImage
                                        ? `${uploadsBaseUrl}/uploads/${student.profileImage}`
                                        : null
                                    }
                                    fallback={student.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                                    size={10}
                                  />
                                  <div>
                                    <p className="font-semibold text-foreground">{student.name}</p>
                                    <p className="text-sm text-muted-foreground">
                                      {student.grade} • {student.subject}
                                    </p>
                                  </div>
                                </div>
                                <div className="hidden md:flex items-center gap-2">
                                  {(() => {
                                    // Addresses the student's real PARENT (resolved via Enrollment), not the
                                    // student User's own placeholder account email — matches how Admin's Users
                                    // tab email icon opens a Gmail compose draft rather than a mailto: link.
                                    const parentContact = parentContactByStudentId.get(student.studentId);
                                    if (!parentContact) return null;
                                    return (
                                      <a
                                        href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(parentContact.email)}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-muted transition-colors"
                                        title={`Email ${student.name}'s parent (${parentContact.name})`}
                                      >
                                        <Mail className="h-4 w-4" />
                                      </a>
                                    );
                                  })()}
                                </div>
                              </div>
                              <div className="ml-14 mt-1">
                                <p className="text-xs text-muted-foreground">{student.schedule}</p>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="h-full">
                      {renderScheduleGridCard(
                        "My Calendar Schedule",
                        "Your assigned teaching dates and times, shown here for quick reference just like the student overview.",
                        "No sessions scheduled yet. Your calendar will appear here once classes are assigned."
                      )}
                    </div>
                  </div>
    </>
  );

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="min-h-screen bg-muted">
        <div className="container mx-auto px-4 py-8">

          {/* Page header */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8"
          >
            <div>
              <h1 className="font-display text-2xl md:text-3xl font-bold text-foreground">
                Tutor Dashboard
              </h1>
              <p className="text-muted-foreground">Welcome back, {user?.name}!</p>
            </div>
          </motion.div>

          <div className="grid lg:grid-cols-4 gap-6">

            {/* ── Sidebar ── */}
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              className="lg:col-span-1 space-y-6"
            >
              {/* Profile card */}
              <div className="bg-card rounded-xl p-6 border border-border">
                <div className="text-center">
                  <div className="flex justify-center mb-4">
                    <UserAvatar
                      src={user?.profileImageUrl}
                      fallback={
                        (user?.firstName?.[0] || "") + (user?.lastName?.[0] || "") || "T"
                      }
                      size={20}
                    />
                  </div>
                  <h3 className="font-display font-bold text-lg text-foreground">{user?.name}</h3>
                  <p className="text-sm text-muted-foreground">{user?.email}</p>
                  <p className="text-xs text-muted-foreground mt-2">
                    {(user as { employmentType?: string })?.employmentType === "part-time" ? "Part-time tutor" : "Full-time tutor"}
                  </p>
                </div>
              </div>

              {/* Quick actions */}
              <div className="bg-card rounded-xl p-4 border border-border">
                <h4 className="font-semibold text-foreground mb-2">Quick Actions</h4>
                <MyRequestsBell asRow />
              </div>

              {/* Today's schedule */}
              <div className="bg-card rounded-xl p-4 border border-border">
                <h4 className="font-semibold text-foreground mb-4">Today&apos;s Schedule</h4>
                <div className="space-y-3">
                  {sessionsLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : todaySchedule.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">No sessions today</p>
                  ) : (
                    todaySchedule.map((item) => (
                      <button
                        key={item._id}
                        type="button"
                        onClick={() =>
                          setAttendanceDialogSession({
                            _id: item._id,
                            studentName: item.student,
                            subjectName: item.subject,
                            dateStr: todayStr,
                            attendanceStatus: item.attendanceStatus,
                          })
                        }
                        className={`w-full text-left flex items-center gap-3 p-3 rounded-lg transition-colors hover:ring-2 hover:ring-primary/30 ${
                          item.status === "ongoing"
                            ? "bg-primary/10 border border-primary/30"
                            : item.status === "completed"
                            ? "bg-muted opacity-60"
                            : "bg-muted"
                        }`}
                      >
                        <div className="text-center min-w-[50px]">
                          <p className="text-xs font-medium text-muted-foreground">{item.time}</p>
                          <p className="text-[10px] text-muted-foreground">{item.endTime}</p>
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-medium text-foreground">{item.student}</p>
                          <p className="text-xs text-muted-foreground">{item.subject}</p>
                          {item.attendanceStatus && item.attendanceStatus !== "unmarked" && (
                            <p className="text-[10px] mt-0.5 text-muted-foreground capitalize">{item.attendanceStatus}</p>
                          )}
                        </div>
                        {item.status === "ongoing" && (
                          <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
                        )}
                        {item.status === "completed" && (
                          <span className="text-[10px] text-success font-medium">Done</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </motion.div>

            {/* ── Main content ── */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="lg:col-span-3 space-y-6"
            >
              {/*
                NOTE: No <TabsList> here. The DashboardLayout already renders
                the hash-based tab navigation bar. Adding a second <TabsList>
                was causing the duplicate tab strip visible in the screenshot.
                The <Tabs> wrapper below is kept only for its value/onValueChange
                context so <TabsContent> switching works correctly.
              */}
              <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
                {/* ╔═ ATTENDANCE TAB ══ */}
<TabsContent value="attendance" className="space-y-6">
                  <AttendanceTab
                    sessions={sessions}
                    onRefresh={fetchSessions}
                    loading={sessionsLoading}
                  />
                </TabsContent>
                {/* ══ STUDENTS TAB — stats live here (the "overview") ══ */}
                <TabsContent value="students" className="space-y-6">
                  {renderTeachingPage(studentCardsSection)}
                </TabsContent>

                {/* ══ OVERVIEW / ASSESSMENT — same teaching summary, with the announcements preview ══ */}
                <TabsContent value="overview" className="space-y-6">
                  {renderTeachingPage(announcementsPreview)}
                </TabsContent>

                {/* ══ SCHEDULE TAB ══ */}
                <TabsContent value="schedule" className="space-y-6">
                  {/* Summary cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="bg-muted/50 rounded-xl p-4 border border-border">
                      <p className="text-sm text-muted-foreground">All Sessions</p>
                      <p className="text-2xl font-bold text-foreground">{sessionsLoading ? "—" : sessions.length}</p>
                      <p className="text-xs text-muted-foreground">sessions total</p>
                    </div>
                    <div className="bg-primary/5 rounded-xl p-4 border border-border">
                      <p className="text-sm text-muted-foreground">This Week</p>
                      <p className="text-2xl font-bold text-foreground">{sessionsLoading ? "—" : schedulesThisWeek}</p>
                      <p className="text-xs text-muted-foreground">sessions</p>
                    </div>
                    <div className="bg-info/5 rounded-xl p-4 border border-border">
                      <p className="text-sm text-muted-foreground">This Month</p>
                      <p className="text-2xl font-bold text-foreground">{sessionsLoading ? "—" : schedulesThisMonth}</p>
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
                          <Label htmlFor="daily-view-date" className="text-xs text-muted-foreground">Day</Label>
                          <Input
                            id="daily-view-date"
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
                    {sessionsLoading ? (
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
                                    const studentName = formatSessionStudentLabel(s);
                                    return (
                                      <div
                                        key={s._id}
                                        className={`w-full text-left p-2 rounded text-xs truncate transition-colors hover:opacity-90 ${scheduleEntryBgClass(s.subject?.code)} ${SCHEDULE_ENTRY_TEXT_CLASS}`}
                                      >
                                        <span className="font-medium block">{s.subject?.name ?? "—"}</span>
                                        <span className="opacity-90">{formatSlotTime(s.startTime)}</span>
                                        <span className="opacity-75 block truncate">{studentName}</span>
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
                              const dayName = weeklyDays.find((day) => day.key === entry.dayKey)?.label ?? "";
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

                                    {weeklyDays.map((day) => {
                                      const schedulesSessions = (schedulesByWeeklyDay[day.key] || []).filter((session) => {
                                        return `${session.startTime}-${session.endTime}` === slotKey;
                                      });

                                      return (
                                        <div key={`${slotKey}-${day.key}`} className="p-2 border-r border-border last:border-r-0 space-y-1">
                                          {schedulesSessions.length === 0 ? null : schedulesSessions.map((session) => {
                                            const studentName = formatSessionStudentLabel(session);
                                            return (
                                              <div
                                                key={session._id}
                                                className={`w-full text-left p-2 rounded text-xs truncate transition-colors hover:opacity-90 ${scheduleEntryBgClass(session.subject?.code)} ${SCHEDULE_ENTRY_TEXT_CLASS}`}
                                              >
                                                <span className="font-medium block">{session.subject?.name ?? "—"}</span>
                                                <span className="opacity-75 block truncate">{studentName}</span>
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
                            const studentName = formatSessionStudentLabel(s);
                            return (
                              <div
                                key={s._id}
                                className={`p-3 rounded-md border border-border transition-colors hover:opacity-90 ${scheduleEntryBgClass(s.subject?.code)} ${SCHEDULE_ENTRY_TEXT_CLASS}`}
                              >
                                <div className="flex items-start gap-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="font-medium">{s.subject?.name ?? "—"}</p>
                                    <p className="text-sm opacity-90">{formatSlotTime(s.startTime)} - {formatSlotTime(s.endTime)}</p>
                                    <p className="text-xs opacity-80">
                                      {s.sessionType === "playgroup" ? "Children" : "Student"}: {studentName}
                                    </p>
                                    {s.sessionType === "playgroup" && Array.isArray(s.students) && s.students.length > 0 && (
                                      <p className="text-xs opacity-80">{s.students.length} / 10 enrolled</p>
                                    )}
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

                {/* ══ STUDENT REMARKS TAB ══ */}
                <TabsContent value="remarks" className="space-y-6">
                  <div className="bg-card rounded-xl border border-border p-6">
                    <h2 className="text-2xl font-bold text-foreground mb-1">Student Remarks</h2>
                    <p className="text-muted-foreground">
                      Publish session-based observations. Replaces grading — a remark is not a grade, ranking, or pass/fail result.
                    </p>
                  </div>

                  <div className="bg-card rounded-xl border border-border">
                    <div className="p-4 border-b border-border">
                      <h3 className="font-bold text-lg text-foreground">
                        {remarkFormMode === "edit" ? "Edit Draft" : "New Remark"}
                      </h3>
                    </div>
                    <div className="p-4">
                      {remarkFormMode === "create" && (
                        <div className="space-y-1 mb-4">
                          <Label>Remark type *</Label>
                          {tutorActiveRemarkPrograms.length === 0 ? (
                            <p className="text-sm text-muted-foreground">You have no active program assignments yet.</p>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {tutorActiveRemarkPrograms.map((p) => (
                                <Button
                                  key={p.id}
                                  type="button"
                                  size="sm"
                                  variant={remarkTypeProgramCode === p.programCode ? "default" : "outline"}
                                  className={remarkTypeProgramCode === p.programCode ? "btn-glow" : ""}
                                  onClick={() => setRemarkTypeProgramCode(p.programCode as RemarkProgramCode)}
                                >
                                  {/* Plain program name - p.label carries a decorative emoji (kept as-is for legacy grade matching). */}
                                  {PROGRAM_LABELS[p.programCode as ActiveProgramCode] ?? p.label.replace(/^\P{L}+/u, "")}
                                </Button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {remarkFormMode === "create" && remarkTypeProgramCode && (
                        <div className="space-y-1 mb-4">
                          <Label>Student *</Label>
                          <Select value={remarkFormStudentId} onValueChange={setRemarkFormStudentId}>
                            <SelectTrigger className="w-full sm:w-80">
                              <SelectValue placeholder={studentsForRemarkType.length === 0 ? "No assigned students for this program" : "Select student"} />
                            </SelectTrigger>
                            <SelectContent>
                              {studentsForRemarkType.map((stu) => (
                                <SelectItem key={stu._id} value={stu._id}>{stu.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {remarkFormMode === "create" && remarkTypeProgramCode && remarkFormStudentId && (
                        <RemarkForm
                          key={`create-${remarkTypeProgramCode}-${remarkFormStudentId}`}
                          studentId={remarkFormStudentId}
                          studentLabel={studentsForRemarkType.find((s) => s._id === remarkFormStudentId)?.name || ""}
                          programCode={remarkTypeProgramCode}
                          templateType={templateTypeForProgramCode(remarkTypeProgramCode)}
                          mode="create"
                          onCancel={() => { setRemarkFormStudentId(""); setRemarkTypeProgramCode(""); }}
                          onSaved={() => { setRemarkFormStudentId(""); setRemarkTypeProgramCode(""); fetchRemarks(); }}
                        />
                      )}

                      {remarkFormMode === "edit" && remarkFormTarget && (
                        <RemarkForm
                          key={`${remarkFormMode}-${remarkFormTarget._id}`}
                          studentId={typeof remarkFormTarget.student === "object" ? remarkFormTarget.student._id : String(remarkFormTarget.student)}
                          studentLabel={remarkFormTarget.student ? `${remarkFormTarget.student.firstName} ${remarkFormTarget.student.lastName}` : ""}
                          programCode={remarkFormTarget.programCode}
                          templateType={remarkFormTarget.templateType}
                          existingRemark={remarkFormTarget}
                          mode={remarkFormMode}
                          onCancel={() => { setRemarkFormMode("create"); setRemarkFormTarget(null); }}
                          onSaved={() => { setRemarkFormMode("create"); setRemarkFormTarget(null); fetchRemarks(); }}
                          onDeleted={() => { setRemarkFormMode("create"); setRemarkFormTarget(null); fetchRemarks(); }}
                        />
                      )}

                      {remarkFormMode === "create" && !remarkTypeProgramCode && tutorActiveRemarkPrograms.length > 0 && (
                        <p className="text-sm text-muted-foreground">Choose a remark type above to continue.</p>
                      )}
                      {remarkFormMode === "create" && remarkTypeProgramCode && !remarkFormStudentId && (
                        <p className="text-sm text-muted-foreground">Select a student above to start a new remark.</p>
                      )}
                    </div>
                  </div>

                  <div className="bg-card rounded-xl border border-border">
                    <div className="p-4 border-b border-border flex items-center justify-between gap-4 flex-wrap">
                      <h3 className="font-bold text-lg text-foreground">Remark History</h3>
                      <Select value={remarkFilterStudentId} onValueChange={setRemarkFilterStudentId}>
                        <SelectTrigger className="w-full sm:w-[200px]">
                          <SelectValue placeholder="All students" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ALL_STUDENTS_VALUE}>All students</SelectItem>
                          {tutorAssignedStudentsList.map((stu) => (
                            <SelectItem key={stu._id} value={stu._id}>{stu.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="p-4">
                      {remarksLoading ? (
                        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
                      ) : remarks.length === 0 ? (
                        <p className="text-center text-muted-foreground py-6">No remarks yet.</p>
                      ) : (
                        <div className="space-y-2">
                          {remarks.map((r) => (
                            <div key={r._id} className="rounded-md border border-border p-3 flex items-start justify-between gap-3 flex-wrap">
                              <div>
                                <p className="text-sm font-medium text-foreground">
                                  {r.student ? `${r.student.firstName} ${r.student.lastName}` : "—"}{" "}
                                  <span
                                    className={`ml-1 rounded-full px-2 py-0.5 text-[11px] ${
                                      r.status === "published" ? "bg-success/10 text-success" : r.status === "pending_admin_review" ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground"
                                    }`}
                                  >
                                    {r.status === "published" ? (r.isCurrentVersion ? "Published" : "Superseded") : r.status === "pending_admin_review" ? "Pending Admin Review" : "Draft"}
                                  </span>
                                </p>
                                <p className="text-xs text-muted-foreground">{new Date(r.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p>
                                {r.status === "draft" && r.rejectionReason && (
                                  <p className="text-xs text-destructive mt-1">Rejected: {r.rejectionReason}</p>
                                )}
                              </div>
                              <div className="flex gap-2">
                                <Button type="button" size="sm" variant="outline" onClick={() => setViewingRemark(r)}>
                                  <Eye className="h-3.5 w-3.5 mr-1.5" />
                                  View
                                </Button>
                                {r.status === "draft" && (
                                  <Button type="button" size="sm" variant="outline" onClick={() => { setRemarkFormTarget(r); setRemarkFormMode("edit"); }}>
                                    Continue editing
                                  </Button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </TabsContent>

                {/* ══ ANNOUNCEMENTS TAB ══ */}
                <TabsContent value="announcements" className="space-y-6">
                  <div className="bg-card rounded-xl p-6 border border-border">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-display font-bold text-lg text-foreground">Announcements</h3>
                      <Button onClick={openCreateAnnouncement}>
                        <Plus className="h-4 w-4 mr-2" />
                        Post announcement
                      </Button>
                    </div>
                    <p className="text-sm text-muted-foreground mb-4">Click any announcement card to read the full message.</p>
                    {announcementsLoading ? (
                      <div className="flex justify-center py-12">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                      </div>
                    ) : announcements.length === 0 ? (
                      <p className="py-8 text-center text-muted-foreground">No announcements yet. Post one to notify your students.</p>
                    ) : (
                      <div className="space-y-4">
                        {announcements.map((a) => {
                          const statusColor = a.status === "approved" ? "bg-success/10 text-success" : a.status === "rejected" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning";
                          const categoryLabel = { sick_leave: "Sick Leave", exam: "Exam", quiz: "Quiz", exam_quiz: "Exam / Quiz", materials: "Materials to Bring", reschedule: "Reschedule", reminder: "Reminder", general: "General" }[a.category] || a.category;
                          const targetStr = Array.isArray(a.targetStudentIds) && a.targetStudentIds.length
                            ? (a.targetStudentIds as { firstName?: string; lastName?: string }[]).map((s) => [s.firstName, s.lastName].filter(Boolean).join(" ")).join(", ")
                            : "—";
                          const isOwnTutorAnnouncement = a.authorRole === "tutor";
                          return (
                            <div
                              key={a._id}
                              role="button"
                              tabIndex={0}
                              onClick={() => openAnnouncementDetails(a)}
                              onKeyDown={(event) => handleAnnouncementKeyDown(event, a)}
                              className="p-4 rounded-lg border border-border bg-muted/30 cursor-pointer transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${statusColor}`}>{a.status}</span>
                                  <span className="text-xs text-muted-foreground px-2 py-0.5 rounded bg-muted">{categoryLabel}</span>
                                </div>
                                {isOwnTutorAnnouncement && (
                                  <div className="flex gap-2 flex-wrap">
                                    <Button size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); openEditAnnouncement(a); }}>
                                      <Pencil className="h-4 w-4 mr-1" /> Edit
                                    </Button>
                                    <Button size="sm" variant="outline" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={(event) => { event.stopPropagation(); handleDeleteAnnouncement(a); }}>
                                      <Trash2 className="h-4 w-4 mr-1" /> Delete
                                    </Button>
                                  </div>
                                )}
                              </div>
                              <h4 className="font-semibold text-foreground">{a.title}</h4>
                              <p className="text-sm text-muted-foreground whitespace-pre-wrap mt-1">{a.body}</p>
                              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
                                <span>To: {targetStr}</span>
                                {a.scheduledDate && <span>When: {new Date(a.scheduledDate).toLocaleDateString("en-US", { dateStyle: "medium" })}</span>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* ══ ACTIVITY TAB ══ */}
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

      {/* ── Post announcement dialog ── */}
      <Dialog open={announcementFormOpen} onOpenChange={setAnnouncementFormOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{editingAnnouncementId ? "Edit announcement" : "Post announcement"}</DialogTitle>
            <DialogDescription>{editingAnnouncementId ? "Update your announcement. Edited tutor announcements will go back to pending so admin can review the new version." : "Select a type to quick-fill, or write your own."}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4 overflow-y-auto pr-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!announcementForm.title.trim() || !announcementForm.body.trim()) {
                toast.error("Title and message are required.");
                return;
              }
              if (announcementForm.targetStudentIds.length === 0) {
                toast.error("Select at least one student.");
                return;
              }
              setAnnouncementSubmitting(true);
              const payload = {
                title: announcementForm.title.trim(),
                body: announcementForm.body.trim(),
                category: announcementForm.category,
                targetStudentIds: announcementForm.targetStudentIds,
                scheduledDate: announcementForm.scheduledDate || undefined,
              };
              const request = editingAnnouncementId
                ? announcementService.update(editingAnnouncementId, payload)
                : announcementService.create({
                    ...payload,
                    targetType: "specific_students",
                  });
              request
                .then((res) => {
                  if (res.data?.success) {
                    toast.success(editingAnnouncementId ? "Announcement updated and sent back for admin approval." : "Announcement submitted. It will be visible to students after admin approval.");
                    setAnnouncementFormOpen(false);
                    setEditingAnnouncementId(null);
                    setAnnouncementForm({ title: "", body: "", category: "general", targetStudentIds: [], scheduledDate: "" });
                    fetchAnnouncements();
                  } else {
                    toast.error(res.data?.message || "Failed to post.");
                  }
                })
                .catch((err) => {
                  toast.error(err?.response?.data?.message || "Failed to post announcement.");
                })
                .finally(() => setAnnouncementSubmitting(false));
            }}
          >
            <div className="grid gap-2">
              <Label>Quick select</Label>
              <div className="flex flex-wrap gap-2">
                {[
                  { title: "Sick leave", body: "I will not be available for class. Sessions will be rescheduled. Sorry for the inconvenience.", category: "sick_leave" as const },
                  { title: "Upcoming exam", body: "Please prepare for the exam. Review your notes and materials. Good luck!", category: "exam" as const },
                  { title: "Upcoming quiz", body: "A short quiz will be given next session. Please review the topics we covered.", category: "quiz" as const },
                  { title: "Materials to bring", body: "Please bring the following to our next session: notebook, textbook, calculator (if applicable).", category: "materials" as const },
                  { title: "Class rescheduled", body: "Our class has been rescheduled. Check your schedule for the new date and time.", category: "reschedule" as const },
                  { title: "Homework reminder", body: "Reminder: Complete the assigned homework before our next session.", category: "reminder" as const },
                ].map((opt) => (
                  <Button key={opt.category} type="button" variant="outline" size="sm" onClick={() => setAnnouncementForm((f) => ({ ...f, title: opt.title, body: opt.body, category: opt.category }))}>
                    {opt.title}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Title *</Label>
              <Input
                value={announcementForm.title}
                onChange={(e) => setAnnouncementForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Sick leave tomorrow"
                maxLength={200}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-2">
                <Label>Category</Label>
                <Select value={announcementForm.category} onValueChange={(v) => setAnnouncementForm((f) => ({ ...f, category: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sick_leave">Sick leave</SelectItem>
                    <SelectItem value="exam">Exam</SelectItem>
                    <SelectItem value="quiz">Quiz</SelectItem>
                    <SelectItem value="materials">Materials to bring</SelectItem>
                    <SelectItem value="reschedule">Class reschedule</SelectItem>
                    <SelectItem value="reminder">Reminder</SelectItem>
                    <SelectItem value="general">General</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Date when it happens</Label>
                <Input
                  type="date"
                  min={todayStr}
                  value={announcementForm.scheduledDate}
                  onChange={(e) => {
                    const v = e.target.value;
                    // A forward-looking announcement can't happen in the past — `min` blocks the
                    // native picker's own calendar; this also rejects a hand-typed past date.
                    if (v && v < todayStr) return;
                    setAnnouncementForm((f) => ({ ...f, scheduledDate: v }));
                  }}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Message *</Label>
              <Textarea
                value={announcementForm.body}
                onChange={(e) => setAnnouncementForm((f) => ({ ...f, body: e.target.value }))}
                placeholder="Write your announcement..."
                rows={4}
                className="resize-none"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label>Notify these students *</Label>
              <p className="text-xs text-muted-foreground">Select students you teach. They will receive an email when admin approves.</p>
              <ScrollArea className="h-40 rounded-md border border-border p-2">
                {announcementStudents.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">Loading students...</p>
                ) : (
                  <div className="space-y-2">
                    {announcementStudents.map((s) => (
                      <div key={s._id} className="flex items-center space-x-2">
                        <Checkbox
                          id={`ann-stu-${s._id}`}
                          checked={announcementForm.targetStudentIds.includes(s._id)}
                          onCheckedChange={(checked) => {
                            setAnnouncementForm((f) => ({
                              ...f,
                              targetStudentIds: checked
                                ? [...f.targetStudentIds, s._id]
                                : f.targetStudentIds.filter((id) => id !== s._id),
                            }));
                          }}
                        />
                        <label htmlFor={`ann-stu-${s._id}`} className="text-sm font-medium cursor-pointer">{s.name}</label>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setAnnouncementFormOpen(false); setEditingAnnouncementId(null); }}>Cancel</Button>
              <Button type="submit" disabled={announcementSubmitting}>
                {announcementSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {editingAnnouncementId ? "Save changes" : "Submit for approval"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Attendance: Present / Absent — for today and past dates */}
      <Dialog open={!!attendanceDialogSession} onOpenChange={(open) => !open && setAttendanceDialogSession(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Mark attendance</DialogTitle>
            <DialogDescription>
              {attendanceDialogSession && (
                <>
                  <span className="font-medium text-foreground">{attendanceDialogSession.studentName}</span>
                  <span className="text-muted-foreground"> · {attendanceDialogSession.subjectName}</span>
                  <span className="block text-xs text-muted-foreground mt-1">
                    Session date: {attendanceDialogSession.dateStr}
                  </span>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {attendanceDialogSession && (
            <div className="flex gap-2 pt-2">
              <Button
                variant={attendanceDialogSession.attendanceStatus === "present" ? "default" : "outline"}
                className="flex-1 gap-2"
                onClick={() =>
                  handleMarkAttendance(
                    attendanceDialogSession._id,
                    attendanceDialogSession.dateStr,
                    "present"
                  )
                }
                disabled={attendanceMarking}
              >
                {attendanceMarking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Present
              </Button>
              <Button
                variant={attendanceDialogSession.attendanceStatus === "absent" ? "destructive" : "outline"}
                className="flex-1 gap-2"
                onClick={() =>
                  handleMarkAttendance(
                    attendanceDialogSession._id,
                    attendanceDialogSession.dateStr,
                    "absent"
                  )
                }
                disabled={attendanceMarking}
              >
                {attendanceMarking ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                Absent
              </Button>
            </div>
          )}
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
                  <span className={`px-2 py-0.5 rounded font-medium ${selectedAnnouncement.status === "approved" ? "bg-success/10 text-success" : selectedAnnouncement.status === "rejected" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning"}`}>{selectedAnnouncement.status}</span>
                  <span className="px-2 py-0.5 rounded bg-muted text-muted-foreground">{announcementCategoryLabel(selectedAnnouncement.category)}</span>
                </div>
                <p className="text-sm leading-7 text-foreground whitespace-pre-wrap">{selectedAnnouncement.body}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span>To: {Array.isArray(selectedAnnouncement.targetStudentIds) && selectedAnnouncement.targetStudentIds.length ? (selectedAnnouncement.targetStudentIds as { firstName?: string; lastName?: string }[]).map((s) => [s.firstName, s.lastName].filter(Boolean).join(" ")).join(", ") : "—"}</span>
                  {selectedAnnouncement.scheduledDate && <span>When: {new Date(selectedAnnouncement.scheduledDate).toLocaleDateString("en-US", { dateStyle: "medium" })}</span>}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedAssessmentEnrollment} onOpenChange={(open) => { if (!open) setSelectedAssessmentEnrollment(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          {selectedAssessmentEnrollment && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {[selectedAssessmentEnrollment.studentSnapshot?.firstName, selectedAssessmentEnrollment.studentSnapshot?.middleName, selectedAssessmentEnrollment.studentSnapshot?.lastName].filter(Boolean).join(" ") || "Student"}
                </DialogTitle>
                <DialogDescription>
                  Academic Tutorial · Student ID {displayStudentId(selectedAssessmentEnrollment)}
                </DialogDescription>
              </DialogHeader>
              <EnrollmentAssessmentView assessment={selectedAssessmentEnrollment.preEnrollmentAssessment} />
            </>
          )}
        </DialogContent>
      </Dialog>

      <RemarkDetailDialog remark={viewingRemark} onClose={() => setViewingRemark(null)} />
    </DashboardLayout>
  );
}