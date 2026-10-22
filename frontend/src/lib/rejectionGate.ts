import type { DashboardEnrollment } from "@/contexts/SelectedChildContext";

/**
 * Panel-required change: a parent who has never been approved for ANYTHING yet, and
 * whose enrollment is mid a reject/resubmit cycle, must see ONLY a restricted screen on
 * login — not the normal dashboard. `allowResubmission` is set true by
 * adminRejectEnrollment the moment admin rejects, and is left untouched by resubmission
 * (submitPaymentProof never clears it) — so it stays true through "rejected, needs new
 * proof" AND "resubmitted, awaiting re-verification" alike, only ever going away once the
 * SAME enrollment is actually approved (at which point its status leaves the exclusion
 * list below for good). A parent who already has ANY approved/active/completed
 * enrollment is never gated, even if a different child/program of theirs is separately
 * going through this cycle.
 *
 * A rejection on an 'add_child' (or 'renewal') -sourced enrollment is deliberately
 * NEVER picked here — the parent already has a working account and other usable
 * children/programs, so that cycle is shown scoped to just that one child's "My Child"
 * card instead (see components/dashboard/ChildCardRejectionAction.tsx). Only a 'signup'
 * -sourced enrollment (the main Enrollment page / account-creation wizard — there is
 * nothing else on the account yet) can lock the whole dashboard. Enrollments predating
 * the `source` field come back with it `undefined`, which is treated as 'signup' (the
 * only entry point that existed before Add Child got its own card-level treatment) so
 * old records keep their existing behavior.
 *
 * Extracted as a pure function (no React) so it's directly unit-testable without
 * mounting the full StudentDashboard page, which has no existing render-test harness.
 */
export interface RejectionGateState {
  /** True when the parent must see the restricted screen instead of the normal dashboard. */
  restricted: boolean;
  /** The enrollment the restricted screen is scoped to; null unless restricted. */
  enrollment: DashboardEnrollment | null;
  /** True = show the payment-upload screen; false = show the "please wait" screen. Only meaningful when restricted. */
  needsNewProof: boolean;
}

export const APPROVED_STATUSES = ["approved", "active", "completed"];

/**
 * "rejected" covers the whole-enrollment Reject button; a down payment proof rejected
 * on its own (via the Enrollments-tab modal's separate Reject Payment action) leaves
 * enrollment.status at "submitted" instead but its own latest down-payment Payment
 * record is what actually says a NEW proof is needed — checked directly rather than
 * assuming status alone tells the whole story. Shared by the full-screen gate below and
 * the per-child card (ChildCardRejectionAction) so the two can never disagree.
 */
export function enrollmentNeedsNewProof(enrollment: DashboardEnrollment): boolean {
  const latestDownPayment = (enrollment.payments || []).find((p) => p.paymentType !== "remaining");
  return enrollment.status === "rejected" || latestDownPayment?.status === "rejected";
}

export function computeRejectionGateState(enrollments: DashboardEnrollment[]): RejectionGateState {
  const neverApprovedAnything = enrollments.length > 0
    && !enrollments.some((e) => APPROVED_STATUSES.includes(e.status || ""));
  const enrollment = neverApprovedAnything
    ? enrollments.find((e) => e.allowResubmission && e.source !== "add_child" && e.source !== "renewal") || null
    : null;
  if (!enrollment) return { restricted: false, enrollment: null, needsNewProof: false };

  return { restricted: true, enrollment, needsNewProof: enrollmentNeedsNewProof(enrollment) };
}

/**
 * Of ONE child's own enrollments, the ones still mid a reject/resubmit cycle — not yet
 * approved, but still allowed to resubmit. This is the single source of truth for that
 * child's "My Child" card: it decides whether ChildCardRejectionAction renders at all,
 * AND (reused directly, not re-derived) whether that card's Renew/Add Program button is
 * locked — the panel-reported bug was Renew/Add Program using only the coarser status
 * badge (`"pending"`), which misses the post-resubmission window where status has
 * already left "rejected" but the child still isn't approved yet. Scoped to one child's
 * own `enrollments` array, so it can never affect — or be affected by — a different
 * child's card.
 */
export function childRejectionCycleEnrollments(enrollments: DashboardEnrollment[]): DashboardEnrollment[] {
  return enrollments.filter((e) => e.allowResubmission && !APPROVED_STATUSES.includes(e.status || ""));
}
