import { useEffect, useState } from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Step7Schedule from "@/components/enrollment/steps/Step7Schedule";
import { INITIAL_WIZARD_DATA } from "@/components/enrollment/wizard-types";
import type { WizardData } from "@/components/enrollment/wizard-types";
import { enrollmentService } from "@/services/api";

// Enrollment-side Time Slot Availability picker must grey out any slot that OVERLAPS
// (not just exactly matches) an already-picked slot in another program, within the
// same enrollment session — the same conflict-detection concept already built for the
// admin Toddlers Playgroup Scheduling Wizard, ported to this frontend-only surface
// (see Step7Schedule.tsx's timeRangesOverlap, mirroring scheduleController.js's).
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

const ACT102_SLOTS = {
  "08:00-09:00": { label: "8:00 - 9:00 AM", available: 3, total: 5 },
  "09:00-10:00": { label: "9:00 - 10:00 AM", available: 3, total: 5 },
  "10:00-11:00": { label: "10:00 - 11:00 AM", available: 3, total: 5 },
};
const EXP106_SLOTS = {
  "08:00-09:00": { label: "8:00 - 9:00 AM", available: 2, total: 4 },
  "09:00-10:00": { label: "9:00 - 10:00 AM", available: 2, total: 4 },
  "10:00-11:00": { label: "10:00 - 11:00 AM", available: 2, total: 4 },
};
const TPG101_SLOTS = {
  "08:00-10:00": { label: "8:00 - 10:00 AM", available: 2, total: 4 },
  "13:00-15:00": { label: "1:00 - 3:00 PM", available: 2, total: 4 },
};

function mockAvailabilityByProgram(byCode: Record<string, typeof ACT102_SLOTS | typeof TPG101_SLOTS>) {
  (enrollmentService.getAvailability as ReturnType<typeof vi.fn>).mockImplementation(
    (_date: string, programCode: string) =>
      Promise.resolve({ data: { success: true, date: _date, programCode, slots: byCode[programCode] ?? {} } })
  );
}

