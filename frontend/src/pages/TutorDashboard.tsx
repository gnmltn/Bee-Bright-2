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
  Download,
  Mail,
  Video,
  Loader2,
  Link as LinkIcon,
  Image as ImageIcon,
  ExternalLink,
  Trash2,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
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
import { UserAvatar } from "@/components/UserAvatar";
import {
  scheduleService,
  materialService,
  gradeService,
  announcementService,
  auditLogService,
  uploadsBaseUrl,
  type LearningMaterialItem,
  type GradeItem,
  type AnnouncementItem,
  type AuditLogItem,
} from "@/services/api";
import { PROGRAM_CATEGORIES } from "@/constants/programs";
import { AITab } from "@/components/ai/AITab";
import { AttendanceTab } from "@/components/tutor/AttendanceTab";


/** Infer material type from file extension for backend */
function inferMaterialTypeFromFile(file: File): string {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".pdf")) return "pdf";
  if (/\.(mp4|webm|mov|avi|mkv)$/.test(name)) return "video";
  if (/\.(jpg|jpeg|png|gif|webp|svg)$/.test(name)) return "image";
  if (/\.(doc|docx|xls|xlsx|txt|csv)$/.test(name)) return "document";
  return "other";
}

const CATEGORIES = [
  "Lecture Notes",
  "Video Lecture",
  "Practice & Exercises",
  "Reference",
  "Reading",
  "Slides",
  "Other",
];

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

  if (text.includes("toddler") || text.includes("playgroup")) return "toddlers_playgroup";
  if (
    text.includes("pre kindergarten") ||
    text.includes("prek") ||
    text.includes("pre k")
  ) return "prek_readiness";
  if (text.includes("kindergarten") || text.includes("kinder")) return "kindergarten_readiness";
  if (
    text.includes("sped") ||
    text.includes("special education") ||
    text.includes("special ed") ||
    text.includes("iep")
  ) return "sped_tutorial";
  if (
    text.includes("exam") ||
    text.includes("review") ||
    text.includes("entrance") ||
    text.includes("prep")
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
      student?: {
        _id: string;
        firstName: string;
        lastName: string;
        middleName?: string;
        email?: string;
        gradeLevel?: string;
        phone?: string;
      };
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
    if (!location.hash || location.hash === "#students" || location.hash === "#announcements") {
      fetchAnnouncements();
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
      if (!s.student || !s.subject) return;
      const key = `${s.student._id}-${s.subject._id}`;
      const name = [s.student.firstName, s.student.middleName, s.student.lastName]
        .filter(Boolean)
        .join(" ");
      const existing = map.get(key);
      if (existing) {
        existing.sessionCount += 1;
        existing.schedule += `; ${new Date(s.date).toLocaleDateString("en-US", {
          weekday: "short",
        })} ${formatTime12h(s.startTime)}`;
      } else {
        map.set(key, {
          name,
          grade: s.student.gradeLevel ?? "—",
          subject: s.subject.name,
          schedule: `${new Date(s.date).toLocaleDateString("en-US", {
            weekday: "short",
          })} ${formatTime12h(s.startTime)}`,
          email: s.student.email ?? "",
          phone: s.student.phone ?? "",
          sessionCount: 1,
          profileImage: (s.student as { profileImage?: string }).profileImage,
        });
      }
    });
    return Array.from(map.values());
  }, [sessions]);

  // ─── Materials state ──────────────────────────────────────────────────────────
  const [materials, setMaterials] = useState<LearningMaterialItem[]>([]);
  const [materialsLoading, setMaterialsLoading] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formCategory, setFormCategory] = useState("Lecture Notes");
  const [formProgramCategoryId, setFormProgramCategoryId] = useState("");
  const [formProgramSubjectItem, setFormProgramSubjectItem] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formFile, setFormFile] = useState<File | null>(null);
  const [formAssignedStudentIds, setFormAssignedStudentIds] = useState<string[]>([]);
  const [formInputMode, setFormInputMode] = useState<"url" | "file">("file");

  // ─── Grades state ─────────────────────────────────────────────────────────────
  const [grades, setGrades] = useState<GradeItem[]>([]);
  const [gradesLoading, setGradesLoading] = useState(false);
  const [gradeFormStudentId, setGradeFormStudentId] = useState("");
  const [gradeFormProgramCategoryId, setGradeFormProgramCategoryId] = useState("");
  const [gradeFormSubjectItem, setGradeFormSubjectItem] = useState("");
  const [gradeFormScore, setGradeFormScore] = useState("");
  const [gradeFormMaxScore, setGradeFormMaxScore] = useState("100");
  const [gradeFormPeriod, setGradeFormPeriod] = useState("");
  const [gradeFormRemarks, setGradeFormRemarks] = useState("");
  // sentinel instead of "" — Radix SelectItem crashes on value=""
  const [gradeFilterStudentId, setGradeFilterStudentId] = useState(ALL_STUDENTS_VALUE);
  const [gradeSubmitting, setGradeSubmitting] = useState(false);

  // ─── Inline edit state for grade history rows ─────────────────────────────────
  // editingGradeId: which row is currently being edited (null = none)
  // editFields: the live field values for the row being edited
  const [editingGradeId, setEditingGradeId] = useState<string | null>(null);
  const [editScore, setEditScore] = useState("");
  const [editMaxScore, setEditMaxScore] = useState("");
  const [editPeriod, setEditPeriod] = useState("");
  const [editRemarks, setEditRemarks] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // Program options for materials (same structure as grading)
  const materialProgramOptions = PROGRAM_CATEGORIES;

  // Map programCategory id -> subject names used in backend Subject catalog / schedules
  const MATERIAL_PROGRAM_SUBJECT_NAME_MAP: Record<string, string[]> = {
    toddlers_playgroup: ["Toddlers Playgroup"],
    prek_readiness: ["Pre-Kindergarten Readiness Program"],
    kindergarten_readiness: ["Kindergarten Readiness Program"],
    academic_tutorial: ["Academic Tutorial"],
    sped_tutorial: ["SPED Tutorial"],
    exam_prep: ["Examination Preparation"],
  };

  const materialProgramSubjectItems = useMemo(() => {
    if (!formProgramCategoryId) return [];
    const prog = PROGRAM_CATEGORIES.find((p) => p.id === formProgramCategoryId);
    return prog?.subjectItems ?? [];
  }, [formProgramCategoryId]);

  // ─── Unique students this tutor teaches ──────────────────────────────────────
  const tutorAssignedStudentsList = useMemo(() => {
    const seen = new Set<string>();
    const list: { _id: string; name: string }[] = [];
    sessions.forEach((s) => {
      if (!s.student) return;
      const id = s.student._id != null ? String(s.student._id) : "";
      if (!id || seen.has(id)) return;
      seen.add(id);
      list.push({
        _id: id,
        name: [s.student.firstName, s.student.middleName, s.student.lastName]
          .filter(Boolean)
          .join(" "),
      });
    });
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions]);

  // ─── Students for selected program (material assignment) ─────────────────────
  // Only students that this tutor actually teaches in the chosen program.
  const studentsForSelectedPrograms = useMemo(() => {
    if (!formProgramCategoryId) return [];
    const subjectNames = MATERIAL_PROGRAM_SUBJECT_NAME_MAP[formProgramCategoryId] || [];
    if (subjectNames.length === 0) return [];
    const subjectNamesLower = subjectNames.map((n) => n.toLowerCase());

    const seen = new Set<string>();
    const list: { _id: string; name: string }[] = [];
    sessions.forEach((s) => {
      if (!s.student || !s.subject || !s.subject.name) return;
      const subjNameLower = s.subject.name.toLowerCase();
      const matchesProgram = subjectNamesLower.some((needle) =>
        subjNameLower.includes(needle)
      );
      if (!matchesProgram) return;
      const studentId = s.student._id != null ? String(s.student._id) : "";
      if (!studentId || seen.has(studentId)) return;
      seen.add(studentId);
      list.push({
        _id: studentId,
        name: [s.student.firstName, s.student.middleName, s.student.lastName]
          .filter(Boolean)
          .join(" "),
      });
    });
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [formProgramCategoryId, sessions]);

  // ─── Program categories filtered to the selected student ─────────────────────
  // Strict matching: show only categories inferred from this tutor-student
  // schedule subject names. No fallback to all categories.
  const programCategoriesForSelectedStudent = useMemo(() => {
    if (!gradeFormStudentId) return [];

    const categoryIds = new Set<string>();
    sessions.forEach((s) => {
      if (!s.student || !s.subject) return;
      if (String(s.student._id) !== gradeFormStudentId) return;
      const inferred = inferProgramCategoryIdFromSubjectName(s.subject.name || "");
      if (inferred) categoryIds.add(inferred);
    });

    return PROGRAM_CATEGORIES.filter((prog) => categoryIds.has(prog.id));
  }, [gradeFormStudentId, sessions]);

  useEffect(() => {
    if (!gradeFormProgramCategoryId) return;
    const stillAllowed = programCategoriesForSelectedStudent.some(
      (p) => p.id === gradeFormProgramCategoryId
    );
    if (!stillAllowed) {
      setGradeFormProgramCategoryId("");
      setGradeFormSubjectItem("");
    }
  }, [gradeFormProgramCategoryId, programCategoriesForSelectedStudent]);


  const gradeSubjectItems: string[] = useMemo(() => {
    if (!gradeFormProgramCategoryId) return [];

    const allItems =
      PROGRAM_CATEGORIES.find((p) => p.id === gradeFormProgramCategoryId)
        ?.subjectItems ?? [];

    if (!gradeFormStudentId) return allItems;

    const prog = PROGRAM_CATEGORIES.find((p) => p.id === gradeFormProgramCategoryId);
    if (!prog) return allItems;

    // Collect subjectItems already graded for this student + program (any period)
    const gradedItems = new Set<string>();
    grades.forEach((g) => {
      if (!g.student) return;
      if (String(g.student._id) !== gradeFormStudentId) return;
      if (g.programCategory !== prog.label) return;
      gradedItems.add(g.subjectItem);
    });

    return allItems.filter((item) => !gradedItems.has(item));
  }, [gradeFormProgramCategoryId, gradeFormStudentId, grades]);

  // ─── Inline edit handlers ─────────────────────────────────────────────────────
  const startEditGrade = (g: GradeItem) => {
    setEditingGradeId(g._id);
    setEditScore(String(g.score));
    setEditMaxScore(String(g.maxScore));
    setEditPeriod(g.period);
    setEditRemarks(g.remarks ?? "");
  };

  const cancelEditGrade = () => {
    setEditingGradeId(null);
    setEditScore("");
    setEditMaxScore("");
    setEditPeriod("");
    setEditRemarks("");
  };

  const saveEditGrade = (id: string) => {
    const scoreNum = Number(editScore);
    const maxNum = Number(editMaxScore);
    if (Number.isNaN(scoreNum) || scoreNum < 0) {
      toast.error("Enter a valid score (0 or higher).");
      return;
    }
    if (Number.isNaN(maxNum) || maxNum < 1) {
      toast.error("Max score must be at least 1.");
      return;
    }
    if (scoreNum > maxNum) {
      toast.error("Score cannot exceed max score.");
      return;
    }
    if (!editPeriod.trim()) {
      toast.error("Period is required.");
      return;
    }
    setEditSaving(true);
    gradeService
      .updateGrade(id, {
        score: scoreNum,
        maxScore: maxNum,
        period: editPeriod.trim(),
        remarks: editRemarks.trim() || undefined,
      })
      .then((res) => {
        if (res.data?.success) {
          toast.success("Grade updated.");
          cancelEditGrade();
          fetchGrades();
        } else {
          toast.error("Failed to update grade.");
        }
      })
      .catch((err) =>
        toast.error(err.response?.data?.message || "Failed to update grade.")
      )
      .finally(() => setEditSaving(false));
  };

  // ─── Data fetchers ────────────────────────────────────────────────────────────
  const fetchMaterials = () => {
    setMaterialsLoading(true);
    materialService
      .getMyMaterials()
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.materials)) {
          setMaterials(res.data.materials);
        } else {
          setMaterials([]);
        }
      })
      .catch(() => setMaterials([]))
      .finally(() => setMaterialsLoading(false));
  };

  useEffect(() => {
    if (user?.role === "tutor") fetchMaterials();
  }, [user?.role]);

  const fetchGrades = () => {
    setGradesLoading(true);
    const studentIdParam =
      gradeFilterStudentId === ALL_STUDENTS_VALUE ? undefined : gradeFilterStudentId;
    gradeService
      .getGradesAsTutor(studentIdParam)
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.grades)) {
          setGrades(res.data.grades);
        } else {
          setGrades([]);
        }
      })
      .catch(() => setGrades([]))
      .finally(() => setGradesLoading(false));
  };

  useEffect(() => {
    if (user?.role === "tutor") fetchGrades();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.role, gradeFilterStudentId]);

  useEffect(() => {
    if (user?.role === "tutor" && location.hash === "#grades") {
      fetchGrades();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash, user?.role]);

  // ─── Grade handlers ───────────────────────────────────────────────────────────
  const handleAddGrade = (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !gradeFormStudentId ||
      !gradeFormProgramCategoryId ||
      !gradeFormSubjectItem ||
      !gradeFormPeriod.trim() ||
      !gradeFormScore.trim()
    ) {
      toast.error("Please fill Student, Program, Subject, Period, and Score.");
      return;
    }
    const prog = PROGRAM_CATEGORIES.find((p) => p.id === gradeFormProgramCategoryId);
    if (!prog) { toast.error("Invalid program selected."); return; }
    const isAllowedCategory = programCategoriesForSelectedStudent.some(
      (p) => p.id === gradeFormProgramCategoryId
    );
    if (!isAllowedCategory) {
      toast.error("Selected program does not match this student's assigned program.");
      return;
    }
    if (!gradeSubjectItems.includes(gradeFormSubjectItem)) {
      toast.error("Selected subject does not match the chosen program.");
      return;
    }
    const scoreNum = Number(gradeFormScore);
    const maxNum = gradeFormMaxScore ? Number(gradeFormMaxScore) : 100;
    if (Number.isNaN(scoreNum) || scoreNum < 0) {
      toast.error("Enter a valid score (0 or higher).");
      return;
    }
    if (Number.isNaN(maxNum) || maxNum < 1 || scoreNum > maxNum) {
      toast.error("Enter a valid max score and ensure score ≤ max score.");
      return;
    }
    setGradeSubmitting(true);
    gradeService
      .addGrade({
        studentId: gradeFormStudentId,
        programCategory: prog.label,
        subjectItem: gradeFormSubjectItem,
        score: scoreNum,
        maxScore: maxNum,
        period: gradeFormPeriod.trim(),
        remarks: gradeFormRemarks.trim() || undefined,
      })
      .then((res) => {
        if (res.data?.success) {
          toast.success("Grade recorded.");
          setGradeFormScore("");
          setGradeFormMaxScore("100");
          setGradeFormPeriod("");
          setGradeFormRemarks("");
          fetchGrades();
        } else {
          toast.error((res.data as any)?.message || "Failed to add grade.");
        }
      })
      .catch((err) =>
        toast.error(err.response?.data?.message || "Failed to add grade.")
      )
      .finally(() => setGradeSubmitting(false));
  };

  const handleDeleteGrade = (id: string) => {
    if (!confirm("Delete this grade entry?")) return;
    gradeService
      .deleteGrade(id)
      .then(() => { toast.success("Grade deleted."); fetchGrades(); })
      .catch((err) => toast.error(err.response?.data?.message || "Delete failed."));
  };

  // ─── Material upload helpers ──────────────────────────────────────────────────
  // Keep assigned student IDs in sync with currently available students
  // for the selected program.
  useEffect(() => {
    if (!formProgramCategoryId) {
      setFormAssignedStudentIds((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const idSet = new Set(studentsForSelectedPrograms.map((s) => String(s._id)));
    setFormAssignedStudentIds((prev) => {
      const next = prev.filter((id) => idSet.has(String(id)));
      return next.length === prev.length && next.every((id, i) => prev[i] === id)
        ? prev
        : next;
    });
  }, [formProgramCategoryId, studentsForSelectedPrograms.length]);

  const openUploadDialog = () => {
    setFormTitle("");
    setFormDescription("");
    setFormCategory("Lecture Notes");
    setFormProgramCategoryId("");
    setFormProgramSubjectItem("");
    setFormInputMode("file");
    setFormUrl("");
    setFormFile(null);
    setFormAssignedStudentIds([]);
    setUploadDialogOpen(true);
  };

  const handleUploadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formTitle.trim()) { toast.error("Title is required."); return; }
    if (!formCategory.trim()) { toast.error("Category is required."); return; }
    if (!formProgramCategoryId) {
      toast.error("Select a program for this material.");
      return;
    }
    if (!formProgramSubjectItem) {
      toast.error("Select a subject/topic for this program.");
      return;
    }
    const prog = PROGRAM_CATEGORIES.find((p) => p.id === formProgramCategoryId);
    if (!prog) {
      toast.error("Invalid program selected for this material.");
      return;
    }
    const isWebLink = formInputMode === "url";
    if (isWebLink) {
      if (!formUrl.trim()) { toast.error("URL is required for web link materials."); return; }
    } else {
      if (!formFile) { toast.error("Please select a file to upload."); return; }
    }
    const materialType = isWebLink
      ? "web_link"
      : formFile ? inferMaterialTypeFromFile(formFile) : "other";
    const formData = new FormData();
    formData.append("title", formTitle.trim());
    formData.append("description", formDescription.trim());
    formData.append("materialType", materialType);
    formData.append("category", formCategory.trim());
    // Store the human-readable program label so it matches Grade.programCategory
    formData.append("programCategory", prog.label);
    formData.append("subjectItem", formProgramSubjectItem);
    if (isWebLink) formData.append("url", formUrl.trim());
    if (formFile) formData.append("file", formFile);
    formData.append("assignedStudents", JSON.stringify(formAssignedStudentIds));
    setUploading(true);
    materialService
      .createMaterial(formData)
      .then((res) => {
        if (res.data?.success) {
          toast.success("Material uploaded successfully.");
          setUploadDialogOpen(false);
          fetchMaterials();
        } else {
          toast.error("Upload failed.");
        }
      })
      .catch((err) => toast.error(err.response?.data?.message || "Upload failed."))
      .finally(() => setUploading(false));
  };

  const handleDeleteMaterial = (id: string) => {
    if (!confirm("Delete this material? Students will no longer see it.")) return;
    materialService
      .deleteMaterial(id)
      .then(() => { toast.success("Material deleted."); fetchMaterials(); })
      .catch((err) => toast.error(err.response?.data?.message || "Delete failed."));
  };

  // ─── Derived display data ─────────────────────────────────────────────────────
  const materialsByCategory = useMemo(() => {
    const map = new Map<string, LearningMaterialItem[]>();
    materials.forEach((m) => {
      const cat = m.category || "Other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(m);
    });
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [materials]);

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
          student: s.student
            ? [s.student.firstName, s.student.middleName, s.student.lastName]
                .filter(Boolean).join(" ")
            : "—",
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
          student: session.student
            ? [session.student.firstName, session.student.middleName, session.student.lastName]
                .filter(Boolean)
                .join(" ")
            : "—",
          subject: session.subject?.name ?? "—",
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
      { student: string; subject: string; scheduleId: string; attendanceStatus?: string }[]
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

      const student = s.student
        ? [s.student.firstName, s.student.middleName, s.student.lastName]
            .filter(Boolean).join(" ")
        : "—";

      const cellKey = `${dayOffset}|${slotKey}`;
      const list = map.get(cellKey) || [];
      list.push({
        student,
        subject: s.subject?.name ?? "—",
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
                              className="w-full p-2 bg-primary/10 hover:bg-primary/20 rounded-lg text-center cursor-pointer transition-colors hover:ring-2 hover:ring-primary/30"
                            >
                              <p
                                className="text-xs font-medium text-foreground truncate"
                                title={session.student}
                              >
                                {session.student}
                              </p>
                              <p className="text-[10px] text-muted-foreground">{session.subject}</p>
                              {session.attendanceStatus && session.attendanceStatus !== "unmarked" && (
                                <p className="text-[10px] mt-0.5 text-muted-foreground capitalize">
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
    "#attendance": "attendance",
    "#schedule": "schedule",
    "#materials": "materials",
    "#grades": "grades",
    "#announcements": "announcements",
    "#activity": "activity",
  };
  const activeTab = hashToTab[location.hash] || "students";
  const handleTabChange = (value: string) => {
    navigate(`/tutor-dashboard#${value}`, { replace: true });
  };

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
                  <div className="flex flex-wrap gap-2 justify-center mt-3">
                    {(user?.subjectsTaught ?? []).map((s) => (
                      <span
                        key={typeof s === "object" ? (s as { _id: string })._id : s}
                        className="px-3 py-1 bg-primary/10 text-primary text-xs rounded-full font-medium"
                      >
                        {typeof s === "object" && s && "name" in s
                          ? (s as { name: string }).name
                          : String(s)}
                      </span>
                    ))}
                  </div>
                </div>
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
                      title="Subjects"
                      value={user?.subjectsTaught?.length ?? 0}
                      icon={FileText}
                      variant="warning"
                    />
                  </div>

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
                              <p className="text-sm text-muted-foreground">Student: {session.student}</p>
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
                                  {student.email && (
                                    <a
                                      href={`mailto:${student.email}`}
                                      className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-muted transition-colors"
                                      title={`Email ${student.name}`}
                                    >
                                      <Mail className="h-4 w-4" />
                                    </a>
                                  )}
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
                                    const studentName = s.student ? [s.student.firstName, s.student.lastName].filter(Boolean).join(" ") : "—";
                                    return (
                                      <div
                                        key={s._id}
                                        className="w-full text-left p-2 rounded text-xs truncate transition-colors bg-primary/10 text-primary hover:bg-primary/20"
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
                                            const studentName = session.student ? [session.student.firstName, session.student.lastName].filter(Boolean).join(" ") : "—";
                                            return (
                                              <div
                                                key={session._id}
                                                className="w-full text-left p-2 rounded text-xs truncate transition-colors bg-primary/10 text-primary hover:bg-primary/20"
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
                            const studentName = s.student ? [s.student.firstName, s.student.lastName].filter(Boolean).join(" ") : "—";
                            return (
                              <div
                                key={s._id}
                                className="p-3 rounded-md border border-border transition-colors bg-card hover:bg-muted/40"
                              >
                                <div className="flex items-start gap-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="font-medium text-foreground">{s.subject?.name ?? "—"}</p>
                                    <p className="text-sm text-muted-foreground">{formatSlotTime(s.startTime)} - {formatSlotTime(s.endTime)}</p>
                                    <p className="text-xs text-muted-foreground">Student: {studentName}</p>
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

                {/* ══ GRADES TAB ══ */}
                <TabsContent value="grades" className="space-y-6">
                  <div className="bg-card rounded-xl border border-border p-6">
                    <h2 className="text-2xl font-bold text-foreground mb-1">Grade Management</h2>
                    <p className="text-muted-foreground">
                      Record and track student grades for your programs and subjects.
                    </p>
                  </div>

                  {/* Grade Input Form */}
                  <div className="bg-card rounded-xl border border-border">
                    <div className="p-4 border-b border-border">
                      <h3 className="font-bold text-lg text-foreground">Grade Input Form</h3>
                      <p className="text-sm text-muted-foreground">
                        Select a student first — only programs for their enrolled subjects will appear.
                      </p>
                    </div>
                    <div className="p-4">
                      {tutorAssignedStudentsList.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          You have no assigned students yet. Grades can be added once you
                          have schedules with students.
                        </p>
                      ) : (
                        <form onSubmit={handleAddGrade} className="space-y-4">
                          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-12">

                            {/* Student — resets program + subject on change */}
                            <div className="grid gap-1.5 min-w-0 xl:col-span-3">
                              <Label>Student *</Label>
                              <Select
                                value={gradeFormStudentId}
                                onValueChange={(v) => {
                                  setGradeFormStudentId(v);
                                  setGradeFormProgramCategoryId("");
                                  setGradeFormSubjectItem("");
                                }}
                              >
                                <SelectTrigger className="w-full min-w-0">
                                  <SelectValue placeholder="Select student" />
                                </SelectTrigger>
                                <SelectContent>
                                  {tutorAssignedStudentsList.map((stu) => (
                                    <SelectItem key={stu._id} value={stu._id}>
                                      {stu.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>

                            {/* Program Category — filtered to selected student's subjects */}
                            <div className="grid gap-1.5 min-w-0 xl:col-span-3">
                              <Label>Program Category *</Label>
                              <Select
                                value={gradeFormProgramCategoryId}
                                onValueChange={(v) => {
                                  setGradeFormProgramCategoryId(v);
                                  setGradeFormSubjectItem("");
                                }}
                                disabled={
                                  !gradeFormStudentId ||
                                  programCategoriesForSelectedStudent.length === 0
                                }
                              >
                                <SelectTrigger className="w-full min-w-0">
                                  <SelectValue
                                    placeholder={
                                      !gradeFormStudentId
                                        ? "Select student first"
                                        : programCategoriesForSelectedStudent.length === 0
                                        ? "No assigned program found"
                                        : "Select program"
                                    }
                                  />
                                </SelectTrigger>
                                <SelectContent>
                                  {programCategoriesForSelectedStudent.map((p) => (
                                    <SelectItem key={p.id} value={p.id}>
                                      {p.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>

                            {/* Subject / Skill — disabled until program chosen, filtered to exclude already-graded */}
                            <div className="grid gap-1.5 min-w-0 xl:col-span-3">
                              <Label>Subject / Skill *</Label>
                              <Select
                                value={gradeFormSubjectItem}
                                onValueChange={setGradeFormSubjectItem}
                                disabled={
                                  !gradeFormProgramCategoryId ||
                                  gradeSubjectItems.length === 0
                                }
                              >
                                <SelectTrigger className="w-full min-w-0">
                                  <SelectValue
                                    placeholder={
                                      !gradeFormProgramCategoryId
                                        ? "Select program first"
                                        : gradeSubjectItems.length === 0 &&
                                          gradeFormStudentId
                                        ? "All subjects already graded"
                                        : "Select subject"
                                    }
                                  />
                                </SelectTrigger>
                                <SelectContent>
                                  {gradeSubjectItems.map((item) => (
                                    <SelectItem key={item} value={item}>{item}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>

                            {/* Period */}
                            <div className="grid gap-1.5 min-w-0 xl:col-span-3">
                              <Label>Period (e.g. Q1 2024) *</Label>
                              <Input
                                value={gradeFormPeriod}
                                onChange={(e) => setGradeFormPeriod(e.target.value)}
                                placeholder="Q1 2024"
                              />
                            </div>
                          </div>

                          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-12">
                            <div className="grid gap-1.5 min-w-0 xl:col-span-3">
                              <Label>Score *</Label>
                              <Input
                                type="number" min={0}
                                value={gradeFormScore}
                                onChange={(e) => setGradeFormScore(e.target.value)}
                                placeholder="85"
                              />
                            </div>
                            <div className="grid gap-1.5 min-w-0 xl:col-span-3">
                              <Label>Max Score</Label>
                              <Input
                                type="number" min={1}
                                value={gradeFormMaxScore}
                                onChange={(e) => setGradeFormMaxScore(e.target.value)}
                                placeholder="100"
                              />
                            </div>
                            <div className="grid gap-1.5 min-w-0 md:col-span-2 xl:col-span-6">
                              <Label>Remarks (optional)</Label>
                              <Input
                                value={gradeFormRemarks}
                                onChange={(e) => setGradeFormRemarks(e.target.value)}
                                placeholder="e.g. Good progress"
                              />
                            </div>
                          </div>

                          <Button type="submit" disabled={gradeSubmitting} className="w-full sm:w-auto">
                            {gradeSubmitting ? (
                              <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            ) : null}
                            Record Grade
                          </Button>
                        </form>
                      )}
                    </div>
                  </div>

                  {/* Grade History */}
                  <div className="bg-card rounded-xl border border-border">
                    <div className="p-4 border-b border-border flex items-center justify-between gap-4 flex-wrap">
                      <h3 className="font-bold text-lg text-foreground">Grade History</h3>
                      {/* sentinel value "__all__" — Radix crashes on value="" */}
                      <Select value={gradeFilterStudentId} onValueChange={setGradeFilterStudentId}>
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
                      {gradesLoading ? (
                        <div className="flex justify-center py-12">
                          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                      ) : grades.length === 0 ? (
                        <p className="text-center text-muted-foreground py-6">
                          {tutorAssignedStudentsList.length === 0
                            ? "No assigned students yet."
                            : "No grades recorded yet."}
                        </p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-muted">
                              <tr>
                                <th className="text-left p-3 font-semibold">Student</th>
                                <th className="text-left p-3 font-semibold">Program</th>
                                <th className="text-left p-3 font-semibold">Subject</th>
                                <th className="text-left p-3 font-semibold">Score</th>
                                <th className="text-left p-3 font-semibold">Max</th>
                                <th className="text-left p-3 font-semibold">Period</th>
                                <th className="text-left p-3 font-semibold">Remarks</th>
                                <th className="p-3 text-right font-semibold">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {grades.map((g) => {
                                const isEditing = editingGradeId === g._id;
                                return (
                                  <tr
                                    key={g._id}
                                    className={`transition-colors ${isEditing ? "bg-primary/5" : "hover:bg-muted/50"}`}
                                  >
                                    {/* Student — never editable */}
                                    <td className="p-3 whitespace-nowrap">
                                      {g.student
                                        ? `${g.student.firstName} ${g.student.lastName}`
                                        : "—"}
                                    </td>

                                    {/* Program — never editable */}
                                    <td className="p-3 max-w-[140px]">
                                      <span className="truncate block" title={g.programCategory}>
                                        {g.programCategory}
                                      </span>
                                    </td>

                                    {/* Subject — never editable */}
                                    <td className="p-3 max-w-[160px]">
                                      <span className="truncate block" title={g.subjectItem}>
                                        {g.subjectItem}
                                      </span>
                                    </td>

                                    {/* Score — editable */}
                                    <td className="p-2 font-medium">
                                      {isEditing ? (
                                        <Input
                                          type="number"
                                          min={0}
                                          value={editScore}
                                          onChange={(e) => setEditScore(e.target.value)}
                                          className="w-20 h-8 text-sm"
                                        />
                                      ) : (
                                        <span>
                                          {g.score}
                                          {g.percentage != null && (
                                            <span className="text-muted-foreground ml-1 text-xs">
                                              ({g.percentage}%)
                                            </span>
                                          )}
                                        </span>
                                      )}
                                    </td>

                                    {/* Max Score — editable */}
                                    <td className="p-2">
                                      {isEditing ? (
                                        <Input
                                          type="number"
                                          min={1}
                                          value={editMaxScore}
                                          onChange={(e) => setEditMaxScore(e.target.value)}
                                          className="w-20 h-8 text-sm"
                                        />
                                      ) : (
                                        g.maxScore
                                      )}
                                    </td>

                                    {/* Period — editable */}
                                    <td className="p-2">
                                      {isEditing ? (
                                        <Input
                                          value={editPeriod}
                                          onChange={(e) => setEditPeriod(e.target.value)}
                                          className="w-28 h-8 text-sm"
                                          placeholder="Q1 2024"
                                        />
                                      ) : (
                                        g.period
                                      )}
                                    </td>

                                    {/* Remarks — editable */}
                                    <td className="p-2">
                                      {isEditing ? (
                                        <Input
                                          value={editRemarks}
                                          onChange={(e) => setEditRemarks(e.target.value)}
                                          className="w-36 h-8 text-sm"
                                          placeholder="Remarks"
                                        />
                                      ) : (
                                        <span className="text-muted-foreground">
                                          {g.remarks || "—"}
                                        </span>
                                      )}
                                    </td>

                                    {/* Action buttons */}
                                    <td className="p-2">
                                      <div className="flex items-center justify-end gap-1">
                                        {isEditing ? (
                                          <>
                                            {/* Save */}
                                            <Button
                                              type="button"
                                              size="icon"
                                              variant="ghost"
                                              className="h-7 w-7 text-success hover:text-success hover:bg-success/10"
                                              disabled={editSaving}
                                              onClick={() => saveEditGrade(g._id)}
                                              title="Save changes"
                                            >
                                              {editSaving
                                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                : <Check className="h-3.5 w-3.5" />}
                                            </Button>
                                            {/* Cancel */}
                                            <Button
                                              type="button"
                                              size="icon"
                                              variant="ghost"
                                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                              onClick={cancelEditGrade}
                                              title="Cancel"
                                            >
                                              <X className="h-3.5 w-3.5" />
                                            </Button>
                                          </>
                                        ) : (
                                          <>
                                            {/* Edit */}
                                            <Button
                                              type="button"
                                              size="icon"
                                              variant="ghost"
                                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                              onClick={() => startEditGrade(g)}
                                              title="Edit grade"
                                            >
                                              <Pencil className="h-3.5 w-3.5" />
                                            </Button>
                                            {/* Delete */}
                                            <Button
                                              type="button"
                                              size="icon"
                                              variant="ghost"
                                              className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                              onClick={() => handleDeleteGrade(g._id)}
                                              title="Delete grade"
                                            >
                                              <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                          </>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                </TabsContent>

                {/* ══ MATERIALS TAB ══ */}
                <TabsContent value="materials" className="space-y-6">
                  <div className="bg-card rounded-xl border border-border overflow-hidden">
                    <div className="p-4 border-b border-border flex items-center justify-between">
                      <h3 className="font-display font-bold text-lg text-foreground">Teaching Materials</h3>
                      <Button type="button" size="sm" onClick={openUploadDialog}>
                        <Plus className="h-4 w-4 mr-2" />
                        Upload Now
                      </Button>
                    </div>
                    <div className="divide-y divide-border">
                      {materialsLoading ? (
                        <div className="flex items-center justify-center py-12">
                          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                      ) : materials.length === 0 ? (
                        <p className="p-8 text-center text-muted-foreground">
                          No materials uploaded yet. Use &quot;Upload Now&quot; to add PDFs, videos,
                          web links, or images for your students.
                        </p>
                      ) : (
                        materialsByCategory.map(([category, items]) => (
                          <div key={category} className="p-4">
                            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                              {category}
                            </h4>
                            <div className="space-y-2">
                              {items.map((material) => {
                                const isFile = material.storageType === "file";
                                const href =
                                  isFile && material.filePath
                                    ? `${uploadsBaseUrl}/uploads/${material.filePath}`
                                    : material.url || "#";
                                const icon =
                                  material.materialType === "video" ? (
                                    <Video className="h-5 w-5 text-warning" />
                                  ) : material.materialType === "web_link" ? (
                                    <LinkIcon className="h-5 w-5 text-info" />
                                  ) : material.materialType === "image" ? (
                                    <ImageIcon className="h-5 w-5 text-success" />
                                  ) : (
                                    <FileText className="h-5 w-5 text-info" />
                                  );
                                const assignedNames = (material.assignedStudents || [])
                                  .map((s) =>
                                    [s.firstName, s.middleName, s.lastName].filter(Boolean).join(" ")
                                  )
                                  .join(", ");
                                return (
                                  <div
                                    key={material._id}
                                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                                  >
                                    <div className="flex items-center gap-4 min-w-0">
                                      <div className="h-10 w-10 rounded-lg bg-background border border-border flex items-center justify-center shrink-0">
                                        {icon}
                                      </div>
                                      <div className="min-w-0">
                                        <p className="font-semibold text-foreground truncate">{material.title}</p>
                                        <p className="text-sm text-muted-foreground">
                                          {material.materialType} • {material.subject?.name ?? "—"}
                                          {assignedNames ? ` • For: ${assignedNames}` : ""}
                                        </p>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                      <Button type="button" size="sm" variant="ghost" asChild>
                                        <a href={href} target="_blank" rel="noopener noreferrer">
                                          <Download className="h-4 w-4" />
                                        </a>
                                      </Button>
                                      <Button
                                        type="button" size="sm" variant="ghost"
                                        onClick={() => handleDeleteMaterial(material._id)}
                                      >
                                        <Trash2 className="h-4 w-4 text-destructive" />
                                      </Button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="bg-card rounded-xl p-6 border border-border">
                    <h3 className="font-display font-bold text-lg mb-2 text-foreground">
                      AI Assistant &amp; Recommendations
                    </h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      Recommend materials (slides, practice) to students who need extra support.
                      Chat for quick answers about Bee Bright.
                    </p>
                    <AITab
                      title="AI Assistant"
                      description="Recommend these materials to students who are struggling or want extra practice. Chat for schedule and system help."
                    />
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
                  value={announcementForm.scheduledDate}
                  onChange={(e) => setAnnouncementForm((f) => ({ ...f, scheduledDate: e.target.value }))}
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

      {/* ── Upload material dialog ── */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Upload Learning Material</DialogTitle>
            <DialogDescription>
              Add a PDF, video, web link, image, or document. Choose a category and which
              students can see it.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleUploadSubmit} className="flex flex-col gap-4 overflow-y-auto pr-2">
            <div className="grid gap-2">
              <Label htmlFor="mat-title">Title *</Label>
              <Input
                id="mat-title"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="e.g. Chapter 3 Notes"
                maxLength={200}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mat-desc">Description (optional)</Label>
              <Textarea
                id="mat-desc"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Brief description for students"
                rows={2}
                maxLength={2000}
                className="resize-none"
              />
            </div>
            <div className="grid gap-2">
              <Label>Category *</Label>
              <Select value={formCategory} onValueChange={setFormCategory}>
                <SelectTrigger>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Program (for this material, used in AI & grading) *</Label>
              <Select
                value={formProgramCategoryId}
                onValueChange={(val) => {
                  setFormProgramCategoryId(val);
                  setFormProgramSubjectItem("");
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select program" />
                </SelectTrigger>
                <SelectContent>
                  {materialProgramOptions.map((prog) => (
                    <SelectItem key={prog.id} value={prog.id}>
                      {prog.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {formProgramCategoryId && (
              <div className="grid gap-2">
                <Label>Subject / topic in this program *</Label>
                <Select
                  value={formProgramSubjectItem}
                  onValueChange={setFormProgramSubjectItem}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select subject or topic" />
                  </SelectTrigger>
                  <SelectContent>
                    {materialProgramSubjectItems.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-2">
              <Label>Link or file *</Label>
              <div className="flex gap-2 border border-border rounded-md p-1 bg-muted/30">
                <Button
                  type="button"
                  variant={formInputMode === "file" ? "secondary" : "ghost"}
                  size="sm" className="flex-1"
                  onClick={() => { setFormInputMode("file"); setFormUrl(""); }}
                >
                  Upload file
                </Button>
                <Button
                  type="button"
                  variant={formInputMode === "url" ? "secondary" : "ghost"}
                  size="sm" className="flex-1"
                  onClick={() => { setFormInputMode("url"); setFormFile(null); }}
                >
                  Web link
                </Button>
              </div>
              {formInputMode === "url" ? (
                <Input
                  id="mat-url" type="url"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  placeholder="https://..."
                />
              ) : (
                <div>
                  <Input
                    id="mat-file" type="file"
                    accept=".pdf,.doc,.docx,.xls,.xlsx,.mp4,.webm,.mov,.avi,.jpg,.jpeg,.png,.gif,.webp,.svg,.txt,.csv"
                    onChange={(e) => setFormFile(e.target.files?.[0] ?? null)}
                  />
                  {formFile && (
                    <p className="text-xs text-muted-foreground mt-1">{formFile.name}</p>
                  )}
                </div>
              )}
            </div>
            <div className="grid gap-2">
              <Label>Assign to students * (only students you teach in the selected program)</Label>
              {!formProgramCategoryId ? (
                <p className="text-sm text-muted-foreground">
                  Select a program above to see students enrolled in that program.
                </p>
              ) : studentsForSelectedPrograms.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No students are currently enrolled with you in this program.
                </p>
              ) : (
                <ScrollArea className="h-32 rounded-md border border-border p-2">
                  <div className="flex flex-col gap-2">
                    {studentsForSelectedPrograms.map((stu) => (
                      <label key={stu._id} className="flex items-center gap-2 cursor-pointer">
                        <Checkbox
                          checked={formAssignedStudentIds.includes(stu._id)}
                          onCheckedChange={(checked) => {
                            setFormAssignedStudentIds((prev) =>
                              checked ? [...prev, stu._id] : prev.filter((id) => id !== stu._id)
                            );
                          }}
                        />
                        <span className="text-sm">{stu.name}</span>
                      </label>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={() => setUploadDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={uploading}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Upload Now
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
    </DashboardLayout>
  );
}