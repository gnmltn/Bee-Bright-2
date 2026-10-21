import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { AttendanceCard, type AttendanceHistoryEntry, type AttendanceCalendarSession } from "@/components/dashboard/AttendanceCard";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const EMPTY_STATS = { total: 0, present: 0, percent: null };
const SOME_STATS = { total: 10, present: 8, percent: 80 };

const HISTORY: AttendanceHistoryEntry[] = [
  { label: "Academic Tutorial", startDate: "2026-01-05", endDate: "2026-03-20", ongoing: false, total: 10, present: 8, percent: 80 },
  { label: "Toddlers Playgroup", startDate: "2026-04-01", endDate: "2026-10-10", ongoing: true, total: 6, present: 6, percent: 100 },
];

// Content is swapped at the rotation MIDPOINT (half of the 500ms transition), not at
// the click itself, so the flip never flashes a backwards/mirrored face — tests need to
// advance past that to see the other face.
function flipClick(name: RegExp) {
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name }));
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

/** Local YYYY-MM-DD N days before today — matches AttendanceCalendarSession.date's own
 *  format (same convention as attendanceTab.test.tsx's own daysAgoDateStr). */
function daysAgoDateStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The day-of-month number for a YYYY-MM-DD key, read at local noon so no timezone
 *  conversion can shift it to the adjacent day. */
function dayOfMonthFor(dateKey: string): number {
  return new Date(`${dateKey}T12:00:00`).getDate();
}

/** Mirrors the component's own formatSelectedDate(), for asserting the date heading text. */
function formatSelectedDateFor(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

// Progress page Attendance card bug fix — a child with zero sessions used to make the
// WHOLE card vanish (StudentDashboard.tsx gated it on attendanceStats.percent != null).
// It must now always render, showing a 0%/"0 of 0 sessions" empty state instead.
describe("AttendanceCard: never disappears, even with zero sessions", () => {
  it("renders the empty state (0%, 0 of 0 sessions) instead of vanishing", () => {
    render(<AttendanceCard stats={EMPTY_STATS} sessions={[]} history={[]} />);
    expect(screen.getByText("Attendance")).toBeTruthy();
    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByText(/overall: present at 0 of 0 sessions/i)).toBeTruthy();
    // No session fell on today (the calendar's default selected day) — an honest empty
    // state for that day, not a vanished card.
    expect(screen.getByText(/no session on this date/i)).toBeTruthy();
  });

  it("renders the real overall percentage when sessions exist", () => {
    render(<AttendanceCard stats={SOME_STATS} sessions={[]} history={HISTORY} />);
    expect(screen.getByText("80%")).toBeTruthy();
    expect(screen.getByText(/overall: present at 8 of 10 sessions/i)).toBeTruthy();
  });
});

// Regression coverage for the reported bug: the front face must NEVER carry a scroll
// container, and must render at its natural size — not be forced into a fixed-height
// box with the dual-stacked-faces approach that broke it.
describe("AttendanceCard: front face has no forced height or scrollbar", () => {
  it("the front face's outermost card element has no overflow-y-auto class", () => {
    render(<AttendanceCard stats={SOME_STATS} sessions={[]} history={HISTORY} />);
    const card = screen.getByText("Attendance").closest(".rounded-2xl") as HTMLElement;
    expect(card.className).not.toMatch(/overflow-y-auto/);
    expect(card.className).not.toMatch(/min-h-/);
  });

  it("only the back face's program list scrolls, capped to a bounded height — not the whole back face", () => {
    render(<AttendanceCard stats={SOME_STATS} sessions={[]} history={HISTORY} />);
    flipClick(/history/i);

    const listContainer = screen.getByText("Academic Tutorial").closest(".space-y-2") as HTMLElement;
    expect(listContainer.className).toMatch(/overflow-y-auto/);
    expect(listContainer.className).toMatch(/max-h-/);

    const backCard = screen.getByText("Program History").closest(".rounded-2xl") as HTMLElement;
    expect(backCard.className).not.toMatch(/overflow-y-auto/);
  });
});

