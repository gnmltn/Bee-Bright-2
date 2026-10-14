import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { Download, RotateCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface AttendanceCardStats {
  total: number;
  present: number;
  percent: number | null;
}

export interface AttendanceByProgramEntry {
  label: string;
  total: number;
  present: number;
  percent: number;
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

interface AttendanceCardProps {
  stats: AttendanceCardStats;
  byProgram: AttendanceByProgramEntry[];
  history: AttendanceHistoryEntry[];
  /** Used only for the exported CSV's filename. */
  childLabel?: string;
}

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
 * The parent/student Progress page's Attendance card — front face is the existing
 * overall ring + per-program bars; a "History" button flips it to a back face listing
 * every program the child has ever availed (completed and active), with a CSV export.
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
export function AttendanceCard({ stats, byProgram, history, childLabel }: AttendanceCardProps) {
  const [flipped, setFlipped] = useState(false);
  const [showBack, setShowBack] = useState(false);
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
                <p className="text-xs text-muted-foreground mt-1">Attendance is also separated by program below.</p>
              </div>
            </div>

            <div className="space-y-3">
              {byProgram.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sessions scheduled yet.</p>
              ) : byProgram.map((program) => (
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
          </div>
        )}
      </motion.div>
    </div>
  );
}
