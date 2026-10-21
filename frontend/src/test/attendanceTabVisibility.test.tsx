import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Request: on the Tutor Dashboard's Attendance tab, only "Calendar Sessions" and
 * "Student summary" are visible for now — "Today's sessions" and "Past sessions" are
 * hidden (not deleted), and Calendar Sessions is the default tab. The hide is driven
 * by ONE flag, SHOW_LEGACY_ATTENDANCE_TABS (attendanceTabFlags.ts), reversible by
 * changing that one value back to `true`.
 *
 * These tests exercise the real AttendanceTab component against both states of the
 * flag — the `false` (current) state via a normal import, and the `true` (legacy)
 * state via vi.doMock + a fresh dynamic import, since the flag is a module-level
 * constant the component reads at import time, not a prop.
 */
afterEach(() => {
  cleanup();
  vi.doUnmock("@/components/tutor/attendanceTabFlags");
  vi.resetModules();
});

describe("AttendanceTab visibility: SHOW_LEGACY_ATTENDANCE_TABS = false (current default)", () => {
  it("only 'Calendar Sessions' and 'Student summary' render — 'Today's sessions'/'Past sessions' are hidden, not deleted", async () => {
    const { AttendanceTab } = await import("@/components/tutor/AttendanceTab");
    render(<AttendanceTab sessions={[]} onRefresh={() => {}} />);

    expect(screen.getByRole("button", { name: /calendar sessions/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /student summary/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /today's sessions/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /past sessions/i })).toBeNull();
  });

  it("'Calendar Sessions' is the default (active) tab when Attendance opens", async () => {
    const { AttendanceTab } = await import("@/components/tutor/AttendanceTab");
    render(<AttendanceTab sessions={[]} onRefresh={() => {}} />);

    // The calendar's own content ("Browse by date") is showing without any click —
    // i.e. Calendar Sessions, not a hidden "Today's sessions", is what's active by
    // default. The Calendar Sessions button also reflects "selected" (default variant).
    expect(screen.getByText(/browse by date/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /calendar sessions/i }).className).toMatch(/bg-primary/);
  });
});

describe("AttendanceTab visibility: SHOW_LEGACY_ATTENDANCE_TABS = true (flipped back on)", () => {
  it("flipping the flag back to true restores BOTH legacy tabs, with the original 'Today's sessions' default", async () => {
    vi.resetModules();
    vi.doMock("@/components/tutor/attendanceTabFlags", () => ({ SHOW_LEGACY_ATTENDANCE_TABS: true }));
    const { AttendanceTab } = await import("@/components/tutor/AttendanceTab");

    render(<AttendanceTab sessions={[]} onRefresh={() => {}} />);

    // Both legacy tabs are back, alongside the two that were always visible.
    expect(screen.getByRole("button", { name: /today's sessions/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /past sessions/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /calendar sessions/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /student summary/i })).toBeTruthy();

    // The original default (Today's sessions) is restored too — nothing else changed.
    expect(screen.getByText(/mark attendance — today/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /today's sessions/i }).className).toMatch(/bg-primary/);
  });
});