describe("AttendanceCard: click-to-flip Program History (unchanged — still the per-program breakdown)", () => {
  it("starts on the front face; clicking History flips to the back, listing every program with start/end dates", () => {
    render(<AttendanceCard stats={SOME_STATS} sessions={[]} history={HISTORY} />);
    expect(screen.queryByText("Program History")).toBeNull();

    flipClick(/history/i);

    expect(screen.queryByText("Attendance")).toBeNull();
    expect(screen.getByText("Program History")).toBeTruthy();
    expect(screen.getByText("Academic Tutorial")).toBeTruthy();
    expect(screen.getByText(/jan 5, 2026.*mar 20, 2026/i)).toBeTruthy();
    expect(screen.getByText("Toddlers Playgroup")).toBeTruthy();
    // Still-active program shows "Ongoing" instead of an end date.
    expect(screen.getByText(/apr 1, 2026.*ongoing/i)).toBeTruthy();
  });

  it("Back returns to the front face", () => {
    render(<AttendanceCard stats={SOME_STATS} sessions={[]} history={HISTORY} />);
    flipClick(/history/i);
    expect(screen.getByText("Program History")).toBeTruthy();

    flipClick(/^back$/i);
    expect(screen.queryByText("Program History")).toBeNull();
    expect(screen.getByText("Overall: present at 8 of 10 sessions")).toBeTruthy();
  });

  it("shows an empty state on the back face when no programs have ever been availed", () => {
    render(<AttendanceCard stats={EMPTY_STATS} sessions={[]} history={[]} />);
    flipClick(/history/i);
    expect(screen.getByText(/no programs availed yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^export$/i })).toBeDisabled();
  });

  // Strict per-child scoping: a parent switching "Viewing child" must never see a
  // previous child's flipped state or data. The caller mounts this component with
  // key={<child id>} specifically so React remounts (not just re-renders) on switch —
  // verified here the same way: a fresh mount always starts on the front face.
  it("a fresh mount (simulating a switch to a different child) always starts back on the front face", () => {
    const { unmount } = render(<AttendanceCard stats={SOME_STATS} sessions={[]} history={HISTORY} />);
    flipClick(/history/i);
    expect(screen.getByText("Program History")).toBeTruthy();
    unmount();

    render(<AttendanceCard stats={EMPTY_STATS} sessions={[]} history={[]} />);
    expect(screen.queryByText("Program History")).toBeNull();
    expect(screen.getByText(/overall: present at 0 of 0 sessions/i)).toBeTruthy();
  });
});

// Spies on the Blob/URL/<a> download mechanics so a click's resulting CSV content can
// be inspected directly, without actually triggering a browser download.
function spyOnCsvDownload() {
  const blobParts: string[][] = [];
  const originalBlob = global.Blob;
  // @ts-expect-error - minimal stub sufficient for inspecting the CSV content built
  global.Blob = vi.fn((parts: string[]) => { blobParts.push(parts); return {}; });
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:fake-url"), revokeObjectURL: vi.fn() });
  const clickSpy = vi.fn();
  const downloadNames: string[] = [];
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = originalCreateElement(tag);
    if (tag === "a") {
      el.click = clickSpy;
      const anchor = el as HTMLAnchorElement;
      Object.defineProperty(anchor, "download", {
        set(v: string) { downloadNames.push(v); },
        get() { return downloadNames[downloadNames.length - 1] ?? ""; },
      });
    }
    return el;
  });
  return {
    clickSpy,
    lastCsv: () => blobParts[blobParts.length - 1]?.join("") ?? "",
    lastFilename: () => downloadNames[downloadNames.length - 1] ?? "",
    restore: () => { global.Blob = originalBlob; },
  };
}

describe("AttendanceCard: CSV export (back face, unchanged)", () => {
  it("the overall 'Export' button (label, not 'Export CSV') exports every program with the required columns", () => {
    const spy = spyOnCsvDownload();
    render(<AttendanceCard stats={SOME_STATS} sessions={[]} history={HISTORY} childLabel="Alex Soriano" />);
    flipClick(/history/i);

    const header = screen.getByText("Program History").closest("div") as HTMLElement;
    expect(within(header).queryByRole("button", { name: /export csv/i })).toBeNull();
    fireEvent.click(within(header).getByRole("button", { name: /^export$/i }));

    const csv = spy.lastCsv();
    expect(csv.split("\n")[0]).toBe("Program Name,Total Classes,Total Present,Attendance %");
    expect(csv).toContain("Academic Tutorial,10,8,80%");
    expect(csv).toContain("Toddlers Playgroup,6,6,100%");
    expect(csv).not.toMatch(/subject code/i);
    expect(csv).not.toMatch(/subject type/i);
    expect(spy.clickSpy).toHaveBeenCalledTimes(1);
    spy.restore();
  });

  it("each program row has its OWN 'Export' button that downloads just that one program, not the full list", () => {
    const spy = spyOnCsvDownload();
    render(<AttendanceCard stats={SOME_STATS} sessions={[]} history={HISTORY} childLabel="Alex Soriano" />);
    flipClick(/history/i);

    const row = screen.getByText("Academic Tutorial").closest(".rounded-lg") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /^export$/i }));

    const csv = spy.lastCsv();
    expect(csv.split("\n").filter(Boolean)).toEqual([
      "Program Name,Total Classes,Total Present,Attendance %",
      "Academic Tutorial,10,8,80%",
    ]);
    expect(csv).not.toContain("Toddlers Playgroup");
    expect(spy.lastFilename()).toMatch(/academic_tutorial/i);
    spy.restore();
  });
});

