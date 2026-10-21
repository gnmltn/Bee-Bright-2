import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OneOnOneSchedulingWizard } from "@/components/admin/OneOnOneSchedulingWizard";
import { REALTIME_EVENTS } from "@/lib/realtimeBridge";
import type { AdminEnrollment, MonthlySlotGridEntry } from "@/services/api";

/**
 * Request: Step 3 of the 1-on-1 wizard must be a REAL monthly calendar grid (Sun-Sat
 * columns, weeks as rows, prev/next month navigable) — not a list of stacked day
 * blocks. Only the real calendar dates covered by the chosen weekdays AND on/after the
 * Starting Date are clickable; every other day is grayed out. Clicking an eligible day
 * reveals its 8 hourly slots (compact in the cell, full detail in the side panel);
 * clicking an open slot there reveals exactly the tutors free for it. These tests
 * exercise the real component end to end against a mocked
 * scheduleService.getMonthlySlotGrid/checkMonthly/createMonthly — the backend's own
 * rule composition (canTutorHandleSchedule, availability windows, ghost-session
 * filtering, the 12-per-hour cap) is covered separately in
 * backend/test/one-on-one-slot-grid.test.js.
 */
const getMonthlySlotGrid = vi.fn();
const checkMonthly = vi.fn();
const createMonthly = vi.fn();

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    scheduleService: {
      getMonthlySlotGrid: (...args: unknown[]) => getMonthlySlotGrid(...args),
      checkMonthly: (...args: unknown[]) => checkMonthly(...args),
      createMonthly: (...args: unknown[]) => createMonthly(...args),
    },
  };
});

const ENROLLMENT: AdminEnrollment = {
  _id: "enr-1",
  status: "approved",
  packages: [{ programCode: "ACT102", displayName: "Academic Tutorial" }],
  selectedSubjects: [],
  student: { _id: "student-1", firstName: "Maria", lastName: "Cruz", email: "" },
  studentSnapshot: { firstName: "Maria", lastName: "Cruz" },
  parent: { _id: "parent-1", firstName: "Ana", lastName: "Cruz", email: "ana@example.com" },
  totalFee: 5000,
  paymentOption: "down",
  paymentStatus: "verified",
};

const STANDARD_SLOT_TIMES: [string, string][] = [
  ["08:00", "09:00"], ["09:00", "10:00"], ["10:00", "11:00"], ["11:00", "12:00"],
  ["13:00", "14:00"], ["14:00", "15:00"], ["15:00", "16:00"], ["16:00", "17:00"],
];

function slot(startTime: string, endTime: string, overrides: Partial<MonthlySlotGridEntry> = {}): MonthlySlotGridEntry {
  return {
    startTime,
    endTime,
    available: true,
    tutors: [{ _id: "tutor-nicole", name: "Nicole Monzada" }],
    reason: null,
    ...overrides,
  };
}

/** Local-date YYYY-MM-DD, matching the component's own toDateKey (never UTC). */
function toDateKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The next real local date on/after `fromKey` that falls on `dayOfWeek` — mirrors
 *  the backend's own "first occurrence" logic, kept local here so the test never has
 *  to independently guess "today" to know which calendar cell will be clickable. */
function nextDateKeyForDay(fromKey: string, dayOfWeek: number): string {
  const [y, m, d] = fromKey.split("-").map(Number);
  const from = new Date(y, (m || 1) - 1, d || 1);
  const diff = (dayOfWeek - from.getDay() + 7) % 7;
  const target = new Date(from);
  target.setDate(target.getDate() + diff);
  return toDateKey(target);
}

/** Builds a getMonthlySlotGrid mock implementation that computes ONE real date per
 *  requested day (using whatever startDate the component actually sends — it always
 *  defaults to today when the fixture enrollment has no preferredStartDate), fully
 *  open with the given tutors — a faithful-enough stand-in for the real backend
 *  without the test needing to hardcode or independently guess "today". */
