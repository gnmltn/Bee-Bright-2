/**
 * Admin Reports page — Export's two-step picker (dataset, then time range —
 * handleExportDataset's filtering/CSV building) and Generate Report's month/week picker
 * (getCalendarWeeksInMonth's Monday-Sunday calendar math, including clipped partial
 * weeks at a month's start/end). Generate Report's own picker is untouched by the Export
 * rework; both still share MonthOption/monthKey/monthLabel/dateInMonth.
 */
import { describe, it, expect, vi } from "vitest";
import {
  getCalendarWeeksInMonth,
  dateInMonth,
  dateInYear,
  monthKey,
  monthLabel,
  sameCalendarDay,
  handleExportDataset,
  type MonthOption,
} from "@/pages/AdminDashboard";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("getCalendarWeeksInMonth", () => {
  it("October 2026 (starts Thursday, ends Saturday) — partial weeks clipped, middle weeks real Mon-Sun", () => {
    // Oct 1 2026 is a Thursday; Oct 31 2026 is a Saturday.
    const weeks = getCalendarWeeksInMonth(2026, 9); // month is 0-indexed: 9 = October
    expect(weeks[0].weekStart.getDate()).toBe(1); // clipped to the 1st, not the preceding Monday
    expect(weeks[0].weekEnd.getDate()).toBe(4); // Sunday Oct 4
    // Middle weeks are real Monday-Sunday, 7 days each.
    expect(weeks[1].weekStart.getDate()).toBe(5);
    expect(weeks[1].weekStart.getDay()).toBe(1); // Monday
    expect(weeks[1].weekEnd.getDate()).toBe(11);
    expect(weeks[1].weekEnd.getDay()).toBe(0); // Sunday
    expect(weeks[2].weekStart.getDate()).toBe(12);
    expect(weeks[2].weekEnd.getDate()).toBe(18);
    // Last week is clipped to the 31st (a Saturday), not extended into November.
    const last = weeks[weeks.length - 1];
    expect(last.weekEnd.getDate()).toBe(31);
    expect(last.weekEnd.getMonth()).toBe(9);
    // No week start/end ever escapes into an adjacent month.
    weeks.forEach((w) => {
      expect(w.weekStart.getMonth()).toBe(9);
      expect(w.weekEnd.getMonth()).toBe(9);
    });
  });

  it("a month that starts on a Monday needs no clipping at the front", () => {
    // June 2026: June 1 is a Monday. June has 30 days, so the last week (29-30) is still
    // a genuine partial week — just check the first week's unclipped boundary here.
    const weeks = getCalendarWeeksInMonth(2026, 5); // June 2026
    expect(weeks[0].weekStart.getDate()).toBe(1);
    expect(weeks[0].weekStart.getDay()).toBe(1); // Monday — first week needed no clipping
  });

  it("every week is non-overlapping and in chronological order", () => {
    const weeks = getCalendarWeeksInMonth(2026, 1); // February 2026
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i].weekStart.getTime()).toBeGreaterThan(weeks[i - 1].weekEnd.getTime());
    }
  });
});

describe("dateInMonth / monthKey / monthLabel", () => {
  const oct2026: MonthOption = { year: 2026, month: 9, label: "October 2026" };

  it("matches a date inside the month, rejects one outside it, rejects undefined", () => {
    expect(dateInMonth("2026-10-15T00:00:00.000Z", oct2026)).toBe(true);
    expect(dateInMonth("2026-11-01T00:00:00.000Z", oct2026)).toBe(false);
    expect(dateInMonth(undefined, oct2026)).toBe(false);
    expect(dateInMonth("not-a-date", oct2026)).toBe(false);
  });

  it("monthKey/monthLabel are stable and human-readable", () => {
    expect(monthKey(2026, 9)).toBe("2026-10");
    expect(monthLabel(2026, 9)).toBe("October 2026");
  });
});

describe("dateInYear", () => {
  it("matches a date inside the year, rejects an adjacent year, rejects undefined", () => {
    expect(dateInYear("2026-06-15T12:00:00.000Z", 2026)).toBe(true);
    expect(dateInYear("2026-12-31T12:00:00.000Z", 2026)).toBe(true);
    expect(dateInYear("2025-12-31T12:00:00.000Z", 2026)).toBe(false);
    expect(dateInYear("2027-01-01T12:00:00.000Z", 2026)).toBe(false);
    expect(dateInYear(undefined, 2026)).toBe(false);
  });
});

describe("sameCalendarDay", () => {
  it("compares calendar day only, ignoring time-of-day", () => {
    const localMidnight = new Date(2026, 9, 5);
    expect(sameCalendarDay(localMidnight, "2026-10-05T23:59:59.999Z".slice(0, 10))).toBe(true);
    expect(sameCalendarDay(localMidnight, "2026-10-06")).toBe(false);
  });
});

