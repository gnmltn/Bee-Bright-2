import { describe, it, expect } from "vitest";
import { isProgramInProgress, hasProgramEndRange, formatProgramEndRange, formatDateRangeOnly, formatProgramLabelWithRange } from "@/lib/programEndDate";

describe("isProgramInProgress", () => {
  it("'approved' and 'active' count as in progress — same set aiController.js's RENEW_PROGRAM_BLOCKING_STATUSES uses", () => {
    expect(isProgramInProgress("approved")).toBe(true);
    expect(isProgramInProgress("active")).toBe(true);
  });

  it("'completed', 'rejected', 'cancelled', and undefined are NOT in progress", () => {
    expect(isProgramInProgress("completed")).toBe(false);
    expect(isProgramInProgress("rejected")).toBe(false);
    expect(isProgramInProgress("cancelled")).toBe(false);
    expect(isProgramInProgress(undefined)).toBe(false);
  });
});

describe("hasProgramEndRange / formatProgramEndRange / formatDateRangeOnly", () => {
  it("false/null when the package has no endDate yet (not fully scheduled) — never a premature guess", () => {
    const pkg = { displayName: "Toddlers Playgroup – 16 Hours", startDate: "2026-10-17T00:00:00.000Z", endDate: null };
    expect(hasProgramEndRange(pkg)).toBe(false);
    expect(formatProgramEndRange(pkg)).toBeNull();
    expect(formatDateRangeOnly(pkg)).toBeNull();
  });

  it("false/null when there's no startDate either (never scheduled at all)", () => {
    expect(hasProgramEndRange({})).toBe(false);
    expect(formatProgramEndRange({})).toBeNull();
  });

  it("formats the full line once both dates exist", () => {
    const pkg = { displayName: "Toddlers Playgroup – 16 Hours", startDate: "2026-10-17T00:00:00.000Z", endDate: "2026-11-26T00:00:00.000Z" };
    expect(hasProgramEndRange(pkg)).toBe(true);
    expect(formatProgramEndRange(pkg)).toBe("Toddlers Playgroup – 16 Hours · Oct 17 to Nov 26, 2026");
  });

  it("formatDateRangeOnly gives just the date portion, for callers that already show the program name separately", () => {
    const pkg = { displayName: "Academic Tutorial", startDate: "2026-10-17T00:00:00.000Z", endDate: "2026-11-26T00:00:00.000Z" };
    expect(formatDateRangeOnly(pkg)).toBe("Oct 17 to Nov 26, 2026");
  });

  it("falls back to a generic name when displayName is missing", () => {
    const pkg = { startDate: "2026-10-17T00:00:00.000Z", endDate: "2026-11-26T00:00:00.000Z" };
    expect(formatProgramEndRange(pkg)).toBe("Program · Oct 17 to Nov 26, 2026");
  });

  it("shows BOTH years when the range spans a calendar year boundary", () => {
    const pkg = { displayName: "X", startDate: "2026-12-20T00:00:00.000Z", endDate: "2027-01-15T00:00:00.000Z" };
    expect(formatDateRangeOnly(pkg)).toBe("Dec 20, 2026 to Jan 15, 2027");
  });
});

// Tutor Dashboard "My Students" cards — one program per card, each with its own
// independent range (a multi-program child gets a separate range per program, and a
// completed program's range disappears while the card's other, still-active program
// keeps showing theirs — the card itself never disappears here, since that's a
// per-program concern, not a per-card one).
describe("formatProgramLabelWithRange (Tutor Dashboard My Students cards)", () => {
  it("appends the range when the program is in progress and fully scheduled", () => {
    const pkg = { displayName: "Academic Tutorial", startDate: "2026-10-17T00:00:00.000Z", endDate: "2026-11-26T00:00:00.000Z", status: "approved" };
    expect(formatProgramLabelWithRange(pkg)).toBe("Academic Tutorial · Oct 17 to Nov 26, 2026");
  });

  it("two programs on the same card each get their own independent range", () => {
    const playgroup = { displayName: "Toddlers Playgroup – 16 Hours", startDate: "2026-09-01T00:00:00.000Z", endDate: "2026-10-13T00:00:00.000Z", status: "active" };
    const academic = { displayName: "Academic Tutorial", startDate: "2026-10-17T00:00:00.000Z", endDate: "2026-11-26T00:00:00.000Z", status: "approved" };
    expect(formatProgramLabelWithRange(playgroup)).toBe("Toddlers Playgroup – 16 Hours · Sep 1 to Oct 13, 2026");
    expect(formatProgramLabelWithRange(academic)).toBe("Academic Tutorial · Oct 17 to Nov 26, 2026");
  });

  it("omits the range once that specific program's status is no longer in progress (e.g. completed) — just the plain name", () => {
    const pkg = { displayName: "Toddlers Playgroup – 16 Hours", startDate: "2026-09-01T00:00:00.000Z", endDate: "2026-10-13T00:00:00.000Z", status: "completed" };
    expect(formatProgramLabelWithRange(pkg)).toBe("Toddlers Playgroup – 16 Hours");
  });

  it("omits the range while the program isn't fully scheduled yet, even if still in progress", () => {
    const pkg = { displayName: "Academic Tutorial", startDate: "2026-10-17T00:00:00.000Z", endDate: null, status: "approved" };
    expect(formatProgramLabelWithRange(pkg)).toBe("Academic Tutorial");
  });

  it("falls back to a generic name when displayName is missing", () => {
    expect(formatProgramLabelWithRange({ status: "approved" })).toBe("Program");
  });
});