// A real wizard lifts `data` into its own state and passes the updated object back
// down on every `update()` call — unlike step7ScheduleStartDate.test.tsx's harness
// (which just mutates a closure variable without re-rendering), this test needs a
// REAL re-render whenever a slot is picked, since the overlap check for program B
// depends on program A's pick already being reflected in the `data` prop.
function Harness({
  initial,
  onReady,
  onNext,
}: {
  initial: Partial<WizardData>;
  /** Exposes `update` to the test so it can simulate a day-selection change made
   *  elsewhere in the step (the Available Days section is a separate, already-stepped
   *  UI not driven here), without re-deriving the whole stepped-UI flow. */
  onReady?: (update: (p: Partial<WizardData>) => void) => void;
  onNext?: () => void;
}) {
  const [data, setData] = useState<WizardData>({ ...INITIAL_WIZARD_DATA, ...initial });
  const update = (partial: Partial<WizardData>) => setData((prev) => ({ ...prev, ...partial }));
  useEffect(() => {
    onReady?.(update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Step7Schedule data={data} update={update} onNext={onNext ?? (() => {})} onBack={() => {}} />;
}

function selectedPackage(programCode: string) {
  return {
    programCode,
    packageSlug: "standard",
    displayName: programCode,
    price: 1000,
    priceDown: 500,
    paymentOption: "down" as const,
    durationDesc: "",
    sessionCount: 10,
  };
}

// The program name also appears a second time lower down in the separate "Available
// Days" section, so take the FIRST occurrence — the Time Slot Availability one, which
// renders earlier in the DOM.
async function findSlotButton(programName: string, slotLabel: string) {
  const headers = await screen.findAllByText(programName);
  const section = headers[0].closest(".border") as HTMLElement;
  return within(section).getByText(slotLabel).closest("button") as HTMLButtonElement;
}

describe("Step7Schedule: cross-program time-slot overlap graying", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Academic Tutorial 8-9AM picked first greys out Toddlers Playgroup's overlapping 8-10AM, leaves 1-3PM selectable", async () => {
    mockAvailabilityByProgram({ ACT102: ACT102_SLOTS, TPG101: TPG101_SLOTS });
    render(
      <Harness
        initial={{
          preferredStartDate: "2026-11-02",
          selectedPackages: [selectedPackage("ACT102"), selectedPackage("TPG101")],
          preferredDaysByProgram: [
            { programCode: "ACT102", days: ["Monday"] },
            { programCode: "TPG101", days: ["Monday"] },
          ],
        }}
      />
    );

    const actSlot = await findSlotButton("Academic Tutorial", "8:00 - 9:00 AM");
    await waitFor(() => expect(actSlot).not.toBeDisabled());
    fireEvent.click(actSlot);

    const playgroup8to10 = await findSlotButton("Toddlers Playgroup", "8:00 - 10:00 AM");
    await waitFor(() => expect(playgroup8to10).toBeDisabled());
    expect(playgroup8to10.textContent).toMatch(/conflicts with academic tutorial/i);

    const playgroup1to3 = await findSlotButton("Toddlers Playgroup", "1:00 - 3:00 PM");
    expect(playgroup1to3).not.toBeDisabled();
  });

  it("the other direction: Toddlers Playgroup 8-10AM picked first greys out BOTH overlapping Academic Tutorial slots, leaves 10-11AM selectable", async () => {
    mockAvailabilityByProgram({ ACT102: ACT102_SLOTS, TPG101: TPG101_SLOTS });
    render(
      <Harness
        initial={{
          preferredStartDate: "2026-11-02",
          selectedPackages: [selectedPackage("ACT102"), selectedPackage("TPG101")],
          preferredDaysByProgram: [
            { programCode: "ACT102", days: ["Monday"] },
            { programCode: "TPG101", days: ["Monday"] },
          ],
        }}
      />
    );

    const playgroup8to10 = await findSlotButton("Toddlers Playgroup", "8:00 - 10:00 AM");
    await waitFor(() => expect(playgroup8to10).not.toBeDisabled());
    fireEvent.click(playgroup8to10);

    const act8to9 = await findSlotButton("Academic Tutorial", "8:00 - 9:00 AM");
    const act9to10 = await findSlotButton("Academic Tutorial", "9:00 - 10:00 AM");
    const act10to11 = await findSlotButton("Academic Tutorial", "10:00 - 11:00 AM");
    await waitFor(() => {
      expect(act8to9).toBeDisabled();
      expect(act9to10).toBeDisabled();
    });
    expect(act10to11).not.toBeDisabled();
  });

  it("Examination Preparation vs Toddlers Playgroup: the same overlap check applies to this combination too", async () => {
    mockAvailabilityByProgram({ EXP106: EXP106_SLOTS, TPG101: TPG101_SLOTS });
    render(
      <Harness
        initial={{
          preferredStartDate: "2026-11-02",
          selectedPackages: [selectedPackage("EXP106"), selectedPackage("TPG101")],
          preferredDaysByProgram: [
            { programCode: "EXP106", days: ["Monday"] },
            { programCode: "TPG101", days: ["Monday"] },
          ],
        }}
      />
    );

    const expSlot = await findSlotButton("Examination Preparation", "8:00 - 9:00 AM");
    await waitFor(() => expect(expSlot).not.toBeDisabled());
    fireEvent.click(expSlot);

    const playgroup8to10 = await findSlotButton("Toddlers Playgroup", "8:00 - 10:00 AM");
    await waitFor(() => expect(playgroup8to10).toBeDisabled());
  });

  it("Academic Tutorial vs Examination Preparation (both 1-on-1): an identical time slot conflicts directly", async () => {
    mockAvailabilityByProgram({ ACT102: ACT102_SLOTS, EXP106: EXP106_SLOTS });
    render(
      <Harness
        initial={{
          preferredStartDate: "2026-11-02",
          selectedPackages: [selectedPackage("ACT102"), selectedPackage("EXP106")],
          preferredDaysByProgram: [
            { programCode: "ACT102", days: ["Monday"] },
            { programCode: "EXP106", days: ["Monday"] },
          ],
        }}
      />
    );

    const actSlot = await findSlotButton("Academic Tutorial", "8:00 - 9:00 AM");
    await waitFor(() => expect(actSlot).not.toBeDisabled());
    fireEvent.click(actSlot);

    const expSlot = await findSlotButton("Examination Preparation", "8:00 - 9:00 AM");
    await waitFor(() => expect(expSlot).toBeDisabled());
    expect(expSlot.textContent).toMatch(/conflicts with academic tutorial/i);

    // The non-overlapping 9-10AM slot for the other program must stay selectable.
    const expNext = await findSlotButton("Examination Preparation", "9:00 - 10:00 AM");
    expect(expNext).not.toBeDisabled();
  });

  it("back-to-back (touching, not overlapping) slots remain fully selectable — 8-9AM then 9-10AM is NOT a conflict", async () => {
    mockAvailabilityByProgram({ ACT102: ACT102_SLOTS, EXP106: EXP106_SLOTS });
    render(
      <Harness
        initial={{
          preferredStartDate: "2026-11-02",
          selectedPackages: [selectedPackage("ACT102"), selectedPackage("EXP106")],
          preferredDaysByProgram: [
            { programCode: "ACT102", days: ["Monday"] },
            { programCode: "EXP106", days: ["Monday"] },
          ],
        }}
      />
    );

    const actSlot = await findSlotButton("Academic Tutorial", "8:00 - 9:00 AM");
    await waitFor(() => expect(actSlot).not.toBeDisabled());
    fireEvent.click(actSlot);

    const expBackToBack = await findSlotButton("Examination Preparation", "9:00 - 10:00 AM");
    expect(expBackToBack).not.toBeDisabled();
  });

  it("deselecting a picked slot (clicking it again) immediately un-greys the other program's overlapping slot", async () => {
    mockAvailabilityByProgram({ ACT102: ACT102_SLOTS, TPG101: TPG101_SLOTS });
    render(
      <Harness
        initial={{
          preferredStartDate: "2026-11-02",
          selectedPackages: [selectedPackage("ACT102"), selectedPackage("TPG101")],
          preferredDaysByProgram: [
            { programCode: "ACT102", days: ["Monday"] },
            { programCode: "TPG101", days: ["Monday"] },
          ],
        }}
      />
    );

    const actSlot = await findSlotButton("Academic Tutorial", "8:00 - 9:00 AM");
    await waitFor(() => expect(actSlot).not.toBeDisabled());
    fireEvent.click(actSlot);

    const playgroup8to10 = await findSlotButton("Toddlers Playgroup", "8:00 - 10:00 AM");
    await waitFor(() => expect(playgroup8to10).toBeDisabled());

    fireEvent.click(actSlot); // deselect
    await waitFor(() => expect(playgroup8to10).not.toBeDisabled());
  });
});

