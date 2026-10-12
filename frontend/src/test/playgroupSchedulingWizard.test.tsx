import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlaygroupSchedulingWizard } from "@/components/admin/PlaygroupSchedulingWizard";
import type { AdminEnrollment, AdminSchedule } from "@/services/api";

// Admin scheduling fix — the Playgroup wizard's time-window dropdown must proactively
// disable a window that would double-book the selected child against an existing
// session, instead of only rejecting it after the whole form is filled out and
// submitted. This exercises that through the real component, not just the underlying
// conflict-check function, since the bug report was specifically about the dropdown
// itself still being clickable.

const checkPlaygroupWindows = vi.fn();
const listPlaygroupGroups = vi.fn();
const createOrJoinPlaygroupGroup = vi.fn();

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    scheduleService: {
      checkPlaygroupWindows: (...args: unknown[]) => checkPlaygroupWindows(...args),
      listPlaygroupGroups: (...args: unknown[]) => listPlaygroupGroups(...args),
      createOrJoinPlaygroupGroup: (...args: unknown[]) => createOrJoinPlaygroupGroup(...args),
    },
  };
});

// Radix Select needs these in jsdom (no real pointer/scroll implementation there);
// scoped to this file only, not the global test setup.
beforeEach(() => {
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture || (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture || (() => {});
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture || (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

const ENROLLMENT: AdminEnrollment = {
  _id: "enr-1",
  status: "approved",
  packages: [{ programCode: "TPG101", displayName: "Toddlers Playgroup" }],
  selectedSubjects: [],
  student: { _id: "student-1", firstName: "Maria", lastName: "Cruz", email: "" },
  studentSnapshot: { firstName: "Maria", lastName: "Cruz" },
  parent: { _id: "parent-1", firstName: "Ana", lastName: "Cruz", email: "ana@example.com" },
  totalFee: 5000,
  paymentOption: "down",
  paymentStatus: "verified",
};

const SCHEDULES: AdminSchedule[] = [];

function renderWizard(enrollments: AdminEnrollment[] = [ENROLLMENT]) {
  const onCreated = vi.fn();
  const utils = render(
    <PlaygroupSchedulingWizard
      subjects={[{ _id: "subj-tpg101", name: "Toddlers Playgroup", code: "TPG101" }]}
      enrollments={enrollments}
      tutors={[{ _id: "tutor-a", firstName: "Jake", lastName: "Soriano" }]}
      pricing={[]}
      schedules={SCHEDULES}
      onCreated={onCreated}
    />
  );
  return { ...utils, onCreated };
}

async function selectStudent(label: string) {
  // The plain "Select a student" dropdown (second control next to the search box).
  const trigger = screen.getByText("Select a student");
  fireEvent.click(trigger);
  const option = await screen.findByText(label);
  fireEvent.click(option);
}

describe("PlaygroupSchedulingWizard: proactive time-window conflict disabling", () => {
  beforeEach(() => {
    checkPlaygroupWindows.mockReset();
    listPlaygroupGroups.mockReset().mockResolvedValue({ data: { success: true, groups: [] } });
    createOrJoinPlaygroupGroup.mockReset();
  });

  it("disables the conflicting 8-10 AM window in the dropdown once a child + day are chosen, and leaves 1-3 PM selectable", async () => {
    checkPlaygroupWindows.mockResolvedValue({
      data: {
        success: true,
        startDate: "2026-11-02",
        windows: [
          {
            startTime: "08:00",
            endTime: "10:00",
            ok: false,
            conflicts: [{ enrollmentId: "enr-1", date: "2026-11-02", subjectLabel: "Academic Tutorial", startTime: "08:00", endTime: "09:00" }],
          },
          { startTime: "13:00", endTime: "15:00", ok: true, conflicts: [] },
        ],
      },
    });

    renderWizard();
    await selectStudent("Maria Cruz");
    fireEvent.click(screen.getByRole("button", { name: "Mon" }));

    await waitFor(() => expect(checkPlaygroupWindows).toHaveBeenCalled());

    // Open the time-window dropdown via its stable accessible name (its visible text is
    // the currently-selected window's label, which also appears again inside the open
    // dropdown's own options, so text-matching the trigger itself would be ambiguous).
    fireEvent.click(screen.getByRole("combobox", { name: "Time window" }));

    await screen.findByText(/already has Academic Tutorial at this time/i);
    const morningItem = screen.getByRole("option", { name: /8:00 AM - 10:00 AM/ });
    expect(morningItem).toHaveAttribute("data-disabled");

    const afternoonItem = screen.getByRole("option", { name: "1:00 PM - 3:00 PM" });
    expect(afternoonItem).not.toHaveAttribute("data-disabled");
  });

  it("shows no conflict warning and keeps both windows selectable when the check reports no conflicts", async () => {
    checkPlaygroupWindows.mockResolvedValue({
      data: {
        success: true,
        startDate: "2026-11-02",
        windows: [
          { startTime: "08:00", endTime: "10:00", ok: true, conflicts: [] },
          { startTime: "13:00", endTime: "15:00", ok: true, conflicts: [] },
        ],
      },
    });

    renderWizard();
    await selectStudent("Maria Cruz");
    fireEvent.click(screen.getByRole("button", { name: "Mon" }));

    await waitFor(() => expect(checkPlaygroupWindows).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("combobox", { name: "Time window" }));
    const morningItem = screen.getByRole("option", { name: "8:00 AM - 10:00 AM" });
    expect(morningItem).not.toHaveAttribute("data-disabled");
    expect(screen.queryByText(/already has/i)).toBeNull();
  });

  it("does not call the conflict check before a day is chosen (child alone is not enough info)", async () => {
    checkPlaygroupWindows.mockResolvedValue({ data: { success: true, startDate: "2026-11-02", windows: [] } });
    renderWizard();
    await selectStudent("Maria Cruz");
    // No day toggled yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(checkPlaygroupWindows).not.toHaveBeenCalled();
  });
});
