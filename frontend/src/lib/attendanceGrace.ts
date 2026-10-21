/**
 * The tutor dashboard's Attendance tab established this rule ("bug (13).pdf" Group AR):
 * a tutor gets a 3-day grace period after a session date to mark Present/Absent; past
 * that, an unmarked session auto-resolves to Absent. Computed on read, never written to
 * the database unless a tutor explicitly marks it.
 *
 * Centralized here (moved out of frontend/src/components/tutor/AttendanceTab.tsx, which
 * used to define this inline) so every place that needs "what is this session's real
 * attendance status right now" — the tutor's own Attendance tab AND the parent-side
 * Progress tab's calendar/percentage — compute the exact same answer instead of two
 * separate rules silently drifting apart.
 */
export const ATTENDANCE_GRACE_DAYS = 3;

export type AttendanceStatus = "present" | "absent" | "unmarked";

/** Whole-calendar-day difference between two YYYY-MM-DD strings, independent of local timezone. */
export function daysBetweenDateOnly(fromStr: string, toStr: string): number {
  const [fy, fm, fd] = fromStr.split("-").map(Number);
  const [ty, tm, td] = toStr.split("-").map(Number);
  const from = Date.UTC(fy, (fm || 1) - 1, fd || 1);
  const to = Date.UTC(ty, (tm || 1) - 1, td || 1);
  return Math.round((to - from) / (1000 * 60 * 60 * 24));
}

/** Resolves what a session (or, for a group session, one specific child) effectively IS
 *  right now: the stored value if present/absent, otherwise Absent once more than
 *  ATTENDANCE_GRACE_DAYS have passed since the session date, otherwise still Unmarked (the
 *  grace window hasn't closed yet). `real` must already be the stored present/absent/
 *  unmarked value for the relevant session — this only layers the time-based auto-resolve
 *  on top, it never reads attendanceByStudent itself. `sessionDateKey`/`todayKey` are both
 *  YYYY-MM-DD. */
export function resolveAttendanceStatus(
  real: AttendanceStatus,
  sessionDateKey: string,
  todayKey: string
): AttendanceStatus {
  if (real !== "unmarked") return real;
  if (sessionDateKey && daysBetweenDateOnly(sessionDateKey, todayKey) > ATTENDANCE_GRACE_DAYS) return "absent";
  return "unmarked";
}

/** Once a session has crossed the grace period, it's locked — Present/Absent can no
 *  longer be changed, whether it auto-resolved to Absent or was already explicitly
 *  marked. Purely time-based, independent of the stored value. */
export function isAttendanceLocked(sessionDateKey: string, todayKey: string): boolean {
  return !!sessionDateKey && daysBetweenDateOnly(sessionDateKey, todayKey) > ATTENDANCE_GRACE_DAYS;
}

/** Local calendar day (YYYY-MM-DD) for a given Date, in the browser's own timezone. */
export function toLocalDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface AttendanceStatsSessionInput {
  /** YYYY-MM-DD */
  date: string;
  /** The stored value — present/absent/unmarked, never an already-resolved one. */
  status: AttendanceStatus;
  endTime?: string;
}

export interface AttendanceStats {
  total: number;
  present: number;
  percent: number | null;
}

/** Feeds the parent-side Progress tab's overall percentage ring. A session runs through
 *  the same resolveAttendanceStatus() grace rule as the calendar day markers, so an old
 *  unmarked session counts as Absent here too, not just in the day-detail panel — fixing
 *  the gap where the ring never reflected auto-resolved absences at all. A session still
 *  inside its grace window (or not yet even happened) has no decided outcome yet, so it's
 *  excluded from BOTH `present` and `total` — counting it as a non-present "miss" would
 *  understate the percentage for a day nobody has actually missed (yet). A session marked
 *  Present whose scheduled end time hasn't passed yet is treated the same way (not counted
 *  either way), matching the pre-existing "isCompleted" rule this replaces. */
export function computeAttendanceStats(sessions: AttendanceStatsSessionInput[], now: Date = new Date()): AttendanceStats {
  const todayKey = toLocalDateKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  let present = 0;
  let total = 0;
  for (const s of sessions) {
    const effective = resolveAttendanceStatus(s.status, s.date, todayKey);
    if (effective === "unmarked") continue;

    if (effective === "present") {
      const isCompleted = s.date < todayKey || (s.date === todayKey && nowMinutes >= minutesSinceMidnight(s.endTime));
      if (!isCompleted) continue;
      present += 1;
    }
    total += 1;
  }
  const percent = total > 0 ? Math.round((present / total) * 100) : null;
  return { total, present, percent };
}

function minutesSinceMidnight(hhmm?: string): number {
  const [h, m] = String(hhmm || "00:00").split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}
