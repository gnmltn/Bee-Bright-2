import { useEffect, useState, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Users,
  GraduationCap,
  BookOpen,
  PhilippinePeso,
  TrendingUp,
  Calendar,
  FileText,
  Download,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ArrowUpRight,
  Mail,
  Phone,
  Shield,
  UserCheck,
  Loader2,
  Check,
  CheckCircle2,
  X,
  Plus,
  Pencil,
  Trash2,
  Archive,
  RotateCcw,
} from "lucide-react";
import { EnrollmentAssessmentView } from "@/components/enrollment/EnrollmentAssessmentView";
import FilePreview from "@/components/enrollment/FilePreview";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { StatCard } from "@/components/ui/stat-card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { UserAvatar } from "@/components/UserAvatar";
import { enrollmentService, userService, dashboardService, subjectService, scheduleService, weeklyScheduleService, paymentService, announcementService, auditLogService, uploadsBaseUrl, type AdminEnrollment, type AdminUser, type AdminSchedule, type AdminPaymentItem, type DashboardStats, type AnnouncementItem, type AuditLogAdminItem, type AuditLogItem, type WeeklyScheduleAreaOption, type WeeklyScheduleTutorOption } from "@/services/api";
import { adminEmailVerificationService } from "@/services/adminEmailVerification";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PasswordInput } from "@/components/ui/password-input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sanitizeName, sanitizePhoneInput } from "@/utils/validation";

/** Program names by grade level (matches Enrollment page). Used to filter programs in Add Student. */
/** Program names by grade level — only the 3 active programs. Used to filter programs in Add Student. */
const PROGRAMS_BY_GRADE: Record<string, string[]> = {
  Toddler:          ["Toddlers Playgroup"],
  "Pre-Kindergarten": ["Toddlers Playgroup", "Academic Tutorial"],
  Kindergarten:     ["Toddlers Playgroup", "Academic Tutorial"],
  "Grade 1":        ["Academic Tutorial", "Examination Preparation"],
  "Grade 2":        ["Academic Tutorial", "Examination Preparation"],
  "Grade 3":        ["Academic Tutorial", "Examination Preparation"],
  "Grade 4":        ["Academic Tutorial", "Examination Preparation"],
  "Grade 5":        ["Academic Tutorial", "Examination Preparation"],
  "Grade 6":        ["Academic Tutorial", "Examination Preparation"],
  "Grade 7":        ["Academic Tutorial", "Examination Preparation"],
  "Grade 8":        ["Academic Tutorial", "Examination Preparation"],
  "Grade 9":        ["Academic Tutorial", "Examination Preparation"],
  "Grade 10":       ["Academic Tutorial", "Examination Preparation"],
};

/** Returns true if subject name matches any program name for the grade (case-insensitive, allows partial match). */
function subjectMatchesGrade(subjectName: string, gradeLevel: string): boolean {
  const programNames = PROGRAMS_BY_GRADE[gradeLevel];
  if (!programNames?.length) return false;
  const s = (subjectName || "").toLowerCase().trim();
  return programNames.some((p) => {
    const pn = p.toLowerCase().trim();
    return s.includes(pn) || pn.includes(s) || s === pn;
  });
}

const AVAILABILITY_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const AVAILABILITY_TIME_SLOTS = [
  "08:00", "09:00", "10:00", "11:00", "12:00",
  "13:00", "14:00", "15:00", "16:00", "17:00", "18:00",
];