function gridResponderFor(tutorsByDay: Record<number, { _id: string; name: string }[]>) {
  return (body: { days: number[]; startDate: string }) => {
    const grid: Record<string, MonthlySlotGridEntry[]> = {};
    for (const day of body.days) {
      const dateKey = nextDateKeyForDay(body.startDate, day);
      grid[dateKey] = STANDARD_SLOT_TIMES.map(([s, e]) => slot(s, e, { tutors: tutorsByDay[day] ?? [] }));
    }
    return Promise.resolve({ data: { success: true, startDate: body.startDate, subscriptionEnd: body.startDate, grid } });
  };
}

function renderWizard() {
  const onCreated = vi.fn();
  const utils = render(
    <OneOnOneSchedulingWizard
      subjects={[{ _id: "subj-act102", name: "Academic Tutorial", code: "ACT102" }]}
      enrollments={[ENROLLMENT]}
      tutors={[{ _id: "tutor-nicole", firstName: "Nicole", lastName: "Monzada" }, { _id: "tutor-jake", firstName: "Jake", lastName: "Soriano" }]}
      pricing={[]}
      schedules={[]}
      onCreated={onCreated}
    />
  );
  return { ...utils, onCreated };
}

async function selectStudent(label: string) {
  const trigger = screen.getByText("Select a student");
  fireEvent.click(trigger);
  const option = await screen.findByText(label);
  fireEvent.click(option);
}

/** Clicks the one calendar-day cell the grid actually populated for this weekday —
 *  avoids the test needing to compute "today" itself; it just waits for the real
 *  component to render whichever real date the mock resolved to as enabled. */
async function clickTheOnlyEligibleCalendarDay() {
  const cell = await waitFor(() => {
    const found = document.querySelector('[data-testid^="calendar-day-"]:not([disabled])');
    if (!found) throw new Error("no eligible calendar day cell rendered yet");
    return found as HTMLElement;
  });
  fireEvent.click(cell);
  return cell.getAttribute("data-testid")!.replace("calendar-day-", "");
}