// Follow-up fix: a time overlap alone isn't a real conflict if the two programs never
// actually meet on the same day. Also covers the trickier ordering issue — Available
// Days comes AFTER Time Slot Availability in this wizard, so days may not be known yet
// at slot-pick time.
describe("Step7Schedule: cross-program conflict also requires an overlapping DAY, not just an overlapping time", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exact screenshot scenario: Academic Tutorial Mon/Tue/Wed 8-9AM does NOT conflict with Toddlers Playgroup Thu/Fri/Sat 8-10AM — no shared day", async () => {
    mockAvailabilityByProgram({ ACT102: ACT102_SLOTS, TPG101: TPG101_SLOTS });
    render(
      <Harness
        initial={{
          preferredStartDate: "2026-11-02",
          selectedPackages: [selectedPackage("ACT102"), selectedPackage("TPG101")],
          preferredSlots: [{ programCode: "ACT102", startTime: "08:00", endTime: "09:00", label: "8:00 - 9:00 AM" }],
          preferredDaysByProgram: [
            { programCode: "ACT102", days: ["Monday", "Tuesday", "Wednesday"] },
            { programCode: "TPG101", days: ["Thursday", "Friday", "Saturday"] },
          ],
        }}
      />
    );

    const playgroup8to10 = await findSlotButton("Toddlers Playgroup", "8:00 - 10:00 AM");
    await waitFor(() => expect(playgroup8to10).not.toBeDisabled());
    expect(playgroup8to10.textContent).not.toMatch(/conflicts/i);
  });

  it("reactive to day changes: changing the days so they now share Wednesday makes the same slot conflict again, live, with no re-pick needed", async () => {
    mockAvailabilityByProgram({ ACT102: ACT102_SLOTS, TPG101: TPG101_SLOTS });
    let externalUpdate: ((p: Partial<WizardData>) => void) | null = null;
    render(
      <Harness
        initial={{
          preferredStartDate: "2026-11-02",
          selectedPackages: [selectedPackage("ACT102"), selectedPackage("TPG101")],
          preferredSlots: [{ programCode: "ACT102", startTime: "08:00", endTime: "09:00", label: "8:00 - 9:00 AM" }],
          preferredDaysByProgram: [
            { programCode: "ACT102", days: ["Monday", "Tuesday", "Wednesday"] },
            { programCode: "TPG101", days: ["Thursday", "Friday", "Saturday"] },
          ],
        }}
        onReady={(u) => { externalUpdate = u; }}
      />
    );

    const playgroup8to10 = await findSlotButton("Toddlers Playgroup", "8:00 - 10:00 AM");
    await waitFor(() => expect(playgroup8to10).not.toBeDisabled());

    act(() => {
      externalUpdate!({
        preferredDaysByProgram: [
          { programCode: "ACT102", days: ["Monday", "Tuesday", "Wednesday"] },
          { programCode: "TPG101", days: ["Wednesday", "Friday", "Saturday"] }, // now shares Wednesday
        ],
      });
    });

    await waitFor(() => expect(playgroup8to10).toBeDisabled());
    expect(playgroup8to10.textContent).toMatch(/conflicts with academic tutorial/i);
  });

  it("days not yet picked for either program: treated as unknown/not-yet-conflicting, not as overlapping everything", async () => {
    mockAvailabilityByProgram({ ACT102: ACT102_SLOTS, TPG101: TPG101_SLOTS });
    render(
      <Harness
        initial={{
          preferredStartDate: "2026-11-02",
          selectedPackages: [selectedPackage("ACT102"), selectedPackage("TPG101")],
          // No preferredDaysByProgram at all — this is the state at the moment the
          // parent is still on the Time Slot step, before reaching Available Days.
        }}
      />
    );

    const actSlot = await findSlotButton("Academic Tutorial", "8:00 - 9:00 AM");
    await waitFor(() => expect(actSlot).not.toBeDisabled());
    fireEvent.click(actSlot);

    const playgroup8to10 = await findSlotButton("Toddlers Playgroup", "8:00 - 10:00 AM");
    // Still not flagged — days are unknown for both programs at this point, so no
    // conflict is assumed yet.
    await waitFor(() => expect(playgroup8to10).not.toBeDisabled());
  });

  it("one program's days still unknown: no conflict assumed even though the other program's days ARE set", async () => {
    mockAvailabilityByProgram({ ACT102: ACT102_SLOTS, TPG101: TPG101_SLOTS });
    render(
      <Harness
        initial={{
          preferredStartDate: "2026-11-02",
          selectedPackages: [selectedPackage("ACT102"), selectedPackage("TPG101")],
          preferredSlots: [{ programCode: "ACT102", startTime: "08:00", endTime: "09:00", label: "8:00 - 9:00 AM" }],
          // Only ACT102's days are known so far; TPG101's Available Days step hasn't
          // been reached yet in this session.
          preferredDaysByProgram: [{ programCode: "ACT102", days: ["Monday", "Tuesday", "Wednesday"] }],
        }}
      />
    );

    const playgroup8to10 = await findSlotButton("Toddlers Playgroup", "8:00 - 10:00 AM");
    await waitFor(() => expect(playgroup8to10).not.toBeDisabled());
  });
});

