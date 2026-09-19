import type { AdminEnrollment } from "@/services/api";

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
