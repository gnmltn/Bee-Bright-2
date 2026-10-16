import { useEffect, useState } from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Step7Schedule from "@/components/enrollment/steps/Step7Schedule";
import { INITIAL_WIZARD_DATA } from "@/components/enrollment/wizard-types";
import type { WizardData } from "@/components/enrollment/wizard-types";
import { enrollmentService } from "@/services/api";

/**
 * Real bug report: the "Available Slots" count for Examination Preparation 8-9AM
 * stayed stuck at "2 available" no matter how many times the same child was
 * re-added to that slot, while the admin's real 1-on-1 Scheduling Wizard — checked
 * later — correctly found all 3 tutors already booked. Investigation: both sides
 * call the exact same backend check (canTutorHandleSchedule) — there is no bogus or
 * hardcoded count on this side. The real gap is that this component fetched
 * availability exactly ONCE per (date, program) selection and never again: picking a
 * slot is a non-binding preference (never written to the server, so re-picking it
 * can never change anything), but if real bookings changed elsewhere while a parent
 * stayed on this step, the displayed count had no way to catch up short of a full
 * page reload. Fixed with a periodic background refresh (+ refresh on tab refocus),
 * same convention as lib/navBadges.ts's own polling.
 */
vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    enrollmentService: {
      ...actual.enrollmentService,
      getAvailability: vi.fn(),
    },
  };
});

function Harness({ initial }: { initial: Partial<WizardData> }) {
  const [data, setData] = useState<WizardData>({ ...INITIAL_WIZARD_DATA, ...initial });
  const update = (partial: Partial<WizardData>) => setData((prev) => ({ ...prev, ...partial }));
  return <Step7Schedule data={data} update={update} onNext={() => {}} onBack={() => {}} />;
}

function selectedPackage(programCode: string) {
  return {
    programCode,
    packageSlug: "bright",
    displayName: programCode,
    price: 1000,
    priceDown: 500,
    paymentOption: "down" as const,
    durationDesc: "",
    sessionCount: 10,
  };
}

describe("Step7Schedule: Time Slot Availability stays fresh instead of a one-time stale snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Fake timers + RTL's async find*/waitFor don't mix (waitFor polls via REAL timers
  // internally and hangs forever once fake timers are active — same documented gotcha
  // as attendanceTab.test.tsx's grace-period timer test) — so these two stay fully
  // synchronous, using `act()` only to flush the already-resolved mock promises.
  it("re-fetches availability on a periodic timer, without the parent re-picking anything or changing the date/program", async () => {
    vi.useFakeTimers();
    let call = 0;
    (enrollmentService.getAvailability as ReturnType<typeof vi.fn>).mockImplementation(() => {
      call += 1;
      // First call: 2 of 3 tutors free. Every call after: a real booking landed
      // elsewhere in the meantime — now genuinely 0 free, matching the admin wizard's
      // own fresh, authoritative check.
      const available = call === 1 ? 2 : 0;
      return Promise.resolve({
        data: {
          success: true,
          date: "2026-10-15",
          programCode: "EXP106",
          slots: { "08:00-09:00": { label: "8:00 - 9:00 AM", available, total: 3 } },
        },
      });
    });

    render(
      <Harness
        initial={{
          preferredStartDate: "2026-10-15",
          selectedPackages: [selectedPackage("EXP106")],
        }}
      />
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/available slots: 2/i)).toBeTruthy();
    expect(enrollmentService.getAvailability).toHaveBeenCalledTimes(1);

    // Advance past the 30s background-refresh interval — no user interaction at all.
    await act(async () => { await vi.advanceTimersByTimeAsync(31000); });

    expect(enrollmentService.getAvailability).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/fully booked/i)).toBeTruthy();
  });

  it("a background refresh never re-shows the loading spinner (only the very first fetch does)", async () => {
    vi.useFakeTimers();
    (enrollmentService.getAvailability as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({
        data: {
          success: true,
          date: "2026-10-15",
          programCode: "EXP106",
          slots: { "08:00-09:00": { label: "8:00 - 9:00 AM", available: 1, total: 3 } },
        },
      })
    );

    render(
      <Harness
        initial={{
          preferredStartDate: "2026-10-15",
          selectedPackages: [selectedPackage("EXP106")],
        }}
      />
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/available slots: 1/i)).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(31000); });

    // Still showing the real slot data throughout — never flashed back to the
    // "Checking availability…" loading state for a silent background refresh.
    expect(screen.queryByText(/checking availability/i)).toBeNull();
    expect(screen.getByText(/available slots: 1/i)).toBeTruthy();
  });

  it("also refreshes when the browser tab regains focus", async () => {
    let call = 0;
    (enrollmentService.getAvailability as ReturnType<typeof vi.fn>).mockImplementation(() => {
      call += 1;
      const available = call === 1 ? 2 : 0;
      return Promise.resolve({
        data: {
          success: true,
          date: "2026-10-15",
          programCode: "EXP106",
          slots: { "08:00-09:00": { label: "8:00 - 9:00 AM", available, total: 3 } },
        },
      });
    });

    render(
      <Harness
        initial={{
          preferredStartDate: "2026-10-15",
          selectedPackages: [selectedPackage("EXP106")],
        }}
      />
    );

    await waitFor(() => expect(screen.getByText(/available slots: 2/i)).toBeTruthy());

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(enrollmentService.getAvailability).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/fully booked/i)).toBeTruthy());
  });
});
