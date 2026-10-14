import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { AttendanceCard, type AttendanceHistoryEntry } from "@/components/dashboard/AttendanceCard";

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

// Progress page Attendance card bug fix — a child with zero sessions used to make the
// WHOLE card vanish (StudentDashboard.tsx gated it on attendanceStats.percent != null).
// It must now always render, showing a 0%/"0 of 0 sessions" empty state instead.
describe("AttendanceCard: never disappears, even with zero sessions", () => {
  it("renders the empty state (0%, 0 of 0 sessions) instead of vanishing", () => {
    render(<AttendanceCard stats={EMPTY_STATS} byProgram={[]} history={[]} />);
    expect(screen.getByText("Attendance")).toBeTruthy();
    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByText(/overall: present at 0 of 0 sessions/i)).toBeTruthy();
    expect(screen.getByText(/no sessions scheduled yet/i)).toBeTruthy();
  });

  it("renders real percentages and per-program bars when sessions exist", () => {
    render(
      <AttendanceCard
        stats={SOME_STATS}
        byProgram={[{ label: "Academic Tutorial", total: 10, present: 8, percent: 80 }]}
        history={HISTORY}
      />
    );
    expect(screen.getByText("80%")).toBeTruthy();
    expect(screen.getByText(/overall: present at 8 of 10 sessions/i)).toBeTruthy();
  });
});

// Regression coverage for the reported bug: the front face must NEVER carry a scroll
// container, and must render at its natural size — not be forced into a fixed-height
// box with the dual-stacked-faces approach that broke it.
describe("AttendanceCard: front face has no forced height or scrollbar", () => {
  it("the front face's outermost card element has no overflow-y-auto class", () => {
    render(<AttendanceCard stats={SOME_STATS} byProgram={[]} history={HISTORY} />);
    const card = screen.getByText("Attendance").closest(".rounded-2xl") as HTMLElement;
    expect(card.className).not.toMatch(/overflow-y-auto/);
    expect(card.className).not.toMatch(/min-h-/);
  });

  it("only the back face's program list scrolls, capped to a bounded height — not the whole back face", () => {
    render(<AttendanceCard stats={SOME_STATS} byProgram={[]} history={HISTORY} />);
    flipClick(/history/i);

    const listContainer = screen.getByText("Academic Tutorial").closest(".space-y-2") as HTMLElement;
    expect(listContainer.className).toMatch(/overflow-y-auto/);
    expect(listContainer.className).toMatch(/max-h-/);

    const backCard = screen.getByText("Program History").closest(".rounded-2xl") as HTMLElement;
    expect(backCard.className).not.toMatch(/overflow-y-auto/);
  });
});

describe("AttendanceCard: click-to-flip Program History", () => {
  it("starts on the front face; clicking History flips to the back, listing every program with start/end dates", () => {
    render(<AttendanceCard stats={SOME_STATS} byProgram={[]} history={HISTORY} />);
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
    render(<AttendanceCard stats={SOME_STATS} byProgram={[]} history={HISTORY} />);
    flipClick(/history/i);
    expect(screen.getByText("Program History")).toBeTruthy();

    flipClick(/^back$/i);
    expect(screen.queryByText("Program History")).toBeNull();
    expect(screen.getByText("Overall: present at 8 of 10 sessions")).toBeTruthy();
  });

  it("shows an empty state on the back face when no programs have ever been availed", () => {
    render(<AttendanceCard stats={EMPTY_STATS} byProgram={[]} history={[]} />);
    flipClick(/history/i);
    expect(screen.getByText(/no programs availed yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^export$/i })).toBeDisabled();
  });

  // Strict per-child scoping: a parent switching "Viewing child" must never see a
  // previous child's flipped state or data. The caller mounts this component with
  // key={<child id>} specifically so React remounts (not just re-renders) on switch —
  // verified here the same way: a fresh mount always starts on the front face.
  it("a fresh mount (simulating a switch to a different child) always starts back on the front face", () => {
    const { unmount } = render(<AttendanceCard stats={SOME_STATS} byProgram={[]} history={HISTORY} />);
    flipClick(/history/i);
    expect(screen.getByText("Program History")).toBeTruthy();
    unmount();

    render(<AttendanceCard stats={EMPTY_STATS} byProgram={[]} history={[]} />);
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

describe("AttendanceCard: CSV export", () => {
  it("the overall 'Export' button (label, not 'Export CSV') exports every program with the required columns", () => {
    const spy = spyOnCsvDownload();
    render(<AttendanceCard stats={SOME_STATS} byProgram={[]} history={HISTORY} childLabel="Alex Soriano" />);
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
    render(<AttendanceCard stats={SOME_STATS} byProgram={[]} history={HISTORY} childLabel="Alex Soriano" />);
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
