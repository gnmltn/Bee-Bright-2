import { useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Download, RotateCw, RotateCcw, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";

export interface AttendanceCardStats {
  total: number;
  present: number;
  percent: number | null;
}

export interface AttendanceHistoryEntry {
  label: string;
  /** YYYY-MM-DD of the earliest scheduled session for this program. */
  startDate: string;
  /** YYYY-MM-DD of the latest scheduled session for this program. */
  endDate: string;
  /** True when the latest session is today or still upcoming — shown as "Ongoing". */
  ongoing: boolean;
  total: number;
  present: number;
  percent: number;
}

/** One real session, for the front face's calendar — only this child's own sessions,
 *  scoped the same way every other Progress tab feature already is (the caller's own
 *  getMyClasses(activeChildUserId) fetch). `status` is already the EFFECTIVE status —
 *  the caller runs it through the same 3-day-grace auto-absent resolver the tutor
 *  dashboard uses (frontend/src/lib/attendanceGrace.ts) before handing it to this
 *  component, so this component itself never computes grace-period logic. */
export interface AttendanceCalendarSession {
  /** YYYY-MM-DD */
  date: string;
  startTime?: string;
  endTime?: string;
  programLabel: string;
  status: "present" | "absent" | "unmarked";
  /** Assigned tutor(s)' display name(s) — already comma-joined by the caller for a
   *  Toddlers Playgroup session with co-tutors (same formatClassTutorNames helper the
   *  Schedule tab/Tutor Dashboard already use), "—" when none is assigned. */
  tutorName?: string;
}

interface AttendanceCardProps {
  stats: AttendanceCardStats;
  sessions: AttendanceCalendarSession[];
  history: AttendanceHistoryEntry[];
  /** Used only for the exported CSV's filename. */
  childLabel?: string;
}

function dateKeyToLocalDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function dateToKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatClock12(hhmm?: string): string {
  if (!hhmm) return "";
  const [hRaw, mRaw] = hhmm.split(":").map(Number);
  if (!Number.isFinite(hRaw)) return "";
  const period = hRaw >= 12 ? "PM" : "AM";
  const h12 = hRaw % 12 === 0 ? 12 : hRaw % 12;
  return `${h12}:${String(mRaw || 0).padStart(2, "0")} ${period}`;
}

function formatSelectedDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

const ATTENDANCE_CALENDAR_STATUS: Record<AttendanceCalendarSession["status"], { label: string; className: string; icon: typeof CheckCircle2 }> = {
  present: { label: "Present", className: "bg-success/10 text-success border-success/30", icon: CheckCircle2 },
  absent: { label: "Absent", className: "bg-destructive/10 text-destructive border-destructive/30", icon: XCircle },
  unmarked: { label: "Not yet marked", className: "bg-muted text-muted-foreground border-border", icon: CheckCircle2 },
};

const FLIP_DURATION_SECONDS = 0.5;

function formatHistoryDate(value: string) {
  if (!value) return "—";
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Shared by both the overall "Export" button (the full list) and each program row's
 * own "Export" button (a single-entry array) — same 4 columns either way. */
function downloadAttendanceCsv(entries: AttendanceHistoryEntry[], childLabel?: string, scopeLabel?: string) {
  let csv = "Program Name,Total Classes,Total Present,Attendance %\n";
  entries.forEach((h) => {
    csv += `${h.label},${h.total},${h.present},${h.percent}%\n`;
  });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const namePart = slugify(childLabel || "student") || "student";
  const scopePart = scopeLabel ? `${slugify(scopeLabel) || "program"}_` : "history_";
  link.href = url;
  link.download = `attendance_${scopePart}${namePart}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * The parent/student Progress page's Attendance card — front face is the overall ring
 * plus a calendar marking each real session day Present or Absent, scoped to this one
 * child (the caller's `sessions` prop is already access-scoped and already live-updates
 * the same way the rest of this page does — nothing new needed here for either). A
 * "History" button flips it to a back face listing every program the child has ever
 * availed (completed and active) with its own date range and present count, unchanged.
 *
 * Only ONE face is ever mounted at a time (not two stacked absolutely-positioned faces
 * — an earlier version did that and it broke the card's natural height, since absolutely
 * positioned children don't contribute to a parent's auto height). The card's height is
 * always just whatever its current face naturally needs, exactly like before this
 * feature existed; only the back face's own list has an internal scroll region, never
 * the front face or the card as a whole. The content is swapped at the ROTATION
 * MIDPOINT (when the card is edge-on to the viewer, effectively invisible) rather than
 * at the click itself, so the flip never flashes a backwards/mirrored face.
 *
 * Mount this with `key={<the active child's id>}` from the caller — switching child
 * must always land back on the front face with that child's own data, never carrying
 * over a previous child's flipped state. A fresh `key` forces React to remount this
 * component from scratch, which resets state to its default for free, rather than
 * relying on an effect to watch for a child change.
 */
export function AttendanceCard({ stats, sessions, history, childLabel }: AttendanceCardProps) {
  const [flipped, setFlipped] = useState(false);
  const [showBack, setShowBack] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date());

  const { presentDates, absentDates } = useMemo(() => {
    const present = new Set<string>();
    const absent = new Set<string>();
    sessions.forEach((s) => {
      if (!s.date) return;
      if (s.status === "absent") absent.add(s.date);
      else if (s.status === "present") present.add(s.date);
    });
    // A day with both a present AND an absent session (2+ programs, mixed outcome) is
    // marked absent on the calendar — the day deserves a closer look either way, and
    // the detail panel below still lists every session with its own real status.
    for (const key of absent) present.delete(key);
    return { presentDates: present, absentDates: absent };
  }, [sessions]);

  const selectedDateKey = useMemo(() => dateToKey(selectedDate), [selectedDate]);
  const selectedDaySessions = useMemo(
    () => sessions.filter((s) => s.date === selectedDateKey),
    [sessions, selectedDateKey]
  );
  const swapTimer = useRef<number | null>(null);
  const percent = stats.percent ?? 0;

  const flipTo = (next: boolean) => {
    setFlipped(next);
    if (swapTimer.current) window.clearTimeout(swapTimer.current);
    swapTimer.current = window.setTimeout(() => setShowBack(next), (FLIP_DURATION_SECONDS * 1000) / 2);
  };

  return (
    <div style={{ perspective: "1600px" }}>
      <motion.div
        animate={{ rotateY: flipped ? 180 : 0 }}
        transition={{ duration: FLIP_DURATION_SECONDS, ease: "easeInOut" }}
        style={{ transformStyle: "preserve-3d" }}
      >
        {showBack ? (
          <div
            className="rounded-2xl border border-border bg-card p-6 flex flex-col"
            style={{ transform: "rotateY(180deg)" }}
          >
            <div className="flex items-center justify-between gap-2 mb-3 flex-wrap shrink-0">
              <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Program History</h4>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 gap-1 text-xs"
                  onClick={() => downloadAttendanceCsv(history, childLabel)}
                  disabled={history.length === 0}
                >
                  <Download className="h-3.5 w-3.5" /> Export
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs" onClick={() => flipTo(false)}>
                  <RotateCcw className="h-3.5 w-3.5" /> Back
                </Button>
              </div>
            </div>

            {/* Only this list scrolls — never the front face, never the card itself. */}
            <div className="space-y-2 max-h-[22rem] overflow-y-auto pr-1">
              {history.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No programs availed yet.</p>
              ) : history.map((h) => (
                <div key={h.label} className="rounded-lg border border-border p-3 bg-muted/20 flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{h.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatHistoryDate(h.startDate)} – {h.ongoing ? "Ongoing" : formatHistoryDate(h.endDate)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <p className="text-xs text-muted-foreground whitespace-nowrap">{h.present}/{h.total} present ({h.percent}%)</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 gap-1 text-xs"
                      onClick={() => downloadAttendanceCsv([h], childLabel, h.label)}
                    >
                      <Download className="h-3 w-3" /> Export
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Attendance</h4>
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs" onClick={() => flipTo(true)}>
                <RotateCw className="h-3.5 w-3.5" /> History
              </Button>
            </div>

            <div className="flex items-center gap-4 mb-5">
              <div className="relative h-24 w-24 rounded-full bg-muted flex items-center justify-center shrink-0">
                <svg className="h-24 w-24 -rotate-90" viewBox="0 0 36 36">
                  <path className="text-muted stroke-current" strokeWidth="3" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                  <path
                    className="text-primary stroke-current transition-all duration-700"
                    strokeWidth="3"
                    strokeDasharray={`${percent}, 100`}
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                </svg>
                <span className="absolute text-2xl font-bold text-foreground">{percent}%</span>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Overall: present at {stats.present} of {stats.total} sessions</p>
                <p className="text-xs text-muted-foreground mt-1">Pick a day below to see that day's session.</p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-4">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={(date) => date && setSelectedDate(date)}
                modifiers={{
                  present: Array.from(presentDates, dateKeyToLocalDate),
                  absent: Array.from(absentDates, dateKeyToLocalDate),
                }}
                modifiersClassNames={{
                  present: "bg-success/15 text-success font-semibold hover:bg-success/25",
                  absent: "bg-destructive/15 text-destructive font-semibold hover:bg-destructive/25",
                }}
                showOutsideDays={false}
                className="rounded-md border border-border w-fit mx-auto sm:mx-0"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-success" /> Present</span>
                  <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-destructive" /> Absent</span>
                </div>
                <p className="text-sm font-medium text-foreground mb-2">{formatSelectedDate(selectedDate)}</p>
                {selectedDaySessions.length === 0 ? (
                  <p className="text-sm text-muted-foreground rounded-lg border border-border bg-muted/20 p-4 text-center">No session on this date.</p>
                ) : (
                  <div className="space-y-2">
                    {selectedDaySessions.map((s, idx) => {
                      const statusInfo = ATTENDANCE_CALENDAR_STATUS[s.status];
                      const StatusIcon = statusInfo.icon;
                      const timeLabel = s.startTime ? `${formatClock12(s.startTime)}${s.endTime ? ` – ${formatClock12(s.endTime)}` : ""}` : null;
                      const tutorLabel = s.tutorName && s.tutorName !== "—" ? s.tutorName : null;
                      return (
                        <div key={`${s.date}-${s.programLabel}-${idx}`} className="rounded-lg border border-border p-3 bg-muted/20 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-foreground truncate">{s.programLabel}</p>
                            {(timeLabel || tutorLabel) && (
                              <p className="text-xs text-muted-foreground truncate">
                                {timeLabel}
                                {timeLabel && tutorLabel ? " · " : ""}
                                {tutorLabel}
                              </p>
                            )}
                          </div>
                          <span className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${statusInfo.className}`}>
                            <StatusIcon className="h-3.5 w-3.5" /> {statusInfo.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
