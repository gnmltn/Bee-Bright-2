import type { AdminEnrollment, AdminSchedule } from "@/services/api";

/**
 * An enrollment is only schedulable once admin has actually approved it —
 * 'active' is the model's legacy alias for 'approved', nothing else counts.
 * A paymentStatus of 'paid' can occur well before approval (e.g. while admin
 * is still reviewing payment_under_verification / pending_approval), so it is
 * deliberately NOT treated as a shortcut here.
 */
export function isEnrollmentSchedulable(enrollment: Pick<AdminEnrollment, "status">): boolean {
  const status = enrollment.status || "";
  return status === "active" || status === "approved";
}

/**
 * Mirrors backend/utils/attendanceCycles.js's resolveCycleId exactly — Schedule rows
 * carry no direct enrollment reference, so which enrollment "owns" a given schedule date
 * is resolved the same way there and here: the LATEST enrollment (for this student +
 * program, sorted ascending by enrollmentDate) whose enrollmentDate is on or before that
 * date. `null` when the date predates every enrollment on record.
 */
function resolveCycleId(sortedCycles: { id: string; enrollmentDate?: string }[], sessionDate: string): string | null {
  const t = new Date(sessionDate).getTime();
  if (!Number.isFinite(t)) return null;
  let match: { id: string; enrollmentDate?: string } | null = null;
  for (const cycle of sortedCycles) {
    const et = new Date(cycle.enrollmentDate || 0).getTime();
    if (!Number.isFinite(et) || et > t) break;
    match = cycle;
  }
  return match ? match.id : null;
}

/**
 * True only when THIS SPECIFIC enrollment's own cycle already has a real schedule for
 * the given program — never just "this student has ever had one." A child can go through
 * Renew / Add Program more than once for the same program; matching only on (student,
 * program) would wrongly exclude a brand-new renewal from "Select a student" just
 * because an OLDER, already-scheduled (possibly finished) cycle of the same program still
 * has schedule rows on file. Used by both OneOnOneSchedulingWizard.tsx and
 * PlaygroupSchedulingWizard.tsx so the two can never diverge on this rule.
 */
export function enrollmentAlreadyScheduledForProgram(
  enrollment: Pick<AdminEnrollment, "_id" | "student">,
  programCode: string,
  allEnrollments: Pick<AdminEnrollment, "_id" | "student" | "packages" | "enrollmentDate" | "createdAt">[],
  schedules: Pick<AdminSchedule, "student" | "students" | "subject" | "date">[]
): boolean {
  const studentUserId = enrollment.student?._id;
  if (!studentUserId) return false;
  const code = programCode.toUpperCase();

  // Every cycle (enrollment) this student has ever had for this exact program, oldest first.
  const cycles = allEnrollments
    .filter((e) => e.student?._id === studentUserId && (e.packages || []).some((p) => (p.programCode || "").toUpperCase() === code))
    .map((e) => ({ id: e._id, enrollmentDate: e.enrollmentDate || e.createdAt }))
    .sort((a, b) => new Date(a.enrollmentDate || 0).getTime() - new Date(b.enrollmentDate || 0).getTime());

  return schedules.some((s) => {
    const inRoster = s.student?._id === studentUserId || (s.students || []).some((st) => st._id === studentUserId);
    if (!inRoster) return false;
    if ((s.subject?.code || "").toUpperCase() !== code) return false;
    return resolveCycleId(cycles, s.date) === enrollment._id;
  });
}
