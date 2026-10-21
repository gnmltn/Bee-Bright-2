import { describe, it, expect } from "vitest";
import { enrollmentAlreadyScheduledForProgram } from "@/utils/enrollmentEligibility";

/**
 * Bug report: a child who goes through Renew / Add Program didn't appear in the
 * Scheduling Tab's "Select a student" dropdown, even though their new/renewed program
 * had never actually been scheduled. Root cause: the dropdown's "already scheduled"
 * check matched on (student, program) alone — if an OLDER, already-finished cycle of the
 * SAME program still had real Schedule rows on file (the normal case for any returning
 * child), the brand-new renewal was wrongly treated as "already scheduled" too and
 * excluded. Fix: enrollmentAlreadyScheduledForProgram is cycle-aware — it mirrors
 * backend/utils/attendanceCycles.js's resolveCycleId, resolving which enrollment "owns"
 * each schedule date from the FULL set of that student's cycles for the program (sorted
 * by enrollmentDate), and only counts a schedule as "this enrollment's own" when it
 * actually resolves to THIS enrollment's _id.
 */
describe("enrollmentAlreadyScheduledForProgram", () => {
  const studentUserId = "student-1";
  const studentRef = (id: string) => ({ _id: id, firstName: "Ana", lastName: "Cruz", email: "ana@example.test" });
  const scheduleStudentRef = (id: string) => ({ _id: id, firstName: "Ana", lastName: "Cruz" });
  const subjectRef = (code: string) => ({ _id: `subj-${code}`, name: code, code });

  it("a brand-new Renew/Add Program enrollment is NOT considered already scheduled, even though an OLDER, already-scheduled cycle of the same program still has schedule rows on file", () => {
    const oldEnrollment = { _id: "enr-old", student: studentRef(studentUserId), packages: [{ programCode: "ACT102" }], enrollmentDate: "2026-01-01" };
    const newEnrollment = { _id: "enr-new", student: studentRef(studentUserId), packages: [{ programCode: "ACT102" }], enrollmentDate: "2026-10-01" };
    const allEnrollments = [oldEnrollment, newEnrollment];
    const schedules = [
      // The OLD cycle's own sessions, months before the renewal even existed.
      { student: scheduleStudentRef(studentUserId), subject: subjectRef("ACT102"), date: "2026-01-05" },
      { student: scheduleStudentRef(studentUserId), subject: subjectRef("ACT102"), date: "2026-01-12" },
    ];

    expect(enrollmentAlreadyScheduledForProgram(newEnrollment, "ACT102", allEnrollments, schedules)).toBe(false);
    // Sanity: the OLD enrollment itself IS correctly recognized as already scheduled.
    expect(enrollmentAlreadyScheduledForProgram(oldEnrollment, "ACT102", allEnrollments, schedules)).toBe(true);
  });

  it("becomes true once the renewed enrollment's OWN cycle actually gets scheduled", () => {
    const oldEnrollment = { _id: "enr-old", student: studentRef(studentUserId), packages: [{ programCode: "ACT102" }], enrollmentDate: "2026-01-01" };
    const newEnrollment = { _id: "enr-new", student: studentRef(studentUserId), packages: [{ programCode: "ACT102" }], enrollmentDate: "2026-10-01" };
    const allEnrollments = [oldEnrollment, newEnrollment];
    const schedules = [
      { student: scheduleStudentRef(studentUserId), subject: subjectRef("ACT102"), date: "2026-01-05" },
      // A real session for the NEW cycle, on/after its own enrollmentDate.
      { student: scheduleStudentRef(studentUserId), subject: subjectRef("ACT102"), date: "2026-10-05" },
    ];

    expect(enrollmentAlreadyScheduledForProgram(newEnrollment, "ACT102", allEnrollments, schedules)).toBe(true);
  });

  it("a student's Playgroup group roster (students[], not the singular student field) is matched too", () => {
    const enrollment = { _id: "enr-1", student: studentRef(studentUserId), packages: [{ programCode: "TPG101" }], enrollmentDate: "2026-01-01" };
    const schedules = [
      { students: [scheduleStudentRef(studentUserId)], subject: subjectRef("TPG101"), date: "2026-01-05" },
    ];
    expect(enrollmentAlreadyScheduledForProgram(enrollment, "TPG101", [enrollment], schedules)).toBe(true);
  });

  it("an enrollment with no linked student yet is never considered already scheduled", () => {
    const enrollment = { _id: "enr-1", student: undefined, packages: [{ programCode: "ACT102" }], enrollmentDate: "2026-01-01" };
    const schedules = [{ student: scheduleStudentRef(studentUserId), subject: subjectRef("ACT102"), date: "2026-01-05" }];
    expect(enrollmentAlreadyScheduledForProgram(enrollment, "ACT102", [enrollment], schedules)).toBe(false);
  });

  it("a different program for the same student is unaffected", () => {
    const enrollment = { _id: "enr-1", student: studentRef(studentUserId), packages: [{ programCode: "ACT102" }], enrollmentDate: "2026-01-01" };
    const schedules = [{ student: scheduleStudentRef(studentUserId), subject: subjectRef("EXP106"), date: "2026-01-05" }];
    expect(enrollmentAlreadyScheduledForProgram(enrollment, "ACT102", [enrollment], schedules)).toBe(false);
  });
});