beforeEach(() => {
  // Radix Select (used by StudentSearchSelect's dropdown) needs these in jsdom (no
  // real pointer/scroll implementation there) — same polyfill every other wizard
  // test file in this suite already applies.
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture || (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture || (() => {});
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture || (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  getMonthlySlotGrid.mockReset().mockImplementation(gridResponderFor({ 1: [{ _id: "tutor-nicole", name: "Nicole Monzada" }, { _id: "tutor-jake", name: "Jake Soriano" }], 3: [{ _id: "tutor-nicole", name: "Nicole Monzada" }, { _id: "tutor-jake", name: "Jake Soriano" }] }));
  checkMonthly.mockReset().mockResolvedValue({ data: { success: true, ok: true, startDate: "2026-11-02", conflicts: [], conflictCount: 0, suggestions: [], slotCap: 12 } });
  createMonthly.mockReset().mockResolvedValue({ data: { success: true, message: "Created 4 sessions.", count: 4 } });
});

describe("OneOnOneSchedulingWizard: real monthly calendar grid (Step 3)", () => {
  it("renders an actual calendar grid (weekday header row + day cells), not a list of stacked day blocks", async () => {
    renderWizard();
    await selectStudent("Maria Cruz — Academic Tutorial");
    fireEvent.click(screen.getByText("Mon"));

    const calendar = await screen.findByTestId("slot-calendar");
    // The Sun..Sat header row is the clearest signature of a real calendar grid.
    for (const label of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      expect(within(calendar).getByText(label)).toBeTruthy();
    }
    // At least one real, clickable (enabled) day cell exists once a weekday is chosen.
    await clickTheOnlyEligibleCalendarDay();
  });

  it("days NOT covered by the chosen weekdays are grayed out and not clickable", async () => {
    renderWizard();
    await selectStudent("Maria Cruz — Academic Tutorial");
    fireEvent.click(screen.getByText("Mon"));
    await clickTheOnlyEligibleCalendarDay();

    const calendar = screen.getByTestId("slot-calendar");
    const allDayButtons = within(calendar).getAllByTestId(/^calendar-day-/);
    const disabledCount = allDayButtons.filter((b) => b.hasAttribute("disabled")).length;
    const enabledCount = allDayButtons.length - disabledCount;
    // Only Monday was chosen — the vast majority of the ~42 rendered cells must be
    // disabled (wrong weekday, outside the window, or in the past).
    expect(enabledCount).toBeGreaterThan(0);
    expect(disabledCount).toBeGreaterThan(enabledCount);
  });

  it("a slot where every tutor is booked is grayed out and labeled 'No available tutor'", async () => {
    getMonthlySlotGrid.mockImplementation((body: { days: number[]; startDate: string }) => {
      const dateKey = nextDateKeyForDay(body.startDate, 1);
      const slots = STANDARD_SLOT_TIMES.map(([s, e]) => slot(s, e, { tutors: [{ _id: "tutor-nicole", name: "Nicole Monzada" }] }));
      slots[1] = slot("09:00", "10:00", { available: false, tutors: [], reason: "No available tutor for this time." });
      return Promise.resolve({ data: { success: true, startDate: body.startDate, subscriptionEnd: body.startDate, grid: { [dateKey]: slots } } });
    });

    renderWizard();
    await selectStudent("Maria Cruz — Academic Tutorial");
    fireEvent.click(screen.getByText("Mon"));
    const dateKey = await clickTheOnlyEligibleCalendarDay();

    const blockedSlot = await screen.findByTestId(`slot-${dateKey}-09:00`);
    expect(blockedSlot).toBeDisabled();
    expect(within(blockedSlot).getByText(/no available tutor/i)).toBeTruthy();

    const openSlot = screen.getByTestId(`slot-${dateKey}-10:00`);
    expect(openSlot).not.toBeDisabled();
  });

  it("a slot where at least one tutor is free shows EXACTLY those tutors when clicked, not every tutor in the system", async () => {
    getMonthlySlotGrid.mockImplementation((body: { days: number[]; startDate: string }) => {
      const dateKey = nextDateKeyForDay(body.startDate, 1);
      const slots = STANDARD_SLOT_TIMES.map(([s, e]) => slot(s, e, { tutors: [{ _id: "tutor-nicole", name: "Nicole Monzada" }] }));
      slots[1] = slot("09:00", "10:00", { tutors: [{ _id: "tutor-jake", name: "Jake Soriano" }] }); // only Jake, not Nicole
      return Promise.resolve({ data: { success: true, startDate: body.startDate, subscriptionEnd: body.startDate, grid: { [dateKey]: slots } } });
    });

    renderWizard();
    await selectStudent("Maria Cruz — Academic Tutorial");
    fireEvent.click(screen.getByText("Mon"));
    const dateKey = await clickTheOnlyEligibleCalendarDay();

    fireEvent.click(await screen.findByTestId(`slot-${dateKey}-09:00`));
    const picker = await screen.findByTestId(`tutor-picker-${dateKey}`);
    expect(within(picker).getByRole("button", { name: "Jake Soriano" })).toBeTruthy();
    expect(within(picker).queryByRole("button", { name: "Nicole Monzada" })).toBeNull();
  });

  it("picking the shown tutor assigns them to that day, and the assignment is visible", async () => {
    renderWizard();
    await selectStudent("Maria Cruz — Academic Tutorial");
    fireEvent.click(screen.getByText("Mon"));
    const dateKey = await clickTheOnlyEligibleCalendarDay();

    fireEvent.click(await screen.findByTestId(`slot-${dateKey}-09:00`));
    const picker = await screen.findByTestId(`tutor-picker-${dateKey}`);
    fireEvent.click(within(picker).getByRole("button", { name: "Nicole Monzada" }));

    expect(await screen.findByText(/Nicole Monzada/)).toBeTruthy();
  });

  it("picking DIFFERENT tutors for different days produces the correct separate per-day assignments — in both the check call and the final generate payload", async () => {
    getMonthlySlotGrid.mockImplementation(gridResponderFor({
      1: [{ _id: "tutor-nicole", name: "Nicole Monzada" }],
      3: [{ _id: "tutor-jake", name: "Jake Soriano" }],
    }));

    renderWizard();
    await selectStudent("Maria Cruz — Academic Tutorial");
    fireEvent.click(screen.getByText("Mon"));
    fireEvent.click(screen.getByText("Wed"));

    const calendar = await screen.findByTestId("slot-calendar");
    // Click each real eligible day in turn, assigning its tutor.
    const eligibleCells = within(calendar).getAllByTestId(/^calendar-day-/).filter((b) => !b.hasAttribute("disabled"));
    expect(eligibleCells.length).toBe(2);

    fireEvent.click(eligibleCells[0]);
    const firstDateKey = eligibleCells[0].getAttribute("data-testid")!.replace("calendar-day-", "");
    const firstDayOfWeek = new Date(`${firstDateKey}T00:00:00`).getDay();
    fireEvent.click(await screen.findByTestId(`slot-${firstDateKey}-09:00`));
    const firstPicker = await screen.findByTestId(`tutor-picker-${firstDateKey}`);
    const firstTutorName = firstDayOfWeek === 1 ? "Nicole Monzada" : "Jake Soriano";
    fireEvent.click(within(firstPicker).getByRole("button", { name: firstTutorName }));

    fireEvent.click(eligibleCells[1]);
    const secondDateKey = eligibleCells[1].getAttribute("data-testid")!.replace("calendar-day-", "");
    const secondDayOfWeek = new Date(`${secondDateKey}T00:00:00`).getDay();
    fireEvent.click(await screen.findByTestId(`slot-${secondDateKey}-09:00`));
    const secondPicker = await screen.findByTestId(`tutor-picker-${secondDateKey}`);
    const secondTutorName = secondDayOfWeek === 1 ? "Nicole Monzada" : "Jake Soriano";
    fireEvent.click(within(secondPicker).getByRole("button", { name: secondTutorName }));

    await waitFor(() => expect(checkMonthly).toHaveBeenCalled());
    const lastCall = checkMonthly.mock.calls[checkMonthly.mock.calls.length - 1][0];
    const byDay = new Map(lastCall.daySlots.map((s: { dayOfWeek: number; tutorId: string }) => [s.dayOfWeek, s.tutorId]));
    expect(byDay.get(1)).toBe("tutor-nicole");
    expect(byDay.get(3)).toBe("tutor-jake");

    // Generate uses the exact same per-day payload.
    fireEvent.click(screen.getByRole("button", { name: /generate session slots/i }));
    await waitFor(() => expect(createMonthly).toHaveBeenCalled());
    const createArgs = createMonthly.mock.calls[0][0];
    const createByDay = new Map(createArgs.daySlots.map((s: { dayOfWeek: number; tutorId: string }) => [s.dayOfWeek, s.tutorId]));
    expect(createByDay.get(1)).toBe("tutor-nicole");
    expect(createByDay.get(3)).toBe("tutor-jake");
  });

  it("blocks a time slot that coincides with the student's own existing session (e.g. overlapping Toddlers Playgroup)", async () => {
    getMonthlySlotGrid.mockImplementation((body: { days: number[]; startDate: string }) => {
      const dateKey = nextDateKeyForDay(body.startDate, 1);
      const slots = STANDARD_SLOT_TIMES.map(([s, e]) => slot(s, e, { tutors: [{ _id: "tutor-nicole", name: "Nicole Monzada" }] }));
      slots[1] = slot("09:00", "10:00", { available: false, tutors: [], reason: "The student already has a conflicting session at this time." });
      return Promise.resolve({ data: { success: true, startDate: body.startDate, subscriptionEnd: body.startDate, grid: { [dateKey]: slots } } });
    });

    renderWizard();
    await selectStudent("Maria Cruz — Academic Tutorial");
    fireEvent.click(screen.getByText("Mon"));
    const dateKey = await clickTheOnlyEligibleCalendarDay();

    const blockedSlot = await screen.findByTestId(`slot-${dateKey}-09:00`);
    expect(blockedSlot).toBeDisabled();
    expect(blockedSlot.getAttribute("title")).toMatch(/already has a conflicting session/i);
  });

  it("re-fetches the grid live when a 'schedule:changed' realtime event fires, with no manual refresh", async () => {
    renderWizard();
    await selectStudent("Maria Cruz — Academic Tutorial");
    fireEvent.click(screen.getByText("Mon"));
    const dateKey = await clickTheOnlyEligibleCalendarDay();
    await screen.findByTestId(`slot-${dateKey}-09:00`);

    expect(getMonthlySlotGrid).toHaveBeenCalledTimes(1);

    getMonthlySlotGrid.mockImplementation((body: { days: number[]; startDate: string }) => {
      const key = nextDateKeyForDay(body.startDate, 1);
      const slots = STANDARD_SLOT_TIMES.map(([s, e]) => slot(s, e, { tutors: [{ _id: "tutor-nicole", name: "Nicole Monzada" }] }));
      slots[1] = slot("09:00", "10:00", { available: false, tutors: [], reason: "No available tutor for this time." });
      return Promise.resolve({ data: { success: true, startDate: body.startDate, subscriptionEnd: body.startDate, grid: { [key]: slots } } });
    });

    window.dispatchEvent(new Event(REALTIME_EVENTS.SCHEDULE_CHANGED));

    await waitFor(() => expect(screen.getByTestId(`slot-${dateKey}-09:00`)).toBeDisabled());
  });
});

/**
 * Bug report: the "Starting date" field at the top of the calendar step stayed fixed at
 * whatever it was originally set to, even after the admin assigned a tutor to a later
 * real day instead. Fix: Starting date must always reflect the EARLIEST real day that
 * currently has a tutor assigned — before any assignment exists it stays untouched, it
 * updates to the first assigned day (even if that's not the original starting date), and
 * it moves back again if an earlier day is assigned afterward. The underlying weekday
 * selection, required day count, and per-day tutor assignment payloads are untouched —
 * covered already by the tests above; these only check the displayed field value.
 */
describe("OneOnOneSchedulingWizard: Starting date tracks the earliest actually-assigned day", () => {
  function startDateInput() {
    return screen.getByLabelText(/starting date/i) as HTMLInputElement;
  }

  it("does not change the Starting date before any tutor assignment exists", async () => {
    renderWizard();
    await selectStudent("Maria Cruz — Academic Tutorial");

    const initialValue = startDateInput().value;
    expect(initialValue).toBeTruthy();

    fireEvent.click(screen.getByText("Mon"));
    const calendar = await screen.findByTestId("slot-calendar");
    for (const label of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      expect(within(calendar).getByText(label)).toBeTruthy();
    }
    await clickTheOnlyEligibleCalendarDay();

    // A day is chosen and even focused for picking, but no tutor has been assigned yet —
    // the field must still read exactly what it started as.
    expect(startDateInput().value).toBe(initialValue);
  });

  it("updates the Starting date to match the first assigned day, even when it isn't the original starting date", async () => {
    const todayKey = toDateKey(new Date());
    const laterDay = nextDateKeyForDay(todayKey, 1) >= nextDateKeyForDay(todayKey, 4) ? 1 : 4;
    const earlierDay = laterDay === 1 ? 4 : 1;
    const laterDateKey = nextDateKeyForDay(todayKey, laterDay);
    const earlierDateKey = nextDateKeyForDay(todayKey, earlierDay);
    expect(laterDateKey > earlierDateKey).toBe(true);

    getMonthlySlotGrid.mockImplementation(gridResponderFor({
      [laterDay]: [{ _id: "tutor-nicole", name: "Nicole Monzada" }],
      [earlierDay]: [{ _id: "tutor-jake", name: "Jake Soriano" }],
    }));

    renderWizard();
    await selectStudent("Maria Cruz — Academic Tutorial");
    const originalStartDate = startDateInput().value;
    fireEvent.click(screen.getByText(laterDay === 1 ? "Mon" : "Thu"));
    fireEvent.click(screen.getByText(earlierDay === 1 ? "Mon" : "Thu"));

    // Skip the (admin) "later day" first — assign only the LATER real date.
    const laterCell = await screen.findByTestId(`calendar-day-${laterDateKey}`);
    fireEvent.click(laterCell);
    fireEvent.click(await screen.findByTestId(`slot-${laterDateKey}-09:00`));
    const laterPicker = await screen.findByTestId(`tutor-picker-${laterDateKey}`);
    fireEvent.click(within(laterPicker).getByRole("button", { name: "Nicole Monzada" }));

    expect(startDateInput().value).toBe(laterDateKey);
    expect(startDateInput().value).not.toBe(originalStartDate);
  });

  it("moves the Starting date back when an earlier day is assigned afterward (after the admin moves Starting date back to unlock it)", async () => {
    const todayKey = toDateKey(new Date());
    const laterDay = nextDateKeyForDay(todayKey, 1) >= nextDateKeyForDay(todayKey, 4) ? 1 : 4;
    const earlierDay = laterDay === 1 ? 4 : 1;
    const laterDateKey = nextDateKeyForDay(todayKey, laterDay);
    const earlierDateKey = nextDateKeyForDay(todayKey, earlierDay);

    getMonthlySlotGrid.mockImplementation(gridResponderFor({
      [laterDay]: [{ _id: "tutor-nicole", name: "Nicole Monzada" }],
      [earlierDay]: [{ _id: "tutor-jake", name: "Jake Soriano" }],
    }));

    renderWizard();
    await selectStudent("Maria Cruz — Academic Tutorial");
    fireEvent.click(screen.getByText(laterDay === 1 ? "Mon" : "Thu"));
    fireEvent.click(screen.getByText(earlierDay === 1 ? "Mon" : "Thu"));

    // Assign the later day first — Starting date moves to it, which now locks out the
    // earlier real date (see the dedicated eligibility describe block below) — so the
    // admin moves Starting date back to it directly before it can be clicked again.
    const laterCell = await screen.findByTestId(`calendar-day-${laterDateKey}`);
    fireEvent.click(laterCell);
    fireEvent.click(await screen.findByTestId(`slot-${laterDateKey}-09:00`));
    const laterPicker = await screen.findByTestId(`tutor-picker-${laterDateKey}`);
    fireEvent.click(within(laterPicker).getByRole("button", { name: "Nicole Monzada" }));
    expect(startDateInput().value).toBe(laterDateKey);

    fireEvent.change(startDateInput(), { target: { value: earlierDateKey } });
    const earlierCell = await screen.findByTestId(`calendar-day-${earlierDateKey}`);
    expect(earlierCell).not.toBeDisabled();
    fireEvent.click(earlierCell);
    fireEvent.click(await screen.findByTestId(`slot-${earlierDateKey}-09:00`));
    const earlierPicker = await screen.findByTestId(`tutor-picker-${earlierDateKey}`);
    fireEvent.click(within(earlierPicker).getByRole("button", { name: "Jake Soriano" }));

    // Now the earlier day is the earliest assignment — Starting date stays at it.
    expect(startDateInput().value).toBe(earlierDateKey);
  });
});

/**
 * Follow-up bug report: after Starting date auto-advances to the earliest assigned day,
 * earlier real days (still present in the already-fetched grid, by design — see the
 * describe block above) kept showing as open/selectable instead of locking out like days
 * before the ORIGINAL starting date always did. Fix: a calendar day is only selectable
 * when it's on/after the CURRENT Starting date, recomputed on every render directly from
 * `startDate` — no separate state to keep in sync. A locked-out day becomes selectable
 * again the moment Starting date moves back on/before it (today, that only happens via
 * the admin editing the Starting date field directly, which is also what re-enables the
 * day before assigning it a tutor — see the test above). This must not affect days
 * already grayed out for other reasons (wrong weekday, full slots, tutor conflicts) —
 * those still come from the day being absent from `grid` entirely, untouched here.
 */
describe("OneOnOneSchedulingWizard: calendar day eligibility locks out days before the current Starting date", () => {
  function startDateInput() {
    return screen.getByLabelText(/starting date/i) as HTMLInputElement;
  }

  async function setup() {
    const todayKey = toDateKey(new Date());
    const laterDay = nextDateKeyForDay(todayKey, 1) >= nextDateKeyForDay(todayKey, 4) ? 1 : 4;
    const earlierDay = laterDay === 1 ? 4 : 1;
    const laterDateKey = nextDateKeyForDay(todayKey, laterDay);
    const earlierDateKey = nextDateKeyForDay(todayKey, earlierDay);

    getMonthlySlotGrid.mockImplementation(gridResponderFor({
      [laterDay]: [{ _id: "tutor-nicole", name: "Nicole Monzada" }],
      [earlierDay]: [{ _id: "tutor-jake", name: "Jake Soriano" }],
    }));

    renderWizard();
    await selectStudent("Maria Cruz — Academic Tutorial");
    fireEvent.click(screen.getByText(laterDay === 1 ? "Mon" : "Thu"));
    fireEvent.click(screen.getByText(earlierDay === 1 ? "Mon" : "Thu"));

    const laterCell = await screen.findByTestId(`calendar-day-${laterDateKey}`);
    fireEvent.click(laterCell);
    fireEvent.click(await screen.findByTestId(`slot-${laterDateKey}-09:00`));
    const laterPicker = await screen.findByTestId(`tutor-picker-${laterDateKey}`);
    fireEvent.click(within(laterPicker).getByRole("button", { name: "Nicole Monzada" }));
    // Starting date is now the later date — the earlier date is before it.
    expect(startDateInput().value).toBe(laterDateKey);

    return { laterDateKey, earlierDateKey };
  }

  it("a day before the current Starting date is grayed out and not selectable, even though it's still in the fetched grid", async () => {
    const { earlierDateKey } = await setup();

    const earlierCell = await screen.findByTestId(`calendar-day-${earlierDateKey}`);
    expect(earlierCell).toBeDisabled();

    // Clicking it does nothing — no detail panel opens for it.
    fireEvent.click(earlierCell);
    expect(screen.queryByTestId(`slot-${earlierDateKey}-09:00`)).toBeNull();
  });

  it("the locked-out day becomes selectable again once Starting date moves back to on/before it", async () => {
    const { earlierDateKey } = await setup();
    const earlierCellBefore = await screen.findByTestId(`calendar-day-${earlierDateKey}`);
    expect(earlierCellBefore).toBeDisabled();

    fireEvent.change(startDateInput(), { target: { value: earlierDateKey } });

    const earlierCellAfter = await screen.findByTestId(`calendar-day-${earlierDateKey}`);
    expect(earlierCellAfter).not.toBeDisabled();
    fireEvent.click(earlierCellAfter);
    expect(await screen.findByTestId(`slot-${earlierDateKey}-09:00`)).toBeTruthy();
  });

  it("stays correct as the Starting date changes multiple times in a row", async () => {
    const { laterDateKey, earlierDateKey } = await setup();

    // 1. Locked out (Starting date = laterDateKey, set up above).
    expect(await screen.findByTestId(`calendar-day-${earlierDateKey}`)).toBeDisabled();

    // 2. Move back — unlocked.
    fireEvent.change(startDateInput(), { target: { value: earlierDateKey } });
    expect(await screen.findByTestId(`calendar-day-${earlierDateKey}`)).not.toBeDisabled();

    // 3. Move forward again — locked out again.
    fireEvent.change(startDateInput(), { target: { value: laterDateKey } });
    expect(await screen.findByTestId(`calendar-day-${earlierDateKey}`)).toBeDisabled();
    // The later date itself is always on/after Starting date, so it stays selectable throughout.
    expect(await screen.findByTestId(`calendar-day-${laterDateKey}`)).not.toBeDisabled();

    // 4. Move back once more — unlocked again.
    fireEvent.change(startDateInput(), { target: { value: earlierDateKey } });
    expect(await screen.findByTestId(`calendar-day-${earlierDateKey}`)).not.toBeDisabled();
  });
});