// The new front-face calendar (replacing the per-program breakdown bars, per explicit
// confirmation): each real session day is marked Present/Absent, and clicking a day
// shows that day's session detail (program, time, status) — scoped entirely to
// whatever `sessions` this component was given (the caller, StudentDashboard.tsx,
// already scopes that to getMyClasses(activeChildUserId) and already keeps it live via
// SCHEDULE_CHANGED — nothing new needed in this component for either).
describe("AttendanceCard: front-face calendar marks Present/Absent days", () => {
  it("marks a day with a present session success-styled, and a day with an absent session destructive-styled", () => {
    const presentDay = daysAgoDateStr(5);
    const absentDay = daysAgoDateStr(3);
    const todayDayNum = new Date().getDate();
    const presentDayNum = dayOfMonthFor(presentDay);
    const absentDayNum = dayOfMonthFor(absentDay);
    // Month-boundary safety, same tolerance convention used elsewhere in this suite.
    if (presentDayNum >= todayDayNum || absentDayNum >= todayDayNum) return;

    const sessions: AttendanceCalendarSession[] = [
      { date: presentDay, startTime: "09:00", endTime: "10:00", programLabel: "Academic Tutorial", status: "present" },
      { date: absentDay, startTime: "08:00", endTime: "09:00", programLabel: "Toddlers Playgroup", status: "absent" },
    ];
    render(<AttendanceCard stats={SOME_STATS} sessions={sessions} history={HISTORY} />);

    const presentCell = screen.getByRole("gridcell", { name: String(presentDayNum) });
    expect(presentCell.className).toMatch(/success/);
    const absentCell = screen.getByRole("gridcell", { name: String(absentDayNum) });
    expect(absentCell.className).toMatch(/destructive/);
  });

  it("a day with no session gets no Present/Absent marker", () => {
    const presentDay = daysAgoDateStr(5);
    const unmarkedDay = daysAgoDateStr(4);
    const todayDayNum = new Date().getDate();
    const presentDayNum = dayOfMonthFor(presentDay);
    const unmarkedDayNum = dayOfMonthFor(unmarkedDay);
    if (presentDayNum >= todayDayNum || unmarkedDayNum >= todayDayNum) return;

    const sessions: AttendanceCalendarSession[] = [
      { date: presentDay, startTime: "09:00", endTime: "10:00", programLabel: "Academic Tutorial", status: "present" },
    ];
    render(<AttendanceCard stats={SOME_STATS} sessions={sessions} history={HISTORY} />);

    const unmarkedCell = screen.getByRole("gridcell", { name: String(unmarkedDayNum) });
    expect(unmarkedCell.className).not.toMatch(/success/);
    expect(unmarkedCell.className).not.toMatch(/destructive/);
  });

  it("clicking a marked day shows that day's session detail — program, time, and status", () => {
    const presentDay = daysAgoDateStr(5);
    const todayDayNum = new Date().getDate();
    const presentDayNum = dayOfMonthFor(presentDay);
    if (presentDayNum >= todayDayNum) return;

    const sessions: AttendanceCalendarSession[] = [
      { date: presentDay, startTime: "09:00", endTime: "10:00", programLabel: "Academic Tutorial", status: "present" },
    ];
    render(<AttendanceCard stats={SOME_STATS} sessions={sessions} history={HISTORY} />);
    fireEvent.click(screen.getByRole("gridcell", { name: String(presentDayNum) }));

    const row = screen.getByText("Academic Tutorial").closest(".rounded-lg") as HTMLElement;
    expect(within(row).getByText(/9:00 AM.*10:00 AM/)).toBeTruthy();
    // Scoped to the row — "Present"/"Absent" also appear in the calendar's own legend.
    expect(within(row).getByText("Present")).toBeTruthy();
  });

  it("a day with an absent session shows the Absent status when clicked", () => {
    const absentDay = daysAgoDateStr(3);
    const todayDayNum = new Date().getDate();
    const absentDayNum = dayOfMonthFor(absentDay);
    if (absentDayNum >= todayDayNum) return;

    const sessions: AttendanceCalendarSession[] = [
      { date: absentDay, startTime: "08:00", endTime: "09:00", programLabel: "Toddlers Playgroup", status: "absent" },
    ];
    render(<AttendanceCard stats={SOME_STATS} sessions={sessions} history={HISTORY} />);
    fireEvent.click(screen.getByRole("gridcell", { name: String(absentDayNum) }));

    const row = screen.getByText("Toddlers Playgroup").closest(".rounded-lg") as HTMLElement;
    expect(within(row).getByText("Absent")).toBeTruthy();
  });

  it("selecting a day with no session shows an honest 'no session' message, not an error", () => {
    const presentDay = daysAgoDateStr(5);
    const emptyDay = daysAgoDateStr(2);
    const todayDayNum = new Date().getDate();
    const presentDayNum = dayOfMonthFor(presentDay);
    const emptyDayNum = dayOfMonthFor(emptyDay);
    if (presentDayNum >= todayDayNum || emptyDayNum >= todayDayNum) return;

    const sessions: AttendanceCalendarSession[] = [
      { date: presentDay, startTime: "09:00", endTime: "10:00", programLabel: "Academic Tutorial", status: "present" },
    ];
    render(<AttendanceCard stats={SOME_STATS} sessions={sessions} history={HISTORY} />);
    fireEvent.click(screen.getByRole("gridcell", { name: String(emptyDayNum) }));

    expect(screen.getByText(/no session on this date/i)).toBeTruthy();
  });

  // Component-level scoping: AttendanceCard itself must be a pure function of whatever
  // `sessions` it's given — the actual access-control scoping happens upstream
  // (StudentDashboard.tsx's getMyClasses(activeChildUserId)), so this proves the
  // component never shows anything beyond its own props, the same guarantee a switch
  // between two different real children relies on.
  it("only ever shows the data passed in `sessions` — switching to a different child's props shows ONLY that child's session, never a carried-over one", () => {
    const sharedDay = daysAgoDateStr(5);
    const todayDayNum = new Date().getDate();
    const sharedDayNum = dayOfMonthFor(sharedDay);
    if (sharedDayNum >= todayDayNum) return;

    const childASessions: AttendanceCalendarSession[] = [
      { date: sharedDay, startTime: "09:00", endTime: "10:00", programLabel: "Academic Tutorial", status: "present" },
    ];
    const { unmount } = render(<AttendanceCard key="child-a" stats={SOME_STATS} sessions={childASessions} history={HISTORY} />);
    fireEvent.click(screen.getByRole("gridcell", { name: String(sharedDayNum) }));
    expect(screen.getByText("Academic Tutorial")).toBeTruthy();
    unmount();

    const childBSessions: AttendanceCalendarSession[] = [
      { date: sharedDay, startTime: "08:00", endTime: "09:00", programLabel: "Toddlers Playgroup", status: "absent" },
    ];
    render(<AttendanceCard key="child-b" stats={SOME_STATS} sessions={childBSessions} history={HISTORY} />);
    fireEvent.click(screen.getByRole("gridcell", { name: String(sharedDayNum) }));
    expect(screen.getByText("Toddlers Playgroup")).toBeTruthy();
    expect(screen.queryByText("Academic Tutorial")).toBeNull();
  });
});

