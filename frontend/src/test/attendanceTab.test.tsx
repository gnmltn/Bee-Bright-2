import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttendanceTab } from "@/components/tutor/AttendanceTab";
import { scheduleService } from "@/services/api";

vi.mock("@/services/api", () => ({
  scheduleService: {
    markAttendance: vi.fn(() => Promise.resolve({ data: { success: true } })),
  },
}));

// 2026-09-17: previously BOTH Present/Absent buttons stayed independently clickable
// after one was already marked, so a stray click could silently flip an already-marked
// session's attendance. Decision: keep both buttons clickable (support correcting a
// mistake), but switching away from an already-marked status now requires an explicit
// confirmation — re-clicking the SAME status is a harmless no-op, no confirmation and
// no re-submit needed.
function makeTodaySession(overrides: Record<string, unknown> = {}) {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return {
    _id: "sched-1",
    date: `${todayStr}T00:00:00.000Z`,
    startTime: "08:00",
    endTime: "09:00",
    student: { _id: "student-1", firstName: "Ana", lastName: "Cruz" },
    subject: { name: "Academic Tutorial" },
    ...overrides,
  };
}

function daysAgoDateStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function makePastSession(daysAgo: number, overrides: Record<string, unknown> = {}) {
  return {
    _id: `sched-past-${daysAgo}`,
    date: `${daysAgoDateStr(daysAgo)}T00:00:00.000Z`,
    startTime: "08:00",
    endTime: "09:00",
    student: { _id: "student-1", firstName: "Ana", lastName: "Cruz" },
    subject: { name: "Academic Tutorial" },
    ...overrides,
  };
}

describe("AttendanceTab: Present/Absent button locking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks attendance immediately for an unmarked session (no confirmation needed)", async () => {
    const session = makeTodaySession();
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /present/i }));

    await waitFor(() => {
      expect(scheduleService.markAttendance).toHaveBeenCalledWith("sched-1", "present");
    });
    expect(screen.queryByText(/change attendance/i)).toBeNull();
  });

  it("re-clicking the already-marked status is a no-op — no confirmation, no API call", async () => {
    const session = makeTodaySession({ attendanceStatus: "present" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /present/i }));

    expect(screen.queryByText(/change attendance/i)).toBeNull();
    expect(scheduleService.markAttendance).not.toHaveBeenCalled();
  });

  it("clicking the opposite status on an already-marked session opens a confirmation instead of submitting immediately", async () => {
    const session = makeTodaySession({ attendanceStatus: "present" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /absent/i }));

    expect(await screen.findByText(/change attendance to absent\?/i)).toBeTruthy();
    expect(scheduleService.markAttendance).not.toHaveBeenCalled();
  });

  it("confirming the switch submits the new status", async () => {
    const session = makeTodaySession({ attendanceStatus: "present" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /absent/i }));
    expect(await screen.findByText(/change attendance to absent\?/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /yes, mark as absent/i }));

    await waitFor(() => {
      expect(scheduleService.markAttendance).toHaveBeenCalledWith("sched-1", "absent");
    });
  });

  it("cancelling the switch does not submit anything", async () => {
    const session = makeTodaySession({ attendanceStatus: "present" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /absent/i }));
    expect(await screen.findByText(/change attendance to absent\?/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(screen.queryByText(/change attendance to absent\?/i)).toBeNull();
    });
    expect(scheduleService.markAttendance).not.toHaveBeenCalled();
  });
});

// "bug (13).pdf" Group AR — tutors get a 3-day grace period after a session date to mark
// Present/Absent; past that, an unmarked session auto-resolves to Absent (display-only,
// never written to the DB until the tutor actually acts on it).
describe("AttendanceTab: 3-day grace period auto-resolves an unmarked past session to Absent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("more than 3 days old, still unmarked: reads as Absent — clicking Absent is a no-op, clicking Present asks to confirm overwriting it", async () => {
    const session = makePastSession(4); // 4 days ago -> past the grace period
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /past sessions/i }));

    fireEvent.click(await screen.findByRole("button", { name: /^absent$/i }));
    expect(scheduleService.markAttendance).not.toHaveBeenCalled();
    expect(screen.queryByText(/change attendance/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^present$/i }));
    expect(await screen.findByText(/change attendance to present\?/i)).toBeTruthy();
    expect(scheduleService.markAttendance).not.toHaveBeenCalled();
  });

  it("within the 3-day window, still unmarked: does NOT get forced to Absent — Present submits immediately, no confirmation", async () => {
    const session = makePastSession(2); // 2 days ago -> still inside the grace window
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /past sessions/i }));

    fireEvent.click(await screen.findByRole("button", { name: /^present$/i }));
    await waitFor(() => {
      expect(scheduleService.markAttendance).toHaveBeenCalledWith(session._id, "present");
    });
    expect(screen.queryByText(/change attendance/i)).toBeNull();
  });

  it("exactly 3 days old is still within the grace period — \"more than 3 days\" means day 4 onward, not day 3", async () => {
    const session = makePastSession(3);
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /past sessions/i }));

    fireEvent.click(await screen.findByRole("button", { name: /^present$/i }));
    await waitFor(() => {
      expect(scheduleService.markAttendance).toHaveBeenCalledWith(session._id, "present");
    });
    expect(screen.queryByText(/change attendance/i)).toBeNull();
  });
});