// Follow-up fix: the grey-out is a display-only hint — it stops NEW conflicting picks,
// but a slot that was ALREADY selected while valid can still silently become
// conflicting later (e.g. Available Days changed afterward) and nothing previously
// stopped Continue from going through anyway. This is the submit-time safety net.
describe("Step7Schedule: Continue is blocked when an already-selected slot later becomes conflicting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exact repro: a validly-picked Academic Tutorial slot becomes conflicting after Toddlers Playgroup's days are changed to overlap — Continue is blocked with a clear message, not silently allowed through", async () => {
    mockAvailabilityByProgram({ ACT102: ACT102_SLOTS, TPG101: TPG101_SLOTS });
    let externalUpdate: ((p: Partial<WizardData>) => void) | null = null;
    const onNext = vi.fn();
    render(
      <Harness
        onNext={onNext}
        initial={{
          preferredStartDate: "2026-11-02",
          selectedPackages: [selectedPackage("ACT102"), selectedPackage("TPG101")],
          // Both slots were picked validly at the time — Mon/Tue/Wed never overlapped
          // Thu/Fri/Sat, so neither pick was ever flagged as conflicting when made.
          preferredSlots: [
            { programCode: "ACT102", startTime: "08:00", endTime: "09:00", label: "8:00 - 9:00 AM" },
            { programCode: "TPG101", startTime: "08:00", endTime: "10:00", label: "8:00 - 10:00 AM" },
          ],
          preferredDaysByProgram: [
            { programCode: "ACT102", days: ["Monday", "Tuesday", "Wednesday"] },
            { programCode: "TPG101", days: ["Thursday", "Friday", "Saturday"] },
          ],
        }}
        onReady={(u) => { externalUpdate = u; }}
      />
    );

    // Sanity check: nothing flagged as conflicting yet.
    const playgroup8to10 = await findSlotButton("Toddlers Playgroup", "8:00 - 10:00 AM");
    await waitFor(() => expect(playgroup8to10).not.toBeDisabled());

    // Available Days is changed afterward so Toddlers Playgroup now also meets on
    // Wednesday — the two already-selected slots now genuinely overlap in both time
    // AND day.
    act(() => {
      externalUpdate!({
        preferredDaysByProgram: [
          { programCode: "ACT102", days: ["Monday", "Tuesday", "Wednesday"] },
          { programCode: "TPG101", days: ["Wednesday", "Friday", "Saturday"] },
        ],
      });
    });
    await waitFor(() => expect(playgroup8to10).toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Blocked — never advances past this step with a conflicting selection in place.
    expect(onNext).not.toHaveBeenCalled();
    const errorMessage = screen.getByText(/now conflicts with/i);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage.textContent).toMatch(/academic tutorial/i);
  });

  it("Continue proceeds normally once the conflicting slot is swapped out", async () => {
    mockAvailabilityByProgram({ ACT102: ACT102_SLOTS, TPG101: TPG101_SLOTS });
    const onNext = vi.fn();
    render(
      <Harness
        onNext={onNext}
        initial={{
          preferredStartDate: "2026-11-02",
          selectedPackages: [selectedPackage("ACT102"), selectedPackage("TPG101")],
          preferredSlots: [
            { programCode: "ACT102", startTime: "08:00", endTime: "09:00", label: "8:00 - 9:00 AM" },
            { programCode: "TPG101", startTime: "08:00", endTime: "10:00", label: "8:00 - 10:00 AM" },
          ],
          // Both already share Wednesday — the slots are conflicting from the start here.
          preferredDaysByProgram: [
            { programCode: "ACT102", days: ["Monday", "Tuesday", "Wednesday"] },
            { programCode: "TPG101", days: ["Wednesday", "Friday", "Saturday"] },
          ],
        }}
      />
    );

    const playgroup1to3 = await findSlotButton("Toddlers Playgroup", "1:00 - 3:00 PM");
    await waitFor(() => expect(playgroup1to3).not.toBeDisabled());
    fireEvent.click(playgroup1to3); // swap Playgroup to the non-conflicting slot

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.queryByText(/now conflicts with/i)).toBeNull();
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
