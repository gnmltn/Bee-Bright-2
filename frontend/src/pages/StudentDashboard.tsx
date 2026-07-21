import { useEffect, useState, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  BookOpen,
  Calendar,
  Clock,
  CheckCircle,
  Award,
  ChevronLeft,
  ChevronRight,
  Video,
  MessageSquare,
  FileText,
  Loader2,
  Download,
  Link as LinkIcon,
  Image as ImageIcon,
} from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { StatCard } from "@/components/ui/stat-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { UserAvatar } from "@/components/UserAvatar";
import { enrollmentService, scheduleService, materialService, gradeService, announcementService, auditLogService, uploadsBaseUrl, type LearningMaterialItem, type GradeItem, type AnnouncementItem, type AuditLogItem } from "@/services/api";
import { AITab } from "@/components/ai/AITab";

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

function summarizeAnnouncement(body: string) {
  const trimmed = body.trim();
  return trimmed.length > 110 ? `${trimmed.slice(0, 107)}...` : trimmed;
}

export default function StudentDashboard() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [enrollments, setEnrollments] = useState<{ _id: string; selectedSubjects?: { _id: string; name: string }[]; status?: string }[]>([]);
  const [enrollmentsLoading, setEnrollmentsLoading] = useState(true);
  const [schedules, setSchedules] = useState<{
    _id: string;
    date: string;
    startTime: string;
    endTime: string;
    attendanceStatus?: 'unmarked' | 'present' | 'absent';
    subject?: { name: string };
    tutor?: { firstName?: string; lastName?: string; middleName?: string; email?: string };
  }[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(true);
  const [assignedMaterials, setAssignedMaterials] = useState<LearningMaterialItem[]>([]);
  const [assignedMaterialsLoading, setAssignedMaterialsLoading] = useState(false);
  const [progressGrades, setProgressGrades] = useState<GradeItem[]>([]);
  const [progressGradesLoading, setProgressGradesLoading] = useState(false);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [announcementsLoading, setAnnouncementsLoading] = useState(false);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<AnnouncementItem | null>(null);
  const [activityLogs, setActivityLogs] = useState<AuditLogItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [weekStart, setWeekStart] = useState<Date>(() => startOfSchoolWeek(new Date()));

  // ─── Schedule view controls ────────────────────────────────────────────────────
  const [scheduleViewMode, setScheduleViewMode] = useState<"monthly" | "weekly" | "daily">("monthly");
  const [calendarMonth, setCalendarMonth] = useState(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [scheduleDailyDate, setScheduleDailyDate] = useState(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  });
  const [scheduleWeekStart, setScheduleWeekStart] = useState<Date>(() => startOfSchoolWeek(new Date()));

  useEffect(() => {
    setProgressGradesLoading(true);
    gradeService
      .getMyProgress()
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.grades)) {
          setProgressGrades(res.data.grades);
        } else {
          setProgressGrades([]);
        }
      })
      .catch(() => setProgressGrades([]))
      .finally(() => setProgressGradesLoading(false));
  }, []);

  useEffect(() => {
    setAssignedMaterialsLoading(true);
    materialService
      .getAssignedMaterials()
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.materials)) {
          setAssignedMaterials(res.data.materials);
        } else {
          setAssignedMaterials([]);
        }
      })
      .catch(() => setAssignedMaterials([]))
      .finally(() => setAssignedMaterialsLoading(false));
  }, []);

  useEffect(() => {
    enrollmentService
      .getMyEnrollments()
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.enrollments)) {
          setEnrollments(res.data.enrollments);
        } else {
          setEnrollments([]);
        }
      })
      .catch(() => setEnrollments([]))
      .finally(() => setEnrollmentsLoading(false));
  }, []);

  useEffect(() => {
    scheduleService
      .getMyClasses()
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.schedules)) {
          setSchedules(res.data.schedules);
        } else {
          setSchedules([]);
        }
      })
      .catch(() => setSchedules([]))
      .finally(() => setSchedulesLoading(false));
  }, []);

  const fetchAnnouncements = () => {
    setAnnouncementsLoading(true);
    announcementService
      .getForStudent()
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

  useEffect(() => {
    fetchAnnouncements();
  }, []);

  useEffect(() => {
    if (location.hash === "#announcements") fetchAnnouncements();
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

  const enrolledSubjectsList = useMemo(() => {
    const list: { _id: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const en of enrollments) {
      if (en.status !== "active") continue;
      for (const s of en.selectedSubjects || []) {
        const id = (s._id || s).toString();
        if (!seen.has(id)) {
          seen.add(id);
          list.push({ _id: id, name: s.name });
        }
      }
    }
    return list;
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
        const tutorName = s.tutor
          ? [s.tutor.firstName, s.tutor.middleName, s.tutor.lastName].filter(Boolean).join(" ")
          : "—";
        return {
          _id: s._id,
          subject: s.subject?.name ?? "—",
          time: `${formatTime12h(s.startTime)} – ${formatTime12h(s.endTime)}`,
          date: dateLabel,
          tutor: tutorName,
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
    const map = new Map<string, { subject: string; tutor: string }[]>();

    uniqueSchedules.forEach((s) => {
      const sessionDate = new Date(s.date);
      sessionDate.setHours(0, 0, 0, 0);
      const dayOffset = Math.floor((sessionDate.getTime() - weekStart.getTime()) / 86400000);
      if (dayOffset < 0 || dayOffset > 5) return;

      const start = s.startTime || "00:00";
      const end = s.endTime || start;
      const slotKey = `${start}|${end}`;
      slotSet.add(slotKey);

      const tutor = s.tutor
        ? [s.tutor.firstName, s.tutor.middleName, s.tutor.lastName].filter(Boolean).join(" ")
        : "—";
      const cellKey = `${dayOffset}|${slotKey}`;
      const list = map.get(cellKey) || [];
      list.push({ subject: s.subject?.name ?? "—", tutor });
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

  const assignedMaterialsByCategory = useMemo(() => {
    const map = new Map<string, LearningMaterialItem[]>();
    assignedMaterials.forEach((m) => {
      const cat = m.category || "Other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(m);
    });
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [assignedMaterials]);

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
    "#materials": "materials",
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
      materials: "materials",
      announcements: "announcements",
      activity: "activity",
    };
    const nextHash = tabToHash[value] ?? value;
    navigate(nextHash ? `/student-dashboard#${nextHash}` : "/student-dashboard", { replace: true });
  };

  const handleQuickAction = (action: string) => {
    switch (action) {
      case "Contact Tutor": {
        const tutorEmail = schedules.find((s) => s.tutor?.email)?.tutor?.email;
        if (tutorEmail) {
          window.location.href = `mailto:${tutorEmail}`;
        } else {
          toast.info("No tutor email available. Check your schedule for tutor contact.", { description: "Your tutor's email will appear once sessions are assigned." });
        }
        break;
      }
      case "Learning Materials":
        navigate("/student-dashboard#materials", { replace: true });
        break;
      case "View Grades":
        navigate("/student-dashboard#progress", { replace: true });
        break;
      default:
        toast(action);
    }
  };

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
                Student Dashboard
              </h1>
              <p className="text-muted-foreground">Welcome back, {user?.name || "Student"}!</p>
            </div>
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
                    <UserAvatar
                      src={user?.profileImageUrl}
                      fallback={avatarInitials}
                      size={20}
                    />
                  </div>
                  <h3 className="font-display font-bold text-lg text-foreground">
                    {user?.name || "Student"}
                  </h3>
                  <p className="text-sm text-muted-foreground">{user?.email ?? "—"}</p>
                  {user?.phone && (
                    <p className="text-sm text-muted-foreground">Phone: {user.phone}</p>
                  )}
                  <span className="inline-block mt-2 px-3 py-1 bg-primary/10 text-primary text-sm rounded-full font-medium">
                    {user?.gradeLevel ?? "—"}
                  </span>
                </div>
                <div className="mt-6 pt-6 border-t border-border space-y-1">
                  {(user?.guardianName || user?.guardianPhone) && (
                    <>
                      <p className="text-sm text-muted-foreground text-center">Guardian: {user?.guardianName ?? "—"}</p>
                      <p className="text-sm text-muted-foreground text-center">Guardian phone: {user?.guardianPhone ?? "—"}</p>
                    </>
                  )}
                </div>
              </div>

              <div className="bg-card rounded-xl p-4 border border-border space-y-2">
                <h4 className="font-semibold text-sm text-foreground mb-3">Quick Actions</h4>
                {[
                  { label: "Contact Tutor", icon: MessageSquare },
                  { label: "Learning Materials", icon: FileText },
                  { label: "View Grades", icon: Award },
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
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="self-start lg:col-span-3 space-y-6"
            >
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard title="Enrolled Subjects" value={enrollmentsLoading ? "—" : enrolledSubjectsList.length} icon={BookOpen} variant="primary" />
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
                    <div className="p-4 border-b border-border flex items-center justify-between">
                      <h3 className="font-display font-bold text-lg text-foreground">My Subjects</h3>
                      <span className="text-sm text-muted-foreground">{enrollmentsLoading ? "..." : `${enrolledSubjectsList.length} subjects`}</span>
                    </div>
                    <div className="divide-y divide-border">
                      {enrollmentsLoading ? (
                        <div className="flex items-center justify-center py-12">
                          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                      ) : enrolledSubjectsList.length === 0 ? (
                        <p className="p-8 text-center text-muted-foreground">No enrolled subjects yet. Complete enrollment to see your subjects here.</p>
                      ) : (
                        enrolledSubjectsList.map((subject) => (
                          <div key={subject._id} className="p-4 hover:bg-muted/50 transition-colors">
                            <div className="flex items-center gap-4">
                              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                                <BookOpen className="h-5 w-5 text-primary" />
                              </div>
                              <div>
                                <p className="font-semibold text-foreground">{subject.name}</p>
                                <p className="text-sm text-muted-foreground">Enrolled</p>
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
                                    const tutorName = s.tutor ? [s.tutor.firstName, s.tutor.lastName].filter(Boolean).join(" ") : "—";
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
                                            const tutorName = session.tutor ? [session.tutor.firstName, session.tutor.lastName].filter(Boolean).join(" ") : "—";
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
                            const tutorName = s.tutor ? [s.tutor.firstName, s.tutor.lastName].filter(Boolean).join(" ") : "—";
                            return (
                              <div
                                key={s._id}
                                className="p-3 rounded-md border border-border transition-colors bg-card hover:bg-muted/40"
                              >
                                <div className="flex items-start gap-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="font-medium text-foreground">{s.subject?.name ?? "—"}</p>
                                    <p className="text-sm text-muted-foreground">{formatSlotTime(s.startTime)} - {formatSlotTime(s.endTime)}</p>
                                    <p className="text-xs text-muted-foreground">Tutor: {tutorName}</p>
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

                <TabsContent value="materials" className="space-y-6">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/5 via-card to-primary/10 p-6 md:p-8"
                  >
                    <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                    <div className="absolute bottom-0 left-0 w-48 h-48 bg-primary/5 rounded-full translate-y-1/2 -translate-x-1/2" />
                    <div className="relative flex flex-col sm:flex-row sm:items-center gap-4">
                      <div className="h-14 w-14 rounded-2xl bg-primary/15 flex items-center justify-center shrink-0">
                        <FileText className="h-7 w-7 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-display text-xl md:text-2xl font-bold text-foreground">Learning Materials</h3>
                        <p className="text-sm text-muted-foreground mt-1">Materials assigned by your tutor and recommended resources by subject.</p>
                      </div>
                    </div>
                  </motion.div>

                  <div className="rounded-2xl border border-border bg-card overflow-hidden">
                    <div className="p-4 border-b border-border">
                      <h4 className="font-display font-bold text-foreground">Assigned by your tutor</h4>
                      <p className="text-sm text-muted-foreground">PDFs, videos, links, and documents shared with you.</p>
                    </div>
                    {assignedMaterialsLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : assignedMaterials.length === 0 ? (
                      <p className="p-6 text-center text-muted-foreground">No materials assigned yet. Your tutor will add materials here for you.</p>
                    ) : (
                      <div className="divide-y divide-border">
                        {assignedMaterialsByCategory.map(([category, items]) => (
                          <div key={category} className="p-4">
                            <h5 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">{category}</h5>
                            <div className="space-y-2">
                              {items.map((material) => {
                                const isFile = material.storageType === "file";
                                const href = isFile && material.filePath
                                  ? `${uploadsBaseUrl}/uploads/${material.filePath}`
                                  : material.url || "#";
                                const icon = material.materialType === "video" ? <Video className="h-5 w-5 text-warning" /> : material.materialType === "web_link" ? <LinkIcon className="h-5 w-5 text-info" /> : material.materialType === "image" ? <ImageIcon className="h-5 w-5 text-success" /> : <FileText className="h-5 w-5 text-info" />;
                                return (
                                  <a
                                    key={material._id}
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-4 p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors group"
                                  >
                                    <div className="h-10 w-10 rounded-lg bg-background border border-border flex items-center justify-center shrink-0">
                                      {icon}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <p className="font-semibold text-foreground truncate group-hover:text-primary">{material.title}</p>
                                      <p className="text-sm text-muted-foreground">
                                        {material.materialType} {material.subject?.name ? `• ${material.subject.name}` : ""}
                                        {material.description ? ` — ${material.description}` : ""}
                                      </p>
                                    </div>
                                    <Download className="h-4 w-4 text-muted-foreground shrink-0" />
                                  </a>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
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
                        <h3 className="font-display text-xl md:text-2xl font-bold text-foreground">My Progress</h3>
                        <p className="text-sm text-muted-foreground mt-1">Grades and progress from your tutors, by program and subject.</p>
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

                  {progressGradesLoading ? (
                    <div className="flex justify-center py-16">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                  ) : progressGrades.length === 0 ? (
                    <div className="rounded-2xl border border-border bg-card p-12 text-center">
                      <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-4">
                        <Award className="h-8 w-8 text-muted-foreground" />
                      </div>
                      <p className="font-medium text-foreground">No grades yet</p>
                      <p className="text-sm text-muted-foreground mt-1">Your tutors will add grades here as you complete activities and assessments.</p>
                    </div>
                  ) : (
                    <>
                      {overallProgressPercent != null && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className="rounded-2xl border border-border bg-card p-6"
                        >
                          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Overall average</h4>
                          <div className="flex items-center gap-4">
                            <div className="relative h-24 w-24 rounded-full bg-muted flex items-center justify-center">
                              <svg className="h-24 w-24 -rotate-90" viewBox="0 0 36 36">
                                <path
                                  className="text-muted stroke-current"
                                  strokeWidth="3"
                                  fill="none"
                                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                />
                                <path
                                  className="text-primary stroke-current transition-all duration-700"
                                  strokeWidth="3"
                                  strokeDasharray={`${overallProgressPercent}, 100`}
                                  fill="none"
                                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                />
                              </svg>
                              <span className="absolute text-2xl font-bold text-foreground">{overallProgressPercent}%</span>
                            </div>
                            <div>
                              <p className="text-sm text-muted-foreground">{progressGrades.length} grade(s) recorded</p>
                              <p className="text-xs text-muted-foreground mt-1">Across your programs and subjects</p>
                            </div>
                          </div>
                        </motion.div>
                      )}

                      <div className="space-y-6">
                        {gradesByProgram.map(([programLabel, items], idx) => {
                          const avg = items.length > 0
                            ? Math.round(
                                items.reduce((s, g) => s + (g.percentage ?? Math.round((g.score / g.maxScore) * 100)), 0) / items.length
                              )
                            : 0;
                          const headerBg = avg >= 90 ? "bg-success/10" : avg >= 75 ? "bg-primary/10" : avg >= 60 ? "bg-warning/10" : "bg-destructive/10";
                          const avgColor = avg >= 90 ? "text-success" : avg >= 75 ? "text-primary" : avg >= 60 ? "text-warning" : "text-destructive";
                          return (
                            <motion.div
                              key={programLabel}
                              initial={{ opacity: 0, y: 12 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: idx * 0.05 }}
                              className="rounded-2xl border border-border bg-card overflow-hidden"
                            >
                              <div className={`p-4 border-b border-border ${headerBg}`}>
                                <h4 className="font-display font-bold text-foreground">{programLabel}</h4>
                                <p className="text-sm text-muted-foreground mt-0.5">
                                  Average: <span className={`font-semibold ${avgColor}`}>{avg}%</span> · {items.length} grade(s)
                                </p>
                              </div>
                              <div className="divide-y divide-border">
                                {items.map((g) => {
                                  const pct = g.percentage ?? Math.round((g.score / g.maxScore) * 100);
                                  const barColor = pct >= 90 ? "bg-success" : pct >= 75 ? "bg-primary" : pct >= 60 ? "bg-warning" : "bg-destructive";
                                  const tutorName = g.tutor ? [g.tutor.firstName, g.tutor.lastName].filter(Boolean).join(" ") : "";
                                  return (
                                    <div key={g._id} className="p-4 hover:bg-muted/30 transition-colors">
                                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                                        <span className="font-medium text-foreground">{g.subjectItem}</span>
                                        <span className="text-sm text-muted-foreground">
                                          {g.score} / {g.maxScore} ({pct}%) · {g.period}
                                          {tutorName && ` · ${tutorName}`}
                                        </span>
                                      </div>
                                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                                        <div
                                          className={`h-full rounded-full ${barColor} transition-all duration-500`}
                                          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                                        />
                                      </div>
                                      {g.remarks && (
                                        <p className="text-xs text-muted-foreground mt-2 italic">&ldquo;{g.remarks}&rdquo;</p>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </motion.div>
                          );
                        })}
                      </div>
                    </>
                  )}

                  {/* AI recommendations embedded in Progress tab (no extra heading wrapper) */}
                  <AITab />
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
                          const authorName = a.author ? [a.author.firstName, a.author.lastName].filter(Boolean).join(" ") || "Center" : a.authorRole === "admin" ? "Bee Bright" : "Tutor";
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
                  <span>{selectedAnnouncement.author ? [selectedAnnouncement.author.firstName, selectedAnnouncement.author.lastName].filter(Boolean).join(" ") || "Center" : selectedAnnouncement.authorRole === "admin" ? "Bee Bright" : "Tutor"}</span>
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
    </DashboardLayout>
  );
}
