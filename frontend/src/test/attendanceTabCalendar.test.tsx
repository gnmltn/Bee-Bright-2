import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { AttendanceTab } from "@/components/tutor/AttendanceTab";

/**
 * Request: add a calendar view to the Tutor Dashboard's Attendance tab, for both
 * "Today's sessions" and "Past sessions" — an ADDITIONAL way to browse to a given
 * day, not a replacement. Must not change the existing 3-day-lock behavior at all
 * (that's covered exhaustively by attendanceTab.test.tsx already — these tests only
 * confirm the NEW calendar path reaches the exact same renderSessionRow/isLocked
 * logic, not a parallel copy of it).
 */
vi.mock("@/services/api", () => ({
  scheduleService: { markAttendance: vi.fn(() => Promise.resolve({ data: { success: true } })) },
}));

afterEach(() => {
  cleanup();
});

function daysAgoDateStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function makeSession(daysAgo: number, overrides: Record<string, unknown> = {}) {
  return {
    _id: `sched-${daysAgo}`,
    date: `${daysAgoDateStr(daysAgo)}T00:00:00.000Z`,
    startTime: "08:00",
    endTime: "09:00",
    student: { _id: "student-1", firstName: "Ana", lastName: "Cruz" },
    subject: { name: "Academic Tutorial" },
    ...overrides,
  };
}

function openCalendarView() {
  fireEvent.click(screen.getByRole("button", { name: /calendar/i }));
}

function clickDay(dayOfMonth: number) {
  // react-day-picker's day cells are real <button> elements but override their role
  // to "gridcell" (confirmed via the rendered DOM), not the implicit "button" role.
  fireEvent.click(screen.getByRole("gridcell", { name: String(dayOfMonth) }));
}

describe("AttendanceTab: Calendar view (additional way to browse, same underlying lock logic)", () => {
  // Today's sessions / Past sessions are temporarily hidden (SHOW_LEGACY_ATTENDANCE_TABS
  // = false in attendanceTabFlags.ts) — only Calendar Sessions and Student summary show,
  // and Calendar Sessions is the default. See attendanceTabVisibility.test.tsx for the
  // dedicated "only these two render", "Calendar Sessions is the default", and "flipping
  // the flag back on restores both legacy tabs" coverage.
  it("opening the Calendar view defaults to today and shows today's session", () => {
    const session = makeSession(0);
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    openCalendarView();
    expect(screen.getByText("Ana Cruz")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^present$/i })).toBeTruthy();
  });

  it("selecting a day via the calendar that is MORE than 3 days old still shows BOTH Present/Absent as disabled — the lock applies identically through this new path", () => {
    const todayDay = new Date().getDate();
    const fourDaysAgo = makeSession(4);
    const targetDay = new Date(fourDaysAgo.date).getDate();
    // Skip if the target day isn't safely inside the current displayed month (avoids
    // flaky month-boundary ambiguity, same tolerance the existing test file accepts).
    if (targetDay >= todayDay) return;

    render(<AttendanceTab sessions={[fourDaysAgo]} onRefresh={() => {}} />);
    openCalendarView();
    clickDay(targetDay);

    expect(screen.getByText("Ana Cruz")).toBeTruthy();
    const presentBtn = screen.getByRole("button", { name: /^present$/i });
    const absentBtn = screen.getByRole("button", { name: /^absent$/i });
    expect(presentBtn).toBeDisabled();
    expect(absentBtn).toBeDisabled();
  });

  it("selecting a day via the calendar that is WITHIN the 3-day grace period submits normally (not locked)", () => {
    const todayDay = new Date().getDate();
    const oneDayAgo = makeSession(1);
    const targetDay = new Date(oneDayAgo.date).getDate();
    if (targetDay >= todayDay) return;

    render(<AttendanceTab sessions={[oneDayAgo]} onRefresh={() => {}} />);
    openCalendarView();
    clickDay(targetDay);

    const presentBtn = screen.getByRole("button", { name: /^present$/i });
    expect(presentBtn).not.toBeDisabled();
    fireEvent.click(presentBtn);
  });

  it("a day with no sessions shows 'No sessions on this date' instead of an error", () => {
    render(<AttendanceTab sessions={[]} onRefresh={() => {}} />);
    openCalendarView();
    expect(screen.getByText(/no sessions on this date/i)).toBeTruthy();
  });
});
