/**
 * Copy for the two admin "Reject" confirmations — the Enrollments tab's whole-enrollment
 * Reject, and the Payments tab's reject-a-submitted-payment-proof action. Both are
 * non-destructive since the reject-flow rework (see lib/rejectionGate.ts): nothing is
 * ever deleted, the record moves to Rejected (or the amount goes back to outstanding),
 * and the parent can resubmit. Previously the Enrollments copy still described the OLD
 * hard-delete behavior ("Reject & Delete Account" / "permanently deletes the account...
 * cannot be undone") even though the actual handler had already been rewritten to be
 * non-destructive — a stale-copy bug, not a behavior change here.
 *
 * Extracted into plain data (not left as inline JSX strings) so the exact wording shown
 * to admin is directly unit-testable without rendering the full AdminDashboard page,
 * which has no existing render-test harness.
 */
export const REJECT_ENROLLMENT_DIALOG_COPY = {
  title: "Reject Enrollment",
  description:
    "This moves the enrollment to Rejected — nothing is deleted. The parent is notified by email and can log in to upload a new payment proof, which brings it back for review.",
  confirmLabel: "Reject",
};

export const REJECT_PAYMENT_DIALOG_COPY = {
  title: "Reject Payment",
  description: "The parent will see this amount as outstanding again and can submit a new payment proof.",
  confirmLabel: "Reject Payment",
};