// The day-detail panel must also show WHO is assigned — a 1-on-1 session's single tutor,
// or every co-tutor on a Playgroup session — reusing the same comma-joined display name
// string the Schedule tab/Tutor Dashboard already build (formatClassTutorNames in
// StudentDashboard.tsx), without disturbing the time, date heading, or status badge.
describe("AttendanceCard: day-detail panel shows the assigned tutor(s)", () => {
  it("a 1-on-1 session shows its single assigned tutor's name next to the time", () => {
    const day = daysAgoDateStr(5);
    const todayDayNum = new Date().getDate();
    const dayNum = dayOfMonthFor(day);
    if (dayNum >= todayDayNum) return;

    const sessions: AttendanceCalendarSession[] = [
      { date: day, startTime: "09:00", endTime: "10:00", programLabel: "Academic Tutorial", status: "present", tutorName: "Nicole Monzada" },
    ];
    render(<AttendanceCard stats={SOME_STATS} sessions={sessions} history={HISTORY} />);
    fireEvent.click(screen.getByRole("gridcell", { name: String(dayNum) }));

    const row = screen.getByText("Academic Tutorial").closest(".rounded-lg") as HTMLElement;
    expect(within(row).getByText(/9:00 AM.*10:00 AM.*Nicole Monzada/)).toBeTruthy();
    // Status badge and date heading stay exactly as before.
    expect(within(row).getByText("Present")).toBeTruthy();
    expect(screen.getByText(formatSelectedDateFor(day))).toBeTruthy();
  });

  it("a Toddlers Playgroup session with multiple co-tutors shows all of them, not just one", () => {
    const day = daysAgoDateStr(3);
    const todayDayNum = new Date().getDate();
    const dayNum = dayOfMonthFor(day);
    if (dayNum >= todayDayNum) return;

    const sessions: AttendanceCalendarSession[] = [
      { date: day, startTime: "08:00", endTime: "09:00", programLabel: "Toddlers Playgroup", status: "absent", tutorName: "Nicole Monzada, Juan Dela Cruz" },
    ];
    render(<AttendanceCard stats={SOME_STATS} sessions={sessions} history={HISTORY} />);
    fireEvent.click(screen.getByRole("gridcell", { name: String(dayNum) }));

    const row = screen.getByText("Toddlers Playgroup").closest(".rounded-lg") as HTMLElement;
    expect(within(row).getByText(/Nicole Monzada, Juan Dela Cruz/)).toBeTruthy();
    expect(within(row).getByText("Absent")).toBeTruthy();
  });

  it("shows the tutor name regardless of status — unmarked, present, and absent all keep it", () => {
    const presentDay = daysAgoDateStr(10);
    const absentDay = daysAgoDateStr(9);
    const unmarkedDay = daysAgoDateStr(1);
    const todayDayNum = new Date().getDate();
    const presentDayNum = dayOfMonthFor(presentDay);
    const absentDayNum = dayOfMonthFor(absentDay);
    const unmarkedDayNum = dayOfMonthFor(unmarkedDay);
    if (presentDayNum >= todayDayNum || absentDayNum >= todayDayNum || unmarkedDayNum >= todayDayNum) return;

    const sessions: AttendanceCalendarSession[] = [
      { date: presentDay, startTime: "09:00", endTime: "10:00", programLabel: "Academic Tutorial", status: "present", tutorName: "Nicole Monzada" },
      { date: absentDay, startTime: "08:00", endTime: "09:00", programLabel: "Examination Preparation", status: "absent", tutorName: "Juan Dela Cruz" },
      { date: unmarkedDay, startTime: "14:00", endTime: "15:00", programLabel: "Academic Tutorial", status: "unmarked", tutorName: "Nicole Monzada" },
    ];
    render(<AttendanceCard stats={SOME_STATS} sessions={sessions} history={HISTORY} />);

    fireEvent.click(screen.getByRole("gridcell", { name: String(presentDayNum) }));
    expect(within(screen.getByText("Academic Tutorial").closest(".rounded-lg") as HTMLElement).getByText(/Nicole Monzada/)).toBeTruthy();

    fireEvent.click(screen.getByRole("gridcell", { name: String(absentDayNum) }));
    expect(within(screen.getByText("Examination Preparation").closest(".rounded-lg") as HTMLElement).getByText(/Juan Dela Cruz/)).toBeTruthy();

    fireEvent.click(screen.getByRole("gridcell", { name: String(unmarkedDayNum) }));
    const unmarkedRow = screen.getByText("Academic Tutorial").closest(".rounded-lg") as HTMLElement;
    expect(within(unmarkedRow).getByText(/Nicole Monzada/)).toBeTruthy();
    expect(within(unmarkedRow).getByText("Not yet marked")).toBeTruthy();
  });

  it("falls back to no tutor line at all when no tutor is assigned (\"—\"), without breaking the time line", () => {
    const day = daysAgoDateStr(5);
    const todayDayNum = new Date().getDate();
    const dayNum = dayOfMonthFor(day);
    if (dayNum >= todayDayNum) return;

    const sessions: AttendanceCalendarSession[] = [
      { date: day, startTime: "09:00", endTime: "10:00", programLabel: "Academic Tutorial", status: "present", tutorName: "—" },
    ];
    render(<AttendanceCard stats={SOME_STATS} sessions={sessions} history={HISTORY} />);
    fireEvent.click(screen.getByRole("gridcell", { name: String(dayNum) }));

    const row = screen.getByText("Academic Tutorial").closest(".rounded-lg") as HTMLElement;
    expect(within(row).getByText("9:00 AM – 10:00 AM")).toBeTruthy();
  });
});