// Reuses the established Blob/URL/<a> spy pattern from test/attendanceCard.test.tsx.
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
        configurable: true, // this file calls spyOnCsvDownload() more than once; must be redefinable
        set(v: string) { downloadNames.push(v); },
        get() { return downloadNames[downloadNames.length - 1] ?? ""; },
      });
    }
    return el;
  });
  return {
    lastCsv: () => blobParts[blobParts.length - 1]?.join("") ?? "",
    lastFilename: () => downloadNames[downloadNames.length - 1] ?? "",
    restore: () => { global.Blob = originalBlob; },
  };
}

describe("handleExportDataset: two-step Export (dataset, then Monthly/Yearly/Overall time range)", () => {
  const enrollments = [
    { _id: "e1", studentSnapshot: { firstName: "Sep", lastName: "Child" }, createdAt: "2026-09-15T00:00:00.000Z", status: "approved" },
    { _id: "e2", studentSnapshot: { firstName: "Oct", lastName: "Child" }, createdAt: "2026-10-05T00:00:00.000Z", status: "approved" },
    { _id: "e3", studentSnapshot: { firstName: "LastYear", lastName: "Child" }, createdAt: "2025-10-05T00:00:00.000Z", status: "approved" },
  ] as unknown as Parameters<typeof handleExportDataset>[1];
  const users = [
    { _id: "u1", firstName: "Sep", lastName: "User", email: "sep@example.com", role: "parent", isActive: true, createdAt: "2026-09-10T00:00:00.000Z" },
    { _id: "u2", firstName: "Oct", lastName: "User", email: "oct@example.com", role: "parent", isActive: true, createdAt: "2026-10-10T00:00:00.000Z" },
    { _id: "u3", firstName: "LastYear", lastName: "User", email: "lastyear@example.com", role: "tutor", isActive: true, createdAt: "2024-01-01T00:00:00.000Z" },
  ] as unknown as Parameters<typeof handleExportDataset>[2];
  const payments = [
    { _id: "p1", amount: 1000, status: "verified", createdAt: "2026-09-20T00:00:00.000Z" },
    { _id: "p2", amount: 2000, status: "verified", createdAt: "2026-10-20T00:00:00.000Z" },
    { _id: "p3", amount: 3000, status: "verified", createdAt: "2025-10-20T00:00:00.000Z" }, // adjacent year
    { _id: "p4", amount: 4000, status: "verified", createdAt: "2027-01-05T00:00:00.000Z" }, // adjacent year
  ] as unknown as Parameters<typeof handleExportDataset>[3];

  it("an Enrollments-only Monthly export contains only that month's enrollment rows — never Payments or Users sections", () => {
    const spy = spyOnCsvDownload();
    handleExportDataset("enrollments", enrollments, users, payments, { type: "monthly", month: { year: 2026, month: 9, label: "October 2026" } });
    const csv = spy.lastCsv();
    expect(csv).toContain("Oct Child");
    expect(csv).not.toContain("Sep Child");
    expect(csv).not.toContain("LastYear Child");
    // Genuinely a single-dataset file now — the Payments/Users column headers and rows
    // never appear in an Enrollments export.
    expect(csv).not.toContain("Reference,Student,Amount,Status,Date,Method");
    expect(csv).not.toContain("Name,Role,Email,Phone,Status");
    expect(csv).not.toContain("Oct User");
    expect(spy.lastFilename()).toBe("beebright_enrollments_2026-10.csv");
    spy.restore();
  });

  it("a Payments-only Yearly export contains every payment from that year and nothing from adjacent years", () => {
    const spy = spyOnCsvDownload();
    handleExportDataset("payments", enrollments, users, payments, { type: "yearly", year: 2026 });
    const csv = spy.lastCsv();
    expect(csv).toMatch(/₱1,000|₱1000/); // September 2026
    expect(csv).toMatch(/₱2,000|₱2000/); // October 2026
    expect(csv).not.toMatch(/₱3,000|₱3000/); // October 2025 — adjacent year excluded
    expect(csv).not.toMatch(/₱4,000|₱4000/); // January 2027 — adjacent year excluded
    expect(csv).not.toContain("Name,Programs,Date,Status");
    expect(spy.lastFilename()).toBe("beebright_payments_2026.csv");
    spy.restore();
  });

  it("a Users Overall export contains every user record regardless of date, with no month/year filtering applied", () => {
    const spy = spyOnCsvDownload();
    handleExportDataset("users", enrollments, users, payments, { type: "overall" });
    const csv = spy.lastCsv();
    expect(csv).toContain("Sep User");
    expect(csv).toContain("Oct User");
    expect(csv).toContain("LastYear User"); // 2024 — far outside any month/year, still included
    expect(csv).not.toContain("Name,Programs,Date,Status");
    expect(spy.lastFilename()).toBe("beebright_users_all-time.csv");
    spy.restore();
  });
});
