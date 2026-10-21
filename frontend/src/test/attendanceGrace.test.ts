import { describe, it, expect } from "vitest";
import { resolveAttendanceStatus, computeAttendanceStats, ATTENDANCE_GRACE_DAYS } from "@/lib/attendanceGrace";

// Bug: the parent-side Progress tab's Attendance calendar/percentage never applied the
// tutor dashboard's existing 3-day-grace auto-absent rule — an 8-day-old unmarked session
// stayed "Not yet marked" forever instead of resolving to Absent. These tests cover the
// shared resolver (frontend/src/lib/attendanceGrace.ts) both components now delegate to.

const TODAY = "2026-10-21";

/** YYYY-MM-DD `days` before TODAY. */
function daysBefore(days: number): string {
  const d = new Date(`${TODAY}T12:00:00`);
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("resolveAttendanceStatus", () => {
  it("a session still within the grace window (exactly ATTENDANCE_GRACE_DAYS old) stays unmarked", () => {
    const sessionDay = daysBefore(ATTENDANCE_GRACE_DAYS);
    expect(resolveAttendanceStatus("unmarked", sessionDay, TODAY)).toBe("unmarked");
  });

  it("a session more than ATTENDANCE_GRACE_DAYS old with nothing marked auto-resolves to absent", () => {
    const sessionDay = daysBefore(ATTENDANCE_GRACE_DAYS + 1);
    expect(resolveAttendanceStatus("unmarked", sessionDay, TODAY)).toBe("absent");
  });

  it("an 8-day-old unmarked session (the exact reported case) resolves to absent", () => {
    const sessionDay = daysBefore(8);
    expect(resolveAttendanceStatus("unmarked", sessionDay, TODAY)).toBe("absent");
  });

  it("a future/today unmarked session is never auto-resolved", () => {
    expect(resolveAttendanceStatus("unmarked", TODAY, TODAY)).toBe("unmarked");
  });

  it("a session already marked present before the cutoff keeps its real status, never overridden", () => {
    const oldDay = daysBefore(30);
    expect(resolveAttendanceStatus("present", oldDay, TODAY)).toBe("present");
  });

  it("a session already marked absent before the cutoff keeps its real status", () => {
    const oldDay = daysBefore(30);
    expect(resolveAttendanceStatus("absent", oldDay, TODAY)).toBe("absent");
  });
});

describe("computeAttendanceStats (feeds the parent-side overall percentage ring)", () => {
  const now = new Date(`${TODAY}T12:00:00`);

  it("a session within the grace window isn't counted either way yet", () => {
    const stats = computeAttendanceStats(
      [{ date: daysBefore(ATTENDANCE_GRACE_DAYS), status: "unmarked" }],
      now
    );
    expect(stats).toEqual({ total: 0, present: 0, percent: null });
  });

  it("a session older than the grace window with nothing marked counts as absent in the percentage", () => {
    const stats = computeAttendanceStats(
      [
        { date: daysBefore(30), status: "present", endTime: "10:00" },
        { date: daysBefore(8), status: "unmarked" },
      ],
      now
    );
    // 1 present out of 2 resolved sessions (the old unmarked one now counts as absent).
    expect(stats).toEqual({ total: 2, present: 1, percent: 50 });
  });

  it("an explicitly marked present/absent session keeps counting exactly as before, regardless of age", () => {
    const stats = computeAttendanceStats(
      [
        { date: daysBefore(30), status: "present", endTime: "10:00" },
        { date: daysBefore(30), status: "absent" },
      ],
      now
    );
    expect(stats).toEqual({ total: 2, present: 1, percent: 50 });
  });

  it("a future scheduled session is excluded from the percentage entirely, not counted as a miss", () => {
    const stats = computeAttendanceStats(
      [
        { date: daysBefore(30), status: "present", endTime: "10:00" },
        { date: "2026-12-01", status: "unmarked" },
      ],
      now
    );
    // Without the fix, the future session would drag the denominator up without ever
    // being able to count as present — understating a still-ongoing child's attendance.
    expect(stats).toEqual({ total: 1, present: 1, percent: 100 });
  });

  it("zero sessions yields a null percent, not a division error", () => {
    expect(computeAttendanceStats([], now)).toEqual({ total: 0, present: 0, percent: null });
  });
});
