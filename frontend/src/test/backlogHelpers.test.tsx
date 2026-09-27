import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { isReminderDue, formatDueDate, REMINDER_LEAD_DAYS } from "@/lib/balance";
import { requiredRatingKeys, assessedByDisplayLabel } from "@/components/enrollment/assessment-types";
import { childrenForUser, ChildrenInfo } from "@/components/admin/UserProfileDialog";
import type { AdminUser, ParentChild } from "@/services/api";

const DAY = 24 * 60 * 60 * 1000;

describe("remaining-balance reminder timing", () => {
  const now = new Date("2026-10-01T09:00:00Z");
  it("is silent when there is no due date yet (e.g. right after enrolling)", () => {
    expect(isReminderDue(null, now)).toBe(false);
    expect(isReminderDue(undefined, now)).toBe(false);
    expect(isReminderDue("not-a-date", now)).toBe(false);
  });
  it("only starts REMINDER_LEAD_DAYS before the due date", () => {
    expect(REMINDER_LEAD_DAYS).toBe(3);
    expect(isReminderDue(new Date(now.getTime() + 10 * DAY).toISOString(), now)).toBe(false);
    expect(isReminderDue(new Date(now.getTime() + 3.5 * DAY).toISOString(), now)).toBe(false);
    expect(isReminderDue(new Date(now.getTime() + 3 * DAY).toISOString(), now)).toBe(true);
    expect(isReminderDue(new Date(now.getTime() + 1 * DAY).toISOString(), now)).toBe(true);
  });
  it("keeps reminding once the date has passed", () => {
    expect(isReminderDue(new Date(now.getTime() - 2 * DAY).toISOString(), now)).toBe(true);
  });
  it("formats the due date for the popup", () => {
    expect(formatDueDate("2026-10-16T00:00:00Z")).toMatch(/2026/);
    expect(formatDueDate(null)).toBe("");
  });
});

describe("assessment form helpers", () => {
  const template = { sections: [{ items: [] }, { items: [{ key: "a" }, { key: "b" }] }, { items: [{ key: "c" }] }] };
  it("only the first rating of the first non-empty section is required", () => {
    expect(requiredRatingKeys(template)).toEqual(["a"]);
    expect(requiredRatingKeys({ sections: [] })).toEqual([]);
    expect(requiredRatingKeys(null)).toEqual([]);
  });
  it("shows a plain printed-name label — never the signature wording", () => {
    expect(assessedByDisplayLabel("Assessed by (Teacher Signature Over Printed Name)")).toBe("Assessed by (Printed Name)");
    expect(assessedByDisplayLabel("Assessed by (Printed Name)")).toBe("Assessed by (Printed Name)");
    expect(assessedByDisplayLabel(undefined)).toBe("Assessed by");
  });
});

describe("user profile children (Archived User Details / View profile)", () => {
  const kids: Record<string, ParentChild[]> = {
    parent1: [
      { name: "Kai Cruz", studentId: "BB-0001", programs: ["Academic Tutorial – Premier"], studentUserId: "stu1" },
      { name: "Lia Cruz", studentId: "BB-0002", programs: ["Toddlers Playgroup – 16 Hours", "Examination Preparation"], studentUserId: "stu2" },
    ],
    parent2: [{ name: "Other Kid", studentId: "BB-0009", programs: [], studentUserId: "stu9" }],
  };
  const user = (over: Partial<AdminUser>): AdminUser => ({ _id: "x", firstName: "A", lastName: "B", email: "a@b.c", role: "parent", ...over });

  it("a parent's children come from their own entry only", () => {
    expect(childrenForUser(user({ _id: "parent1" }), kids).map((k) => k.studentId)).toEqual(["BB-0001", "BB-0002"]);
    expect(childrenForUser(user({ _id: "parent3" }), kids)).toEqual([]);
  });
  it("a student account resolves to their own child entry; tutors have none", () => {
    expect(childrenForUser(user({ _id: "stu2", role: "student" }), kids).map((k) => k.name)).toEqual(["Lia Cruz"]);
    expect(childrenForUser(user({ _id: "t1", role: "tutor" }), kids)).toEqual([]);
  });
  it("renders each child's Student ID and enrolled program(s) — no grade level", () => {
    render(<ChildrenInfo kids={kids.parent1} />);
    expect(screen.getByText("BB-0001")).toBeTruthy();
    expect(screen.getByText("Academic Tutorial – Premier")).toBeTruthy();
    expect(screen.getByText("Toddlers Playgroup – 16 Hours, Examination Preparation")).toBeTruthy();
    expect(screen.queryByText(/grade level/i)).toBeNull();
  });
  it("renders nothing for a user without children", () => {
    const { container } = render(<ChildrenInfo kids={[]} />);
    expect(container.textContent).toBe("");
  });
});
