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
