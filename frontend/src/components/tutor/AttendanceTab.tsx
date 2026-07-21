import { useMemo, useState, useCallback } from "react";
import { CheckCircle2, XCircle, Users, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/progress-bar";
import { toast } from "sonner";
import { scheduleService } from "@/services/api";

type AttendanceStatus = "present" | "absent" | "unmarked";

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
  subject?: { name: string };
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

// Keep schedule date comparisons stable regardless of timezone conversion.
function dateOnly(d: string): string {
  if (!d) return "";
  const trimmed = String(d).trim();
  const isoDay = trimmed.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDay) return isoDay;
  const x = new Date(trimmed);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
}

export interface AttendanceTabProps {
  sessions: SessionItem[];
  onRefresh: () => void;
  loading?: boolean;
}

export function AttendanceTab({ sessions, onRefresh, loading }: AttendanceTabProps) {
  const [view, setView] = useState<"today" | "history" | "summary">("today");
  const [markingId, setMarkingId] = useState<string | null>(null);

  const todayStr = useMemo(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
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

  const studentSummaries = useMemo(() => {
    const byStudent = new Map<string, { name: string; total: number; present: number; overall: number }>();

    uniqueSessions.forEach((s) => {
      const name = s.student
        ? [s.student.firstName, s.student.middleName, s.student.lastName].filter(Boolean).join(" ")
        : "—";
      if (!byStudent.has(name)) byStudent.set(name, { name, total: 0, present: 0, overall: 0 });
      byStudent.get(name)!.overall += 1;
    });

    const doneSessions = uniqueSessions.filter(
      (s) => dateOnly(s.date) < todayStr && (s.attendanceStatus === "present" || s.attendanceStatus === "absent")
    );

    doneSessions.forEach((s) => {
      const name = s.student
        ? [s.student.firstName, s.student.middleName, s.student.lastName].filter(Boolean).join(" ")
        : "—";
      if (!byStudent.has(name)) byStudent.set(name, { name, total: 0, present: 0, overall: 0 });
      const rec = byStudent.get(name)!;
      rec.total += 1;
      if (s.attendanceStatus === "present") rec.present += 1;
    });
    return Array.from(byStudent.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [uniqueSessions, todayStr]);

  const markAttendance = useCallback((session: SessionItem, status: "present" | "absent") => {
    const sessionDay = dateOnly(session.date);
    if (sessionDay > todayStr) {
      toast.error("You can only mark attendance for today or past sessions.");
      return;
    }

    setMarkingId(session._id);
    scheduleService
      .markAttendance(session._id, status)
      .then(() => {
        toast.success(`Marked as ${status}`);
        onRefresh();
      })
      .catch((err) => {
        const msg: string = err?.response?.data?.message || "Failed to mark attendance.";
        toast.error(msg);
      })
      .finally(() => setMarkingId(null));
  }, [onRefresh]);

  const getStatus = (s: SessionItem): AttendanceStatus => {
    const v = s.attendanceStatus as string | undefined;
    if (v === "present" || v === "absent") return v;
    return "unmarked";
  };

  const renderSessionRow = (session: SessionItem, showDate: boolean) => {
    const studentName = session.student
      ? [session.student.firstName, session.student.middleName, session.student.lastName].filter(Boolean).join(" ")
      : "—";
    const subjectName = session.subject?.name ?? "—";
    const status = getStatus(session);
    const cfg = statusConfig[status];
    const Icon = cfg.icon;
    const busy = markingId === session._id;

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
        <div className="flex gap-2">
          <Button
            variant={status === "present" ? "default" : "outline"}
            size="sm"
            className={`gap-1 ${status === "present" ? "bg-success hover:bg-success/90" : ""}`}
            onClick={() => markAttendance(session, "present")}
            disabled={!!markingId}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Present
          </Button>
          <Button
            variant={status === "absent" ? "destructive" : "outline"}
            size="sm"
            className="gap-1"
            onClick={() => markAttendance(session, "absent")}
            disabled={!!markingId}
          >
            <XCircle className="h-3.5 w-3.5" />
            Absent
          </Button>
        </div>
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
                  <div key={sum.name} className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="font-semibold text-foreground">{sum.name}</p>
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
    </div>
  );
}