function getMinutesFromTime(hhmm: string): number {
  if (!hhmm) return 0;
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function isTimeInRange(time: string, startTime: string, endTime: string): boolean {
  const timeMin = getMinutesFromTime(time);
  const startMin = getMinutesFromTime(startTime);
  const endMin = getMinutesFromTime(endTime);
  return timeMin >= startMin && timeMin < endMin;
}

function normalizeTime12h(timeStr: string): string | null {
  if (!timeStr) return null;
  const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = (match[3] || "").toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (!ampm && h >= 8 && h < 12) h += 12;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

type AvailabilityBlock = {
  days: string[]; // ["Mon", "Wed", "Fri"]
  start: string;  // "08:00"
  end: string;    // "18:00"
};

function parseAvailabilityString(availabilityStr: string | undefined): AvailabilityBlock[] {
  if (!availabilityStr) return [];
  
  const blocks: AvailabilityBlock[] = [];
  const parts = availabilityStr.split(";").map((p) => p.trim()).filter(Boolean);
  
  for (const part of parts) {
    // Extract days: Mon, Tue, Wed, Thu, Fri, Sat, Sun
    const dayMatches = part.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/g);
    if (!dayMatches) continue;
    
    // Normalize day names to "Mon", "Tue", etc.
    const days = dayMatches.map((d) => {
      const normalized = `${d.slice(0, 1).toUpperCase()}${d.slice(1, 3).toLowerCase()}`;
      return normalized;
    });
    
    // Extract time range: "8:00 AM - 6:00 PM" or "8 AM - 6 PM" etc
    const timeMatch = part.match(/(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s*[-–to]+\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)?/i);
    if (!timeMatch) continue;
    
    const startStr = `${timeMatch[1]} ${timeMatch[2] || 'AM'}`.trim();
    const endStr = `${timeMatch[3]} ${timeMatch[4] || 'PM'}`.trim();
    
    const startTime = normalizeTime12h(startStr);
    const endTime = normalizeTime12h(endStr);
    
    if (startTime && endTime && days.length > 0) {
      blocks.push({ days, start: startTime, end: endTime });
    }
  }
  
  return blocks;
}

function getAvailableDaysForTutor(employmentType: string | undefined, availabilityStr: string | undefined): string[] {
  if (!employmentType) return [];
  if (employmentType === "full-time") {
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  }
  
  const blocks = parseAvailabilityString(availabilityStr);
  const daysSet = new Set<string>();
  for (const block of blocks) {
    block.days.forEach((d) => daysSet.add(d));
  }
  return Array.from(daysSet);
}

function getAvailableSchedulingDayKeys(availableDays: string[]): Set<number> {
  const dayNameToKey: Record<string, number> = { "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6 };
  const keySet = new Set<number>();
  for (const day of availableDays) {
    const key = dayNameToKey[day];
    if (key !== undefined) keySet.add(key);
  }
  return keySet;
}

function getAvailabilityForDay(employmentType: string | undefined, availabilityStr: string | undefined, dayName: string): { start: string; end: string } | null {
  if (!employmentType) return null;
  if (employmentType === "full-time") {
    return { start: "08:00", end: "18:00" };
  }
  
  const blocks = parseAvailabilityString(availabilityStr);
  for (const block of blocks) {
    if (block.days.includes(dayName)) {
      return { start: block.start, end: block.end };
    }
  }
  return null;
}

function formatTime12h(hhmm: string) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const h12 = h % 12 || 12;
  const ampm = h < 12 ? "AM" : "PM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}
function buildAvailabilityString(days: string[], start: string, end: string): string {
  if (days.length === 0 || !start || !end) return "";
  return `${days.join(", ")} ${formatTime12h(start)} - ${formatTime12h(end)}`;
}

const SCHEDULE_VIEW_STORAGE_KEY = "admin.schedule.viewMode";
const SCHEDULE_MONTH_STORAGE_KEY = "admin.schedule.month";
const SCHEDULE_DAY_STORAGE_KEY = "admin.schedule.day";
const SCHEDULE_WEEK_START_STORAGE_KEY = "admin.schedule.weekStart";

function parseMonthKeyToDate(value?: string | null): Date | null {
  if (!value) return null;
  const [yearRaw, monthRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  return new Date(year, month - 1, 1);
}

function parseDateKeyToDate(value?: string | null): Date | null {
  if (!value) return null;
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return new Date(year, month - 1, day);
}

type PaymentForExport = { _id: string; referenceNumber?: string; amount: number; status: string; createdAt?: string; paymentMethod?: string; student?: { firstName?: string; lastName?: string } };

const handleExportAll = (enrollmentsList: AdminEnrollment[], usersList: AdminUser[], paymentsList: PaymentForExport[]) => {
  let csvContent = "=== Bee Bright Tutorial Center — Full Report ===\nGenerated: " + new Date().toLocaleString() + "\n\n";

  csvContent += "--- ENROLLMENTS ---\nName,Programs,Date,Status\n";
  (enrollmentsList || []).forEach((e: AdminEnrollment) => {
    const eAny = e as Record<string, unknown>;
    const snap = eAny.studentSnapshot as { firstName?: string; lastName?: string } | undefined;
    const name = snap ? `${snap.firstName || ''} ${snap.lastName || ''}`.trim() : "—";
    const programs = (eAny.packages as { displayName?: string }[] | undefined)?.map((p) => p.displayName).join("; ") || e.selectedSubjects?.map((s) => s.name).join("; ") || "—";
    const date = formatEnrollmentDate(e.enrollmentDate || e.createdAt);
    const status = enrollmentStatusLabel(e.status);
    csvContent += `${name},${programs},${date},${status}\n`;
  });

  csvContent += "\n--- PAYMENTS ---\nReference,Student,Amount,Status,Date,Method\n";
  (paymentsList || []).forEach((p) => {
    const studentName = p.student ? [p.student.firstName, p.student.lastName].filter(Boolean).join(" ").trim() : "—";
    const date = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "—";
    csvContent += `${p.referenceNumber ?? p._id},${studentName},₱${p.amount ?? 0},${p.status},${date},${p.paymentMethod ?? "—"}\n`;
  });

  csvContent += "\n--- USERS ---\nName,Role,Email,Phone,Status\n";
  (usersList || []).forEach((u: AdminUser) => {
    const name = `${u.firstName || ""} ${u.lastName || ""}`.trim() || "—";
    const status = u.isActive ? "active" : "inactive";
    csvContent += `${name},${u.role},${u.email},${u.phone || "—"},${status}\n`;
  });

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `beebright_full_report_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  toast.success("Full report exported!");
};

function formatEnrollmentDate(d: string | undefined): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

function enrollmentStatusLabel(status: string): string {
  const map: Record<string, string> = {
    active: "confirmed",
    pending: "pending",
    completed: "completed",
    cancelled: "cancelled",
  };
  return map[status] || status;
}

function paymentStatusLabel(paymentStatus: string): string {
  const map: Record<string, string> = {
    pending: "Pending",
    pending_verification: "Pending review",
    paid: "Paid",
    failed: "Failed",
    partial: "Partial",
  };
  return map[paymentStatus] || paymentStatus;
}

type PendingUserAction =
  | { type: "archive"; user: AdminUser }
  | { type: "unarchive"; user: AdminUser; closeDetails?: boolean }
  | { type: "delete"; user: AdminUser; closeDetails?: boolean }
  | null;

type EmailVerificationState = {
  email: string;
  code: string;
  verificationId: string;
  verificationToken: string;
  status: "idle" | "code_sent" | "verified";
  expiresAt: string | null;
  sending: boolean;
  verifying: boolean;
};

const initialEmailVerificationState: EmailVerificationState = {
  email: "",
  code: "",
  verificationId: "",
  verificationToken: "",
  status: "idle",
  expiresAt: null,
  sending: false,
  verifying: false,
};

const SCHEDULING_DAYS = [
  { key: 1, name: "Monday", templateDay: 0 },
  { key: 2, name: "Tuesday", templateDay: 1 },
  { key: 3, name: "Wednesday", templateDay: 2 },
  { key: 4, name: "Thursday", templateDay: 3 },
  { key: 5, name: "Friday", templateDay: 4 },
  { key: 6, name: "Saturday", templateDay: 5 },
] as const;

const SESSION_TYPE_OPTIONS = [
  { value: "one-on-one", label: "1-on-1", maxStudents: 1 },
  { value: "small-group", label: "Small Group", maxStudents: 3 },
  { value: "playgroup", label: "Toddler Playgroup", maxStudents: 10 },
] as const;

type SessionTypeValue = (typeof SESSION_TYPE_OPTIONS)[number]["value"];

type WeeklyAssignmentDraft = {
  id: string;
  dayKey: number;
  tutorId: string;
  tutorIds: string[];
  tutorName: string;
  subjectId: string;
  subjectName: string;
  sessionType: SessionTypeValue;
  startTime: string;
  endTime: string;
  roomId: string;
  roomName: string;
  roomType: "tutoring_area" | "toddler_room";
};

const overlapsTimeRange = (startA: string, endA: string, startB: string, endB: string) =>
  startA < endB && startB < endA;

const addTwoHours = (start: string) => {
  const [hourRaw, minuteRaw] = start.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return start;
  const endHour = Math.min(23, hour + 2);
  return `${String(endHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

const personDisplayName = (person?: { firstName?: string; middleName?: string; lastName?: string } | null) =>
  person ? [person.firstName, person.middleName, person.lastName].filter(Boolean).join(" ") : "";

const formatScheduleTutorNames = (schedule: AdminSchedule) => {
  const tutors = Array.isArray(schedule.tutors) && schedule.tutors.length > 0
    ? schedule.tutors
    : schedule.tutor
      ? [schedule.tutor]
      : [];
  const names = tutors.map((tutor) => personDisplayName(tutor)).filter(Boolean);
  return names.length ? names.join(", ") : "—";
};

const formatScheduleStudentNames = (schedule: AdminSchedule) => {
  const students = [
    ...(schedule.student ? [schedule.student] : []),
    ...((schedule.students || [])),
  ].filter((item, index, arr) => arr.findIndex((other) => other?._id === item?._id) === index);
  if (students.length === 0) {
    return schedule.sessionType === "playgroup" ? "No children enrolled yet" : "—";
  }
  if (students.length <= 3) return students.map((student) => personDisplayName(student)).filter(Boolean).join(", ");
  return `${students.length} children`;
};

const enrollmentIsReadyToSchedule = (enrollment: AdminEnrollment) => {
  const status = enrollment.status || "";
  return ["active", "approved"].includes(status) || (enrollment.paymentStatus === "paid" && status !== "cancelled" && status !== "rejected");
};

const enrollmentMatchesSessionProgram = (
  enrollment: AdminEnrollment,
  subject?: { _id?: string; name?: string; code?: string } | null
) => {
  if (!subject?._id) return false;
  if ((enrollment.selectedSubjects || []).some((item) => item._id === subject._id)) return true;
  const code = (subject.code || "").toUpperCase();
  if (code && (enrollment.packages || []).some((pkg) => (pkg.programCode || "").toUpperCase() === code)) return true;
  const name = (subject.name || "").toLowerCase();
  const packageText = (enrollment.packages || []).map((pkg) => `${pkg.programCode || ""} ${pkg.displayName || ""}`).join(" ").toLowerCase();
  if (name.includes("playgroup") && (packageText.includes("playgroup") || packageText.includes("tpg"))) return true;
  if (name.includes("academic") && packageText.includes("academic")) return true;
  if ((name.includes("exam") || name.includes("examination")) && (packageText.includes("exam") || packageText.includes("exp"))) return true;
  return false;
};

const childNameFromEnrollment = (enrollment: AdminEnrollment) => {
  if (enrollment.student) return personDisplayName(enrollment.student);
  const snap = enrollment.studentSnapshot;
  const snapshotName = [snap?.firstName, snap?.middleName, snap?.lastName].filter(Boolean).join(" ");
  return snapshotName || enrollment.studentId || "Child";
};

const parentPreferenceSummary = (enrollment: AdminEnrollment) => {
  const dateLabel = enrollment.preferredStartDate
    ? new Date(enrollment.preferredStartDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "any start date";
  const timeLabel = enrollment.preferredTime === "morning"
    ? "morning"
    : enrollment.preferredTime === "afternoon"
      ? "afternoon"
      : "no time preference";
  return `${dateLabel}, ${timeLabel}`;
};

const matchesParentPreferenceClient = (enrollment: AdminEnrollment, dateValue?: string, startTime?: string) => {
  if (enrollment.preferredStartDate && dateValue) {
    const preferred = new Date(enrollment.preferredStartDate);
    const scheduled = new Date(dateValue);
    if (!Number.isNaN(preferred.getTime()) && !Number.isNaN(scheduled.getTime()) && scheduled < preferred) {
      return { ok: false, reason: "Earlier than the parent preferred start date." };
    }
  }
  if (enrollment.preferredTime && enrollment.preferredTime !== "no_preference" && startTime) {
    const [hours, minutes] = startTime.split(":").map(Number);
    const startMinutes = (hours || 0) * 60 + (minutes || 0);
    const morning = startMinutes >= 8 * 60 && startMinutes < 12 * 60;
    const afternoon = startMinutes >= 13 * 60 && startMinutes < 17 * 60;
    if ((enrollment.preferredTime === "morning" && !morning) || (enrollment.preferredTime === "afternoon" && !afternoon)) {
      return { ok: false, reason: `Does not match the parent ${enrollment.preferredTime} preference.` };
    }
  }
  return { ok: true, reason: "" };
};

export default function AdminDashboard() {
  const { user } = useAuth();
  const isSuperAdmin = (user?.role as string) === "super_admin";
  const dashboardBasePath = isSuperAdmin ? "/super-admin-dashboard" : "/admin-dashboard";
  const dashboardTitle = isSuperAdmin ? "Super Admin Dashboard" : "Admin Dashboard";
  const dashboardSubtitle = isSuperAdmin
    ? "Overview of Bee Bright Tutorial Center operations and admin controls"
    : "Overview of Bee Bright Tutorial Center operations";
  const location = useLocation();
  const navigate = useNavigate();

  const [enrollments, setEnrollments] = useState<AdminEnrollment[]>([]);
  const [enrollmentsLoading, setEnrollmentsLoading] = useState(true);
  const [enrollmentsError, setEnrollmentsError] = useState<string | null>(null);
  const [enrollmentStatusFilter, setEnrollmentStatusFilter] = useState<string>('all');
  const [enrollmentSearch, setEnrollmentSearch] = useState('');
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [viewEnrollmentId, setViewEnrollmentId] = useState<string | null>(null);
  // Reject dialog state
  const [rejectEnrollmentId, setRejectEnrollmentId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectAllowResubmit, setRejectAllowResubmit] = useState(true);
  const [rejectLoading, setRejectLoading] = useState(false);
  // Verify payment dialog state
  const [verifyPaymentDialogOpen, setVerifyPaymentDialogOpen] = useState(false);
  const [verifyPaymentTarget, setVerifyPaymentTarget] = useState<{ enrollmentId: string; paymentId: string } | null>(null);
  const [verifyPaymentNote, setVerifyPaymentNote] = useState('');
  const [verifyPaymentLoading, setVerifyPaymentLoading] = useState(false);
  type ViewEnrollmentData = {
    enrollment: AdminEnrollment & {
      enrollmentId?: string; parent?: { firstName?: string; lastName?: string; email?: string; phone?: string } | null;
      studentSnapshot?: { firstName?: string; lastName?: string; birthdate?: string; computedAge?: number };
      packages?: { programCode?: string; displayName?: string; price?: number; paymentOption?: string }[];
      preferredStartDate?: string; preferredTime?: string;
      healthInfo?: { allergies?: string; medications?: string; specialNeeds?: boolean; specialNeedsDetails?: string };
      consentItems?: { name?: string; accepted?: boolean }[];
      rejectionReason?: string; allowResubmission?: boolean; statusHistory?: { status?: string; at?: string; byRole?: string; note?: string }[];
      student?: AdminEnrollment["student"] & { guardianName?: string; guardianPhone?: string; studentId?: string };
      requirementDocuments?: {
        birthCertificate?: { path?: string | null; fileName?: string | null; uploadedAt?: string | null };
        studentPhoto?: { path?: string | null; fileName?: string | null; uploadedAt?: string | null };
        guardianId?: { path?: string | null; fileName?: string | null; uploadedAt?: string | null };
      };
    };
    payments: {
      _id: string; referenceNumber?: string; amount: number; amountDue?: number; status: string;
      paymentMethod?: string; proofUrl?: string; payerReference?: string; resubmissionCount?: number;
      submittedAt?: string; verifiedAt?: string; rejectionReason?: string;
      gcashDetails?: { mobileNumber?: string; transactionId?: string; screenshotUrl?: string };
      createdAt?: string;
    }[];
  } | null;
  const [viewEnrollmentData, setViewEnrollmentData] = useState<ViewEnrollmentData>(null);
  const [viewEnrollmentLoading, setViewEnrollmentLoading] = useState(false);
  const [paymentProofPreview, setPaymentProofPreview] = useState<{ src: string; reference: string } | null>(null);
  const [paymentProofZoomed, setPaymentProofZoomed] = useState(false);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);

  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const [schedules, setSchedules] = useState<AdminSchedule[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(true);
  const [adminPayments, setAdminPayments] = useState<AdminPaymentItem[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(true);
  const [verifyingPaymentId, setVerifyingPaymentId] = useState<string | null>(null);

  const [scheduleDeletingId, setScheduleDeletingId] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(SCHEDULE_MONTH_STORAGE_KEY) : null;
    const savedDate = parseMonthKeyToDate(saved);
    if (savedDate) return savedDate;
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selectedSchedule, setSelectedSchedule] = useState<AdminSchedule | null>(null);
  const [selectedScheduleIds, setSelectedScheduleIds] = useState<string[]>([]);
  const [scheduleBulkDeleting, setScheduleBulkDeleting] = useState(false);
  const [scheduleEnrollmentSelectedStudentIds, setScheduleEnrollmentSelectedStudentIds] = useState<string[]>([]);
  const [scheduleEnrollmentSaving, setScheduleEnrollmentSaving] = useState(false);
  const [scheduleEnrollmentOverride, setScheduleEnrollmentOverride] = useState(false);
  const [scheduleEnrollmentOverrideReason, setScheduleEnrollmentOverrideReason] = useState("");
  const [scheduleCompatibleSlots, setScheduleCompatibleSlots] = useState<Array<{ _id: string; date: string; startTime: string; endTime: string; tutorName?: string }>>([]);
  const [scheduleViewMode, setScheduleViewMode] = useState<"monthly" | "weekly" | "daily">(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(SCHEDULE_VIEW_STORAGE_KEY) : null;
    if (saved === "monthly" || saved === "weekly" || saved === "daily") {
      return saved;
    }
    return "monthly";
  });
  const [scheduleDailyDate, setScheduleDailyDate] = useState(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(SCHEDULE_DAY_STORAGE_KEY) : null;
    if (saved && parseDateKeyToDate(saved)) {
      return saved;
    }
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [scheduleWeekStart, setScheduleWeekStart] = useState(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(SCHEDULE_WEEK_START_STORAGE_KEY) : null;
    const savedDate = parseDateKeyToDate(saved);
    if (savedDate) {
      return new Date(savedDate.getFullYear(), savedDate.getMonth(), savedDate.getDate());
    }

    const d = new Date();
    const day = d.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMonday);
    return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
  });
  const [weeklyPlannerOptionsLoading, setWeeklyPlannerOptionsLoading] = useState(false);
  const [weeklyPlannerSubmitting, setWeeklyPlannerSubmitting] = useState(false);
  const [weeklyPlannerErrors, setWeeklyPlannerErrors] = useState<string[]>([]);
  const [weeklyPlannerDay, setWeeklyPlannerDay] = useState<number>(1);
  const [weeklyPlannerSelectedDays, setWeeklyPlannerSelectedDays] = useState<number[]>([1, 2, 3]);
  const [scheduleGenerationMonthSpan, setScheduleGenerationMonthSpan] = useState<1 | 2 | 3>(1);
  const [weeklyPlannerAreas, setWeeklyPlannerAreas] = useState<WeeklyScheduleAreaOption[]>([]);
  const [weeklyPlannerTutors, setWeeklyPlannerTutors] = useState<WeeklyScheduleTutorOption[]>([]);
  const [weeklyPlannerSubjects, setWeeklyPlannerSubjects] = useState<{ _id: string; name: string; code?: string }[]>([]);
  const [weeklyPlannerForm, setWeeklyPlannerForm] = useState<{
    tutorId: string;
    tutorIds: string[];
    subjectId: string;
    sessionType: SessionTypeValue;
    startTime: string;
    endTime: string;
  }>({
    tutorId: "",
    tutorIds: [],
    subjectId: "",
    sessionType: "one-on-one",
    startTime: "08:00",
    endTime: "10:00",
  });
  const [weeklyPlannerDraft, setWeeklyPlannerDraft] = useState<Record<number, WeeklyAssignmentDraft[]>>({
    1: [],
    2: [],
    3: [],
    4: [],
    5: [],
    6: [],
  });
  const [substituteDialogOpen, setSubstituteDialogOpen] = useState(false);
  const [substituteTutorOptions, setSubstituteTutorOptions] = useState<{ _id: string; name: string; email?: string }[]>([]);
  const [substituteTutorId, setSubstituteTutorId] = useState("");
  const [substituteReason, setSubstituteReason] = useState("Tutor unavailable");
  const [substituteLoading, setSubstituteLoading] = useState(false);

  const [usersCategory, setUsersCategory] = useState<"active" | "archived">("active");
  const [archivedUserDetail, setArchivedUserDetail] = useState<AdminUser | null>(null);
  const [pendingUserAction, setPendingUserAction] = useState<PendingUserAction>(null);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [announcementsLoading, setAnnouncementsLoading] = useState(false);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<AnnouncementItem | null>(null);
  const [adminAnnouncementOpen, setAdminAnnouncementOpen] = useState(false);
  const [adminAnnouncementForm, setAdminAnnouncementForm] = useState({ title: "", body: "", category: "suspension" as string, scheduledDate: "" });
  const [adminAnnouncementSubmitting, setAdminAnnouncementSubmitting] = useState(false);
  const [editingAdminAnnouncementId, setEditingAdminAnnouncementId] = useState<string | null>(null);
  const [addStudentOpen, setAddStudentOpen] = useState(false);
  const [addStudentSubmitting, setAddStudentSubmitting] = useState(false);
  const [addStudentPrograms, setAddStudentPrograms] = useState<{ _id: string; name: string; code?: string; price?: number }[]>([]);
  const [addStudentForm, setAddStudentForm] = useState({
    firstName: "",
    middleName: "",
    lastName: "",
    email: "",
    phone: "",
    password: "",
    gradeLevel: "",
    guardianName: "",
    guardianPhone: "",
    selectedSubjectIds: [] as string[],
    paymentOption: "full" as "full" | "down",
    paymentStatus: "paid" as string,
    status: "active" as string,
    enrollmentDate: new Date().toISOString().slice(0, 10),
  });

  const managedUserRoles = useMemo(
    // 'student' role is no longer created — children are stored as studentSnapshot on Enrollment.
    // Parent/Guardian is the only account owner that logs in.
    () => new Set(isSuperAdmin ? ["tutor", "admin", "parent"] : ["tutor", "parent"]),
    [isSuperAdmin]
  );
  const getAdminUserName = (adminUser: AdminUser) =>
    [adminUser.firstName, adminUser.middleName, adminUser.lastName].filter(Boolean).join(" ") || "this user";

  const replaceUserInState = (updatedUser: AdminUser) => {
    setUsers((currentUsers) => {
      const hasUser = currentUsers.some((item) => item._id === updatedUser._id);
      if (!hasUser) {
        return [updatedUser, ...currentUsers];
      }
      return currentUsers.map((item) =>
        item._id === updatedUser._id ? { ...item, ...updatedUser } : item
      );
    });
  };

  const removeUserFromState = (userId: string) => {
    setUsers((currentUsers) => currentUsers.filter((item) => item._id !== userId));
  };

  const activeUsers = useMemo(
    () => users.filter((u) => managedUserRoles.has(u.role) && !u.isArchived && !u.deletedAt),
    [managedUserRoles, users]
  );
  const archivedUsers = useMemo(
    () => users.filter((u) => managedUserRoles.has(u.role) && u.isArchived && !u.deletedAt),
    [managedUserRoles, users]
  );
  const pendingUserActionDialog = useMemo(() => {
    if (!pendingUserAction) return null;

    const name = getAdminUserName(pendingUserAction.user);

    if (pendingUserAction.type === "archive") {
      return {
        title: "Archive User",
        description: `Archive ${name}? This will temporarily suspend their account, but keep all records.`,
        actionLabel: "Archive",
        actionClassName:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        icon: Archive,
        iconClassName: "bg-destructive/10 text-destructive",
      };
    }

    if (pendingUserAction.type === "unarchive") {
      return {
        title: "Unarchive User",
        description: `Unarchive ${name}? This will restore their account access.`,
        actionLabel: "Unarchive",
        actionClassName: "bg-primary text-primary-foreground hover:bg-primary/90",
        icon: RotateCcw,
        iconClassName: "bg-primary/10 text-primary",
      };
    }

    return {
      title: "Delete Archived User",
      description: `Delete ${name}? This will remove the archived account from admin records.`,
      actionLabel: "Delete",
      actionClassName:
        "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      icon: Trash2,
      iconClassName: "bg-destructive/10 text-destructive",
    };
  }, [pendingUserAction]);
  /** Programs applicable to selected grade level in Add Student form. */
  const addStudentProgramsForGrade = useMemo(() => {
    if (!addStudentForm.gradeLevel) return [];
    return addStudentPrograms.filter((p) => subjectMatchesGrade(p.name, addStudentForm.gradeLevel));
  }, [addStudentPrograms, addStudentForm.gradeLevel]);
  /** Calculated total fee from selected programs (for Add Student, like enrollment). */
  const addStudentCalculatedTotal = useMemo(() => {
    return addStudentPrograms
      .filter((p) => addStudentForm.selectedSubjectIds.includes(p._id))
      .reduce((sum, p) => sum + (p.price ?? 0), 0);
  }, [addStudentPrograms, addStudentForm.selectedSubjectIds]);

  const GRADE_LEVELS = ["Toddler", "Pre-Kindergarten", "Kindergarten", "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6", "Grade 7", "Grade 8", "Grade 9", "Grade 10"];
  const PAYMENT_STATUS_OPTIONS = [
    { value: "pending", label: "Pending" },
    { value: "pending_verification", label: "Pending verification" },
    { value: "paid", label: "Paid" },
  ];
  const ENROLLMENT_STATUS_OPTIONS = [
    { value: "pending", label: "Pending" },
    { value: "active", label: "Active" },
  ];

  const [addAdminOpen, setAddAdminOpen] = useState(false);
  const [addAdminSubmitting, setAddAdminSubmitting] = useState(false);
  const [addAdminForm, setAddAdminForm] = useState({
    firstName: "",
    middleName: "",
    lastName: "",
    email: "",
    password: "",
    phone: "",
  });
  const [addAdminEmailVerification, setAddAdminEmailVerification] =
    useState<EmailVerificationState>(initialEmailVerificationState);
  const normalizedAdminEmail = addAdminForm.email.trim().toLowerCase();
  const isAdminEmailVerified =
    addAdminEmailVerification.status === "verified" &&
    addAdminEmailVerification.email === normalizedAdminEmail &&
    !!addAdminEmailVerification.verificationId &&
    !!addAdminEmailVerification.verificationToken;

  const [addTutorOpen, setAddTutorOpen] = useState(false);
  const [addTutorSubmitting, setAddTutorSubmitting] = useState(false);
  const [subjectsList, setSubjectsList] = useState<{ _id: string; name: string; code?: string }[]>([]);
  const [addTutorForm, setAddTutorForm] = useState({
    firstName: "",
    middleName: "",
    lastName: "",
    email: "",
    password: "",
    phone: "",
    subjectsTaught: [] as string[],
    employmentType: "full-time" as "full-time" | "part-time",
    availability: "",
    availabilityDays: [] as string[],
    availabilityStart: "",
    availabilityEnd: "",
  });
  const [addTutorEmailVerification, setAddTutorEmailVerification] =
    useState<EmailVerificationState>(initialEmailVerificationState);
  const normalizedTutorEmail = addTutorForm.email.trim().toLowerCase();
  const isTutorEmailVerified =
    addTutorEmailVerification.status === "verified" &&
    addTutorEmailVerification.email === normalizedTutorEmail &&
    !!addTutorEmailVerification.verificationId &&
    !!addTutorEmailVerification.verificationToken;

  const handleTutorEmailChange = (value: string) => {
    const nextEmail = value.trim().toLowerCase();

    setAddTutorForm((form) => ({
      ...form,
      email: nextEmail,
    }));

    setAddTutorEmailVerification((current) =>
      current.email === nextEmail
        ? current
        : {
            ...initialEmailVerificationState,
            email: nextEmail,
          }
    );
  };

  const handleSendTutorVerificationCode = async () => {
    if (!normalizedTutorEmail) {
      toast.error("Please enter the tutor email first.");
      return;
    }

    setAddTutorEmailVerification((current) => ({
      ...current,
      email: normalizedTutorEmail,
      sending: true,
      verifying: false,
    }));

    try {
      const response = await adminEmailVerificationService.requestTutorCode(
        normalizedTutorEmail
      );

      setAddTutorEmailVerification({
        email: normalizedTutorEmail,
        code: "",
        verificationId: response.verificationId,
        verificationToken: "",
        status: "code_sent",
        expiresAt: response.expiresAt,
        sending: false,
        verifying: false,
      });

      toast.success(
        response.message ?? "Verification code sent to the tutor email."
      );
    } catch (err: unknown) {
      setAddTutorEmailVerification((current) => ({
        ...current,
        email: normalizedTutorEmail,
        sending: false,
      }));

      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "Failed to send verification code.";
      toast.error(msg);
    }
  };

  const handleVerifyTutorEmailCode = async () => {
    if (!normalizedTutorEmail || !addTutorEmailVerification.verificationId) {
      toast.error("Please send a verification code first.");
      return;
    }

    if (!addTutorEmailVerification.code.trim()) {
      toast.error("Please enter the verification code from the tutor email.");
      return;
    }

    setAddTutorEmailVerification((current) => ({
      ...current,
      verifying: true,
    }));

    try {
      const response = await adminEmailVerificationService.verifyTutorCode({
        email: normalizedTutorEmail,
        code: addTutorEmailVerification.code.trim(),
        verificationId: addTutorEmailVerification.verificationId,
      });

      setAddTutorEmailVerification((current) => ({
        ...current,
        email: normalizedTutorEmail,
        code: "",
        verificationId: response.verificationId,
        verificationToken: response.verificationToken,
        status: "verified",
        expiresAt: response.expiresAt,
        sending: false,
        verifying: false,
      }));

      toast.success(response.message ?? "Tutor email verified successfully.");
    } catch (err: unknown) {
      setAddTutorEmailVerification((current) => ({
        ...current,
        verifying: false,
      }));

      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "Failed to verify the email code.";
      toast.error(msg);
    }
  };

  const handleAdminEmailChange = (value: string) => {
    const nextEmail = value.trim().toLowerCase();

    setAddAdminForm((form) => ({
      ...form,
      email: nextEmail,
    }));

    setAddAdminEmailVerification((current) =>
      current.email === nextEmail
        ? current
        : {
            ...initialEmailVerificationState,
            email: nextEmail,
          }
    );
  };

  const handleSendAdminVerificationCode = async () => {
    if (!normalizedAdminEmail) {
      toast.error("Please enter the admin email first.");
      return;
    }

    setAddAdminEmailVerification((current) => ({
      ...current,
      email: normalizedAdminEmail,
      sending: true,
      verifying: false,
    }));

    try {
      const response = await adminEmailVerificationService.requestCode(
        normalizedAdminEmail
      );

      setAddAdminEmailVerification({
        email: normalizedAdminEmail,
        code: "",
        verificationId: response.verificationId,
        verificationToken: "",
        status: "code_sent",
        expiresAt: response.expiresAt,
        sending: false,
        verifying: false,
      });

      toast.success(
        response.message ?? "Verification code sent to the admin email."
      );
    } catch (err: unknown) {
      setAddAdminEmailVerification((current) => ({
        ...current,
        email: normalizedAdminEmail,
        sending: false,
      }));

      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "Failed to send verification code.";
      toast.error(msg);
    }
  };

  const handleVerifyAdminEmailCode = async () => {
    if (!normalizedAdminEmail || !addAdminEmailVerification.verificationId) {
      toast.error("Please send a verification code first.");
      return;
    }

    if (!addAdminEmailVerification.code.trim()) {
      toast.error("Please enter the verification code from the admin email.");
      return;
    }

    setAddAdminEmailVerification((current) => ({
      ...current,
      verifying: true,
    }));

    try {
      const response = await adminEmailVerificationService.verifyCode({
        email: normalizedAdminEmail,
        code: addAdminEmailVerification.code.trim(),
        verificationId: addAdminEmailVerification.verificationId,
      });

      setAddAdminEmailVerification((current) => ({
        ...current,
        email: normalizedAdminEmail,
        code: "",
        verificationId: response.verificationId,
        verificationToken: response.verificationToken,
        status: "verified",
        expiresAt: response.expiresAt,
        sending: false,
        verifying: false,
      }));

      toast.success(response.message ?? "Admin email verified successfully.");
    } catch (err: unknown) {
      setAddAdminEmailVerification((current) => ({
        ...current,
        verifying: false,
      }));

      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "Failed to verify the email code.";
      toast.error(msg);
    }
  };

  useEffect(() => {
    if (addStudentOpen) {
      subjectService.getAllSubjects().then((res) => {
        if (res.data?.success && Array.isArray(res.data.subjects)) {
          setAddStudentPrograms(res.data.subjects);
        }
      }).catch(() => setAddStudentPrograms([]));
    }
  }, [addStudentOpen]);

  /** When grade level changes in Add Student, clear selections that are no longer applicable. */
  useEffect(() => {
    if (!addStudentOpen || !addStudentForm.gradeLevel) return;
    const allowedIds = addStudentPrograms
      .filter((p) => subjectMatchesGrade(p.name, addStudentForm.gradeLevel))
      .map((p) => p._id);
    setAddStudentForm((f) => ({
      ...f,
      selectedSubjectIds: f.selectedSubjectIds.filter((id) => allowedIds.includes(id)),
    }));
  }, [addStudentOpen, addStudentForm.gradeLevel, addStudentPrograms]);

  useEffect(() => {
    if (addTutorOpen) {
      subjectService.getAllSubjects().then((res) => {
        if (res.data?.success && Array.isArray(res.data.subjects)) {
          setSubjectsList(res.data.subjects);
        }
      }).catch(() => setSubjectsList([]));
      return;
    }
    setAddTutorEmailVerification(initialEmailVerificationState);
  }, [addTutorOpen]);

  useEffect(() => {
    if (addAdminOpen) {
      return;
    }
    setAddAdminEmailVerification(initialEmailVerificationState);
  }, [addAdminOpen]);

  const fetchEnrollments = () => {
    setEnrollmentsError(null);
    enrollmentService
      .getAllEnrollments()
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.enrollments)) {
          setEnrollments(res.data.enrollments);
        }
      })
      .catch((err) => {
        setEnrollmentsError(err.response?.data?.message || "Failed to load enrollments");
        toast.error("Failed to load enrollments");
      })
      .finally(() => setEnrollmentsLoading(false));
  };

  const fetchUsers = () => {
    setUsersError(null);
    userService
      .getAllUsers()
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.users)) {
          setUsers(res.data.users);
        } else {
          setUsers([]);
        }
      })
      .catch((err) => {
        setUsersError(err.response?.data?.message || "Failed to load users");
        toast.error("Failed to load users");
      })
      .finally(() => setUsersLoading(false));
  };

  useEffect(() => {
    let cancelled = false;
    setEnrollmentsLoading(true);
    fetchEnrollments();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setUsersLoading(true);
    fetchUsers();
  }, []);

  const fetchDashboardStats = () => {
    setStatsLoading(true);
    dashboardService
      .getStats()
      .then((res) => {
        if (res.data?.success && res.data?.stats) {
          setDashboardStats(res.data.stats);
        } else {
          setDashboardStats(null);
        }
      })
      .catch(() => setDashboardStats(null))
      .finally(() => setStatsLoading(false));
  };

  useEffect(() => {
    fetchDashboardStats();
  }, []);

  const fetchSchedules = () => {
    setSchedulesLoading(true);
    scheduleService
      .list()
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.schedules)) {
          setSchedules(res.data.schedules);
        } else {
          setSchedules([]);
        }
      })
      .catch(() => setSchedules([]))
      .finally(() => setSchedulesLoading(false));
  };
  useEffect(() => {
    fetchSchedules();
  }, []);

  useEffect(() => {
    setScheduleEnrollmentSelectedStudentIds([]);
    setScheduleEnrollmentOverride(false);
    setScheduleEnrollmentOverrideReason("");
    setScheduleCompatibleSlots([]);
  }, [selectedSchedule?._id]);

  useEffect(() => {
    if (!weeklyPlannerSelectedDays.includes(weeklyPlannerDay)) {
      setWeeklyPlannerDay(weeklyPlannerSelectedDays[0] ?? 1);
    }
  }, [weeklyPlannerSelectedDays, weeklyPlannerDay]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SCHEDULE_VIEW_STORAGE_KEY, scheduleViewMode);
  }, [scheduleViewMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const monthKey = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, "0")}`;
    window.localStorage.setItem(SCHEDULE_MONTH_STORAGE_KEY, monthKey);
  }, [calendarMonth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SCHEDULE_DAY_STORAGE_KEY, scheduleDailyDate);
  }, [scheduleDailyDate]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const weekKey = `${scheduleWeekStart.getFullYear()}-${String(scheduleWeekStart.getMonth() + 1).padStart(2, "0")}-${String(scheduleWeekStart.getDate()).padStart(2, "0")}`;
    window.localStorage.setItem(SCHEDULE_WEEK_START_STORAGE_KEY, weekKey);
  }, [scheduleWeekStart]);

  useEffect(() => {
    setWeeklyPlannerOptionsLoading(true);
    weeklyScheduleService
      .getOptions()
      .then((res) => {
        if (res.data?.success) {
          setWeeklyPlannerAreas(Array.isArray(res.data.tutoringAreas) ? res.data.tutoringAreas : []);
          setWeeklyPlannerTutors(Array.isArray(res.data.tutors) ? res.data.tutors : []);
          setWeeklyPlannerSubjects(Array.isArray(res.data.subjects) ? res.data.subjects : []);
        } else {
          setWeeklyPlannerAreas([]);
          setWeeklyPlannerTutors([]);
          setWeeklyPlannerSubjects([]);
        }
      })
      .catch(() => {
        setWeeklyPlannerAreas([]);
        setWeeklyPlannerTutors([]);
        setWeeklyPlannerSubjects([]);
      })
      .finally(() => setWeeklyPlannerOptionsLoading(false));
  }, []);

  const openSubstituteDialog = async () => {
    if (!selectedSchedule?.subject?._id || !selectedSchedule?.tutor?._id) {
      toast.error("Select a schedule with a valid tutor and subject first.");
      return;
    }
    try {
      const res = await scheduleService.getTutorsBySubject(selectedSchedule.subject._id);
      const tutors = Array.isArray(res.data?.tutors)
        ? res.data.tutors.filter((t: { _id: string }) => t._id !== selectedSchedule.tutor?._id)
        : [];
      setSubstituteTutorOptions(tutors);
      setSubstituteTutorId("");
      setSubstituteReason("Tutor unavailable");
      setSubstituteDialogOpen(true);
    } catch {
      toast.error("Failed to load substitute tutor options");
    }
  };

  const handleAssignSubstitute = async () => {
    if (!selectedSchedule?._id) return;
    if (!substituteTutorId) {
      toast.error("Please select a replacement tutor.");
      return;
    }
    setSubstituteLoading(true);
    try {
      const res = await scheduleService.assignSubstitute(selectedSchedule._id, {
        replacementTutorId: substituteTutorId,
        reason: substituteReason || undefined,
      });
      if (res.data?.success) {
        toast.success("Substitute tutor assigned.");
        setSubstituteDialogOpen(false);
        fetchSchedules();
      } else {
        toast.error(res.data?.message || "Failed to assign substitute tutor");
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to assign substitute tutor";
      toast.error(msg);
    } finally {
      setSubstituteLoading(false);
    }
  };

  const handleMarkTutorUnavailableForSessionDate = async () => {
    if (!selectedSchedule?.tutor?._id || !selectedSchedule?.date) {
      toast.error("Select a schedule first.");
      return;
    }
    const day = new Date(selectedSchedule.date);
    const dayStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    try {
      const res = await scheduleService.markTutorUnavailability({
        tutorId: selectedSchedule.tutor._id,
        startDate: dayStr,
        endDate: dayStr,
        reason: "Marked unavailable by admin",
        autoAssign: true,
      });
      if (res.data?.success) {
        const reassignedCount = Array.isArray(res.data?.reassigned) ? res.data.reassigned.length : 0;
        const unresolvedCount = Array.isArray(res.data?.unresolved) ? res.data.unresolved.length : 0;
        toast.success(`Unavailability saved. Reassigned: ${reassignedCount}, unresolved: ${unresolvedCount}.`);
        fetchSchedules();
      } else {
        toast.error(res.data?.message || "Failed to mark tutor unavailable");
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to mark tutor unavailable";
      toast.error(msg);
    }
  };

  const handleCleanupDuplicates = async () => {
    try {
      const res = await scheduleService.cleanupDuplicates();
      if (res.data?.success) {
        const report = res.data?.report || {};
        toast.success(
          `Cleanup complete: ${report.archivedUsers || 0} users archived, ${report.removedSchedules || 0} duplicate schedules removed, ${report.cancelledEnrollments || 0} duplicate enrollments cancelled.`
        );
        fetchSchedules();
        fetchUsers();
        fetchEnrollments();
      } else {
        toast.error(res.data?.message || "Duplicate cleanup failed");
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Duplicate cleanup failed";
      toast.error(msg);
    }
  };

  const handleEnrollStudentToSelectedSchedule = async () => {
    if (!selectedSchedule?._id || scheduleEnrollmentSelectedStudentIds.length === 0) {
      toast.error("Select a child first.");
      return;
    }

    const isOneOnOneSession = selectedSchedule.sessionType === "one-on-one" || !selectedSchedule.sessionType;
    if (isOneOnOneSession && scheduleEnrollmentSelectedStudentIds.length > 1) {
      toast.error("A 1-on-1 session can have only one child.");
      return;
    }
    if (scheduleEnrollmentOverride && !scheduleEnrollmentOverrideReason.trim()) {
      toast.error("Enter a reason before overriding the parent preferred date or time.");
      return;
    }

    const idsToEnroll = isOneOnOneSession
      ? [scheduleEnrollmentSelectedStudentIds[0]]
      : [...scheduleEnrollmentSelectedStudentIds];

    setScheduleEnrollmentSaving(true);
    setScheduleCompatibleSlots([]);
    try {
      let successCount = 0;
      let failedCount = 0;
      let lastUpdated: AdminSchedule | undefined;
      let lastError = "";

      for (const enrollmentId of idsToEnroll) {
        try {
          const res = await scheduleService.enrollStudent(selectedSchedule._id, {
            enrollmentId,
            overridePreference: scheduleEnrollmentOverride,
            overrideReason: scheduleEnrollmentOverrideReason.trim(),
          });
          if (res.data?.success) {
            successCount += 1;
            lastUpdated = (res.data as { schedule?: AdminSchedule }).schedule;
          } else {
            failedCount += 1;
            lastError = res.data?.message || lastError;
          }
        } catch (err: unknown) {
          failedCount += 1;
          const data = (err as { response?: { data?: { message?: string; code?: string; compatibleSlots?: Array<{ _id: string; date: string; startTime: string; endTime: string; tutorName?: string }> } } })?.response?.data;
          lastError = data?.message || lastError;
          if (data?.code === "PARENT_PREFERENCE_CONFLICT") {
            setScheduleCompatibleSlots(Array.isArray(data.compatibleSlots) ? data.compatibleSlots : []);
            setScheduleEnrollmentOverride(true);
          }
        }
      }

      if (lastUpdated) {
        setSelectedSchedule(lastUpdated);
        setSchedules((prev) => prev.map((item) => (item._id === lastUpdated!._id ? lastUpdated! : item)));
      } else {
        fetchSchedules();
      }

      if (successCount > 0) {
        setScheduleEnrollmentSelectedStudentIds([]);
        setScheduleEnrollmentOverride(false);
        setScheduleEnrollmentOverrideReason("");
        setScheduleCompatibleSlots([]);
      }

      if (successCount > 0 && failedCount === 0) {
        toast.success(isOneOnOneSession ? "Child assigned to this tutor session." : `${successCount} child${successCount > 1 ? "ren" : ""} added to this playgroup.`);
      } else if (successCount > 0 && failedCount > 0) {
        toast.error(`${successCount} assigned, ${failedCount} could not be assigned. ${lastError}`.trim());
      } else {
        toast.error(lastError || "Could not assign the selected child.");
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || "Could not assign the selected child.";
      toast.error(msg);
    } finally {
      setScheduleEnrollmentSaving(false);
    }
  };

  const handleRemoveStudentFromSelectedSchedule = async (studentId: string) => {
    if (!selectedSchedule?._id || !studentId) return;
    setScheduleEnrollmentSaving(true);
    try {
      const res = await scheduleService.removeStudent(selectedSchedule._id, studentId);
      if (res.data?.success) {
        const updated = (res.data as { schedule?: AdminSchedule }).schedule;
        if (updated) {
          setSelectedSchedule(updated);
          setSchedules((prev) => prev.map((item) => (item._id === updated._id ? updated : item)));
        } else {
          fetchSchedules();
        }
        toast.success("Student removed from session.");
      } else {
        toast.error(res.data?.message || "Failed to remove student.");
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || "Failed to remove student.";
      toast.error(msg);
    } finally {
      setScheduleEnrollmentSaving(false);
    }
  };

  const fetchAdminPayments = () => {
    setPaymentsLoading(true);
    paymentService
      .getAdminPayments()
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.payments)) {
          setAdminPayments(res.data.payments);
        } else {
          setAdminPayments([]);
        }
      })
      .catch(() => setAdminPayments([]))
      .finally(() => setPaymentsLoading(false));
  };
  useEffect(() => {
    fetchAdminPayments();
  }, []);

  useEffect(() => {
    if (!viewEnrollmentId) {
      setViewEnrollmentData(null);
      return;
    }
    setViewEnrollmentLoading(true);
    enrollmentService
      .getEnrollmentById(viewEnrollmentId)
      .then((res) => {
        if (res.data?.success && res.data?.enrollment) {
          setViewEnrollmentData({
            enrollment: res.data.enrollment,
            payments: res.data.payments || [],
          });
        }
      })
      .catch(() => {
        toast.error("Failed to load enrollment details");
        setViewEnrollmentId(null);
      })
      .finally(() => setViewEnrollmentLoading(false));
  }, [viewEnrollmentId]);

  const handleAcceptEnrollment = async (enrollmentId: string) => {
    setVerifyingId(enrollmentId);
    try {
      const res = await enrollmentService.approveEnrollment(enrollmentId);
      if (res.data?.success) {
        toast.success("Enrollment approved. Student account activated.");
        fetchEnrollments(); fetchUsers(); fetchDashboardStats();
        setViewEnrollmentId(null);
      } else {
        toast.error(res.data?.message || "Failed to approve enrollment");
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to approve enrollment";
      toast.error(msg);
    } finally { setVerifyingId(null); }
  };

  const openRejectDialog = (enrollmentId: string) => {
    setRejectEnrollmentId(enrollmentId);
    setRejectReason('');
    setRejectAllowResubmit(true);
  };

  const handleConfirmReject = async () => {
    if (!rejectEnrollmentId) return;
    if (!rejectReason.trim()) { toast.error("Please provide a rejection reason."); return; }
    setRejectLoading(true);
    try {
      const res = await enrollmentService.rejectEnrollment(rejectEnrollmentId, rejectReason, rejectAllowResubmit);
      if (res.data?.success) {
        toast.success("Enrollment rejected and parent notified.");
        fetchEnrollments(); fetchUsers(); fetchDashboardStats();
        setRejectEnrollmentId(null); setViewEnrollmentId(null);
      } else { toast.error(res.data?.message || "Failed to reject"); }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to reject enrollment";
      toast.error(msg);
    } finally { setRejectLoading(false); }
  };

  const handleRejectEnrollment = (enrollmentId: string) => openRejectDialog(enrollmentId);

  const openVerifyPaymentDialog = (enrollmentId: string, paymentId: string) => {
    setVerifyPaymentTarget({ enrollmentId, paymentId });
    setVerifyPaymentNote('');
    setVerifyPaymentDialogOpen(true);
  };

  const handleConfirmVerifyPayment = async (verified: boolean) => {
    if (!verifyPaymentTarget) return;
    setVerifyPaymentLoading(true);
    try {
      const res = await enrollmentService.verifyEnrollmentPayment(verifyPaymentTarget.enrollmentId, verified, verifyPaymentNote || undefined);
      if (res.data?.success) {
        toast.success(verified ? "Payment verified." : "Payment rejected.");
        setVerifyPaymentDialogOpen(false);
        setViewEnrollmentId((prev) => { if (prev) handleViewEnrollment(prev); return prev; });
        fetchEnrollments(); fetchAdminPayments(); fetchDashboardStats();
      } else { toast.error(res.data?.message || "Action failed"); }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Action failed";
      toast.error(msg);
    } finally { setVerifyPaymentLoading(false); }
  };

  const resolvePaymentProofUrl = (src?: string) => {
    const raw = String(src || "").trim();
    if (!raw) return "";
    if (/^(?:https?:|data:|blob:)/i.test(raw)) return raw;
    if (raw.startsWith("/")) return `${uploadsBaseUrl}${raw}`;
    return `${uploadsBaseUrl}/${raw.replace(/^\/+/, "")}`;
  };

  const openPaymentProof = (src?: string, reference?: string) => {
    if (!src) return;
    const normalizedSrc = resolvePaymentProofUrl(src);
    if (!normalizedSrc) return;
    setPaymentProofPreview({
      src: normalizedSrc,
      reference: reference || "Payment proof",
    });
    setPaymentProofZoomed(false);
  };

  const handlePaymentVerification = async (paymentId: string, verified: boolean, rejectionReason?: string) => {
    setVerifyingPaymentId(paymentId);
    try {
      const res = await paymentService.verifyPayment(paymentId, verified, rejectionReason);
      if (res.data?.success) {
        toast.success(verified ? "Payment verified." : "Payment rejected.");
        fetchAdminPayments();
        fetchEnrollments();
        fetchUsers();
        fetchDashboardStats();
      } else {
        toast.error(res.data?.message || (verified ? "Failed to verify" : "Failed to reject"));
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? (verified ? "Failed to verify" : "Failed to reject");
      toast.error(msg);
    } finally {
      setVerifyingPaymentId(null);
    }
  };

  const confirmPendingUserAction = async () => {
    if (!pendingUserAction) return;

    const currentAction = pendingUserAction;
    setPendingUserAction(null);

    if (currentAction.type === "archive") {
      const adminUser = currentAction.user;
      try {
        const res = await userService.deleteUser(adminUser._id);
        if (res.data?.success) {
          replaceUserInState(
            res.data.user ?? {
              ...adminUser,
              isArchived: true,
              isActive: false,
              archivedAt: new Date().toISOString(),
              ...(adminUser.role === "student" ? { enrollmentStatus: "cancelled" } : {}),
            }
          );
          setUsersCategory("archived");
          toast.success("User archived successfully.");
          fetchDashboardStats();
        } else {
          toast.error(res.data?.message || "Failed to archive user.");
        }
      } catch (err: unknown) {
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Failed to archive user.";
        toast.error(msg);
      }
      return;
    }

    if (currentAction.type === "unarchive") {
      const adminUser = currentAction.user;
      try {
        const res = await userService.unarchiveUser(adminUser._id);
        if (res.data?.success) {
          replaceUserInState(
            res.data.user ?? {
              ...adminUser,
              isArchived: false,
              isActive: true,
              archivedAt: undefined,
              ...(adminUser.role === "student" && adminUser.enrollmentStatus === "cancelled"
                ? { enrollmentStatus: "payment_rejected" }
                : {}),
            }
          );
          toast.success("User unarchived successfully.");
          if (currentAction.closeDetails || archivedUserDetail?._id === adminUser._id) {
            setArchivedUserDetail(null);
          }
          setUsersCategory("active");
          fetchDashboardStats();
        } else {
          toast.error(res.data?.message || "Failed to unarchive user.");
        }
      } catch (err: unknown) {
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Failed to unarchive user.";
        toast.error(msg);
      }
      return;
    }

    const adminUser = currentAction.user;
    try {
      const res = await userService.permanentlyDeleteUser(adminUser._id);
      if (res.data?.success) {
        removeUserFromState(adminUser._id);
        toast.success("Archived user deleted successfully.");
        if (currentAction.closeDetails || archivedUserDetail?._id === adminUser._id) {
          setArchivedUserDetail(null);
        }
        fetchDashboardStats();
      } else {
        toast.error(res.data?.message || "Failed to delete archived user.");
      }
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Failed to delete archived user.";
      toast.error(msg);
    }
  };

  const handleArchiveUser = (adminUser: AdminUser) => {
    setPendingUserAction({ type: "archive", user: adminUser });
  };

  const handleUnarchiveUser = (adminUser: AdminUser, closeDetails = false) => {
    setPendingUserAction({ type: "unarchive", user: adminUser, closeDetails });
  };

  const handleDeleteArchivedUser = (adminUser: AdminUser, closeDetails = false) => {
    setPendingUserAction({ type: "delete", user: adminUser, closeDetails });
  };

  const handleViewEnrollment = (enrollmentId: string) => {
    setViewEnrollmentId(enrollmentId);
    setViewEnrollmentData(null);
  };

  const hashToTab: Record<string, string> = {
    "#enrollments": "enrollments",
    "#payments": "payments",
    "#reports": "reports",
    "#schedule": "schedule",
    "#users": "users",
    "#announcements": "announcements",
    "#audit-logs": "audit-logs",
    "#activity": "activity",
  };
  // Use window.location.hash as fallback - React Router's location.hash can be empty in some cases
  const [hash, setHash] = useState(() => (location as { hash?: string }).hash || window.location.hash || "");
  useEffect(() => {
    const h = (location as { hash?: string }).hash || window.location.hash || "";
    setHash(h);
  }, [location.hash]);
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash || "");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const currentHash = hash;
  const activeTab = hashToTab[currentHash] || "overview";

  const fetchAnnouncements = () => {
    setAnnouncementsLoading(true);
    announcementService
      .getForAdmin()
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
      materials: "Materials",
      reschedule: "Reschedule",
      reminder: "Reminder",
      suspension: "Class Suspension",
      maintenance: "Maintenance",
      holiday: "Holiday",
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

  const toDateInputValue = (value?: string | null) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  };

  const openCreateAdminAnnouncement = () => {
    setEditingAdminAnnouncementId(null);
    setAdminAnnouncementForm({ title: "", body: "", category: "suspension", scheduledDate: "" });
    setAdminAnnouncementOpen(true);
  };

  const openEditAdminAnnouncement = (announcement: AnnouncementItem) => {
    setEditingAdminAnnouncementId(announcement._id);
    setAdminAnnouncementForm({
      title: announcement.title || "",
      body: announcement.body || "",
      category: announcement.category || "general",
      scheduledDate: toDateInputValue(announcement.scheduledDate),
    });
    setAdminAnnouncementOpen(true);
  };

  const handleDeleteAnnouncement = async (announcement: AnnouncementItem) => {
    if (!window.confirm(`Delete announcement "${announcement.title}"?`)) return;
    try {
      const res = await announcementService.delete(announcement._id);
      if (res.data?.success) {
        toast.success("Announcement deleted.");
        if (editingAdminAnnouncementId === announcement._id) {
          setEditingAdminAnnouncementId(null);
          setAdminAnnouncementOpen(false);
          setAdminAnnouncementForm({ title: "", body: "", category: "suspension", scheduledDate: "" });
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

  const handleApproveAnnouncement = async (id: string) => {
    try {
      const res = await announcementService.approve(id);
      if (res.data?.success) {
        toast.success("Approved. Students have been notified by email.");
        fetchAnnouncements();
      } else {
        const message = (res.data as { message?: string } | undefined)?.message;
        toast.error(message || "Failed to approve.");
      }
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || "Failed to approve.";
      toast.error(msg);
    }
  };

  const handleRejectAnnouncement = async (id: string) => {
    try {
      const res = await announcementService.reject(id);
      if (res.data?.success) {
        toast.success("Rejected.");
        fetchAnnouncements();
      } else {
        const message = (res.data as { message?: string } | undefined)?.message;
        toast.error(message || "Failed to reject.");
      }
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || "Failed to reject.";
      toast.error(msg);
    }
  };

  useEffect(() => {
    if (currentHash === "#announcements" || activeTab === "overview") fetchAnnouncements();
  }, [currentHash, activeTab]);

  const [auditLogs, setAuditLogs] = useState<AuditLogAdminItem[]>([]);
  const [auditLogsLoading, setAuditLogsLoading] = useState(false);
  const [auditFilters, setAuditFilters] = useState({ module: "all", status: "all", userId: "", startDate: "", endDate: "" });
  const [activityLogs, setActivityLogs] = useState<AuditLogItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  const fetchAuditLogs = () => {
    setAuditLogsLoading(true);
    auditLogService
      .getForAdmin({
        ...(auditFilters.module && auditFilters.module !== "all" && { module: auditFilters.module }),
        ...(auditFilters.status && auditFilters.status !== "all" && { status: auditFilters.status }),
        ...(auditFilters.userId && { userId: auditFilters.userId }),
        ...(auditFilters.startDate && { startDate: auditFilters.startDate }),
        ...(auditFilters.endDate && { endDate: auditFilters.endDate }),
        limit: 200,
      })
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.logs)) {
          setAuditLogs(res.data.logs);
        } else {
          setAuditLogs([]);
        }
      })
      .catch(() => setAuditLogs([]))
      .finally(() => setAuditLogsLoading(false));
  };

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
    if (currentHash === "#audit-logs") fetchAuditLogs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHash, auditFilters.module, auditFilters.status, auditFilters.userId, auditFilters.startDate, auditFilters.endDate]);

  useEffect(() => {
    if (currentHash === "#activity") fetchActivity();
  }, [currentHash]);

  const handleTabChange = (value: string) => {
    navigate(`${dashboardBasePath}#${value}`, { replace: true });
  };

  const roleColors: Record<string, string> = {
    student: "bg-primary/10 text-primary",
    tutor: "bg-info/10 text-info",
    admin: "bg-warning/10 text-warning",
    super_admin: "bg-violet-100 text-violet-700",
    parent: "bg-rose-100 text-rose-700",
  };

  const formatRoleLabel = (role?: string | null) => {
    if (!role) return "—";
    if (role === "parent") return "Parent/Guardian";
    if (role === "super_admin") return "Super Admin";
    return role.charAt(0).toUpperCase() + role.slice(1);
  };

  const formatSlotTime = (hhmm: string) => {
    if (!hhmm) return "";
    const [h, m] = hhmm.split(":").map(Number);
    const h12 = h % 12 || 12;
    const ampm = h < 12 ? "AM" : "PM";
    return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  };

  const addDays = (date: Date, days: number) => {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  };

  const toDateKey = (date: Date) => {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };

  const scheduleDateOnly = (d: string | Date) => {
    if (typeof d === "string") {
      const isoMatch = d.match(/^(\d{4}-\d{2}-\d{2})/);
      if (isoMatch?.[1]) {
        return isoMatch[1];
      }
    }
    const x = typeof d === "string" ? new Date(d) : d;
    if (Number.isNaN(x.getTime())) return "";
    const y = x.getUTCFullYear();
    const m = x.getUTCMonth();
    const day = x.getUTCDate();
    return `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  const todayStrLocal = useMemo(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  }, []);
  const todaySchedulesCount = schedules.filter((s) => scheduleDateOnly(s.date) === todayStrLocal).length;
  const allPaymentsList = adminPayments;
  const pendingPaymentsList = allPaymentsList.filter((payment) => payment.status === "submitted");
  const paymentHistoryList = allPaymentsList;

  const derivedStudentCount = useMemo(
    // Count approved enrollments — children are not separate User accounts
    () => enrollments.filter((e) => e.status === "approved" || e.status === "active").length,
    [enrollments]
  );
  const derivedTutorCount = useMemo(
    () => users.filter((u) => u.role === "tutor" && u.isArchived !== true && u.isActive !== false).length,
    [users]
  );
  const derivedActiveClassCount = useMemo(() => {
    const activeSubjectIds = new Set<string>();
    enrollments.forEach((enrollment) => {
      if (enrollment.status === "cancelled") return;
      enrollment.selectedSubjects?.forEach((subject) => {
        if (subject?._id) {
          activeSubjectIds.add(subject._id);
        }
      });
    });
    return activeSubjectIds.size;
  }, [enrollments]);
  const derivedMonthlyRevenue = useMemo(() => {
    const now = new Date();
    const month = now.getMonth();
    const year = now.getFullYear();

    return allPaymentsList.reduce((sum, payment) => {
      if (payment.status !== "verified") return sum;
      const rawDate = payment.verifiedAt || payment.createdAt;
      if (!rawDate) return sum;
      const paymentDate = new Date(rawDate);
      if (paymentDate.getFullYear() !== year || paymentDate.getMonth() !== month) {
        return sum;
      }
      return sum + (payment.amount || 0);
    }, 0);
  }, [allPaymentsList]);
  const resolvedDashboardStats = useMemo<DashboardStats>(() => ({
    totalStudents: Math.max(dashboardStats?.totalStudents ?? 0, derivedStudentCount),
    activeTutors: Math.max(dashboardStats?.activeTutors ?? 0, derivedTutorCount),
    pendingEnrollments: dashboardStats?.pendingEnrollments ?? enrollments.filter((e) => ['submitted', 'payment_under_verification', 'pending_approval', 'pending'].includes(e.status)).length,
    monthlyRevenue: Math.max(dashboardStats?.monthlyRevenue ?? 0, derivedMonthlyRevenue),
  }), [dashboardStats, enrollments, derivedMonthlyRevenue, derivedStudentCount, derivedTutorCount]);
  const summaryLoading = statsLoading && usersLoading && enrollmentsLoading && paymentsLoading;

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
    const map: Record<string, AdminSchedule[]> = {};
    for (const s of schedules) {
      const key = scheduleDateOnly(s.date);
      if (!map[key]) map[key] = [];
      map[key].push(s);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
    }
    return map;
  }, [schedules]);

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
    return schedules.filter((s) => weekKeys.has(scheduleDateOnly(s.date)));
  }, [schedules, weeklyDateKeys]);

  const schedulesByWeeklyDay = useMemo(() => {
    const map: Record<number, AdminSchedule[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    weeklyDateKeys.forEach((entry) => {
      map[entry.dayKey] = (schedulesByDate[entry.dateKey] || []).slice().sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
    });
    return map;
  }, [weeklyDateKeys, schedulesByDate]);

  const weeklyPlannerDateByDay = useMemo(() => {
    const map: Record<number, string> = {};
    weeklyDateKeys.forEach((entry) => {
      map[entry.dayKey] = entry.dateKey;
    });
    return map;
  }, [weeklyDateKeys]);

  const weeklyPlannerTutorNameById = useMemo(() => {
    const map: Record<string, string> = {};
    weeklyPlannerTutors.forEach((tutor) => {
      map[tutor._id] = [tutor.firstName, tutor.middleName, tutor.lastName].filter(Boolean).join(" ") || tutor.email || "Tutor";
    });
    return map;
  }, [weeklyPlannerTutors]);

  const weeklyPlannerSubjectNameById = useMemo(() => {
    const map: Record<string, string> = {};
    weeklyPlannerSubjects.forEach((subject) => {
      map[subject._id] = subject.name;
    });
    return map;
  }, [weeklyPlannerSubjects]);

  const selectedWeeklyPlannerSubject = useMemo(
    () => weeklyPlannerSubjects.find((subject) => subject._id === weeklyPlannerForm.subjectId),
    [weeklyPlannerForm.subjectId, weeklyPlannerSubjects]
  );

  const selectedWeeklyPlannerTutors = useMemo(() => {
    const ids = weeklyPlannerForm.sessionType === "playgroup"
      ? weeklyPlannerForm.tutorIds
      : (weeklyPlannerForm.tutorId ? [weeklyPlannerForm.tutorId] : []);
    return weeklyPlannerTutors.filter((tutor) => ids.includes(tutor._id));
  }, [weeklyPlannerForm.sessionType, weeklyPlannerForm.tutorId, weeklyPlannerForm.tutorIds, weeklyPlannerTutors]);

  const availableDaysForSelectedTutor = useMemo(() => {
    if (selectedWeeklyPlannerTutors.length === 0) {
      return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    }
    return selectedWeeklyPlannerTutors.reduce<string[]>((days, tutor, index) => {
      const tutorDays = getAvailableDaysForTutor(tutor.employmentType, tutor.availability);
      return index === 0 ? tutorDays : days.filter((day) => tutorDays.includes(day));
    }, []);
  }, [selectedWeeklyPlannerTutors]);

  const availableSchedulingDayKeys = useMemo(() => {
    return getAvailableSchedulingDayKeys(availableDaysForSelectedTutor);
  }, [availableDaysForSelectedTutor]);

  const availableTimeSlotsForSelectedTutor = useMemo(() => {
    const validStarts = weeklyPlannerForm.sessionType === "playgroup" ? ["08:00", "13:00"] : ["08:00", "10:00", "13:00", "15:00"];
    if (selectedWeeklyPlannerTutors.length === 0 || weeklyPlannerSelectedDays.length === 0) {
      return validStarts;
    }
    const [firstDay] = [...weeklyPlannerSelectedDays].sort((a, b) => a - b);
    const dayInfo = SCHEDULING_DAYS.find((d) => d.key === firstDay);
    if (!dayInfo) return validStarts;

    const dayName = dayInfo.name.slice(0, 3);
    return validStarts.filter((time) =>
      selectedWeeklyPlannerTutors.every((tutor) => {
        const availability = getAvailabilityForDay(tutor.employmentType, tutor.availability, dayName);
        return availability ? isTimeInRange(time, availability.start, availability.end) : false;
      })
    );
  }, [selectedWeeklyPlannerTutors, weeklyPlannerSelectedDays, weeklyPlannerForm.sessionType]);

  const isToddlerPlaygroupSubject = useMemo(() => {
    const subjectName = (selectedWeeklyPlannerSubject?.name || "").toLowerCase();
    return subjectName.includes("toddler") || subjectName.includes("playgroup");
  }, [selectedWeeklyPlannerSubject]);

  const availableSessionTypeOptions = useMemo(() => {
    if (isToddlerPlaygroupSubject) {
      return SESSION_TYPE_OPTIONS.filter((sessionType) => sessionType.value === "playgroup");
    }
    return SESSION_TYPE_OPTIONS.filter((sessionType) => sessionType.value === "one-on-one");
  }, [isToddlerPlaygroupSubject]);

  const getPlannerRoomForSessionType = (sessionType: SessionTypeValue) => {
    const targetAreaType = sessionType === "playgroup" ? "toddler_room" : "tutoring_area";
    return weeklyPlannerAreas.find((area) => area.areaType === targetAreaType);
  };

  useEffect(() => {
    if (isToddlerPlaygroupSubject && weeklyPlannerForm.sessionType !== "playgroup") {
      setWeeklyPlannerForm((prev) => ({ ...prev, sessionType: "playgroup" }));
      return;
    }
    if (!isToddlerPlaygroupSubject && weeklyPlannerForm.sessionType === "playgroup") {
      setWeeklyPlannerForm((prev) => ({ ...prev, sessionType: "one-on-one" }));
    }
  }, [isToddlerPlaygroupSubject, weeklyPlannerForm.sessionType]);

  const toSessionRoomType = (session: AdminSchedule): "tutoring_area" | "toddler_room" => {
    const areaType =
      typeof session.tutoringAreaId === "object" && session.tutoringAreaId && "areaType" in session.tutoringAreaId
        ? session.tutoringAreaId.areaType
        : undefined;
    if (areaType === "toddler_room") return "toddler_room";
    if (areaType === "tutoring_area") return "tutoring_area";
    return session.sessionType === "playgroup" ? "toddler_room" : "tutoring_area";
  };

  const addWeeklyPlannerAssignment = () => {
    const nextErrors: string[] = [];
    const { tutorId, tutorIds: selectedTutorIds, subjectId, sessionType, startTime, endTime } = weeklyPlannerForm;
    const tutorIds = (sessionType === "playgroup" ? selectedTutorIds : [tutorId]).filter(Boolean);
    const primaryTutorId = tutorIds[0] || tutorId;
    const targetDayKeys = [...weeklyPlannerSelectedDays].sort((a, b) => a - b);

    if (!subjectId) nextErrors.push("Choose a program first.");
    if (!startTime || !endTime) nextErrors.push("Choose a start time. End time is filled automatically.");
    if (sessionType === "playgroup") {
      // For playgroup slot creation (before children are enrolled):
      // require at least 1 tutor; max 4 (the absolute max for 10 children at ratio ceil(10/3)=4).
      // The exact required count is validated again at enrollment time based on actual child count.
      if (tutorIds.length < 1) {
        nextErrors.push("Select at least 1 tutor for this Toddlers Playgroup slot. Required tutors will be validated when children are enrolled.");
      } else if (tutorIds.length > 4) {
        nextErrors.push(`Maximum 4 tutors for a Toddlers Playgroup session (${tutorIds.length} selected).`);
      }
    } else if (!tutorIds.length) {
      nextErrors.push("Choose 1 tutor for this 1-on-1 session.");
    }

    if (targetDayKeys.length === 0) {
      nextErrors.push("Please select at least one day (Mon-Sat).");
    }

    if (startTime && endTime && startTime >= endTime) {
      nextErrors.push("End time must be after start time.");
    }

    const assignedRoom = getPlannerRoomForSessionType(sessionType);
    if (!assignedRoom) {
      nextErrors.push(
        sessionType === "playgroup"
          ? "Toddler room is not configured yet. Please create an active toddler room."
          : "Tutoring area is not configured yet. Please create an active tutoring area."
      );
    }

    for (const dayKey of targetDayKeys) {
      const dayLabel = SCHEDULING_DAYS.find((day) => day.key === dayKey)?.name || "selected day";
      const localDayDraft = weeklyPlannerDraft[dayKey] || [];

      if (localDayDraft.some((entry) => entry.tutorIds.some((assignedTutorId) => tutorIds.includes(assignedTutorId)) && overlapsTimeRange(startTime, endTime, entry.startTime, entry.endTime))) {
        nextErrors.push(`Tutor already scheduled at this time for ${dayLabel}`);
      }

      if (assignedRoom?.areaType === "tutoring_area") {
        const sameSlotTutoringArea = localDayDraft.filter(
          (entry) => entry.roomType === "tutoring_area" && overlapsTimeRange(startTime, endTime, entry.startTime, entry.endTime)
        ).length;
        if (sameSlotTutoringArea >= 15) {
          nextErrors.push(`Maximum tutor capacity reached (15) for ${dayLabel}`);
        }
      }

      const selectedDateKey = weeklyPlannerDateByDay[dayKey];
      const existingDaySchedules = selectedDateKey ? schedulesByDate[selectedDateKey] || [] : [];

      const hasExistingTutorConflict = existingDaySchedules.some((session) => {
        const existingTutorId = typeof session.tutor === "object" ? session.tutor?._id : undefined;
        const existingTutorIds = session.tutors?.map((tutor) => typeof tutor === "object" ? tutor._id : tutor) || (existingTutorId ? [existingTutorId] : []);
        return existingTutorIds.some((existingId) => tutorIds.includes(existingId || "")) && overlapsTimeRange(startTime, endTime, session.startTime || "", session.endTime || "");
      });

      if (hasExistingTutorConflict) {
        nextErrors.push(`Tutor already has an existing session on ${dayLabel}`);
      }

      const existingSameRoomCount = existingDaySchedules.filter((session) => {
        return toSessionRoomType(session) === (assignedRoom?.areaType || "tutoring_area") && overlapsTimeRange(startTime, endTime, session.startTime || "", session.endTime || "");
      }).length;

      if (assignedRoom?.areaType === "tutoring_area" && existingSameRoomCount >= 15) {
        nextErrors.push(`Maximum tutoring-area capacity reached on ${dayLabel}`);
      }
    }

    if (nextErrors.length > 0) {
      setWeeklyPlannerErrors(Array.from(new Set(nextErrors)));
      return;
    }

    setWeeklyPlannerDraft((prev) => {
      const next = { ...prev };
      for (const dayKey of targetDayKeys) {
        const newEntry: WeeklyAssignmentDraft = {
          id: `${dayKey}-${primaryTutorId}-${subjectId}-${startTime}-${endTime}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          dayKey,
          tutorId: primaryTutorId,
          tutorIds,
          tutorName: tutorIds.map((id) => weeklyPlannerTutorNameById[id] || "Tutor").join(", "),
          subjectId,
          subjectName: weeklyPlannerSubjectNameById[subjectId] || "Subject",
          sessionType,
          startTime,
          endTime,
          roomId: assignedRoom!._id,
          roomName: assignedRoom!.name,
          roomType: assignedRoom!.areaType,
        };
        next[dayKey] = [...(next[dayKey] || []), newEntry].sort((a, b) => a.startTime.localeCompare(b.startTime));
      }
      return next;
    });
    setWeeklyPlannerErrors([]);
  };

  const removeWeeklyPlannerAssignment = (dayKey: number, assignmentId: string) => {
    setWeeklyPlannerDraft((prev) => ({
      ...prev,
      [dayKey]: (prev[dayKey] || []).filter((entry) => entry.id !== assignmentId),
    }));
  };

  const submitWeeklyPlanner = async () => {
    const allAssignments = SCHEDULING_DAYS.flatMap((day) => weeklyPlannerDraft[day.key] || []);
    if (allAssignments.length === 0) {
      setWeeklyPlannerErrors(["Please add at least one tutor assignment before generating sessions."]);
      return;
    }

    const weekStartDate = toDateKey(scheduleWeekStart);
    const templateName = `Weekly Plan ${weekStartDate}`;
    const scheduleEntries = allAssignments.map((entry) => ({
      dayOfWeek: SCHEDULING_DAYS.find((day) => day.key === entry.dayKey)?.templateDay ?? entry.dayKey - 1,
      startTime: entry.startTime,
      endTime: entry.endTime,
      tutorId: entry.tutorIds[0] || entry.tutorId,
      tutorIds: entry.tutorIds.length ? entry.tutorIds : [entry.tutorId],
      sessionType: entry.sessionType,
      tutoringAreaId: entry.roomId,
      subjectId: entry.subjectId,
    }));

    setWeeklyPlannerSubmitting(true);
    setWeeklyPlannerErrors([]);
    try {
      const createRes = await weeklyScheduleService.createTemplate({
        name: templateName,
        description: "Created from inline Scheduling Tab planner",
        effectiveStartDate: weekStartDate,
        scheduleEntries,
      });

      if (!createRes.data?.success || !createRes.data?.template?._id) {
        setWeeklyPlannerErrors([createRes.data?.message || "Failed to create weekly schedule template."]);
        return;
      }

      const templateId = createRes.data.template._id;
      const activateRes = await weeklyScheduleService.activateTemplate(templateId);
      if (!activateRes.data?.success) {
        setWeeklyPlannerErrors([activateRes.data?.message || "Failed to activate weekly schedule template."]);
        return;
      }

      const generateRes = await weeklyScheduleService.generateSessions(templateId, weekStartDate, scheduleGenerationMonthSpan);
      if (!generateRes.data?.success) {
        setWeeklyPlannerErrors([generateRes.data?.message || "Failed to generate sessions."]);
        return;
      }

      const generationErrors = Array.isArray(generateRes.data?.errors) ? generateRes.data.errors : [];
      if (generationErrors.length > 0) {
        setWeeklyPlannerErrors(generationErrors.slice(0, 4));
      }

      toast.success(generateRes.data?.message || `Sessions generated successfully for ${scheduleGenerationMonthSpan} month(s).`);
      setWeeklyPlannerDraft({ 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] });
      fetchSchedules();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || "Failed to generate weekly schedule sessions.";
      setWeeklyPlannerErrors([msg]);
    } finally {
      setWeeklyPlannerSubmitting(false);
    }
  };

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
  const calendarMonthKey = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, "0")}`;
  const scheduleMonthKeys = useMemo(() => {
    const monthSet = new Set<string>();
    schedules.forEach((scheduleItem) => {
      const dateKey = scheduleDateOnly(scheduleItem.date);
      if (dateKey) {
        monthSet.add(dateKey.slice(0, 7));
      }
    });
    monthSet.add(calendarMonthKey);
    return Array.from(monthSet).sort();
  }, [schedules, calendarMonthKey]);

  const formatMonthKeyLabel = (monthKey: string) => {
    const [yearRaw, monthRaw] = monthKey.split("-");
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    if (!Number.isInteger(year) || !Number.isInteger(month)) return monthKey;
    return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  };

  const scheduleMonthSpanLabel = useMemo(() => {
    if (scheduleMonthKeys.length === 0) return "No schedules yet";
    const first = scheduleMonthKeys[0];
    const last = scheduleMonthKeys[scheduleMonthKeys.length - 1];
    if (first === last) return formatMonthKeyLabel(first);
    return `${formatMonthKeyLabel(first)} - ${formatMonthKeyLabel(last)}`;
  }, [scheduleMonthKeys]);

  const thisMonthStart = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, "0")}-01`;
  const thisMonthEnd = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, "0")}-${String(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;
  const schedulesInCalendarMonth = useMemo(() => {
    return schedules.filter((s) => {
      const d = scheduleDateOnly(s.date);
      return d >= thisMonthStart && d <= thisMonthEnd;
    });
  }, [schedules, thisMonthStart, thisMonthEnd]);
  const schedulesThisMonth = schedulesInCalendarMonth.length;
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekStartStr = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, "0")}-${String(weekStart.getDate()).padStart(2, "0")}`;
  const weekEndStr = `${weekEnd.getFullYear()}-${String(weekEnd.getMonth() + 1).padStart(2, "0")}-${String(weekEnd.getDate()).padStart(2, "0")}`;
  const schedulesThisWeek = schedules.filter((s) => {
    const d = scheduleDateOnly(s.date);
    return d >= weekStartStr && d <= weekEndStr;
  }).length;

  const upcomingOverviewSessions = useMemo(() => {
    const now = new Date();

    const parseStartAt = (session: AdminSchedule) => {
      const dateKey = scheduleDateOnly(session.date);
      const baseDate = parseDateKeyToDate(dateKey);
      if (!baseDate) return null;

      const [hourRaw, minuteRaw] = String(session.startTime || "00:00").split(":");
      const hour = Number(hourRaw);
      const minute = Number(minuteRaw);
      const startAt = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0, 0, 0);
      return Number.isNaN(startAt.getTime()) ? null : startAt;
    };

    const mappedSessions = schedules
      .map((session) => {
        const startAt = parseStartAt(session);
        const tutorLabel = formatScheduleTutorNames(session);
        const studentLabel = formatScheduleStudentNames(session);

        return {
          _id: session._id,
          startAt,
          subject: session.subject?.name ?? "Session",
          tutor: tutorLabel === "—" ? "Unassigned tutor" : tutorLabel,
          student: studentLabel === "—" ? "Unassigned student" : studentLabel,
          timeLabel: `${formatSlotTime(session.startTime)} - ${formatSlotTime(session.endTime)}`,
          dateLabel: startAt
            ? startAt.toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              })
            : "Invalid date",
        };
      })
      .filter((session) => !!session.startAt)
      .sort((a, b) => (a.startAt!.getTime() - b.startAt!.getTime()));

    const futureSessions = mappedSessions.filter((session) => session.startAt!.getTime() >= now.getTime());
    if (futureSessions.length > 0) {
      return futureSessions.slice(0, 5);
    }

    // Fallback: still surface stored schedules so overview never looks empty when records exist.
    return mappedSessions.slice(0, 5);
  }, [schedules]);

  const pendingPaymentsSum = pendingPaymentsList.reduce((sum, p) => sum + (p.amount || 0), 0);
  const pendingPaymentsCount = pendingPaymentsList.length;
  const verifiedPaymentsCount = paymentHistoryList.filter((payment) => payment.status === "verified").length;
  const rejectedPaymentsCount = paymentHistoryList.filter((payment) => payment.status === "rejected").length;

  const reportSummary = useMemo(() => {
    const enrollmentTotal = enrollments.length;
    const enrollmentActive = enrollments.filter((e) => e.status === "active").length;
    const enrollmentPending = enrollments.filter((e) => e.status === "pending").length;
    const enrollmentCancelled = enrollments.filter((e) => e.status === "cancelled").length;

    const verifiedPayments = allPaymentsList.filter((p) => p.status === "verified");
    const verifiedRevenue = verifiedPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

    const activeUsers = users.filter((u) => u.isActive && !u.isArchived).length;
    const archivedUsers = users.filter((u) => u.isArchived).length;
    const roleCounts = users.reduce(
      (acc, userItem) => {
        if (userItem.role === "student") acc.students += 1;
        else if (userItem.role === "tutor") acc.tutors += 1;
        else if (userItem.role === "admin") acc.admins += 1;
        return acc;
      },
      { students: 0, tutors: 0, admins: 0 }
    );

    return {
      enrollmentTotal,
      enrollmentActive,
      enrollmentPending,
      enrollmentCancelled,
      verifiedRevenue,
      activeUsers,
      archivedUsers,
      roleCounts,
    };
  }, [allPaymentsList, enrollments, users]);

  const reportTopSubjects = useMemo(() => {
    const counts = new Map<string, number>();
    enrollments.forEach((enrollment) => {
      const names = (enrollment.selectedSubjects || [])
        .map((subject) => (subject?.name || "").trim())
        .filter(Boolean);
      names.forEach((name) => {
        counts.set(name, (counts.get(name) || 0) + 1);
      });
    });

    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [enrollments]);

  const reportPaymentBreakdown = useMemo(() => {
    const summary = {
      pending: { count: 0, total: 0 },
      submitted: { count: 0, total: 0 },
      verified: { count: 0, total: 0 },
      rejected: { count: 0, total: 0 },
    };

    allPaymentsList.forEach((payment) => {
      const key = payment.status as keyof typeof summary;
      if (!summary[key]) return;
      summary[key].count += 1;
      summary[key].total += payment.amount || 0;
    });

    return summary;
  }, [allPaymentsList]);

  const roleIcons: Record<string, typeof Users> = {
    student: GraduationCap,
    tutor: BookOpen,
    admin: Shield,
  };

  return (
    <DashboardLayout>
      <div className="min-h-screen bg-muted">
        <div className="container mx-auto px-4 py-8">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8"
          >
            <div>
              <h1 className="font-display text-2xl md:text-3xl font-bold text-foreground">
                {dashboardTitle}
              </h1>
              <p className="text-muted-foreground">{dashboardSubtitle}</p>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={() => handleExportAll(enrollments, users, allPaymentsList)}>
                <Download className="h-4 w-4 mr-2" />
                Export Report
              </Button>
              <Button className="btn-glow" onClick={() => handleTabChange("schedule")}>
                <Calendar className="h-4 w-4 mr-2" />
                Schedule
              </Button>
            </div>
          </motion.div>

          {/* Stats - fetched from database */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8"
          >
            <StatCard
              title="Enrolled Students"
              value={summaryLoading ? "—" : resolvedDashboardStats.totalStudents}
              icon={Users}
              variant="primary"
            />
            <StatCard
              title="Active Tutors"
              value={summaryLoading ? "—" : resolvedDashboardStats.activeTutors}
              icon={GraduationCap}
              variant="info"
            />
            <StatCard
              title="Pending Enrollments"
              value={summaryLoading ? "—" : resolvedDashboardStats.pendingEnrollments}
              icon={FileText}
              variant="success"
            />
            <StatCard
              title="Monthly Revenue"
              value={summaryLoading ? "—" : `₱${resolvedDashboardStats.monthlyRevenue.toLocaleString()}`}
              icon={PhilippinePeso}
              variant="warning"
            />
          </motion.div>

          {/* Tabs */}
          <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
            {/* Overview Tab */}
            <TabsContent value="overview" className="space-y-6">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="bg-card rounded-xl border border-border overflow-hidden"
              >
                <div className="p-4 border-b border-border flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-display font-bold text-lg text-foreground">Announcements Preview</h3>
                    <p className="text-sm text-muted-foreground">Recent notices at a glance below your summary cards.</p>
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
              </motion.div>

              <div className="grid lg:grid-cols-3 gap-6">
                {/* Revenue Chart */}
                <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="bg-card rounded-xl p-6 border border-border">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="font-display font-bold text-lg text-foreground">Revenue</h3>
                    <span className="text-success text-sm font-medium">
                      ₱{resolvedDashboardStats.monthlyRevenue.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-end justify-between gap-3 h-48">
                    <div className="flex-1 flex flex-col items-center gap-2">
                      <div className="w-full bg-muted rounded-t-lg relative overflow-hidden h-full min-h-[80px]">
                        <div
                          className="absolute bottom-0 left-0 right-0 bg-primary rounded-t-lg transition-all duration-700"
                          style={{ height: `${resolvedDashboardStats.monthlyRevenue ? Math.min(100, (resolvedDashboardStats.monthlyRevenue / 300000) * 100) : 0}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">{new Date().toLocaleString("default", { month: "short" })}</span>
                      <span className="text-[10px] text-muted-foreground">₱{(resolvedDashboardStats.monthlyRevenue / 1000).toFixed(0)}k</span>
                    </div>
                  </div>
                </motion.div>

                {/* Recent Enrollments */}
                <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="bg-card rounded-xl border border-border overflow-hidden">
                  <div className="p-4 border-b border-border flex items-center justify-between">
                    <h3 className="font-display font-bold text-lg text-foreground">Recent Enrollments</h3>
                    <Button variant="ghost" size="sm" onClick={() => handleTabChange("enrollments")}>View All <ChevronRight className="h-4 w-4 ml-1" /></Button>
                  </div>
                  <div className="divide-y divide-border">
                    {enrollmentsLoading ? (
                      <div className="flex items-center justify-center p-8">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : enrollments.slice(0, 5).length === 0 ? (
                      <div className="p-4 text-center text-sm text-muted-foreground">No enrollments yet</div>
                    ) : (
                      enrollments.slice(0, 5).map((enrollment) => {
                        const eAny = enrollment as Record<string, unknown>;
                        const snap = eAny.studentSnapshot as { firstName?: string; lastName?: string } | undefined;
                        const name = snap
                          ? `${snap.firstName || ''} ${snap.lastName || ''}`.trim()
                          : "—";
                        const initials = name !== "—" ? name.split(" ").map((n) => n[0]).join("").slice(0, 2) : "—";
                        const programs = (eAny.packages as { displayName?: string }[] | undefined)
                          ?.map((p) => p.displayName).join(", ") || enrollment.selectedSubjects?.map((s) => s.name).join(", ") || "—";
                        const status = enrollmentStatusLabel(enrollment.status);
                        return (
                          <div key={enrollment._id} className="flex items-center justify-between p-4 hover:bg-muted/50 transition-colors">
                            <div className="flex items-center gap-3">
                              <UserAvatar src={null} fallback={initials} size={8} />
                              <div>
                                <p className="font-medium text-sm text-foreground">{name}</p>
                                <p className="text-xs text-muted-foreground">{programs}</p>
                              </div>
                            </div>
                            <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                              status === "confirmed" ? "bg-success/10 text-success"
                                : status === "pending" ? "bg-warning/10 text-warning"
                                : status === "cancelled" ? "bg-destructive/10 text-destructive"
                                : "bg-info/10 text-info"
                            }`}>{status}</span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </motion.div>

                {/* Upcoming Sessions */}
                <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="bg-card rounded-xl border border-border overflow-hidden">
                  <div className="p-4 border-b border-border flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-display font-bold text-lg text-foreground">Upcoming Sessions</h3>
                      <p className="text-xs text-muted-foreground">Next classes across all tutors and students.</p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => handleTabChange("schedule")}>View All <ChevronRight className="h-4 w-4 ml-1" /></Button>
                  </div>
                  <div className="divide-y divide-border">
                    {schedulesLoading ? (
                      <div className="flex items-center justify-center p-8">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : upcomingOverviewSessions.length === 0 ? (
                      <div className="p-4 text-center text-sm text-muted-foreground">No upcoming sessions scheduled yet.</div>
                    ) : (
                      upcomingOverviewSessions.map((session) => (
                        <div key={session._id} className="p-4 hover:bg-muted/40 transition-colors">
                          <p className="font-medium text-sm text-foreground">{session.subject}</p>
                          <p className="text-xs text-muted-foreground">Tutor: {session.tutor}</p>
                          <p className="text-xs text-muted-foreground">Student: {session.student}</p>
                          <p className="text-xs text-muted-foreground mt-1">{session.timeLabel} • {session.dateLabel}</p>
                        </div>
                      ))
                    )}
                  </div>
                </motion.div>
              </div>

              {/* Quick Stats - from database */}
              <div className="grid sm:grid-cols-3 gap-4">
                <div className="bg-card rounded-xl p-6 border border-border">
                  <h4 className="text-sm text-muted-foreground mb-2">Today&apos;s Classes</h4>
                  <p className="text-3xl font-bold font-display text-foreground">{schedulesLoading ? "—" : todaySchedulesCount}</p>
                  <p className="text-sm text-muted-foreground mt-1">Sessions scheduled today (one room)</p>
                </div>
                <div className="bg-card rounded-xl p-6 border border-border">
                  <h4 className="text-sm text-muted-foreground mb-2">Pending Payments</h4>
                  <p className="text-3xl font-bold font-display text-foreground">₱{pendingPaymentsSum.toLocaleString()}</p>
                  <p className="text-sm text-muted-foreground mt-1">{pendingPaymentsCount} payment(s) pending verification</p>
                </div>
                <div className="bg-card rounded-xl p-6 border border-border">
                  <h4 className="text-sm text-muted-foreground mb-2">Total Schedules</h4>
                  <p className="text-3xl font-bold font-display text-foreground">{schedulesLoading ? "—" : schedules.length}</p>
                  <p className="text-sm text-muted-foreground mt-1">Student–tutor assignments</p>
                </div>
              </div>
            </TabsContent>

            {/* Enrollments Tab */}
            <TabsContent value="enrollments" className="space-y-6">
              {/* Status filter + search */}
              <div className="flex flex-wrap gap-2 items-center justify-between">
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { value: 'all',                      label: 'All' },
                    { value: 'submitted',                label: 'Submitted' },
                    { value: 'payment_under_verification', label: 'Payment Review' },
                    { value: 'pending_approval',         label: 'Pending Approval' },
                    { value: 'approved',                 label: 'Approved' },
                    { value: 'rejected',                 label: 'Rejected' },
                    { value: 'pending',                  label: 'Legacy Pending' },
                  ].map((f) => (
                    <button key={f.value} onClick={() => setEnrollmentStatusFilter(f.value)}
                      className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                        enrollmentStatusFilter === f.value
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-card border-border text-muted-foreground hover:border-primary/40'
                      }`}>
                      {f.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Input placeholder="Search by name or ID…" value={enrollmentSearch}
                    onChange={(e) => setEnrollmentSearch(e.target.value)} className="h-8 w-52 text-sm" />
                  <Button size="sm" onClick={() => setAddStudentOpen(true)}>Add Student</Button>
                </div>
              </div>

              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-muted">
                      <tr>
                        <th className="text-left p-3 text-xs font-semibold text-foreground uppercase tracking-wide">Enrollment ID</th>
                        <th className="text-left p-3 text-xs font-semibold text-foreground uppercase tracking-wide">Student</th>
                        <th className="text-left p-3 text-xs font-semibold text-foreground uppercase tracking-wide">Programs</th>
                        <th className="text-left p-3 text-xs font-semibold text-foreground uppercase tracking-wide">Payment</th>
                        <th className="text-left p-3 text-xs font-semibold text-foreground uppercase tracking-wide">Status</th>
                        <th className="text-left p-3 text-xs font-semibold text-foreground uppercase tracking-wide">Date</th>
                        <th className="text-left p-3 text-xs font-semibold text-foreground uppercase tracking-wide">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {enrollmentsLoading ? (
                        <tr><td colSpan={7} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" /></td></tr>
                      ) : enrollmentsError ? (
                        <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">{enrollmentsError}</td></tr>
                      ) : (() => {
                        const filtered = enrollments.filter((e) => {
                          const statusMatch = enrollmentStatusFilter === 'all' || e.status === enrollmentStatusFilter;
                          if (!statusMatch) return false;
                          if (!enrollmentSearch.trim()) return true;
                          const q = enrollmentSearch.toLowerCase();
                          const eAny = e as Record<string, unknown>;
                          const snap = eAny.studentSnapshot as { firstName?: string; lastName?: string } | undefined;
                          const eid = String(eAny.enrollmentId || '').toLowerCase();
                          const studentName = snap
                            ? `${snap.firstName || ''} ${snap.lastName || ''}`.toLowerCase()
                            : '';
                          const parentAny = eAny.parent as { firstName?: string; lastName?: string } | undefined;
                          const parentName = parentAny ? `${parentAny.firstName || ''} ${parentAny.lastName || ''}`.toLowerCase() : '';
                          return studentName.includes(q) || eid.includes(q) || parentName.includes(q);
                        });
                        if (filtered.length === 0) return (
                          <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">No enrollments match the selected filter.</td></tr>
                        );
                        return filtered.map((enrollment) => {
                          const eAny = enrollment as Record<string, unknown>;
                          const snap = eAny.studentSnapshot as { firstName?: string; lastName?: string } | undefined;
                          // Student name always comes from studentSnapshot — the child is not a separate User
                          const name = snap
                            ? `${snap.firstName || ''} ${snap.lastName || ''}`.trim()
                            : '—';
                          const packages = (eAny.packages as { displayName?: string }[] | undefined) || [];
                          const programsLabel = packages.length > 0
                            ? packages.map((p) => p.displayName || '').join(', ')
                            : enrollment.selectedSubjects?.map((s) => s.name).join(', ') || '—';
                          const enrollmentId = String(eAny.enrollmentId || enrollment._id);
                          const latestPayment = (eAny.latestPayment as { status?: string; paymentMethod?: string; amountDue?: number; _id?: string } | undefined);
                          const payMethod = latestPayment?.paymentMethod || '';
                          const payStatus = latestPayment?.status || enrollment.paymentStatus || 'pending';
                          const isActionable = ['submitted', 'payment_under_verification', 'pending_approval', 'pending'].includes(enrollment.status);
                          const statusColors: Record<string, string> = {
                            approved: 'bg-emerald-100 text-emerald-800', active: 'bg-emerald-100 text-emerald-800',
                            pending_approval: 'bg-purple-100 text-purple-800',
                            payment_under_verification: 'bg-amber-100 text-amber-800',
                            submitted: 'bg-blue-100 text-blue-800', pending: 'bg-blue-100 text-blue-800',
                            rejected: 'bg-red-100 text-red-800', cancelled: 'bg-gray-100 text-gray-700',
                            draft: 'bg-gray-100 text-gray-600',
                          };
                          const sc = statusColors[enrollment.status] || 'bg-muted text-muted-foreground';
                          return (
                            <tr key={enrollment._id} className="hover:bg-muted/40 transition-colors">
                              <td className="p-3 font-mono text-xs text-foreground">{enrollmentId !== enrollment._id ? enrollmentId : enrollment._id.slice(-8)}</td>
                              <td className="p-3 font-medium text-foreground">{name || '—'}</td>
                              <td className="p-3 text-xs text-muted-foreground max-w-[160px] truncate" title={programsLabel}>{programsLabel}</td>
                              <td className="p-3">
                                <div className="text-xs space-y-0.5">
                                  <span className={`px-2 py-0.5 rounded-full font-medium ${payStatus === 'verified' ? 'bg-emerald-100 text-emerald-800' : payStatus === 'submitted' ? 'bg-amber-100 text-amber-800' : payStatus === 'rejected' ? 'bg-red-100 text-red-800' : 'bg-muted text-muted-foreground'}`}>{payStatus}</span>
                                  {payMethod && <div className="text-muted-foreground">{payMethod}</div>}
                                </div>
                              </td>
                              <td className="p-3"><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sc}`}>{enrollment.status}</span></td>
                              <td className="p-3 text-xs text-muted-foreground">{formatEnrollmentDate(enrollment.enrollmentDate || enrollment.createdAt)}</td>
                              <td className="p-3">
                                <div className="flex items-center gap-1 flex-wrap">
                                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => handleViewEnrollment(enrollment._id)}>View</Button>
                                  {isActionable && enrollment.status !== 'approved' && enrollment.status !== 'rejected' && (
                                    <>
                                      {latestPayment?._id && (enrollment.status === 'submitted' || enrollment.status === 'payment_under_verification') && (
                                        <Button variant="outline" size="sm" className="h-7 text-xs text-amber-700 border-amber-300 hover:bg-amber-50"
                                          onClick={() => openVerifyPaymentDialog(enrollment._id, latestPayment._id!)}>
                                          Verify Pay
                                        </Button>
                                      )}
                                      {/* Approve is available at every actionable stage so admin is never blocked */}
                                      <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                                        disabled={verifyingId === enrollment._id}
                                        onClick={() => handleAcceptEnrollment(enrollment._id)}>
                                        {verifyingId === enrollment._id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 mr-1" />}Approve
                                      </Button>
                                      <Button variant="destructive" size="sm" className="h-7 text-xs"
                                        onClick={() => openRejectDialog(enrollment._id)}>
                                        <X className="h-3 w-3 mr-1" />Reject
                                      </Button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>
            </TabsContent>

            {/* Payments Tab - from database */}
            <TabsContent value="payments" className="space-y-6">
              <div className="grid sm:grid-cols-4 gap-4">
                <div className="bg-card rounded-xl p-4 border border-border">
                  <p className="text-sm text-muted-foreground">Total Collected (this month)</p>
                  <p className="text-2xl font-bold text-success">₱{resolvedDashboardStats.monthlyRevenue.toLocaleString()}</p>
                </div>
                <div className="bg-card rounded-xl p-4 border border-border">
                  <p className="text-sm text-muted-foreground">Pending Verification</p>
                  <p className="text-2xl font-bold text-warning">₱{pendingPaymentsSum.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground mt-1">{pendingPaymentsCount} payment(s)</p>
                </div>
                <div className="bg-card rounded-xl p-4 border border-border">
                  <p className="text-sm text-muted-foreground">Verified Transactions</p>
                  <p className="text-2xl font-bold text-foreground">{verifiedPaymentsCount}</p>
                  <p className="text-xs text-muted-foreground mt-1">For admin reference</p>
                </div>
                <div className="bg-card rounded-xl p-4 border border-border">
                  <p className="text-sm text-muted-foreground">Rejected Transactions</p>
                  <p className="text-2xl font-bold text-destructive">{rejectedPaymentsCount}</p>
                  <p className="text-xs text-muted-foreground mt-1">Review history retained</p>
                </div>
              </div>

              <Tabs defaultValue="pending" className="space-y-4">
                <TabsList className="grid w-full max-w-md grid-cols-2">
                  <TabsTrigger value="pending">Pending Review ({pendingPaymentsCount})</TabsTrigger>
                  <TabsTrigger value="history">Transaction History ({paymentHistoryList.length})</TabsTrigger>
                </TabsList>

                <TabsContent value="pending" className="mt-0">
                  <div className="bg-card rounded-xl border border-border overflow-hidden">
                    <div className="p-4 border-b border-border flex items-center justify-between">
                      <h3 className="font-display font-bold text-lg text-foreground">Pending Payment Verification</h3>
                      <span className="text-sm text-muted-foreground">{paymentsLoading ? "Loading..." : `${pendingPaymentsList.length} pending`}</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead className="bg-muted">
                          <tr>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Reference</th>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Student</th>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Amount</th>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Method</th>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Submitted</th>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Status</th>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {paymentsLoading ? (
                            <tr>
                              <td colSpan={7} className="p-8 text-center">
                                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mx-auto" />
                              </td>
                            </tr>
                          ) : pendingPaymentsList.length === 0 ? (
                            <tr>
                              <td colSpan={7} className="p-8 text-center text-muted-foreground">No payments pending verification.</td>
                            </tr>
                          ) : (
                            pendingPaymentsList.map((payment) => {
                              const studentName = (
                                [payment.student?.firstName, payment.student?.lastName].filter(Boolean).join(" ").trim()
                                || [payment.enrollment?.studentSnapshot?.firstName, payment.enrollment?.studentSnapshot?.lastName].filter(Boolean).join(" ").trim()
                                || [payment.parent?.firstName, payment.parent?.lastName].filter(Boolean).join(" ").trim()
                                || "—"
                              );
                              const dateLabel = payment.createdAt
                                ? new Date(payment.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
                                : "—";
                              const isVerifying = verifyingPaymentId === payment._id;
                              return (
                                <tr key={payment._id} className="hover:bg-muted/50 transition-colors">
                                  <td className="p-4 font-mono text-sm text-foreground">{payment.referenceNumber ?? payment._id}</td>
                                  <td className="p-4 text-foreground">{studentName}</td>
                                  <td className="p-4 font-semibold text-foreground">₱{(payment.amount || 0).toLocaleString()}</td>
                                  <td className="p-4 text-muted-foreground capitalize">{payment.paymentMethod === "blockchain" ? "Blockchain" : "GCash"}</td>
                                  <td className="p-4 text-muted-foreground">{dateLabel}</td>
                                  <td className="p-4">
                                    <span className="text-xs px-2 py-1 rounded-full font-medium bg-warning/10 text-warning">Pending review</span>
                                  </td>
                                  <td className="p-4">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      {(payment.proofUrl || payment.gcashDetails?.screenshotUrl) ? (
                                        <Button variant="outline" size="sm" onClick={() => openPaymentProof(payment.proofUrl || payment.gcashDetails?.screenshotUrl, payment.referenceNumber ?? payment._id)}>
                                          Proof
                                        </Button>
                                      ) : null}
                                      <Button variant="default" size="sm" disabled={isVerifying} onClick={() => handlePaymentVerification(payment._id, true)}>
                                        {isVerifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
                                        Verify
                                      </Button>
                                      <Button variant="ghost" size="sm" disabled={isVerifying} onClick={() => handlePaymentVerification(payment._id, false, "Rejected by admin") }>
                                        <X className="h-4 w-4" />
                                        Reject
                                      </Button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="history" className="mt-0">
                  <div className="bg-card rounded-xl border border-border overflow-hidden">
                    <div className="p-4 border-b border-border flex items-center justify-between">
                      <h3 className="font-display font-bold text-lg text-foreground">Transaction History</h3>
                      <span className="text-sm text-muted-foreground">{paymentsLoading ? "Loading..." : `${paymentHistoryList.length} transaction(s)`}</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead className="bg-muted">
                          <tr>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Reference</th>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Student</th>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Amount</th>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Method</th>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Submitted</th>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Reviewed</th>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Status</th>
                            <th className="text-left p-4 text-sm font-semibold text-foreground">Proof / Notes</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {paymentsLoading ? (
                            <tr>
                              <td colSpan={8} className="p-8 text-center">
                                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mx-auto" />
                              </td>
                            </tr>
                          ) : paymentHistoryList.length === 0 ? (
                            <tr>
                              <td colSpan={8} className="p-8 text-center text-muted-foreground">No transactions recorded yet.</td>
                            </tr>
                          ) : (
                            paymentHistoryList.map((payment) => {
                              const studentName = (
                                [payment.student?.firstName, payment.student?.lastName].filter(Boolean).join(" ").trim()
                                || [payment.enrollment?.studentSnapshot?.firstName, payment.enrollment?.studentSnapshot?.lastName].filter(Boolean).join(" ").trim()
                                || [payment.parent?.firstName, payment.parent?.lastName].filter(Boolean).join(" ").trim()
                                || "—"
                              );
                              const submittedLabel = payment.createdAt
                                ? new Date(payment.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
                                : "—";
                              const reviewedLabel = payment.verifiedAt
                                ? new Date(payment.verifiedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
                                : "—";
                              const statusClasses = payment.status === "verified"
                                ? "bg-success/10 text-success"
                                : payment.status === "rejected"
                                ? "bg-destructive/10 text-destructive"
                                : payment.status === "submitted"
                                ? "bg-warning/10 text-warning"
                                : "bg-muted text-muted-foreground";
                              const reviewerName = payment.verifiedBy
                                ? [payment.verifiedBy.firstName, payment.verifiedBy.lastName].filter(Boolean).join(" ").trim()
                                : "";
                              return (
                                <tr key={payment._id} className="hover:bg-muted/50 transition-colors align-top">
                                  <td className="p-4 font-mono text-sm text-foreground">{payment.referenceNumber ?? payment._id}</td>
                                  <td className="p-4 text-foreground">{studentName}</td>
                                  <td className="p-4 font-semibold text-foreground">₱{(payment.amount || 0).toLocaleString()}</td>
                                  <td className="p-4 text-muted-foreground capitalize">{payment.paymentMethod === "blockchain" ? "Blockchain" : "GCash"}</td>
                                  <td className="p-4 text-muted-foreground">{submittedLabel}</td>
                                  <td className="p-4 text-muted-foreground">
                                    <div>{reviewedLabel}</div>
                                    {reviewerName ? <div className="text-xs">by {reviewerName}</div> : null}
                                  </td>
                                  <td className="p-4">
                                    <span className={`text-xs px-2 py-1 rounded-full font-medium capitalize ${statusClasses}`}>{payment.status}</span>
                                    {payment.rejectionReason ? <p className="mt-2 text-xs text-muted-foreground max-w-[220px]">{payment.rejectionReason}</p> : null}
                                  </td>
                                  <td className="p-4 text-sm text-muted-foreground">
                                    <div className="space-y-2">
                                      {(payment.proofUrl || payment.gcashDetails?.screenshotUrl) ? (
                                        <Button variant="outline" size="sm" onClick={() => openPaymentProof(payment.proofUrl || payment.gcashDetails?.screenshotUrl, payment.referenceNumber ?? payment._id)}>
                                          View proof
                                        </Button>
                                      ) : null}
                                      {payment.blockchainPayment?.transactionHash ? (
                                        <p className="max-w-[240px] break-all text-xs">TX: {payment.blockchainPayment.transactionHash}</p>
                                      ) : payment.gcashDetails?.transactionId ? (
                                        <p className="max-w-[240px] break-all text-xs">GCash ID: {payment.gcashDetails.transactionId}</p>
                                      ) : (
                                        <p className="text-xs">No proof uploaded.</p>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </TabsContent>

            {/* Reports Tab - live analytics from database-backed state */}
            <TabsContent value="reports" className="space-y-6">
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="p-4 border-b border-border flex items-center justify-between">
                  <h3 className="font-display font-bold text-lg text-foreground">Reports</h3>
                  <Button variant="outline" size="sm" onClick={() => handleExportAll(enrollments, users, allPaymentsList)}>
                    <Download className="h-4 w-4 mr-2" />
                    Export CSV
                  </Button>
                </div>
                <div className="p-4 space-y-6">
                  <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
                    <div className="bg-muted/40 rounded-lg border border-border p-4">
                      <p className="text-xs text-muted-foreground">Total Enrollments</p>
                      <p className="text-2xl font-bold text-foreground">{enrollmentsLoading ? "—" : reportSummary.enrollmentTotal}</p>
                      <p className="text-xs text-muted-foreground mt-1">Active: {reportSummary.enrollmentActive} | Pending: {reportSummary.enrollmentPending}</p>
                    </div>
                    <div className="bg-muted/40 rounded-lg border border-border p-4">
                      <p className="text-xs text-muted-foreground">Verified Revenue</p>
                      <p className="text-2xl font-bold text-success">{paymentsLoading ? "—" : `₱${reportSummary.verifiedRevenue.toLocaleString()}`}</p>
                      <p className="text-xs text-muted-foreground mt-1">Rejected tx: {rejectedPaymentsCount}</p>
                    </div>
                    <div className="bg-muted/40 rounded-lg border border-border p-4">
                      <p className="text-xs text-muted-foreground">Active Users</p>
                      <p className="text-2xl font-bold text-foreground">{usersLoading ? "—" : reportSummary.activeUsers}</p>
                      <p className="text-xs text-muted-foreground mt-1">Archived: {reportSummary.archivedUsers}</p>
                    </div>
                    <div className="bg-muted/40 rounded-lg border border-border p-4">
                      <p className="text-xs text-muted-foreground">Role Distribution</p>
                      <p className="text-sm text-foreground mt-1">Students: {reportSummary.roleCounts.students}</p>
                      <p className="text-sm text-foreground">Tutors: {reportSummary.roleCounts.tutors}</p>
                      <p className="text-sm text-foreground">Admins: {reportSummary.roleCounts.admins}</p>
                    </div>
                  </div>

                  <div className="grid lg:grid-cols-2 gap-6">
                    <div className="rounded-lg border border-border overflow-hidden">
                      <div className="p-3 border-b border-border bg-muted/30">
                        <h4 className="font-semibold text-foreground">Payment Status Breakdown</h4>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-muted">
                            <tr>
                              <th className="text-left p-3 font-semibold text-foreground">Status</th>
                              <th className="text-left p-3 font-semibold text-foreground">Count</th>
                              <th className="text-left p-3 font-semibold text-foreground">Total Amount</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {Object.entries(reportPaymentBreakdown).map(([status, value]) => (
                              <tr key={status} className="hover:bg-muted/40">
                                <td className="p-3 capitalize text-foreground">{status}</td>
                                <td className="p-3 text-foreground">{value.count}</td>
                                <td className="p-3 text-foreground">₱{value.total.toLocaleString()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="rounded-lg border border-border overflow-hidden">
                      <div className="p-3 border-b border-border bg-muted/30">
                        <h4 className="font-semibold text-foreground">Top Enrolled Programs</h4>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-muted">
                            <tr>
                              <th className="text-left p-3 font-semibold text-foreground">Program / Subject</th>
                              <th className="text-left p-3 font-semibold text-foreground">Enrollments</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {reportTopSubjects.length === 0 ? (
                              <tr>
                                <td colSpan={2} className="p-4 text-center text-muted-foreground">No subject enrollment data yet.</td>
                              </tr>
                            ) : (
                              reportTopSubjects.map((item) => (
                                <tr key={item.name} className="hover:bg-muted/40">
                                  <td className="p-3 text-foreground">{item.name}</td>
                                  <td className="p-3 text-foreground">{item.count}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Report data is computed live from current database-backed dashboard sources (users, enrollments, and payments). Export downloads the same data snapshot as CSV.
                  </p>
                </div>
              </div>
            </TabsContent>

            {/* Schedule Tab – calendar view */}
            <TabsContent value="schedule" className="space-y-6">
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="p-4 border-b border-border flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h3 className="font-display font-bold text-lg text-foreground">Scheduling Tab</h3>
                    <p className="text-sm text-muted-foreground">
                      First create tutor time slots here. After you generate them, open the calendar below and assign children to those slots.
                    </p>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    1-on-1: 1 tutor + 1 child, 2 hours. Playgroup: 1–4 tutors (scales with child count) + 2–10 children, 8–10 AM or 1–3 PM only.
                  </div>
                </div>

                <div className="p-4 space-y-4">
                  <p className="text-xs text-muted-foreground">Step 1: Choose the days this slot should repeat.</p>
                  <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
                    {SCHEDULING_DAYS.filter((day) => availableSchedulingDayKeys.has(day.key)).map((day) => (
                      <Button
                        key={day.key}
                        type="button"
                        variant={weeklyPlannerSelectedDays.includes(day.key) ? "default" : "outline"}
                        className="justify-start"
                        onClick={() => {
                          setWeeklyPlannerSelectedDays((prev) => {
                            if (prev.includes(day.key)) {
                              if (prev.length === 1) return prev;
                              return prev.filter((value) => value !== day.key);
                            }
                            return [...prev, day.key].sort((a, b) => a - b);
                          });
                          if (!weeklyPlannerSelectedDays.includes(day.key)) {
                            setWeeklyPlannerDay(day.key);
                          }
                          setWeeklyPlannerErrors([]);
                        }}
                      >
                        {day.name}
                      </Button>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>Preview day</Label>
                      <Select
                        value={String(weeklyPlannerDay)}
                        onValueChange={(value) => setWeeklyPlannerDay(Number(value))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select day to preview" />
                        </SelectTrigger>
                        <SelectContent>
                          {SCHEDULING_DAYS.map((day) => (
                            <SelectItem key={`preview-${day.key}`} value={String(day.key)}>
                              {day.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1">
                      <Label>Month span</Label>
                      <Select
                        value={String(scheduleGenerationMonthSpan)}
                        onValueChange={(value) => setScheduleGenerationMonthSpan(Math.min(3, Math.max(1, Number(value))) as 1 | 2 | 3)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select month span" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1">1 month</SelectItem>
                          <SelectItem value="2">2 months</SelectItem>
                          <SelectItem value="3">3 months</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
                      <div className="space-y-1">
                        <Label>Step 2: Program</Label>
                        <Select
                          value={weeklyPlannerForm.subjectId}
                          onValueChange={(value) => setWeeklyPlannerForm((prev) => ({ ...prev, subjectId: value }))}
                          disabled={weeklyPlannerOptionsLoading}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={weeklyPlannerOptionsLoading ? "Loading programs..." : "Select Academic Tutorial, Exam Prep, or Playgroup"} />
                          </SelectTrigger>
                          <SelectContent>
                            {weeklyPlannerSubjects.map((subject) => (
                              <SelectItem key={subject._id} value={subject._id}>
                                {subject.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1">
                        <Label>Session type</Label>
                        <Select
                          value={weeklyPlannerForm.sessionType}
                          onValueChange={(value) => setWeeklyPlannerForm((prev) => ({ ...prev, sessionType: value as SessionTypeValue, tutorIds: value === "playgroup" ? prev.tutorIds : (prev.tutorId ? [prev.tutorId] : []) }))}
                          disabled={!weeklyPlannerForm.subjectId || isToddlerPlaygroupSubject || availableSessionTypeOptions.length === 1}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                          <SelectContent>
                            {availableSessionTypeOptions.map((sessionType) => (
                              <SelectItem key={sessionType.value} value={sessionType.value}>
                                {sessionType.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-[11px] text-muted-foreground">
                          {weeklyPlannerForm.sessionType === "playgroup"
                            ? "Playgroup is one shared session. Tutors required: 1 per 3 children (max 4). Assign children from the calendar."
                            : "1-on-1 uses one tutor. Assign the child later from the calendar."}
                        </p>
                      </div>

                      <div className="space-y-1 lg:col-span-1">
                        <Label>{weeklyPlannerForm.sessionType === "playgroup" ? `Step 3: Tutors (${weeklyPlannerForm.tutorIds.length}/1-4)` : "Step 3: Tutor"}</Label>
                        {weeklyPlannerForm.sessionType === "playgroup" ? (
                          <div className="rounded-md border border-border bg-background p-2">
                            {weeklyPlannerTutors.length < 1 ? (
                              <p className="text-xs text-destructive">
                                No active tutors found. Add tutors in the Users tab first.
                              </p>
                            ) : (
                              <p className="mb-2 text-xs text-muted-foreground">
                                Select 1–4 tutors. The required count is determined by the number of children enrolled (1 tutor per 3 children, max 4).
                              </p>
                            )}
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {weeklyPlannerTutors.map((tutor) => {
                                const tutorName = [tutor.firstName, tutor.middleName, tutor.lastName].filter(Boolean).join(" ");
                                const selected = weeklyPlannerForm.tutorIds.includes(tutor._id);
                                return (
                                  <Button
                                    key={tutor._id}
                                    type="button"
                                    size="sm"
                                    variant={selected ? "default" : "outline"}
                                    onClick={() => setWeeklyPlannerForm((prev) => {
                                      const nextIds = selected
                                        ? prev.tutorIds.filter((id) => id !== tutor._id)
                                        : [...prev.tutorIds, tutor._id];
                                      return { ...prev, tutorId: nextIds[0] || "", tutorIds: nextIds };
                                    })}
                                  >
                                    {tutorName}
                                  </Button>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <Select
                            value={weeklyPlannerForm.tutorId}
                            onValueChange={(value) => setWeeklyPlannerForm((prev) => ({ ...prev, tutorId: value, tutorIds: [value] }))}
                            disabled={weeklyPlannerOptionsLoading}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={weeklyPlannerOptionsLoading ? "Loading tutors..." : "Select 1 tutor"} />
                            </SelectTrigger>
                            <SelectContent>
                              {weeklyPlannerTutors.map((tutor) => {
                                const tutorName = [tutor.firstName, tutor.middleName, tutor.lastName].filter(Boolean).join(" ");
                                return (
                                  <SelectItem key={tutor._id} value={tutor._id}>
                                    {tutorName}
                                  </SelectItem>
                                );
                              })}
                            </SelectContent>
                          </Select>
                        )}
                      </div>

                      <div className="space-y-1">
                        <Label>Step 4: Start</Label>
                        <Select
                          value={weeklyPlannerForm.startTime}
                          onValueChange={(value) =>
                            setWeeklyPlannerForm((prev) => ({
                              ...prev,
                              startTime: value,
                              endTime: addTwoHours(value),
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Start time" />
                          </SelectTrigger>
                          <SelectContent>
                            {availableTimeSlotsForSelectedTutor.length === 0 ? (
                              <div className="p-2 text-xs text-muted-foreground">
                                {weeklyPlannerForm.sessionType === "playgroup" ? "Playgroup times are 8:00 AM or 1:00 PM." : "No overlapping times for the selected tutor on these days."}
                              </div>
                            ) : (
                              availableTimeSlotsForSelectedTutor.map((time) => (
                                <SelectItem key={time} value={time}>
                                  {formatSlotTime(time)}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1">
                        <Label>End</Label>
                        <div className="flex h-10 items-center rounded-md border border-input bg-muted/40 px-3 text-sm text-foreground">
                          {weeklyPlannerForm.endTime ? formatSlotTime(weeklyPlannerForm.endTime) : "Automatically 2 hours after start"}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-sm text-muted-foreground">
                        Room is assigned automatically. {weeklyPlannerForm.sessionType === "playgroup" ? "Playgroup always uses the Toddler Room." : "1-on-1 always uses the Tutoring Area."}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        onClick={addWeeklyPlannerAssignment}
                        disabled={weeklyPlannerForm.sessionType === "playgroup" && weeklyPlannerTutors.length < 1}
                      >
                        Add to selected day(s)
                      </Button>
                    </div>

                    {weeklyPlannerErrors.length > 0 && (
                      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 space-y-1">
                        {weeklyPlannerErrors.map((error) => (
                          <p key={error} className="text-sm text-destructive">{error}</p>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <div className="rounded-lg border border-border overflow-hidden">
                      <div className="p-3 border-b border-border bg-muted/30">
                        <h4 className="font-semibold text-foreground">Tutoring Area</h4>
                        <p className="text-xs text-muted-foreground">Up to 15 concurrent 1-on-1 sessions</p>
                      </div>
                      <div className="p-3 space-y-2 min-h-[180px]">
                        {(weeklyPlannerDraft[weeklyPlannerDay] || []).filter((item) => item.roomType === "tutoring_area").length === 0 ? (
                          <p className="text-sm text-muted-foreground">No tutoring-area assignments yet for this day.</p>
                        ) : (
                          (weeklyPlannerDraft[weeklyPlannerDay] || [])
                            .filter((item) => item.roomType === "tutoring_area")
                            .map((assignment) => (
                              <div key={assignment.id} className="rounded-md border border-border p-2 flex items-start justify-between gap-2">
                                <div>
                                  <p className="text-sm font-medium text-foreground">{assignment.tutorName}</p>
                                  <p className="text-xs text-muted-foreground">{formatSlotTime(assignment.startTime)} - {formatSlotTime(assignment.endTime)}</p>
                                  <p className="text-xs text-muted-foreground">{assignment.subjectName} • {SESSION_TYPE_OPTIONS.find((type) => type.value === assignment.sessionType)?.label}</p>
                                </div>
                                <Button type="button" variant="ghost" size="sm" onClick={() => removeWeeklyPlannerAssignment(weeklyPlannerDay, assignment.id)}>
                                  Remove
                                </Button>
                              </div>
                            ))
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg border border-border overflow-hidden">
                      <div className="p-3 border-b border-border bg-muted/30">
                        <h4 className="font-semibold text-foreground">Toddler Room</h4>
                        <p className="text-xs text-muted-foreground">1–4 tutors (scales with children), 2–10 children, 8–10 AM or 1–3 PM</p>
                      </div>
                      <div className="p-3 space-y-2 min-h-[180px]">
                        {(weeklyPlannerDraft[weeklyPlannerDay] || []).filter((item) => item.roomType === "toddler_room").length === 0 ? (
                          <p className="text-sm text-muted-foreground">No toddler-room assignments yet for this day.</p>
                        ) : (
                          (weeklyPlannerDraft[weeklyPlannerDay] || [])
                            .filter((item) => item.roomType === "toddler_room")
                            .map((assignment) => (
                              <div key={assignment.id} className="rounded-md border border-border p-2 flex items-start justify-between gap-2">
                                <div>
                                  <p className="text-sm font-medium text-foreground">{assignment.tutorName}</p>
                                  <p className="text-xs text-muted-foreground">{formatSlotTime(assignment.startTime)} - {formatSlotTime(assignment.endTime)}</p>
                                  <p className="text-xs text-muted-foreground">{assignment.subjectName} • Toddler Playgroup</p>
                                </div>
                                <Button type="button" variant="ghost" size="sm" onClick={() => removeWeeklyPlannerAssignment(weeklyPlannerDay, assignment.id)}>
                                  Remove
                                </Button>
                              </div>
                            ))
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <Button type="button" className="btn-glow" disabled={weeklyPlannerSubmitting} onClick={submitWeeklyPlanner}>
                      {weeklyPlannerSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Calendar className="h-4 w-4 mr-2" />}
                      Step 4: Generate Session Slots ({scheduleGenerationMonthSpan} month{scheduleGenerationMonthSpan > 1 ? "s" : ""})
                    </Button>
                  </div>
                </div>
              </div>

              {/* Summary cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-muted/50 rounded-xl p-4 border border-border">
                  <p className="text-sm text-muted-foreground">All Schedules</p>
                  <p className="text-2xl font-bold text-foreground">{schedulesLoading ? "—" : schedules.length}</p>
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
                      <Select
                        value={calendarMonthKey}
                        onValueChange={(value) => {
                          const parsed = parseMonthKeyToDate(value);
                          if (parsed) {
                            setCalendarMonth(parsed);
                          }
                        }}
                      >
                        <SelectTrigger className="h-9 w-[220px]">
                          <SelectValue placeholder="Jump to month" />
                        </SelectTrigger>
                        <SelectContent>
                          {scheduleMonthKeys.map((monthKey) => (
                            <SelectItem key={monthKey} value={monthKey}>
                              {formatMonthKeyLabel(monthKey)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-xs text-muted-foreground">Month span: {scheduleMonthSpanLabel}</span>
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setSelectedScheduleIds(
                        (scheduleViewMode === "monthly"
                          ? schedulesInCalendarMonth
                          : scheduleViewMode === "weekly"
                          ? schedulesInWeeklyView
                          : schedulesInDailyView
                        ).map((s) => s._id)
                      )
                    }
                  >
                    Select all
                  </Button>
                  {selectedScheduleIds.length > 0 && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setSelectedScheduleIds([])}>
                        Clear selection
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={scheduleBulkDeleting}
                        onClick={async () => {
                          if (!confirm(`Delete ${selectedScheduleIds.length} selected session(s)?`)) return;
                          setScheduleBulkDeleting(true);
                          let done = 0;
                          let failed = 0;
                          for (const id of selectedScheduleIds) {
                            try {
                              const res = await scheduleService.delete(id);
                              if (res.data?.success) done++;
                              else failed++;
                            } catch {
                              failed++;
                            }
                          }
                          setScheduleBulkDeleting(false);
                          setSelectedScheduleIds([]);
                          setSelectedSchedule(null);
                          fetchSchedules();
                          if (failed > 0) toast.error(`${done} deleted, ${failed} failed.`);
                          else toast.success(`${done} session(s) deleted.`);
                        }}
                      >
                        {scheduleBulkDeleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
                        Delete selected ({selectedScheduleIds.length})
                      </Button>
                    </>
                  )}
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
                  <Button variant="outline" size="sm" onClick={handleCleanupDuplicates}>
                    Cleanup Duplicates
                  </Button>
                  <Button className="btn-glow" size="sm" onClick={() => setScheduleViewMode("weekly")}>
                    <Plus className="h-4 w-4 mr-2" />
                    Open Weekly Planner
                  </Button>
                </div>
              </div>

              {/* Schedule grid/list + details panel */}
              <div className="flex gap-4 flex-col lg:flex-row">
                <div className="flex-1 bg-card rounded-xl border border-border overflow-hidden">
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
                                  const studentName = formatScheduleStudentNames(s);
                                  const isDetailsSelected = selectedSchedule?._id === s._id;
                                  const isChecked = selectedScheduleIds.includes(s._id);
                                  return (
                                    <div
                                      key={s._id}
                                      role="button"
                                      tabIndex={0}
                                      onClick={() => setSelectedSchedule(s)}
                                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSelectedSchedule(s); }}
                                      className={`w-full text-left p-2 rounded text-xs truncate transition-colors flex items-start gap-2 cursor-pointer ${isDetailsSelected ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary hover:bg-primary/20"} ${isChecked ? "ring-2 ring-offset-1 ring-primary" : ""}`}
                                    >
                                      <Checkbox
                                        checked={isChecked}
                                        onCheckedChange={() => {
                                          setSelectedScheduleIds((prev) =>
                                            prev.includes(s._id) ? prev.filter((id) => id !== s._id) : [...prev, s._id]
                                          );
                                        }}
                                        onClick={(e) => e.stopPropagation()}
                                        className="mt-0.5 shrink-0"
                                        aria-label={`Select ${s.subject?.name ?? "session"} for deletion`}
                                      />
                                      <div className="min-w-0 flex-1">
                                        <span className="font-medium block">{s.subject?.name ?? "—"}</span>
                                        <span className="opacity-90">{formatSlotTime(s.startTime)}</span>
                                        <span className="opacity-75 block truncate">{studentName}</span>
                                      </div>
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
                                    const sessions = (schedulesByWeeklyDay[day.key] || []).filter((session) => {
                                      return `${session.startTime}-${session.endTime}` === slotKey;
                                    });

                                    return (
                                      <div key={`${slotKey}-${day.key}`} className="p-2 border-r border-border last:border-r-0 space-y-1">
                                        {sessions.length === 0 ? null : sessions.map((session) => {
                                          const studentName = formatScheduleStudentNames(session);
                                          const isDetailsSelected = selectedSchedule?._id === session._id;
                                          const isChecked = selectedScheduleIds.includes(session._id);
                                          return (
                                            <div
                                              key={session._id}
                                              role="button"
                                              tabIndex={0}
                                              onClick={() => setSelectedSchedule(session)}
                                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSelectedSchedule(session); }}
                                              className={`w-full text-left p-2 rounded text-xs truncate transition-colors flex items-start gap-2 cursor-pointer ${isDetailsSelected ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary hover:bg-primary/20"} ${isChecked ? "ring-2 ring-offset-1 ring-primary" : ""}`}
                                            >
                                              <Checkbox
                                                checked={isChecked}
                                                onCheckedChange={() => {
                                                  setSelectedScheduleIds((prev) =>
                                                    prev.includes(session._id) ? prev.filter((id) => id !== session._id) : [...prev, session._id]
                                                  );
                                                }}
                                                onClick={(e) => e.stopPropagation()}
                                                className="mt-0.5 shrink-0"
                                                aria-label={`Select ${session.subject?.name ?? "session"} for deletion`}
                                              />
                                              <div className="min-w-0 flex-1">
                                                <span className="font-medium block">{session.subject?.name ?? "—"}</span>
                                                <span className="opacity-75 block truncate">{studentName}</span>
                                              </div>
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
                          const studentName = formatScheduleStudentNames(s);
                          const tutorName = formatScheduleTutorNames(s);
                          const isDetailsSelected = selectedSchedule?._id === s._id;
                          const isChecked = selectedScheduleIds.includes(s._id);
                          return (
                            <div
                              key={s._id}
                              role="button"
                              tabIndex={0}
                              onClick={() => setSelectedSchedule(s)}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSelectedSchedule(s); }}
                              className={`p-3 rounded-md border transition-colors cursor-pointer ${isDetailsSelected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"}`}
                            >
                              <div className="flex items-start gap-3">
                                <Checkbox
                                  checked={isChecked}
                                  onCheckedChange={() => {
                                    setSelectedScheduleIds((prev) =>
                                      prev.includes(s._id) ? prev.filter((id) => id !== s._id) : [...prev, s._id]
                                    );
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  className="mt-0.5"
                                  aria-label={`Select ${s.subject?.name ?? "session"} for deletion`}
                                />
                                <div className="min-w-0 flex-1">
                                  <p className="font-medium text-foreground">{s.subject?.name ?? "—"}</p>
                                  <p className="text-sm text-muted-foreground">{formatSlotTime(s.startTime)} - {formatSlotTime(s.endTime)}</p>
                                  <p className="text-xs text-muted-foreground">Student: {studentName}</p>
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

                {/* Schedule Details panel */}
                <div className="w-full lg:w-80 shrink-0 bg-card rounded-xl border border-border overflow-hidden">
                  <div className="p-4 border-b border-border flex items-center justify-between">
                    <h3 className="font-display font-bold text-foreground">Schedule Details</h3>
                    {selectedSchedule && (
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSelectedSchedule(null)}>
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <div className="p-4">
                    {!selectedSchedule ? (
                      <p className="text-sm text-muted-foreground">Click a session in the calendar to view details.</p>
                    ) : (
                      (() => {
                        const s = selectedSchedule;
                        const studentName = formatScheduleStudentNames(s);
                        const tutorName = formatScheduleTutorNames(s);
                        const dateLabel = s.date ? new Date(s.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "—";
                        const timeLabel = s.startTime && s.endTime ? `${formatSlotTime(s.startTime)} – ${formatSlotTime(s.endTime)}` : "—";
                        const isDeleting = scheduleDeletingId === s._id;
                        const isOneOnOneSession = s.sessionType === "one-on-one" || !s.sessionType;
                        const fallbackCapacity = s.sessionType === "playgroup" ? 10 : s.sessionType === "small-group" ? 3 : 1;
                        const maxCapacity = s.maxCapacity || fallbackCapacity;
                        const enrolledStudents = [
                          ...(s.student ? [s.student] : []),
                          ...((s.students || []) as Array<{ _id: string; firstName?: string; middleName?: string; lastName?: string; profileImage?: string }>)
                        ].filter((value, index, arr) => arr.findIndex((item) => item?._id === value?._id) === index);
                        const enrolledStudentIds = new Set(enrolledStudents.map((item) => item._id));
                        const programCandidates = enrollments.filter((enrollmentItem) => {
                          if (!enrollmentIsReadyToSchedule(enrollmentItem)) return false;
                          return enrollmentMatchesSessionProgram(enrollmentItem, s.subject);
                        });
                        const availableEnrollmentCandidates = programCandidates.filter((enrollmentItem) => {
                          const linkedStudentId = enrollmentItem.student?._id;
                          if (linkedStudentId && enrolledStudentIds.has(linkedStudentId)) return false;
                          return true;
                        });
                        const matchingPreference = availableEnrollmentCandidates.filter((enrollmentItem) => matchesParentPreferenceClient(enrollmentItem, s.date, s.startTime).ok);
                        const needsOverride = availableEnrollmentCandidates.filter((enrollmentItem) => !matchesParentPreferenceClient(enrollmentItem, s.date, s.startTime).ok);
                        const currentEnrollment = enrolledStudents.length;
                        const hasOpenSlot = currentEnrollment < maxCapacity;
                        return (
                          <div className="space-y-4">
                            <div>
                              <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary font-medium">{s.subject?.name ?? "Session"}</span>
                              <h4 className="font-semibold text-foreground mt-2">{s.subject?.name ?? "—"}</h4>
                              <p className="text-sm text-muted-foreground">{dateLabel} | {timeLabel}</p>
                            </div>
                            <div>
                              <p className="text-xs font-medium text-muted-foreground">{s.sessionType === "playgroup" ? `Tutors (${(s.tutors && s.tutors.length > 0 ? s.tutors : s.tutor ? [s.tutor] : []).length}/1-4)` : "Tutor"}</p>
                              {s.sessionType === "playgroup" ? (
                                (() => {
                                  const allTutors = (Array.isArray(s.tutors) && s.tutors.length > 0)
                                    ? s.tutors
                                    : s.tutor ? [s.tutor] : [];
                                  if (allTutors.length === 0) {
                                    return <p className="text-sm text-muted-foreground mt-1">No tutors assigned.</p>;
                                  }
                                  return (
                                    <div className="mt-1 space-y-1.5">
                                      {allTutors.map((t) => {
                                        const tName = [t.firstName, t.middleName, t.lastName].filter(Boolean).join(" ") || "Tutor";
                                        return (
                                          <div key={t._id} className="flex items-center gap-2">
                                            <UserAvatar
                                              src={null}
                                              fallback={tName.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase()}
                                              size={7}
                                            />
                                            <p className="text-sm text-foreground">{tName}</p>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  );
                                })()
                              ) : (
                                <div className="flex items-center gap-2 mt-1">
                                  <UserAvatar
                                    src={s.tutor?.profileImage ? `${uploadsBaseUrl}/uploads/${s.tutor.profileImage}` : null}
                                    fallback={tutorName !== "—" ? tutorName.split(" ").map((n) => n[0]).join("").slice(0, 2) : "—"}
                                    size={8}
                                  />
                                  <p className="text-sm text-foreground">{tutorName}</p>
                                </div>
                              )}
                            </div>
                            {isOneOnOneSession && (
                            <div>
                              <p className="text-xs font-medium text-muted-foreground">Student</p>
                              {s.student ? (
                                <div className="flex items-center gap-2 mt-1">
                                  <UserAvatar
                                    src={s.student?.profileImage ? `${uploadsBaseUrl}/uploads/${s.student.profileImage}` : null}
                                    fallback={studentName !== "—" ? studentName.split(" ").map((n) => n[0]).join("").slice(0, 2) : "—"}
                                    size={8}
                                  />
                                  <p className="text-sm text-foreground">{studentName}</p>
                                </div>
                              ) : (
                                <p className="text-sm text-muted-foreground mt-1">No child assigned yet.</p>
                              )}
                            </div>
                            )}
                            <div className="rounded-md border border-border p-3 space-y-3">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-xs font-medium text-muted-foreground">Session Enrollment</p>
                                <p className="text-xs text-muted-foreground">{currentEnrollment} / {maxCapacity}</p>
                              </div>

                              {enrolledStudents.length === 0 ? (
                                <p className="text-xs text-muted-foreground">No students enrolled yet.</p>
                              ) : (
                                <div className="space-y-2">
                                  {enrolledStudents.map((enrolledStudent) => {
                                    const enrolledStudentName = [enrolledStudent.firstName, enrolledStudent.middleName, enrolledStudent.lastName]
                                      .filter(Boolean)
                                      .join(" ") || "Student";
                                    return (
                                      <div key={enrolledStudent._id} className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                          <UserAvatar
                                            src={enrolledStudent.profileImage ? `${uploadsBaseUrl}/uploads/${enrolledStudent.profileImage}` : null}
                                            fallback={enrolledStudentName.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                                            size={8}
                                          />
                                          <p className="text-xs text-foreground truncate">{enrolledStudentName}</p>
                                        </div>
                                        {!isOneOnOneSession && (
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            disabled={scheduleEnrollmentSaving}
                                            onClick={() => handleRemoveStudentFromSelectedSchedule(enrolledStudent._id)}
                                          >
                                            Remove
                                          </Button>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}

                              {hasOpenSlot && (
                                <div className="space-y-2">
                                  <p className="text-xs font-medium text-foreground">
                                    {isOneOnOneSession ? "Assign 1 child to this tutor" : `Add children to this playgroup (${Math.max(0, maxCapacity - currentEnrollment)} open)`}
                                  </p>
                                  <p className="text-[11px] text-muted-foreground">
                                    Only approved children in {s.subject?.name || "this program"} are listed. Parent preferred date and time are checked automatically.
                                  </p>
                                  {availableEnrollmentCandidates.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">
                                      No approved children are enrolled in {s.subject?.name || "this program"} yet. Approve the enrollment first, then assign the child here.
                                    </p>
                                  ) : (
                                    <>
                                      <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                          <Button type="button" variant="outline" size="sm" className="w-full justify-between">
                                            <span className="truncate">
                                              {scheduleEnrollmentSelectedStudentIds.length > 0
                                                ? `${scheduleEnrollmentSelectedStudentIds.length} selected`
                                                : isOneOnOneSession ? "Choose 1 child" : "Choose children"}
                                            </span>
                                            <ChevronDown className="h-4 w-4 opacity-70" />
                                          </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="start" className="w-[280px] max-h-64 overflow-auto">
                                          {matchingPreference.length > 0 && (
                                            <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground">Matches this slot</p>
                                          )}
                                          {matchingPreference.map((candidate) => {
                                            const checked = scheduleEnrollmentSelectedStudentIds.includes(candidate._id);
                                            return (
                                              <DropdownMenuCheckboxItem
                                                key={candidate._id}
                                                checked={checked}
                                                onCheckedChange={(nextValue) => {
                                                  setScheduleEnrollmentSelectedStudentIds((prev) => {
                                                    if (!nextValue) return prev.filter((id) => id !== candidate._id);
                                                    if (isOneOnOneSession) return [candidate._id];
                                                    return prev.includes(candidate._id) ? prev : [...prev, candidate._id];
                                                  });
                                                }}
                                              >
                                                <span className="flex flex-col">
                                                  <span>{childNameFromEnrollment(candidate)}</span>
                                                  <span className="text-[10px] text-muted-foreground font-normal">{parentPreferenceSummary(candidate)}</span>
                                                </span>
                                              </DropdownMenuCheckboxItem>
                                            );
                                          })}
                                          {needsOverride.length > 0 && (
                                            <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground">Needs override</p>
                                          )}
                                          {needsOverride.map((candidate) => {
                                            const checked = scheduleEnrollmentSelectedStudentIds.includes(candidate._id);
                                            const mismatch = matchesParentPreferenceClient(candidate, s.date, s.startTime).reason;
                                            return (
                                              <DropdownMenuCheckboxItem
                                                key={candidate._id}
                                                checked={checked}
                                                onCheckedChange={(nextValue) => {
                                                  setScheduleEnrollmentSelectedStudentIds((prev) => {
                                                    if (!nextValue) return prev.filter((id) => id !== candidate._id);
                                                    if (isOneOnOneSession) return [candidate._id];
                                                    return prev.includes(candidate._id) ? prev : [...prev, candidate._id];
                                                  });
                                                  if (nextValue) setScheduleEnrollmentOverride(true);
                                                }}
                                              >
                                                <span className="flex flex-col">
                                                  <span>{childNameFromEnrollment(candidate)}</span>
                                                  <span className="text-[10px] text-muted-foreground font-normal">{mismatch || parentPreferenceSummary(candidate)}</span>
                                                </span>
                                              </DropdownMenuCheckboxItem>
                                            );
                                          })}
                                        </DropdownMenuContent>
                                      </DropdownMenu>
                                      {scheduleEnrollmentSelectedStudentIds.length > 0 && (
                                        <p className="text-[11px] text-muted-foreground">
                                          Selected: {availableEnrollmentCandidates
                                            .filter((candidate) => scheduleEnrollmentSelectedStudentIds.includes(candidate._id))
                                            .map((candidate) => childNameFromEnrollment(candidate))
                                            .join(", ")}
                                        </p>
                                      )}
                                      {(scheduleEnrollmentOverride || needsOverride.some((candidate) => scheduleEnrollmentSelectedStudentIds.includes(candidate._id))) && (
                                        <div className="space-y-1">
                                          <p className="text-[11px] text-muted-foreground">This assignment does not match the parent preferred date/time. Enter a reason to continue.</p>
                                          <Textarea
                                            value={scheduleEnrollmentOverrideReason}
                                            onChange={(event) => {
                                              setScheduleEnrollmentOverride(true);
                                              setScheduleEnrollmentOverrideReason(event.target.value);
                                            }}
                                            placeholder="Override reason for audit"
                                            className="min-h-[72px] text-sm"
                                          />
                                        </div>
                                      )}
                                      {scheduleCompatibleSlots.length > 0 && (
                                        <div className="rounded-md border border-border p-2 space-y-1">
                                          <p className="text-[11px] font-medium text-foreground">Compatible slots</p>
                                          {scheduleCompatibleSlots.map((slot) => (
                                            <Button
                                              key={slot._id}
                                              type="button"
                                              variant="ghost"
                                              size="sm"
                                              className="w-full justify-start h-auto py-1 text-left"
                                              onClick={() => {
                                                const match = schedules.find((item) => item._id === slot._id);
                                                if (match) setSelectedSchedule(match);
                                              }}
                                            >
                                              {new Date(slot.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} {formatSlotTime(slot.startTime)}–{formatSlotTime(slot.endTime)} {slot.tutorName ? `· ${slot.tutorName}` : ""}
                                            </Button>
                                          ))}
                                        </div>
                                      )}
                                    </>
                                  )}
                                  <Button
                                    type="button"
                                    size="sm"
                                    className="w-full"
                                    disabled={scheduleEnrollmentSaving || scheduleEnrollmentSelectedStudentIds.length === 0}
                                    onClick={handleEnrollStudentToSelectedSchedule}
                                  >
                                    {scheduleEnrollmentSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                                    {isOneOnOneSession ? "Assign child to this tutor" : "Add children to playgroup"}
                                  </Button>
                                </div>
                              )}
                            </div>
                            {s.isSubstitution ? (
                              <div className="rounded-md border border-warning/30 bg-warning/10 p-2">
                                <p className="text-xs font-medium text-warning">Substitute tutor assigned</p>
                                <p className="text-xs text-muted-foreground mt-1">Reason: {s.substitutionReason || "Tutor unavailable"}</p>
                              </div>
                            ) : null}
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full"
                              onClick={openSubstituteDialog}
                            >
                              Assign substitute tutor
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full"
                              onClick={handleMarkTutorUnavailableForSessionDate}
                            >
                              Mark tutor unavailable (day)
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full text-destructive border-destructive/50 hover:bg-destructive/10"
                              disabled={isDeleting}
                              onClick={async () => {
                                if (!confirm("Delete this session?")) return;
                                setScheduleDeletingId(s._id);
                                try {
                                  const res = await scheduleService.delete(s._id);
                                  if (res.data?.success) {
                                    toast.success("Schedule deleted.");
                                    setSelectedSchedule(null);
                                    fetchSchedules();
                                  } else {
                                    toast.error(res.data?.message ?? "Failed to delete.");
                                  }
                                } catch (err: unknown) {
                                  const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to delete schedule.";
                                  toast.error(msg);
                                } finally {
                                  setScheduleDeletingId(null);
                                }
                              }}
                            >
                              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
                              Delete session
                            </Button>
                          </div>
                        );
                      })()
                    )}
                  </div>
                </div>
              </div>
            </TabsContent>

            {/* Users Tab */}
            <TabsContent value="users" className="space-y-6">
              {/* User Summary */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="bg-card rounded-xl p-4 border border-border flex items-center gap-4">
                  <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center">
                    <GraduationCap className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-foreground">{usersLoading ? "—" : activeUsers.filter(u => u.role === "student").length}</p>
                    <p className="text-sm text-muted-foreground">Students</p>
                  </div>
                </div>
                <div className="bg-card rounded-xl p-4 border border-border flex items-center gap-4">
                  <div className="h-12 w-12 rounded-lg bg-info/10 flex items-center justify-center">
                    <BookOpen className="h-6 w-6 text-info" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-foreground">{usersLoading ? "—" : activeUsers.filter(u => u.role === "tutor").length}</p>
                    <p className="text-sm text-muted-foreground">Tutors</p>
                  </div>
                </div>
              </div>

              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="p-4 border-b border-border flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="font-display font-bold text-lg text-foreground">{isSuperAdmin ? "Student, Tutor, and Admin Accounts" : "Student and Tutor Accounts"}</h3>
                    <div className="flex rounded-lg border border-border p-0.5 bg-muted/50">
                        <button
                          type="button"
                          onClick={() => setUsersCategory("active")}
                          className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${usersCategory === "active" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                        >
                          Active ({activeUsers.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setUsersCategory("archived")}
                          className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${usersCategory === "archived" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                        >
                          Archived ({archivedUsers.length})
                        </button>
                      </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {usersCategory === "active" && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="default" className="gap-1">
                            <Plus className="h-4 w-4" />
                            Add User
                            <ChevronDown className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setAddStudentOpen(true)}>
                            <GraduationCap className="h-4 w-4 mr-2" />
                            Add Student
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setAddTutorOpen(true)}>
                            <BookOpen className="h-4 w-4 mr-2" />
                            Add Tutor
                          </DropdownMenuItem>
                          {isSuperAdmin && (
                            <DropdownMenuItem onClick={() => setAddAdminOpen(true)}>
                              <Shield className="h-4 w-4 mr-2" />
                              Add Admin
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  {usersCategory === "active" ? (
                  <table className="w-full">
                    <thead className="bg-muted">
                      <tr>
                        <th className="text-left p-4 text-sm font-semibold text-foreground">Name</th>
                        <th className="text-left p-4 text-sm font-semibold text-foreground">Role</th>
                        <th className="text-left p-4 text-sm font-semibold text-foreground">Email</th>
                        <th className="text-left p-4 text-sm font-semibold text-foreground">Phone</th>
                        <th className="text-left p-4 text-sm font-semibold text-foreground">Status</th>
                        <th className="text-left p-4 text-sm font-semibold text-foreground">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {usersLoading ? (
                        <tr>
                          <td colSpan={6} className="p-8 text-center">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mx-auto" />
                          </td>
                        </tr>
                      ) : usersError ? (
                        <tr>
                          <td colSpan={6} className="p-8 text-center text-muted-foreground">{usersError}</td>
                        </tr>
                      ) : activeUsers.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-8 text-center text-muted-foreground">No users in the database yet.</td>
                        </tr>
                      ) : (
                        activeUsers.map((u) => {
                          const name = `${u.firstName || ""} ${u.lastName || ""}`.trim() || "—";
                          const initials = name !== "—" ? name.split(" ").map((n) => n[0]).join("").slice(0, 2) : "—";
                          const status = u.isArchived ? "archived" : u.isActive ? "active" : "inactive";
                          const userImg = u.profileImage ? `${uploadsBaseUrl}/uploads/${u.profileImage}` : null;
                          return (
                            <tr key={u._id} className="hover:bg-muted/50 transition-colors">
                              <td className="p-4">
                                <div className="flex items-center gap-3">
                                  <UserAvatar src={userImg} fallback={initials} size={8} />
                                  <span className="font-medium text-foreground">{name}</span>
                                </div>
                              </td>
                              <td className="p-4">
                                <span className={`text-xs px-2 py-1 rounded-full font-medium capitalize ${roleColors[u.role] || "bg-muted text-muted-foreground"}`}>{formatRoleLabel(u.role)}</span>
                              </td>
                              <td className="p-4 text-muted-foreground text-sm">{u.email}</td>
                              <td className="p-4 text-muted-foreground text-sm">{u.phone ?? "—"}</td>
                              <td className="p-4">
                                <div className="flex flex-col gap-1">
                                  <span
                                    className={`text-xs px-2 py-1 rounded-full font-medium w-fit ${
                                      status === "active"
                                        ? "bg-success/10 text-success"
                                        : status === "archived"
                                        ? "bg-destructive/10 text-destructive"
                                        : "bg-muted text-muted-foreground"
                                    }`}
                                  >
                                    {status}
                                  </span>
                                  {/* Show enrollment status for parent/student so admin can track progress */}
                                  {(u.role === "parent" || u.role === "student") && u.enrollmentStatus && u.enrollmentStatus !== "active" && (
                                    <span className="text-xs text-muted-foreground">
                                      {u.enrollmentStatus.replace(/_/g, " ")}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="p-4">
                                <div className="flex gap-1">
                                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => toast.info(`Emailing ${name}...`)}>
                                    <Mail className="h-4 w-4" />
                                  </Button>
                                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => toast.info(`Viewing ${name}'s profile...`)}>
                                    <UserCheck className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                                    title="archive"
                                    onClick={() => {
                                      void handleArchiveUser(u);
                                    }}
                                  >
                                    <Archive className="h-4 w-4" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                  ) : (
                  <table className="w-full">
                    <thead className="bg-muted">
                      <tr>
                        <th className="text-left p-4 text-sm font-semibold text-foreground">Name</th>
                        <th className="text-left p-4 text-sm font-semibold text-foreground">Role</th>
                        <th className="text-left p-4 text-sm font-semibold text-foreground">Email</th>
                        <th className="text-left p-4 text-sm font-semibold text-foreground">Phone</th>
                        <th className="text-left p-4 text-sm font-semibold text-foreground">Status</th>
                        <th className="text-left p-4 text-sm font-semibold text-foreground">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {usersLoading ? (
                        <tr>
                          <td colSpan={6} className="p-8 text-center">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mx-auto" />
                          </td>
                        </tr>
                      ) : archivedUsers.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-8 text-center text-muted-foreground">
                            No archived users.
                          </td>
                        </tr>
                      ) : (
                        archivedUsers.map((u) => {
                          const name = `${u.firstName || ""} ${u.lastName || ""}`.trim() || "—";
                          const initials =
                            name !== "—" ? name.split(" ").map((n) => n[0]).join("").slice(0, 2) : "—";
                          const userImg = u.profileImage ? `${uploadsBaseUrl}/uploads/${u.profileImage}` : null;
                          return (
                            <tr
                              key={u._id}
                              className="cursor-pointer hover:bg-muted/50 transition-colors"
                              onClick={() => setArchivedUserDetail(u)}
                            >
                              <td className="p-4">
                                <div className="flex items-center gap-3">
                                  <UserAvatar src={userImg} fallback={initials} size={8} />
                                  <span className="font-medium text-foreground">{name}</span>
                                </div>
                              </td>
                              <td className="p-4">
                                <span
                                  className={`text-xs px-2 py-1 rounded-full font-medium capitalize ${
                                    roleColors[u.role] || "bg-muted text-muted-foreground"
                                  }`}
                                >
                                  {u.role.replace("_", " ")}
                                </span>
                              </td>
                              <td className="p-4 text-muted-foreground text-sm">{u.email}</td>
                              <td className="p-4 text-muted-foreground text-sm">{u.phone ?? "—"}</td>
                              <td className="p-4">
                                <span className="text-xs px-2 py-1 rounded-full font-medium bg-destructive/10 text-destructive">
                                  archived
                                </span>
                              </td>
                              <td className="p-4">
                                <div className="flex items-center gap-2">
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    title="Unarchive user"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleUnarchiveUser(u);
                                    }}
                                  >
                                    <RotateCcw className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    title="Delete archived user"
                                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleDeleteArchivedUser(u);
                                    }}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                  )}
                </div>
              </div>
            </TabsContent>

            {/* Announcements Tab */}
            <TabsContent value="announcements" className="space-y-6">
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="p-4 border-b border-border flex items-center justify-between flex-wrap gap-2">
                  <h3 className="font-display font-bold text-lg text-foreground">Announcements</h3>
                  <div className="flex gap-2">
                    <Button size="sm" variant="default" onClick={openCreateAdminAnnouncement}>
                      <Plus className="h-4 w-4 mr-2" />
                      Post center-wide announcement
                    </Button>
                  </div>
                </div>
                <div className="p-4 overflow-x-auto">
                  {announcementsLoading ? (
                    <div className="flex justify-center py-12">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                  ) : announcements.length === 0 ? (
                    <p className="py-8 text-center text-muted-foreground">No announcements yet.</p>
                  ) : (
                    <div className="space-y-4">
                      {announcements.map((a) => {
                        const authorName = a.author ? [a.author.firstName, a.author.lastName].filter(Boolean).join(" ") : a.authorRole === "admin" ? "Admin" : "Tutor";
                        const statusColor = a.status === "approved" ? "bg-success/10 text-success" : a.status === "rejected" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning";
                        const categoryLabel = { sick_leave: "Sick Leave", exam: "Exam", quiz: "Quiz", exam_quiz: "Exam / Quiz", materials: "Materials", reschedule: "Reschedule", reminder: "Reminder", suspension: "Class Suspension", maintenance: "Maintenance", holiday: "Holiday", general: "General" }[a.category] || a.category;
                        const targetStr = a.targetType === "all" ? "All students" : (Array.isArray(a.targetStudentIds) && a.targetStudentIds.length ? (a.targetStudentIds as { firstName?: string; lastName?: string }[]).map((s) => [s.firstName, s.lastName].filter(Boolean).join(" ")).join(", ") : "—");
                        return (
                            <div
                              key={a._id}
                              role="button"
                              tabIndex={0}
                              onClick={() => openAnnouncementDetails(a)}
                              onKeyDown={(event) => handleAnnouncementKeyDown(event, a)}
                              className="p-4 rounded-lg border border-border bg-muted/30 cursor-pointer transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                            <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className={`text-xs px-2 py-0.5 rounded font-medium ${statusColor}`}>{a.status}</span>
                                <span className="text-xs px-2 py-0.5 rounded bg-muted">{categoryLabel}</span>
                                <span className="text-xs text-muted-foreground">by {authorName}</span>
                              </div>
                              <div className="flex gap-2 flex-wrap">
                              {a.authorRole === "admin" && (
                                <>
                                  <Button size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); openEditAdminAnnouncement(a); }}>
                                    <Pencil className="h-4 w-4 mr-1" /> Edit
                                  </Button>
                                  <Button size="sm" variant="outline" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={(event) => { event.stopPropagation(); handleDeleteAnnouncement(a); }}>
                                    <Trash2 className="h-4 w-4 mr-1" /> Delete
                                  </Button>
                                </>
                              )}
                              {a.status === "pending" && a.authorRole === "tutor" && (
                                <div className="flex gap-2">
                                  <Button size="sm" variant="default" className="bg-success hover:bg-success/90" onClick={(event) => { event.stopPropagation(); handleApproveAnnouncement(a._id); }}>
                                    <Check className="h-4 w-4 mr-1" /> Approve
                                  </Button>
                                  <Button size="sm" variant="destructive" onClick={(event) => { event.stopPropagation(); handleRejectAnnouncement(a._id); }}>
                                    <X className="h-4 w-4 mr-1" /> Reject
                                  </Button>
                                </div>
                              )}
                              </div>
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
              </div>
            </TabsContent>

            <TabsContent value="audit-logs" className="space-y-6">
              <div className="bg-card rounded-xl p-6 border border-border">
                <h3 className="font-display font-bold text-lg text-foreground mb-4">Audit Logs</h3>
                <p className="text-sm text-muted-foreground mb-4">System-wide activity log. Filter by module, status, user, or date.</p>
                <div className="flex flex-wrap gap-2 mb-4">
                  <Select value={auditFilters.module || "all"} onValueChange={(v) => setAuditFilters((f) => ({ ...f, module: v }))}>
                    <SelectTrigger className="w-[160px]">
                      <SelectValue placeholder="Module" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All modules</SelectItem>
                      <SelectItem value="Authentication">Authentication</SelectItem>
                      <SelectItem value="User Management">User Management</SelectItem>
                      <SelectItem value="Enrollment">Enrollment</SelectItem>
                      <SelectItem value="Payment">Payment</SelectItem>
                      <SelectItem value="Administrative">Administrative</SelectItem>
                      <SelectItem value="Academic">Academic</SelectItem>
                      <SelectItem value="Security">Security</SelectItem>
                      <SelectItem value="Announcement">Announcement</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={auditFilters.status || "all"} onValueChange={(v) => setAuditFilters((f) => ({ ...f, status: v }))}>
                    <SelectTrigger className="w-[120px]">
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="SUCCESS">Success</SelectItem>
                      <SelectItem value="FAILED">Failed</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    type="date"
                    value={auditFilters.startDate}
                    onChange={(e) => setAuditFilters((f) => ({ ...f, startDate: e.target.value }))}
                    className="w-[140px]"
                    placeholder="Start"
                  />
                  <Input
                    type="date"
                    value={auditFilters.endDate}
                    onChange={(e) => setAuditFilters((f) => ({ ...f, endDate: e.target.value }))}
                    className="w-[140px]"
                    placeholder="End"
                  />
                  <Button variant="outline" size="sm" onClick={() => fetchAuditLogs()}>Refresh</Button>
                </div>
                {auditLogsLoading ? (
                  <div className="flex justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : auditLogs.length === 0 ? (
                  <div className="py-8 text-center text-muted-foreground">No audit logs found.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-2 font-medium">User</th>
                          <th className="text-left py-2 font-medium">Role</th>
                          <th className="text-left py-2 font-medium">Action</th>
                          <th className="text-left py-2 font-medium">Module</th>
                          <th className="text-left py-2 font-medium">Status</th>
                          <th className="text-left py-2 font-medium">IP</th>
                          <th className="text-left py-2 font-medium">Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(auditLogs || []).map((log, idx) => (
                          <tr key={log?._id || `log-${idx}`} className="border-b border-border/50">
                            <td className="py-2">{log?.userName || log?.userIdentifier || "—"}</td>
                            <td className="py-2">
                              <span
                                className={`inline-flex rounded-full px-2 py-1 text-xs font-medium capitalize ${roleColors[log?.userRole || ""] || "bg-muted text-muted-foreground"}`}
                              >
                                {formatRoleLabel(log?.userRole)}
                              </span>
                            </td>
                            <td className="py-2">{log?.action ?? "—"}</td>
                            <td className="py-2">{log?.module ?? "—"}</td>
                            <td className="py-2">
                              <span className={(log?.status === "SUCCESS" ? "text-success" : "text-destructive") + " font-medium"}>{log?.status ?? "—"}</span>
                            </td>
                            <td className="py-2 text-muted-foreground">{log?.ipAddress || "—"}</td>
                            <td className="py-2 text-muted-foreground">{log?.createdAt ? new Date(log.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
        </div>
      </div>

      {/* Add Tutor dialog */}
      <Dialog open={addTutorOpen} onOpenChange={setAddTutorOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              Add Tutor
            </DialogTitle>
            <DialogDescription>
              Create a new tutor account. Email is provided by admin. Tutor can change password after first login.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4 py-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!addTutorForm.firstName?.trim() || !addTutorForm.lastName?.trim() || !addTutorForm.email?.trim() || !addTutorForm.password || !addTutorForm.phone?.trim()) {
                toast.error("First name, last name, email, password, and phone are required.");
                return;
              }
              setAddTutorSubmitting(true);
              try {
                const availabilityStr =
                  addTutorForm.employmentType === "part-time"
                    ? buildAvailabilityString(
                        addTutorForm.availabilityDays,
                        addTutorForm.availabilityStart,
                        addTutorForm.availabilityEnd
                      )
                    : undefined;
                const res = await userService.createTutor({
                  firstName: addTutorForm.firstName.trim(),
                  middleName: addTutorForm.middleName.trim() || undefined,
                  lastName: addTutorForm.lastName.trim(),
                  email: normalizedTutorEmail,
                  password: addTutorForm.password,
                  phone: addTutorForm.phone.trim(),
                  employmentType: addTutorForm.employmentType,
                  availability: availabilityStr || undefined,
                });
                const responseData = res?.data;
                if (responseData?.success) {
                  toast.success(responseData.message || "Tutor created successfully.");
                  setAddTutorOpen(false);
                  setAddTutorForm({
                    firstName: "",
                    middleName: "",
                    lastName: "",
                    email: "",
                    password: "",
                    phone: "",
                    subjectsTaught: [],
                    employmentType: "full-time",
                    availability: "",
                    availabilityDays: [],
                    availabilityStart: "",
                    availabilityEnd: "",
                  });
                  setAddTutorEmailVerification(initialEmailVerificationState);
                  fetchUsers();
                } else {
                  toast.error(responseData?.message || "Failed to create tutor.");
                }
              } catch (err: unknown) {
                const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to create tutor.";
                toast.error(msg);
              } finally {
                setAddTutorSubmitting(false);
              }
            }}
          >
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tutor-firstName">First Name</Label>
                <Input
                  id="tutor-firstName"
                  value={addTutorForm.firstName}
                  onChange={(e) => setAddTutorForm((f) => ({ ...f, firstName: sanitizeName(e.target.value) }))}
                  placeholder="Maria"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tutor-middleName">Middle Name (optional)</Label>
                <Input
                  id="tutor-middleName"
                  value={addTutorForm.middleName}
                  onChange={(e) => setAddTutorForm((f) => ({ ...f, middleName: e.target.value }))}
                  placeholder="Santos"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tutor-lastName">Last Name</Label>
              <Input
                id="tutor-lastName"
                value={addTutorForm.lastName}
                onChange={(e) => setAddTutorForm((f) => ({ ...f, lastName: sanitizeName(e.target.value) }))}
                placeholder="Dela Cruz"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tutor-email">Email (provided by admin)</Label>
              <Input
                id="tutor-email"
                type="email"
                value={addTutorForm.email}
                onChange={(e) => handleTutorEmailChange(e.target.value)}
                placeholder="tutor@beebright.edu.ph"
                required
              />
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-muted-foreground">
                  The account will be created immediately using the email and password provided.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tutor-password">Password</Label>
                <PasswordInput
                  id="tutor-password"
                  value={addTutorForm.password}
                  onChange={(e) => setAddTutorForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="Min 8 chars, 1 upper, 1 lower, 1 number, 1 special"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tutor-phone">Phone (Philippine)</Label>
                <Input
                  id="tutor-phone"
                  type="tel"
                  value={addTutorForm.phone}
                  onChange={(e) => setAddTutorForm((f) => ({ ...f, phone: sanitizePhoneInput(e.target.value) }))}
                  placeholder="09XX XXX XXXX"
                  required
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Employment Type</Label>
              <Select
                value={addTutorForm.employmentType}
                onValueChange={(v) => setAddTutorForm((f) => ({ ...f, employmentType: v as "full-time" | "part-time" }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full-time">Full-time</SelectItem>
                  <SelectItem value="part-time">Part-time</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {addTutorForm.employmentType === "part-time" && (
              <div className="space-y-4 rounded-lg border border-border p-4 bg-muted/20">
                <div className="space-y-2">
                  <Label>Days available</Label>
                  <p className="text-xs text-muted-foreground">Click to select days this tutor is available.</p>
                  <div className="flex flex-wrap gap-2">
                    {AVAILABILITY_DAYS.map((day) => (
                      <Button
                        key={day}
                        type="button"
                        variant={addTutorForm.availabilityDays.includes(day) ? "default" : "outline"}
                        size="sm"
                        onClick={() =>
                          setAddTutorForm((f) => ({
                            ...f,
                            availabilityDays: f.availabilityDays.includes(day)
                              ? f.availabilityDays.filter((d) => d !== day)
                              : [...f.availabilityDays, day],
                          }))
                        }
                      >
                        {day}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Time available</Label>
                  <p className="text-xs text-muted-foreground">Click start and end time for this availability.</p>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Start time</p>
                      <div className="flex flex-wrap gap-1">
                        {AVAILABILITY_TIME_SLOTS.map((slot) => (
                          <Button
                            key={`start-${slot}`}
                            type="button"
                            variant={addTutorForm.availabilityStart === slot ? "default" : "outline"}
                            size="sm"
                            className="text-xs"
                            onClick={() =>
                              setAddTutorForm((f) => ({
                                ...f,
                                availabilityStart: slot,
                                availabilityEnd: f.availabilityEnd && slot >= f.availabilityEnd ? "" : f.availabilityEnd,
                              }))
                            }
                          >
                            {formatTime12h(slot)}
                          </Button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">End time</p>
                      <div className="flex flex-wrap gap-1">
                        {AVAILABILITY_TIME_SLOTS.filter(
                          (slot) => !addTutorForm.availabilityStart || slot > addTutorForm.availabilityStart
                        ).map((slot) => (
                          <Button
                            key={`end-${slot}`}
                            type="button"
                            variant={addTutorForm.availabilityEnd === slot ? "default" : "outline"}
                            size="sm"
                            className="text-xs"
                            onClick={() =>
                              setAddTutorForm((f) => ({ ...f, availabilityEnd: slot }))
                            }
                          >
                            {formatTime12h(slot)}
                          </Button>
                        ))}
                        {addTutorForm.availabilityStart && AVAILABILITY_TIME_SLOTS.filter((s) => s > addTutorForm.availabilityStart).length === 0 && (
                          <span className="text-xs text-muted-foreground">Pick a later start first</span>
                        )}
                      </div>
                    </div>
                  </div>
                  {addTutorForm.availabilityDays.length > 0 && addTutorForm.availabilityStart && addTutorForm.availabilityEnd && (
                    <p className="text-xs text-muted-foreground pt-1">
                      Summary: {buildAvailabilityString(addTutorForm.availabilityDays, addTutorForm.availabilityStart, addTutorForm.availabilityEnd)}
                    </p>
                  )}
                </div>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddTutorOpen(false)} disabled={addTutorSubmitting}>
                Cancel
              </Button>
              <Button
                type="submit"
                className="btn-glow"
                disabled={addTutorSubmitting}
              >
                {addTutorSubmitting ? "Creating..." : "Create Tutor"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Admin dialog – only for super admin */}
      {isSuperAdmin && (
        <Dialog open={addAdminOpen} onOpenChange={setAddAdminOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Add Admin
              </DialogTitle>
              <DialogDescription>
                Create a new admin account. Data is saved to the database. Email and Philippine mobile number required.
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-4 py-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!addAdminForm.firstName?.trim() || !addAdminForm.lastName?.trim() || !addAdminForm.email?.trim() || !addAdminForm.password || !addAdminForm.phone?.trim()) {
                  toast.error("First name, last name, email, password, and phone are required.");
                  return;
                }
                setAddAdminSubmitting(true);
                try {
                  const res = await userService.createAdmin({
                    firstName: addAdminForm.firstName.trim(),
                    middleName: addAdminForm.middleName?.trim() || undefined,
                    lastName: addAdminForm.lastName.trim(),
                    email: normalizedAdminEmail,
                    password: addAdminForm.password,
                    phone: addAdminForm.phone.trim(),
                  });
                  const responseData = res?.data;
                  if (responseData?.success) {
                    toast.success(responseData.message ?? "Admin created successfully.");
                    setAddAdminOpen(false);
                    setAddAdminForm({ firstName: "", middleName: "", lastName: "", email: "", password: "", phone: "" });
                    setAddAdminEmailVerification(initialEmailVerificationState);
                    fetchUsers();
                  } else {
                    toast.error(responseData?.message || "Failed to create admin.");
                  }
                } catch (err: unknown) {
                  const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to create admin.";
                  toast.error(msg);
                } finally {
                  setAddAdminSubmitting(false);
                }
              }}
            >
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="admin-firstName">First Name</Label>
                <Input id="admin-firstName" value={addAdminForm.firstName} onChange={(e) => setAddAdminForm((f) => ({ ...f, firstName: sanitizeName(e.target.value) }))} placeholder="Maria" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="admin-middleName">Middle Name</Label>
                <Input id="admin-middleName" value={addAdminForm.middleName} onChange={(e) => setAddAdminForm((f) => ({ ...f, middleName: sanitizeName(e.target.value) }))} placeholder="Optional" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="admin-lastName">Last Name</Label>
              <Input id="admin-lastName" value={addAdminForm.lastName} onChange={(e) => setAddAdminForm((f) => ({ ...f, lastName: sanitizeName(e.target.value) }))} placeholder="Dela Cruz" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="admin-email">Email</Label>
              <Input id="admin-email" type="email" value={addAdminForm.email} onChange={(e) => handleAdminEmailChange(e.target.value)} placeholder="admin@beebright.com" required />
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-muted-foreground">
                  The account will be created immediately using the email and password provided.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="admin-password">Password</Label>
                <PasswordInput id="admin-password" value={addAdminForm.password} onChange={(e) => setAddAdminForm((f) => ({ ...f, password: e.target.value }))} placeholder="Min 8 chars, 1 upper, 1 lower, 1 number, 1 special" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="admin-phone">Phone (Philippine)</Label>
                <Input id="admin-phone" type="tel" value={addAdminForm.phone} onChange={(e) => setAddAdminForm((f) => ({ ...f, phone: sanitizePhoneInput(e.target.value) }))} placeholder="09XX XXX XXXX" required />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddAdminOpen(false)} disabled={addAdminSubmitting}>
                Cancel
              </Button>
              <Button
                type="submit"
                className="btn-glow"
                disabled={addAdminSubmitting}
              >
                {addAdminSubmitting ? "Creating..." : "Add Admin"}
              </Button>
            </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      <Dialog open={substituteDialogOpen} onOpenChange={setSubstituteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign Substitute Tutor</DialogTitle>
            <DialogDescription>
              Reassign this schedule to another qualified tutor without losing existing schedule data.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Replacement tutor</Label>
              <Select value={substituteTutorId} onValueChange={setSubstituteTutorId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select tutor" />
                </SelectTrigger>
                <SelectContent>
                  {substituteTutorOptions.map((t) => (
                    <SelectItem key={t._id} value={t._id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="substitute-reason">Reason</Label>
              <Input
                id="substitute-reason"
                value={substituteReason}
                onChange={(e) => setSubstituteReason(e.target.value)}
                placeholder="Tutor unavailable"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSubstituteDialogOpen(false)} disabled={substituteLoading}>
              Cancel
            </Button>
            <Button type="button" onClick={handleAssignSubstitute} disabled={substituteLoading || !substituteTutorId}>
              {substituteLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Assign Substitute
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!pendingUserAction}
        onOpenChange={(open) => {
          if (!open) {
            setPendingUserAction(null);
          }
        }}
      >
        <AlertDialogContent className="z-[70] sm:max-w-sm">
          {pendingUserActionDialog ? (
            <>
              <AlertDialogHeader>
                <div className={`mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full ${pendingUserActionDialog.iconClassName}`}>
                  <pendingUserActionDialog.icon className="h-5 w-5" />
                </div>
                <AlertDialogTitle>{pendingUserActionDialog.title}</AlertDialogTitle>
                <AlertDialogDescription>{pendingUserActionDialog.description}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="flex gap-2 sm:justify-end">
                <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    void confirmPendingUserAction();
                  }}
                  className={pendingUserActionDialog.actionClassName}
                >
                  {pendingUserActionDialog.actionLabel}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>

      {/* Admin: Post center-wide announcement */}
      <Dialog open={!!archivedUserDetail} onOpenChange={(open) => { if (!open) setArchivedUserDetail(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Archived User Details</DialogTitle>
            <DialogDescription>
              Account information for the selected archived user.
            </DialogDescription>
          </DialogHeader>
          {archivedUserDetail ? (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-muted-foreground">Name</p>
                  <p className="font-medium text-foreground">
                    {[archivedUserDetail.firstName, archivedUserDetail.middleName, archivedUserDetail.lastName].filter(Boolean).join(" ") || "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Role</p>
                  <p className="font-medium text-foreground capitalize">{archivedUserDetail.role?.replace("_", " ") || "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Email</p>
                  <p className="font-medium text-foreground break-all">{archivedUserDetail.email || "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Phone</p>
                  <p className="font-medium text-foreground">{archivedUserDetail.phone || "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Grade Level</p>
                  <p className="font-medium text-foreground">{archivedUserDetail.gradeLevel || "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Enrollment Status</p>
                  <p className="font-medium text-foreground capitalize">{archivedUserDetail.enrollmentStatus || "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Created</p>
                  <p className="font-medium text-foreground">{archivedUserDetail.createdAt ? new Date(archivedUserDetail.createdAt).toLocaleString() : "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Archived At</p>
                  <p className="font-medium text-foreground">{archivedUserDetail.archivedAt ? new Date(archivedUserDetail.archivedAt).toLocaleString() : "—"}</p>
                </div>
              </div>

              {Array.isArray(archivedUserDetail.subjectsTaught) && archivedUserDetail.subjectsTaught.length > 0 ? (
                <div>
                  <p className="text-muted-foreground mb-1">Subjects Taught</p>
                  <div className="flex flex-wrap gap-2">
                    {archivedUserDetail.subjectsTaught.map((s) => (
                      <span key={s._id} className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                        {s.name}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => {
                    if (!archivedUserDetail) return;
                    void handleDeleteArchivedUser(archivedUserDetail, true);
                  }}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete User
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    if (!archivedUserDetail) return;
                    void handleUnarchiveUser(archivedUserDetail, true);
                  }}
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Unarchive
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Admin: Post center-wide announcement */}
      <Dialog open={adminAnnouncementOpen} onOpenChange={setAdminAnnouncementOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingAdminAnnouncementId ? "Edit center-wide announcement" : "Post center-wide announcement"}</DialogTitle>
            <DialogDescription>Select a type to quick-fill, or write your own. Maintenance announcements only affect students and tutors on the date you choose here.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4 py-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!adminAnnouncementForm.title.trim() || !adminAnnouncementForm.body.trim()) {
                toast.error("Title and message are required.");
                return;
              }
              setAdminAnnouncementSubmitting(true);
              try {
                const payload = {
                  title: adminAnnouncementForm.title.trim(),
                  body: adminAnnouncementForm.body.trim(),
                  category: adminAnnouncementForm.category,
                  scheduledDate: adminAnnouncementForm.scheduledDate || undefined,
                };
                const res = editingAdminAnnouncementId
                  ? await announcementService.update(editingAdminAnnouncementId, payload)
                  : await announcementService.create({
                      ...payload,
                      targetType: "all",
                    });
                if (res.data?.success) {
                  toast.success(editingAdminAnnouncementId ? "Announcement updated." : "Announcement posted. All students have been notified by email.");
                  setAdminAnnouncementOpen(false);
                  setEditingAdminAnnouncementId(null);
                  setAdminAnnouncementForm({ title: "", body: "", category: "suspension", scheduledDate: "" });
                  fetchAnnouncements();
                } else {
                  const message = (res.data as { message?: string } | undefined)?.message;
                  toast.error(message || "Failed to post.");
                }
              } catch (err: unknown) {
                toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || "Failed to post announcement.");
              } finally {
                setAdminAnnouncementSubmitting(false);
              }
            }}
          >
            <div className="space-y-2">
              <Label>Quick select</Label>
              <div className="flex flex-wrap gap-2">
                {[
                  { title: "Class suspension", body: "Classes are suspended. Please check back for updates on when sessions will resume.", category: "suspension" as const },
                  { title: "System maintenance", body: "Our system will undergo maintenance. Some features may be temporarily unavailable. We apologize for any inconvenience.", category: "maintenance" as const },
                  { title: "Holiday closure", body: "The center will be closed for the holiday. Classes will resume as per the schedule. Enjoy the break!", category: "holiday" as const },
                  { title: "Important notice", body: "Please take note of this important update from Bee Bright.", category: "general" as const },
                ].map((opt) => (
                  <Button key={opt.category} type="button" variant="outline" size="sm" onClick={() => setAdminAnnouncementForm((f) => ({ ...f, title: opt.title, body: opt.body, category: opt.category }))}>
                    {opt.title}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input value={adminAnnouncementForm.title} onChange={(e) => setAdminAnnouncementForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Class suspension tomorrow" required />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label>Category</Label>
                <Select value={adminAnnouncementForm.category} onValueChange={(v) => setAdminAnnouncementForm((f) => ({ ...f, category: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="suspension">Class suspension</SelectItem>
                    <SelectItem value="maintenance">System maintenance</SelectItem>
                    <SelectItem value="holiday">Holiday closure</SelectItem>
                    <SelectItem value="general">General</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Date when it happens</Label>
                <Input
                  type="date"
                  value={adminAnnouncementForm.scheduledDate}
                  onChange={(e) => setAdminAnnouncementForm((f) => ({ ...f, scheduledDate: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Message *</Label>
              <textarea
                className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                value={adminAnnouncementForm.body}
                onChange={(e) => setAdminAnnouncementForm((f) => ({ ...f, body: e.target.value }))}
                placeholder="Write your announcement..."
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setAdminAnnouncementOpen(false); setEditingAdminAnnouncementId(null); }}>Cancel</Button>
              <Button type="submit" disabled={adminAnnouncementSubmitting}>
                {adminAnnouncementSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {editingAdminAnnouncementId ? "Save changes" : "Post"}
              </Button>
            </DialogFooter>
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
                  <span className={`px-2 py-0.5 rounded font-medium ${selectedAnnouncement.status === "approved" ? "bg-success/10 text-success" : selectedAnnouncement.status === "rejected" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning"}`}>{selectedAnnouncement.status}</span>
                  <span className="px-2 py-0.5 rounded bg-muted text-muted-foreground">{announcementCategoryLabel(selectedAnnouncement.category)}</span>
                  <span>by {selectedAnnouncement.author ? [selectedAnnouncement.author.firstName, selectedAnnouncement.author.lastName].filter(Boolean).join(" ") : selectedAnnouncement.authorRole === "admin" ? "Admin" : "Tutor"}</span>
                </div>
                <p className="text-sm leading-7 text-foreground whitespace-pre-wrap">{selectedAnnouncement.body}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span>To: {selectedAnnouncement.targetType === "all" ? "All students" : (Array.isArray(selectedAnnouncement.targetStudentIds) && selectedAnnouncement.targetStudentIds.length ? (selectedAnnouncement.targetStudentIds as { firstName?: string; lastName?: string }[]).map((s) => [s.firstName, s.lastName].filter(Boolean).join(" ")).join(", ") : "—")}</span>
                  {selectedAnnouncement.scheduledDate && <span>When: {new Date(selectedAnnouncement.scheduledDate).toLocaleDateString("en-US", { dateStyle: "medium" })}</span>}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Add New Student (walk-in enrollment) dialog */}
      <Dialog open={addStudentOpen} onOpenChange={setAddStudentOpen}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GraduationCap className="h-5 w-5" />
              Add New Student (Walk-in)
            </DialogTitle>
            <DialogDescription>
              Create a student account and enrollment in one step. All fields with * are required. Use Gmail and Philippine mobile number.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4 py-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!addStudentForm.firstName?.trim() || !addStudentForm.lastName?.trim() || !addStudentForm.email?.trim() || !addStudentForm.phone?.trim() || !addStudentForm.password || !addStudentForm.gradeLevel || !addStudentForm.guardianName?.trim()) {
                toast.error("Please fill all required fields.");
                return;
              }
              if (addStudentForm.selectedSubjectIds.length === 0) {
                toast.error("Select at least one program.");
                return;
              }
              const totalFeeNum = addStudentCalculatedTotal;
              if (totalFeeNum < 0) {
                toast.error("Invalid total fee from selected programs.");
                return;
              }
              setAddStudentSubmitting(true);
              try {
                const res = await enrollmentService.adminAddStudent({
                  firstName: addStudentForm.firstName.trim(),
                  middleName: addStudentForm.middleName?.trim() || undefined,
                  lastName: addStudentForm.lastName.trim(),
                  email: addStudentForm.email.trim(),
                  phone: addStudentForm.phone.trim(),
                  password: addStudentForm.password,
                  gradeLevel: addStudentForm.gradeLevel,
                  guardianName: addStudentForm.guardianName.trim(),
                  guardianPhone: addStudentForm.guardianPhone?.trim() || undefined,
                  selectedSubjectIds: addStudentForm.selectedSubjectIds,
                  paymentOption: addStudentForm.paymentOption,
                  totalFee: totalFeeNum,
                  paymentStatus: addStudentForm.paymentStatus,
                  status: addStudentForm.status,
                  enrollmentDate: addStudentForm.enrollmentDate || undefined,
                });
                if (res.data?.success) {
                  toast.success(res.data?.message ?? "Student added successfully.");
                  setAddStudentOpen(false);
                  setAddStudentForm({
                    firstName: "",
                    middleName: "",
                    lastName: "",
                    email: "",
                    phone: "",
                    password: "",
                    gradeLevel: "",
                    guardianName: "",
                    guardianPhone: "",
                    selectedSubjectIds: [],
                    paymentOption: "full",
                    paymentStatus: "paid",
                    status: "active",
                    enrollmentDate: new Date().toISOString().slice(0, 10),
                  });
                  fetchEnrollments();
                  fetchUsers();
                  fetchDashboardStats();
                  fetchAdminPayments();
                } else {
                  toast.error(res.data?.message || "Failed to add student.");
                }
              } catch (err: unknown) {
                const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to add student.";
                toast.error(msg);
              } finally {
                setAddStudentSubmitting(false);
              }
            }}
          >
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="stu-firstName">First Name *</Label>
                <Input id="stu-firstName" value={addStudentForm.firstName} onChange={(e) => setAddStudentForm((f) => ({ ...f, firstName: sanitizeName(e.target.value) }))} placeholder="Juan" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="stu-middleName">Middle Name</Label>
                <Input id="stu-middleName" value={addStudentForm.middleName} onChange={(e) => setAddStudentForm((f) => ({ ...f, middleName: sanitizeName(e.target.value) }))} placeholder="Optional" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="stu-lastName">Last Name *</Label>
              <Input id="stu-lastName" value={addStudentForm.lastName} onChange={(e) => setAddStudentForm((f) => ({ ...f, lastName: sanitizeName(e.target.value) }))} placeholder="Dela Cruz" required />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="stu-email">Email (Gmail) *</Label>
                <Input id="stu-email" type="email" value={addStudentForm.email} onChange={(e) => setAddStudentForm((f) => ({ ...f, email: e.target.value }))} placeholder="student@gmail.com" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="stu-phone">Phone (Philippine) *</Label>
                <Input id="stu-phone" type="tel" value={addStudentForm.phone} onChange={(e) => setAddStudentForm((f) => ({ ...f, phone: sanitizePhoneInput(e.target.value) }))} placeholder="09XX XXX XXXX" required />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="stu-password">Password *</Label>
              <PasswordInput
                id="stu-password"
                value={addStudentForm.password}
                onChange={(e) => setAddStudentForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="Min 8 chars, 1 upper, 1 lower, 1 number, 1 special (@$!%*?&)"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="stu-gradeLevel">Grade Level *</Label>
                <Select value={addStudentForm.gradeLevel} onValueChange={(v) => setAddStudentForm((f) => ({ ...f, gradeLevel: v }))} required>
                  <SelectTrigger id="stu-gradeLevel">
                    <SelectValue placeholder="Select grade" />
                  </SelectTrigger>
                  <SelectContent>
                    {GRADE_LEVELS.map((g) => (
                      <SelectItem key={g} value={g}>{g}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="stu-enrollmentDate">Enrollment Date</Label>
                <Input
                  id="stu-enrollmentDate"
                  type="date"
                  value={addStudentForm.enrollmentDate}
                  onChange={(e) => setAddStudentForm((f) => ({ ...f, enrollmentDate: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="stu-guardianName">Guardian Name *</Label>
                <Input id="stu-guardianName" value={addStudentForm.guardianName} onChange={(e) => setAddStudentForm((f) => ({ ...f, guardianName: sanitizeName(e.target.value) }))} placeholder="Parent/Guardian" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="stu-guardianPhone">Guardian Phone</Label>
                <Input id="stu-guardianPhone" type="tel" value={addStudentForm.guardianPhone} onChange={(e) => setAddStudentForm((f) => ({ ...f, guardianPhone: sanitizePhoneInput(e.target.value) }))} placeholder="09XX XXX XXXX" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Program(s) *</Label>
              <p className="text-xs text-muted-foreground">
                {addStudentForm.gradeLevel
                  ? `Programs applicable to ${addStudentForm.gradeLevel}. Select one or more.`
                  : "Select grade level first to see applicable programs."}
              </p>
              <div className="flex flex-wrap gap-2 border border-border rounded-lg p-3 bg-muted/20 max-h-32 overflow-y-auto">
                {!addStudentForm.gradeLevel ? (
                  <p className="text-sm text-muted-foreground">Select grade level above to see programs.</p>
                ) : addStudentProgramsForGrade.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {addStudentPrograms.length === 0 ? "Loading programs..." : "No programs match this grade level."}
                  </p>
                ) : (
                  addStudentProgramsForGrade.map((prog) => (
                    <div key={prog._id} className="flex items-center space-x-2">
                      <Checkbox
                        id={`prog-${prog._id}`}
                        checked={addStudentForm.selectedSubjectIds.includes(prog._id)}
                        onCheckedChange={(checked) => {
                          setAddStudentForm((f) => ({
                            ...f,
                            selectedSubjectIds: checked ? [...f.selectedSubjectIds, prog._id] : f.selectedSubjectIds.filter((id) => id !== prog._id),
                          }));
                        }}
                      />
                      <label htmlFor={`prog-${prog._id}`} className="text-sm font-medium cursor-pointer">
                        {prog.name} {prog.price != null ? `(₱${(prog.price as number).toLocaleString()})` : ""}
                      </label>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="space-y-4">
              <div className="p-4 bg-muted rounded-lg">
                <p className="text-sm text-muted-foreground">Total fee from selected programs</p>
                <p className="text-xl font-bold text-foreground">
                  ₱{addStudentCalculatedTotal.toLocaleString()}/month
                </p>
                {addStudentForm.paymentOption === "down" && addStudentCalculatedTotal > 0 && (
                  <p className="text-sm text-muted-foreground mt-1">
                    Partial (50%): ₱{Math.ceil(addStudentCalculatedTotal * 0.5).toLocaleString()} now
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="stu-paymentOption">Payment Option</Label>
                <Select value={addStudentForm.paymentOption} onValueChange={(v) => setAddStudentForm((f) => ({ ...f, paymentOption: v as "full" | "down" }))}>
                  <SelectTrigger id="stu-paymentOption">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">Full payment</SelectItem>
                    <SelectItem value="down">Partial payment</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="stu-paymentStatus">Payment Status</Label>
                <Select value={addStudentForm.paymentStatus} onValueChange={(v) => setAddStudentForm((f) => ({ ...f, paymentStatus: v }))}>
                  <SelectTrigger id="stu-paymentStatus">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_STATUS_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="stu-status">Enrollment Status</Label>
                <Select value={addStudentForm.status} onValueChange={(v) => setAddStudentForm((f) => ({ ...f, status: v }))}>
                  <SelectTrigger id="stu-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENROLLMENT_STATUS_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddStudentOpen(false)} disabled={addStudentSubmitting}>
                Cancel
              </Button>
              <Button type="submit" className="btn-glow" disabled={addStudentSubmitting || addStudentForm.selectedSubjectIds.length === 0}>
                {addStudentSubmitting ? "Saving..." : "Add Student"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* View Enrollment / Proof of Payment modal */}
      <Dialog open={!!viewEnrollmentId} onOpenChange={(open) => !open && setViewEnrollmentId(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Enrollment Details</DialogTitle>
            <DialogDescription>Review student info, payment proof, and consent before taking action.</DialogDescription>
          </DialogHeader>
          {viewEnrollmentLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
          ) : viewEnrollmentData ? (() => {
            const e = viewEnrollmentData.enrollment;
            const eAny = e as Record<string, unknown>;
            const snap = eAny.studentSnapshot as { firstName?: string; lastName?: string; birthdate?: string; computedAge?: number } | undefined;
            const parent = eAny.parent as { firstName?: string; lastName?: string; email?: string; phone?: string } | undefined;
            const packages = (eAny.packages as { displayName?: string; price?: number; paymentOption?: string }[] | undefined) || [];
            const preferredStart = eAny.preferredStartDate ? new Date(String(eAny.preferredStartDate)).toLocaleDateString('en-PH') : '—';
            const preferredTime = String(eAny.preferredTime || '—');
            const healthInfo = eAny.healthInfo as { allergies?: string; medications?: string; specialNeeds?: boolean; specialNeedsDetails?: string } | undefined;
            const consentItems = (eAny.consentItems as { name?: string; accepted?: boolean }[] | undefined) || [];
            const statusHistory = (eAny.statusHistory as { status?: string; at?: string; byRole?: string; note?: string }[] | undefined) || [];
            const statusColors: Record<string, string> = {
              approved: 'bg-emerald-100 text-emerald-800', active: 'bg-emerald-100 text-emerald-800',
              pending_approval: 'bg-purple-100 text-purple-800', payment_under_verification: 'bg-amber-100 text-amber-800',
              submitted: 'bg-blue-100 text-blue-800', pending: 'bg-blue-100 text-blue-800',
              rejected: 'bg-red-100 text-red-800', cancelled: 'bg-gray-100 text-gray-700', draft: 'bg-gray-100 text-gray-600',
            };
            const sc = statusColors[e.status] || 'bg-muted text-muted-foreground';
            const isActionable = ['submitted','payment_under_verification','pending_approval','pending'].includes(e.status);
            return (
              <div className="space-y-5">
                {/* Status badge */}
                <div className="flex items-center gap-3">
                  {eAny.enrollmentId && <span className="font-mono font-bold text-foreground">{String(eAny.enrollmentId)}</span>}
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${sc}`}>{e.status}</span>
                  {(eAny.allowResubmission as boolean) && <span className="text-xs px-2 py-1 rounded-full bg-orange-100 text-orange-800 font-medium">Resubmission Allowed</span>}
                </div>

                {/* Parent info */}
                {parent && (
                  <div className="p-3 bg-muted rounded-lg text-sm space-y-1">
                    <p className="font-semibold text-foreground text-xs uppercase tracking-wide mb-1">Parent / Guardian</p>
                    <p>{[parent.firstName, parent.lastName].filter(Boolean).join(' ') || '—'}</p>
                    <p className="text-muted-foreground">{parent.email} · {parent.phone}</p>
                  </div>
                )}

                {/* Enrollment requirement documents — Birth Certificate, 2×2 Photo, Guardian ID */}
                {(() => {
                  const rd = eAny.requirementDocuments as Record<string, { path?: string | null; fileName?: string | null; uploadedAt?: string | null } | undefined> | undefined;
                  const docs = [
                    { key: 'birthCertificate', label: 'Student Birth Certificate', doc: rd?.birthCertificate },
                    { key: 'studentPhoto', label: 'Recent 2×2 Photo of Student', doc: rd?.studentPhoto },
                    { key: 'guardianId', label: 'Guardian Valid ID', doc: rd?.guardianId },
                  ];
                  const anyUploaded = docs.some((d) => d.doc?.path);
                  return (
                    <div className="p-3 border border-border rounded-lg space-y-3">
                      <p className="font-semibold text-foreground text-xs uppercase tracking-wide">Enrollment Requirements</p>
                      {anyUploaded ? (
                        <div className="grid gap-3 sm:grid-cols-3">
                          {docs.map(({ key, label, doc }) => (
                            <div key={key} className="space-y-1">
                              <p className="text-xs font-medium text-foreground">{label}</p>
                              {doc?.path ? (
                                <>
                                  <FilePreview src={{ dataUrl: resolvePaymentProofUrl(doc.path), fileName: doc.fileName || label }} label={label} />
                                  {doc.uploadedAt && <p className="text-[11px] text-muted-foreground">Uploaded {new Date(doc.uploadedAt).toLocaleDateString('en-PH')}</p>}
                                </>
                              ) : (
                                <p className="text-xs text-destructive">Not uploaded</p>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          No requirement documents on file for this enrollment. (Enrollments submitted before this feature will not have them.)
                        </p>
                      )}
                    </div>
                  );
                })()}

                {/* Student info */}
                <div className="p-3 bg-muted rounded-lg text-sm space-y-1">
                  <p className="font-semibold text-foreground text-xs uppercase tracking-wide mb-1">Student (Child)</p>
                  {snap ? (
                    <>
                      <p>{[snap.firstName, snap.lastName].filter(Boolean).join(' ') || '—'}</p>
                      {snap.birthdate && <p className="text-muted-foreground">Born: {new Date(snap.birthdate).toLocaleDateString('en-PH')} · Age: {snap.computedAge ? `${snap.computedAge.toFixed(1)} yrs` : '—'}</p>}
                      {(eAny.studentId as string) && <p className="text-muted-foreground">Student ID: <span className="font-mono font-semibold text-foreground">{String(eAny.studentId)}</span></p>}
                    </>
                  ) : <p className="text-muted-foreground">—</p>}
                  {(eAny.preferredStartDate as string) && <p className="text-muted-foreground">Preferred start: {preferredStart} ({preferredTime})</p>}
                </div>

                {/* Programs */}
                {packages.length > 0 && (
                  <div className="p-3 bg-muted rounded-lg text-sm">
                    <p className="font-semibold text-foreground text-xs uppercase tracking-wide mb-2">Programs Selected</p>
                    {packages.map((pkg, i) => (
                      <div key={i} className="flex justify-between"><span>{pkg.displayName}</span><span className="font-medium">₱{(pkg.price || 0).toLocaleString()}</span></div>
                    ))}
                    <div className="border-t border-border mt-2 pt-2 flex justify-between font-bold">
                      <span>Total Fee</span><span>₱{(e.totalFee || 0).toLocaleString()} ({e.paymentOption})</span>
                    </div>
                  </div>
                )}

                {/* Health info */}
                {healthInfo && (healthInfo.allergies || healthInfo.medications || healthInfo.specialNeeds) && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
                    <p className="font-semibold text-amber-800 text-xs uppercase tracking-wide mb-1">Health Info</p>
                    {healthInfo.allergies && <p><strong>Allergies:</strong> {healthInfo.allergies}</p>}
                    {healthInfo.medications && <p><strong>Medications:</strong> {healthInfo.medications}</p>}
                    {healthInfo.specialNeeds && <p><strong>Special needs:</strong> {healthInfo.specialNeedsDetails || 'Yes'}</p>}
                  </div>
                )}

                {eAny.preEnrollmentAssessment && (
                  <div className="p-3 bg-sky-50 border border-sky-200 rounded-lg">
                    <p className="font-semibold text-sky-900 text-xs uppercase tracking-wide mb-2">Pre-Enrollment Assessment</p>
                    <EnrollmentAssessmentView assessment={eAny.preEnrollmentAssessment as never} compact />
                  </div>
                )}

                {/* Consent */}
                {consentItems.length > 0 && (
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm">
                    <p className="font-semibold text-emerald-800 text-xs uppercase tracking-wide mb-2">Consent</p>
                    {consentItems.map((c, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <CheckCircle2 className={`h-4 w-4 flex-shrink-0 ${c.accepted ? 'text-emerald-600' : 'text-red-500'}`} />
                        <span className="text-xs">{c.name?.replace(/_/g, ' ')}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Payments + Proof */}
                <div className="space-y-3">
                  <h4 className="font-semibold text-foreground text-sm">Payment(s) & Proof</h4>
                  {viewEnrollmentData.payments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No payment records yet.</p>
                  ) : viewEnrollmentData.payments.map((p) => {
                    const proofSrc = p.proofUrl || p.gcashDetails?.screenshotUrl;
                    return (
                      <div key={p._id} className="p-4 border border-border rounded-lg space-y-2">
                        <div className="flex justify-between items-start">
                          <div>
                            <p className="text-sm font-medium">Ref: <span className="font-mono">{p.referenceNumber || p._id.slice(-8)}</span></p>
                            <p className="text-xs text-muted-foreground">Method: {p.paymentMethod || '—'} · Amount: ₱{(p.amountDue || p.amount || 0).toLocaleString()}</p>
                            {p.payerReference && <p className="text-xs text-muted-foreground">Payer ref: {p.payerReference}</p>}
                            {p.resubmissionCount && p.resubmissionCount > 0 ? <p className="text-xs text-amber-600">Resubmitted {p.resubmissionCount}×</p> : null}
                          </div>
                          <span className={`text-xs px-2 py-1 rounded-full font-medium ${p.status === 'verified' ? 'bg-emerald-100 text-emerald-800' : p.status === 'submitted' ? 'bg-amber-100 text-amber-800' : p.status === 'rejected' ? 'bg-red-100 text-red-800' : 'bg-muted text-muted-foreground'}`}>{p.status}</span>
                        </div>
                        {proofSrc ? (
                          <div className="space-y-1">
                            <p className="text-xs text-muted-foreground">Proof of Payment{p.submittedAt ? ` · submitted ${new Date(p.submittedAt).toLocaleString('en-PH')}` : ''}:</p>
                            <FilePreview
                              src={{ dataUrl: resolvePaymentProofUrl(proofSrc), fileName: String(proofSrc).split('/').pop() || 'payment-proof' }}
                              label={`Payment proof — ${p.referenceNumber || p._id.slice(-8)}`}
                            />
                          </div>
                        ) : <p className="text-xs text-muted-foreground">No proof uploaded yet.</p>}
                        {p.status === 'submitted' && (
                          <div className="flex gap-2 pt-1">
                            <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white gap-1"
                              onClick={() => openVerifyPaymentDialog(viewEnrollmentId!, p._id)}>
                              <Check className="h-3 w-3" /> Verify Payment
                            </Button>
                            <Button size="sm" variant="destructive" className="h-7 text-xs gap-1"
                              onClick={() => { setVerifyPaymentTarget({ enrollmentId: viewEnrollmentId!, paymentId: p._id }); setVerifyPaymentNote(''); handleConfirmVerifyPayment(false); }}>
                              <X className="h-3 w-3" /> Reject Payment
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Rejection reason */}
                {e.status === 'rejected' && (eAny.rejectionReason as string) && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm">
                    <p className="font-semibold text-red-800 mb-1">Rejection Reason</p>
                    <p className="text-red-700">{String(eAny.rejectionReason)}</p>
                  </div>
                )}

                {/* Status history */}
                {statusHistory.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground font-medium">Status History ({statusHistory.length})</summary>
                    <ol className="mt-2 space-y-1 pl-3 border-l border-border">
                      {statusHistory.map((h, i) => (
                        <li key={i}><span className="font-semibold">{h.status}</span> — {h.at ? new Date(h.at).toLocaleString('en-PH') : '—'} {h.byRole ? `(${h.byRole})` : ''} {h.note ? `· ${h.note}` : ''}</li>
                      ))}
                    </ol>
                  </details>
                )}

                <DialogFooter className="flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setViewEnrollmentId(null)}>Close</Button>
                  {isActionable && e.status === 'pending_approval' && (
                    <Button className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1"
                      disabled={verifyingId === viewEnrollmentId}
                      onClick={() => { if (viewEnrollmentId) handleAcceptEnrollment(viewEnrollmentId); }}>
                      {verifyingId === viewEnrollmentId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Approve Enrollment
                    </Button>
                  )}
                  {isActionable && (
                    <Button variant="destructive" className="gap-1" onClick={() => { if (viewEnrollmentId) openRejectDialog(viewEnrollmentId); }}>
                      <X className="h-4 w-4" /> Reject Enrollment
                    </Button>
                  )}
                </DialogFooter>
              </div>
            );
          })() : null}
        </DialogContent>
      </Dialog>

      {/* Reject Enrollment Dialog */}
      <Dialog open={!!rejectEnrollmentId} onOpenChange={(open) => !open && setRejectEnrollmentId(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject Enrollment</DialogTitle>
            <DialogDescription>Provide a reason. The parent will be notified by email.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="rejectReason">Reason *</Label>
              <textarea id="rejectReason" rows={3} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="e.g. Payment proof unclear, please resubmit a clearer screenshot."
                value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="allowResubmit" checked={rejectAllowResubmit} onCheckedChange={(v) => setRejectAllowResubmit(Boolean(v))} />
              <Label htmlFor="allowResubmit" className="cursor-pointer font-normal">Allow parent to resubmit payment proof</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectEnrollmentId(null)}>Cancel</Button>
            <Button variant="destructive" disabled={rejectLoading || !rejectReason.trim()} onClick={handleConfirmReject}>
              {rejectLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null} Confirm Rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Verify Payment Dialog */}
      <Dialog open={verifyPaymentDialogOpen} onOpenChange={(open) => !open && setVerifyPaymentDialogOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Verify Payment</DialogTitle>
            <DialogDescription>Confirm that the uploaded proof is valid and the payment amount matches.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="verifyNote">Admin Note (optional)</Label>
              <Input id="verifyNote" placeholder="e.g. Verified GCash transaction #12345"
                value={verifyPaymentNote} onChange={(e) => setVerifyPaymentNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVerifyPaymentDialogOpen(false)}>Cancel</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1" disabled={verifyPaymentLoading}
              onClick={() => handleConfirmVerifyPayment(true)}>
              {verifyPaymentLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Verify Payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!paymentProofPreview}
        onOpenChange={(open) => {
          if (!open) {
            setPaymentProofPreview(null);
            setPaymentProofZoomed(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-5xl h-[95vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Proof of Payment</DialogTitle>
            <DialogDescription>
              {paymentProofPreview ? `Reference ${paymentProofPreview.reference}. Click the image to toggle zoom.` : "Preview payment proof."}
            </DialogDescription>
          </DialogHeader>
          {paymentProofPreview ? (
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-muted/40 p-3">
              <div className={paymentProofZoomed ? "min-w-max" : "min-w-0"}>
                <button
                  type="button"
                  onClick={() => setPaymentProofZoomed((current) => !current)}
                  className={paymentProofZoomed ? "block cursor-zoom-out" : "flex min-h-full w-full items-start justify-center cursor-zoom-in"}
                >
                  <img
                    src={paymentProofPreview.src}
                    alt={`Payment receipt ${paymentProofPreview.reference}`}
                    className={paymentProofZoomed
                      ? "max-w-none w-auto min-w-[1200px] rounded-md border border-border bg-background"
                      : "max-h-[75vh] w-auto max-w-full rounded-md border border-border bg-background object-contain"
                    }
                  />
                </button>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPaymentProofPreview(null);
                setPaymentProofZoomed(false);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
