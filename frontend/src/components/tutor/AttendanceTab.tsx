import { useMemo, useState, useCallback, useEffect } from "react";
import { CheckCircle2, XCircle, Users, Loader2, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/progress-bar";
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
import { toast } from "sonner";
import { scheduleService } from "@/services/api";

type AttendanceStatus = "present" | "absent" | "unmarked";

interface AttendanceByStudentEntry {
  student: string;
  status: "present" | "absent";
  markedAt?: string;
}

interface SessionItem {
  _id: string;
  date: string;
  startTime: string;
  endTime: string;
  attendanceStatus?: string;
  student?: {
    _id: string;
    firstName: string;
    lastName: string;
    middleName?: string;
  };
  /** Toddlers Playgroup/group session roster — present only when there is more than
   *  just the one `student` above. */
  students?: {
    _id: string;
    firstName: string;
    lastName: string;
    middleName?: string;
  }[];
  /** Per-child attendance for a group session (see `students` above) — a one-on-one
   *  session never has more than one entry here and uses `attendanceStatus` instead. */
  attendanceByStudent?: AttendanceByStudentEntry[];
  /** Which enrollment CYCLE each enrolled child was in when this session happened —
   *  resolved server-side from their real Enrollment history (see
   *  backend/utils/attendanceCycles.js), since the same permanent student id is reused
   *  across a renewal/re-enrollment in the same program. `enrollmentId` is `null` when
   *  no matching enrollment could be found. Used only to keep "Attendance by student"
   *  from blending an old, finished cycle together with a brand new one. */
  cycleByStudent?: { student: string; enrollmentId: string | null }[];
  subject?: { name: string };
}

function fullName(p?: { firstName: string; lastName: string; middleName?: string }) {
  return p ? [p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ") : "—";
}

const statusConfig: Record<AttendanceStatus, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  present: { label: "Present", className: "bg-success/10 text-success border-success/30", icon: CheckCircle2 },
  absent: { label: "Absent", className: "bg-destructive/10 text-destructive border-destructive/30", icon: XCircle },
  unmarked: { label: "Unmarked", className: "bg-muted text-muted-foreground border-border", icon: XCircle },
};

function formatTime12h(hhmm: string) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const h12 = h % 12 || 12;
  const ampm = h < 12 ? "AM" : "PM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatDate(d: string) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/** Today's date as YYYY-MM-DD, in the browser's local timezone. */
function todayDateKey(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

// Keep schedule date comparisons stable regardless of timezone conversion.
function dateOnly(d: string): string {
  if (!d) return "";
  const trimmed = String(d).trim();
  const isoDay = trimmed.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDay) return isoDay;
  const x = new Date(trimmed);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
}

// "bug (13).pdf" Group AR — a tutor gets a 3-day grace period after a session date to mark
// Present/Absent; past that, an unmarked session auto-resolves to Absent. Computed on read,
// never written to the database until (if ever) a tutor explicitly marks it — same pattern
// as backend/utils/remainingDueDate.js's schedule-derived due dates, the closest existing
// precedent in this codebase for a time-based auto-status. No cron/scheduled-job
// infrastructure exists anywhere in this backend (confirmed), so a background sweep would
// be a new pattern; this fits how the codebase already does this kind of thing.
const ATTENDANCE_GRACE_DAYS = 3;

/** Whole-calendar-day difference between two YYYY-MM-DD strings, independent of local timezone. */
function daysBetweenDateOnly(fromStr: string, toStr: string): number {
  const [fy, fm, fd] = fromStr.split("-").map(Number);
  const [ty, tm, td] = toStr.split("-").map(Number);
  const from = Date.UTC(fy, (fm || 1) - 1, fd || 1);
  const to = Date.UTC(ty, (tm || 1) - 1, td || 1);
  return Math.round((to - from) / (1000 * 60 * 60 * 24));
}

export interface AttendanceTabProps {
  sessions: SessionItem[];
  onRefresh: () => void;
  loading?: boolean;
}

export function AttendanceTab({ sessions, onRefresh, loading }: AttendanceTabProps) {
  const [view, setView] = useState<"today" | "history" | "summary">("today");
  // Tracked as a set (not a single id) so marking one child in a Playgroup/group
  // session doesn't disable the OTHER enrolled children's buttons in the same
  // session — each child's own Present/Absent request is independent.
  const [markingKeys, setMarkingKeys] = useState<Set<string>>(new Set());
  const [pendingSwitch, setPendingSwitch] = useState<{
    session: SessionItem;
    status: "present" | "absent";
    previousStatus: "present" | "absent";
    studentId?: string;
    studentName?: string;
  } | null>(null);
  // Toddlers Playgroup/group sessions start collapsed — the tutor expands one to reveal
  // each enrolled child's own independent Present/Absent controls.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = useCallback((sessionId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId);
      return next;
    });
  }, []);

  // Re-checked on a timer (not computed once at mount) so the 3-day grace-period lock
  // still engages live if a tutor leaves this tab open across a calendar-day rollover —
  // without this, "today" would stay frozen at whatever it was when the component first
  // mounted, and a session crossing the threshold wouldn't lock until a manual refresh.
  // Day-level granularity is all that matters here, so a 1-minute check is plenty.
  const [todayStr, setTodayStr] = useState(() => todayDateKey());
  useEffect(() => {
    const id = window.setInterval(() => setTodayStr(todayDateKey()), 60 * 1000);
    return () => window.clearInterval(id);
  }, []);

  const uniqueSessions = useMemo(() => {
    const seen = new Set<string>();
    const output: SessionItem[] = [];
    for (const s of sessions) {
      const key = [
        s.student?._id || "",
        s.subject?.name || "",
        dateOnly(s.date),
        s.startTime || "",
        s.endTime || "",
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(s);
    }
    return output;
  }, [sessions]);

  const todaySessions = useMemo(() => {
    return uniqueSessions
      .filter((s) => dateOnly(s.date) === todayStr)
      .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
  }, [uniqueSessions, todayStr]);

  const historySessions = useMemo(() => {
    return uniqueSessions
      .filter((s) => dateOnly(s.date) < todayStr)
      .slice()
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 30);
  }, [uniqueSessions, todayStr]);

  // The value actually ON RECORD right now — a per-child entry for a Toddlers
  // Playgroup/group session (studentId given), or the whole-session field for a
  // one-on-one session (no studentId). Never includes the grace-period auto-resolve;
  // that's layered on top by getStatus() below.
  const realStatus = useCallback((s: SessionItem, studentId?: string): AttendanceStatus => {
    if (studentId) {
      const entry = s.attendanceByStudent?.find((a) => String(a.student) === String(studentId));
      return entry?.status === "present" || entry?.status === "absent" ? entry.status : "unmarked";
    }
    const v = s.attendanceStatus as string | undefined;
    return v === "present" || v === "absent" ? v : "unmarked";
  }, []);

  // Resolves what a session (or, for a group session, one specific child) effectively
  // IS right now — the stored value if present/absent, otherwise Absent once more than
  // ATTENDANCE_GRACE_DAYS have passed since the session date, otherwise still Unmarked
  // (the tutor's grace window hasn't closed yet). Defined once here (not written to the
  // DB) and reused everywhere this component shows or counts a status, so the History
  // view, the Summary tab, and the Present/Absent buttons themselves never disagree.
  const getStatus = useCallback((s: SessionItem, studentId?: string): AttendanceStatus => {
    const real = realStatus(s, studentId);
    if (real !== "unmarked") return real;
    const sessionDay = dateOnly(s.date);
    if (sessionDay && daysBetweenDateOnly(sessionDay, todayStr) > ATTENDANCE_GRACE_DAYS) return "absent";
    return "unmarked";
  }, [todayStr, realStatus]);

  // Once a session (or child) has crossed the grace period, it's locked — BOTH
  // Present and Absent become non-interactive, whether it was ever manually marked or
  // not. This is purely time-based (unlike getStatus/realStatus above, it does not
  // care what the current value is): an old session that's already Present is just as
  // locked as one that auto-resolved to Absent from being left unmarked — a tutor can
  // no longer retroactively change EITHER one after the window has closed.
  const isLocked = useCallback((s: SessionItem): boolean => {
    const sessionDay = dateOnly(s.date);
    return !!sessionDay && daysBetweenDateOnly(sessionDay, todayStr) > ATTENDANCE_GRACE_DAYS;
  }, [todayStr]);

  // Keyed by (real student _id, program name, ENROLLMENT CYCLE) — NOT just a name
  // string, and not just (student, program) either. A Toddlers Playgroup session has
  // no singular `s.student` (it enrolls several children via `s.students[]`), so keying
  // by name alone used to fall back to a single "—" bucket that silently merged every
  // Playgroup child together. The cycle id (resolved server-side — see
  // backend/utils/attendanceCycles.js) is needed on top of that because the student's
  // own id is PERMANENT and never changes across a renewal: without it, a finished
  // Academic Tutorial cycle from months ago would blend into a brand new one for the
  // same child, producing one misleading combined percentage instead of two honest
  // ones. One row per program per student per cycle also avoids a misleading blended
  // percentage for a student enrolled in more than one program at once.
  const studentSummaries = useMemo(() => {
    const byKey = new Map<string, { studentId: string; name: string; programLabel: string; cycleId: string; total: number; present: number; overall: number }>();

    const touch = (studentId: string, name: string, programLabel: string, cycleId: string) => {
      const key = `${studentId}|${programLabel}|${cycleId}`;
      if (!byKey.has(key)) byKey.set(key, { studentId, name, programLabel, cycleId, total: 0, present: 0, overall: 0 });
      return byKey.get(key)!;
    };

    const rosterOf = (s: SessionItem) => {
      const group = s.students ?? [];
      return group.length > 0 ? group : s.student ? [s.student] : [];
    };

    // Falls back to one shared "unknown cycle" bucket (never a per-session singleton)
    // when no matching enrollment could be resolved — a rare edge case, not a reason
    // to explode into one row per session.
    const cycleIdFor = (s: SessionItem, studentId: string) =>
      s.cycleByStudent?.find((c) => String(c.student) === String(studentId))?.enrollmentId ?? "__unknown__";

    uniqueSessions.forEach((s) => {
      const programLabel = (s.subject?.name || "Unassigned Program").trim();
      rosterOf(s).forEach((student) => {
        touch(student._id, fullName(student), programLabel, cycleIdFor(s, student._id)).overall += 1;
      });
    });

    const doneSessions = uniqueSessions.filter((s) => dateOnly(s.date) < todayStr);
    doneSessions.forEach((s) => {
      const programLabel = (s.subject?.name || "Unassigned Program").trim();
      const group = s.students ?? [];
      const isGroup = group.length > 0;
      rosterOf(s).forEach((student) => {
        const status = getStatus(s, isGroup ? student._id : undefined);
        if (status !== "present" && status !== "absent") return;
        const rec = touch(student._id, fullName(student), programLabel, cycleIdFor(s, student._id));
        rec.total += 1;
        if (status === "present") rec.present += 1;
      });
    });

    // cycleId sorts chronologically for free when it's the BB-YYYYMMDD-XXXX format
    // (lexicographic order == date order), so an older finished cycle naturally lists
    // before a newer renewal for the same student+program.
    return Array.from(byKey.values()).sort((a, b) =>
      a.name.localeCompare(b.name) || a.programLabel.localeCompare(b.programLabel) || a.cycleId.localeCompare(b.cycleId)
    );
  }, [uniqueSessions, todayStr, getStatus]);

  const submitAttendance = useCallback((session: SessionItem, status: "present" | "absent", studentId?: string) => {
    const sessionDay = dateOnly(session.date);
    if (sessionDay > todayStr) {
      toast.error("You can only mark attendance for today or past sessions.");
      return;
    }

    const markKey = studentId ? `${session._id}:${studentId}` : session._id;
    setMarkingKeys((prev) => new Set(prev).add(markKey));
    const request = studentId
      ? scheduleService.markAttendance(session._id, status, studentId)
      : scheduleService.markAttendance(session._id, status);
    request
      .then(() => {
        toast.success(`Marked as ${status}`);
        onRefresh();
      })
      .catch((err) => {
        const msg: string = err?.response?.data?.message || "Failed to mark attendance.";
        toast.error(msg);
      })
      .finally(() => setMarkingKeys((prev) => {
        const next = new Set(prev);
        next.delete(markKey);
        return next;
      }));
  }, [onRefresh, todayStr]);

  // Clicking the already-marked status is a harmless no-op. Switching between Present
  // and Absent once a status is already on record requires confirmation first, so a
  // stray click can't silently flip a tutor's earlier attendance call. studentId/
  // studentName are only passed for one child within a Toddlers Playgroup/group
  // session — omitted entirely for a one-on-one session, unchanged from before.
  const handleMarkClick = useCallback((session: SessionItem, status: "present" | "absent", studentId?: string, studentName?: string) => {
    const current = getStatus(session, studentId);
    if (current === status) return;
    if (current === "unmarked") {
      submitAttendance(session, status, studentId);
      return;
    }
    setPendingSwitch({ session, status, previousStatus: current, studentId, studentName });
  }, [submitAttendance, getStatus]);

  const confirmSwitch = useCallback(() => {
    if (!pendingSwitch) return;
    submitAttendance(pendingSwitch.session, pendingSwitch.status, pendingSwitch.studentId);
    setPendingSwitch(null);
  }, [pendingSwitch, submitAttendance]);

  // Shared Present/Absent control pair — studentId/studentName identify ONE child
  // within a group session, or are omitted for a one-on-one session (unchanged
  // behavior either way). Both buttons go fully non-interactive once isLocked() is
  // true: the session (or child) auto-resolved to Absent past the grace period, and a
  // tutor can no longer retroactively mark it Present or re-click Absent.
  const renderAttendanceButtons = (session: SessionItem, studentId?: string, studentName?: string) => {
    const status = getStatus(session, studentId);
    const locked = isLocked(session);
    const markKey = studentId ? `${session._id}:${studentId}` : session._id;
    const busy = markingKeys.has(markKey);
    return (
      <div className="flex gap-2">
        <Button
          variant={status === "present" ? "default" : "outline"}
          size="sm"
          className={`gap-1 ${status === "present" ? "bg-success hover:bg-success/90" : ""}`}
          onClick={() => handleMarkClick(session, "present", studentId, studentName)}
          disabled={busy || locked}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          Present
        </Button>
        <Button
          variant={status === "absent" ? "destructive" : "outline"}
          size="sm"
          className="gap-1"
          onClick={() => handleMarkClick(session, "absent", studentId, studentName)}
          disabled={busy || locked}
        >
          <XCircle className="h-3.5 w-3.5" />
          Absent
        </Button>
      </div>
    );
  };

  const renderSessionRow = (session: SessionItem, showDate: boolean) => {
    const groupStudents = session.students ?? [];

    // One-on-one (or small-group with just the legacy single `student`) — unchanged
    // from before Group 1's fix: exactly one name, one Present/Absent pair.
    if (groupStudents.length === 0) {
      const studentName = fullName(session.student);
      const subjectName = session.subject?.name ?? "—";
      return (
        <div
          key={session._id}
          className="p-4 flex flex-col sm:flex-row sm:items-center gap-3 border-b border-border last:border-0"
        >
          <div className="flex items-center gap-3 flex-1">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <span className="text-sm font-semibold text-primary">
                {studentName.split(" ").map((n) => n[0]).join("").slice(0, 2)}
              </span>
            </div>
            <div>
              <p className="font-semibold text-foreground">{studentName}</p>
              <p className="text-sm text-muted-foreground">
                {formatTime12h(session.startTime)} – {formatTime12h(session.endTime)} · {subjectName}
                {showDate && ` · ${formatDate(session.date)}`}
              </p>
            </div>
          </div>
          {renderAttendanceButtons(session)}
        </div>
      );
    }

    // Toddlers Playgroup/group session — the entry shows the group as a whole; expanding
    // it reveals each enrolled child with their own independent Present/Absent controls,
    // so e.g. 2 Present + 1 Absent is a valid outcome for the same session.
    const groupLabel = session.subject?.name ?? "Toddlers Playgroup";
    const expanded = expandedGroups.has(session._id);
    const counts = groupStudents.reduce(
      (acc, child) => {
        const st = getStatus(session, child._id);
        if (st === "present") acc.present += 1;
        else if (st === "absent") acc.absent += 1;
        else acc.unmarked += 1;
        return acc;
      },
      { present: 0, absent: 0, unmarked: 0 }
    );

    return (
      <div key={session._id} className="border-b border-border last:border-0">
        <button
          type="button"
          onClick={() => toggleGroup(session._id)}
          className="w-full p-4 flex flex-col sm:flex-row sm:items-center gap-3 text-left hover:bg-muted/40 transition-colors"
        >
          <div className="flex items-center gap-3 flex-1">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <Users className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="font-semibold text-foreground">
                {groupLabel}{" "}
                <span className="text-muted-foreground font-normal">
                  · {groupStudents.length} {groupStudents.length === 1 ? "child" : "children"}
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                {formatTime12h(session.startTime)} – {formatTime12h(session.endTime)}
                {showDate && ` · ${formatDate(session.date)}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {counts.present > 0 && <span className="text-success font-medium">{counts.present} Present</span>}
            {counts.absent > 0 && <span className="text-destructive font-medium">{counts.absent} Absent</span>}
            {counts.unmarked > 0 && <span className="text-muted-foreground">{counts.unmarked} Unmarked</span>}
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
          </div>
        </button>
        {expanded && (
          <div className="divide-y divide-border bg-muted/20">
            {groupStudents.map((child) => {
              const childName = fullName(child);
              return (
                <div key={child._id} className="pl-14 pr-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                  <p className="text-sm font-medium text-foreground flex-1">{childName}</p>
                  {renderAttendanceButtons(session, child._id, childName)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <Button
          variant={view === "today" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("today")}
        >
          Today&apos;s sessions
        </Button>
        <Button
          variant={view === "history" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("history")}
        >
          Past sessions
        </Button>
        <Button
          variant={view === "summary" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("summary")}
        >
          <Users className="h-4 w-4 mr-2" />
          Student summary
        </Button>
      </div>

      {view === "today" && (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="p-4 border-b border-border">
            <h3 className="font-display font-bold text-lg text-foreground">Mark attendance — today</h3>
            <p className="text-sm text-muted-foreground">{formatDate(new Date().toISOString().slice(0, 10))}</p>
          </div>
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : todaySessions.length === 0 ? (
            <p className="p-6 text-center text-muted-foreground">
              No sessions scheduled for today. You can still mark attendance from the Schedule tab or History here.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {todaySessions.map((s) => renderSessionRow(s, false))}
            </div>
          )}
        </div>
      )}

      {view === "history" && (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="p-4 border-b border-border">
            <h3 className="font-display font-bold text-lg text-foreground">Attendance history</h3>
            <p className="text-sm text-muted-foreground">
              Only past dates appear here. Use Today&apos;s sessions or the Schedule tab to review current and upcoming classes.
            </p>
          </div>
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : historySessions.length === 0 ? (
            <p className="p-6 text-center text-muted-foreground">No past sessions yet.</p>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              {historySessions.map((s) => renderSessionRow(s, true))}
            </div>
          )}
        </div>
      )}

      {view === "summary" && (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="p-4 border-b border-border">
            <h3 className="font-display font-bold text-lg text-foreground">Attendance by student</h3>
            <p className="text-sm text-muted-foreground">
              Only completed past sessions with marked attendance are counted here.
            </p>
          </div>
          <div className="divide-y divide-border">
            {studentSummaries.length === 0 ? (
              <p className="p-6 text-center text-muted-foreground">No sessions yet.</p>
            ) : (
              studentSummaries.map((sum) => {
                const rate = sum.overall > 0 ? Math.round((sum.present / sum.overall) * 100) : 0;
                return (
                  <div key={`${sum.studentId}|${sum.programLabel}|${sum.cycleId}`} className="p-4">
                    <div className="flex items-center justify-between mb-1">
                      <div>
                        <p className="font-semibold text-foreground">{sum.name}</p>
                        <p className="text-xs text-primary font-medium">{sum.programLabel}</p>
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {sum.present} / {sum.overall} present
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">Marked and completed: {sum.total}</p>
                    <ProgressBar
                      value={rate}
                      size="sm"
                      showPercentage
                      variant={rate >= 80 ? "success" : rate >= 60 ? "primary" : "warning"}
                    />
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      <AlertDialog open={!!pendingSwitch} onOpenChange={(open) => { if (!open) setPendingSwitch(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change attendance to {pendingSwitch?.status === "present" ? "Present" : "Absent"}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingSwitch?.session.student
                ? [pendingSwitch.session.student.firstName, pendingSwitch.session.student.middleName, pendingSwitch.session.student.lastName].filter(Boolean).join(" ")
                : "This student"}{" "}
              was already marked {pendingSwitch?.previousStatus === "present" ? "Present" : "Absent"}. This will overwrite that record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSwitch}>
              Yes, mark as {pendingSwitch?.status === "present" ? "Present" : "Absent"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}