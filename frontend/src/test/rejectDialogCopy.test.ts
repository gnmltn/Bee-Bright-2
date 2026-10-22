import { describe, it, expect } from "vitest";
import { REJECT_ENROLLMENT_DIALOG_COPY, REJECT_PAYMENT_DIALOG_COPY } from "@/lib/rejectDialogCopy";

// Panel-reported bug: the Enrollments tab's "Reject Enrollment" confirmation still
// described the OLD hard-delete behavior ("Reject & Delete Account" / "permanently
// deletes the account... cannot be undone... must submit a brand-new enrollment") even
// though adminRejectEnrollment itself had already been rewritten to be non-destructive
// (see rejectionGate.ts / ChildCardRejectionAction.tsx) — the copy just never got
// updated to match. AdminDashboard.tsx has no render-test harness, so this asserts
// directly on the extracted copy constants it renders from, rather than mounting the
// full page.
describe("REJECT_ENROLLMENT_DIALOG_COPY (Enrollments tab)", () => {
  it("the confirm button says just 'Reject', not the old 'Reject & Delete Account'", () => {
    expect(REJECT_ENROLLMENT_DIALOG_COPY.confirmLabel).toBe("Reject");
  });

  it("the description no longer claims anything IS deleted (it may say the opposite — 'nothing is deleted'), or is permanent/irreversible", () => {
    const d = REJECT_ENROLLMENT_DIALOG_COPY.description.toLowerCase();
    expect(d).not.toMatch(/permanently delete/);
    expect(d).not.toMatch(/deletes the account/);
    expect(d).not.toMatch(/\bpermanent\b/);
    expect(d).not.toMatch(/cannot be undone/);
    expect(d).not.toMatch(/brand-new enrollment/);
  });

  it("the description accurately describes the real non-destructive behavior: moves to Rejected, emailed, can resubmit", () => {
    const d = REJECT_ENROLLMENT_DIALOG_COPY.description.toLowerCase();
    expect(d).toMatch(/rejected/);
    expect(d).toMatch(/email/);
    expect(d).toMatch(/payment proof/);
  });
});

describe("REJECT_PAYMENT_DIALOG_COPY (Payments tab)", () => {
  it("never carried the deletion language either — the button is 'Reject Payment', description says the amount goes back to outstanding", () => {
    expect(REJECT_PAYMENT_DIALOG_COPY.confirmLabel).toMatch(/^reject/i);
    const d = REJECT_PAYMENT_DIALOG_COPY.description.toLowerCase();
    expect(d).not.toMatch(/delet/);
    expect(d).not.toMatch(/permanent/);
    expect(d).not.toMatch(/cannot be undone/);
    expect(d).toMatch(/outstanding/);
    expect(d).toMatch(/new payment proof/);
  });
});
