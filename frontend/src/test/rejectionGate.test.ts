import { describe, it, expect } from "vitest";
import { computeRejectionGateState, childRejectionCycleEnrollments } from "@/lib/rejectionGate";
import type { DashboardEnrollment } from "@/contexts/SelectedChildContext";

// Panel-required change: a parent whose enrollment is mid a reject/resubmit cycle, and
// who has never been approved for anything yet, must be gated to a restricted screen —
// not the normal dashboard. These test the pure decision logic directly (no React
// render needed — there's no existing harness for mounting the full StudentDashboard
// page, so the logic was extracted specifically to be testable on its own).

function enrollment(overrides: Partial<DashboardEnrollment> = {}): DashboardEnrollment {
  return {
    _id: "enr-1",
    enrollmentId: "BB-20260101-0001",
    status: "rejected",
    allowResubmission: true,
    totalFee: 5000,
    ...overrides,
  };
}

describe("computeRejectionGateState", () => {
  it("a freshly-rejected enrollment with no payment yet gates to the upload screen", () => {
    const state = computeRejectionGateState([enrollment({ status: "rejected", allowResubmission: true })]);
    expect(state.restricted).toBe(true);
    expect(state.needsNewProof).toBe(true);
    expect(state.enrollment?.enrollmentId).toBe("BB-20260101-0001");
  });

  it("a resubmitted enrollment awaiting re-verification gates to the wait screen, not the upload screen", () => {
    const state = computeRejectionGateState([
      enrollment({ status: "payment_under_verification", allowResubmission: true, payments: [{ status: "submitted", paymentType: "down" }] }),
    ]);
    expect(state.restricted).toBe(true);
    expect(state.needsNewProof).toBe(false);
  });

  it("a down payment rejected on its own (status still 'submitted') still needs new proof, via the payment record", () => {
    const state = computeRejectionGateState([
      enrollment({ status: "submitted", allowResubmission: true, payments: [{ status: "rejected", paymentType: "down" }] }),
    ]);
    expect(state.restricted).toBe(true);
    expect(state.needsNewProof).toBe(true);
  });

  it("an approved enrollment is never gated, even with allowResubmission left over from an earlier reject", () => {
    const state = computeRejectionGateState([enrollment({ status: "approved", allowResubmission: true })]);
    expect(state.restricted).toBe(false);
    expect(state.enrollment).toBeNull();
  });

  it("a parent with ONE approved child and ONE separately-rejected enrollment is never gated", () => {
    const state = computeRejectionGateState([
      enrollment({ _id: "enr-approved", status: "approved", allowResubmission: false }),
      enrollment({ _id: "enr-rejected", status: "rejected", allowResubmission: true }),
    ]);
    expect(state.restricted).toBe(false);
  });

  it("a normal pending enrollment (never rejected) is never gated — this flow is untouched", () => {
    const state = computeRejectionGateState([enrollment({ status: "submitted", allowResubmission: false })]);
    expect(state.restricted).toBe(false);
  });

  it("no enrollments at all is never gated", () => {
    const state = computeRejectionGateState([]);
    expect(state.restricted).toBe(false);
  });

  it("a cancelled enrollment (allowResubmission false, the legacy terminal path) is never gated into the resubmit flow", () => {
    const state = computeRejectionGateState([enrollment({ status: "cancelled", allowResubmission: false })]);
    expect(state.restricted).toBe(false);
  });

  it("once approved, the gate permanently stops applying even if allowResubmission is still true on the record", () => {
    const rejected = computeRejectionGateState([enrollment({ status: "rejected", allowResubmission: true })]);
    expect(rejected.restricted).toBe(true);

    const approved = computeRejectionGateState([enrollment({ status: "approved", allowResubmission: true })]);
    expect(approved.restricted).toBe(false);
  });

  // Panel-required change (Add Child follow-up): an Add Child (or Renew/Add Program)
  // rejection never locks the whole dashboard, even for a parent who has never been
  // approved for anything yet — the parent already has real account access, so the
  // cycle is shown scoped to that one child's "My Child" card instead (see
  // ChildCardRejectionAction.tsx). Only the main Enrollment page/signup flow
  // ('source: "signup"', or no source at all — legacy records) can gate the whole
  // dashboard.
  it("a rejected Add Child enrollment (source: 'add_child') never gates the whole dashboard, even as the parent's only enrollment", () => {
    const state = computeRejectionGateState([
      enrollment({ status: "rejected", allowResubmission: true, source: "add_child" }),
    ]);
    expect(state.restricted).toBe(false);
    expect(state.enrollment).toBeNull();
  });

  it("a rejected Renew/Add Program enrollment (source: 'renewal') never gates the whole dashboard either", () => {
    const state = computeRejectionGateState([
      enrollment({ status: "rejected", allowResubmission: true, source: "renewal" }),
    ]);
    expect(state.restricted).toBe(false);
  });

  it("the parent's own original signup enrollment still gates the whole dashboard even while a SEPARATE Add Child enrollment is also rejected", () => {
    const state = computeRejectionGateState([
      enrollment({ _id: "enr-signup", status: "rejected", allowResubmission: true, source: "signup" }),
      enrollment({ _id: "enr-add-child", status: "rejected", allowResubmission: true, source: "add_child" }),
    ]);
    expect(state.restricted).toBe(true);
    expect(state.enrollment?._id).toBe("enr-signup");
  });

  it("an enrollment with no source at all (a legacy record predating this field) is treated as 'signup' and still gates", () => {
    const state = computeRejectionGateState([enrollment({ status: "rejected", allowResubmission: true, source: undefined })]);
    expect(state.restricted).toBe(true);
  });

  it("an approved Add Child enrollment still counts toward 'this parent has been approved for something', exempting a separately-rejected signup enrollment", () => {
    const state = computeRejectionGateState([
      enrollment({ _id: "enr-signup", status: "rejected", allowResubmission: true, source: "signup" }),
      enrollment({ _id: "enr-add-child", status: "approved", source: "add_child" }),
    ]);
    expect(state.restricted).toBe(false);
  });
});

// Panel-reported bug: the "My Child" card's Renew/Add Program button was only disabled
// via the coarse status badge ("pending"), which never covered "Rejected" at all, and
// also missed the post-resubmission window (status already left "rejected" but the
// child still isn't approved). It must reuse this SAME computation — not a separate
// check — so the two can never disagree, per child, independent of any other child.
describe("childRejectionCycleEnrollments (drives the Renew/Add Program lock)", () => {
  it("a freshly-rejected enrollment is mid-cycle — Renew/Add Program must be locked", () => {
    const cycle = childRejectionCycleEnrollments([enrollment({ status: "rejected", allowResubmission: true })]);
    expect(cycle).toHaveLength(1);
  });

  it("a resubmitted enrollment awaiting re-verification is STILL mid-cycle, even though status already left 'rejected'", () => {
    const cycle = childRejectionCycleEnrollments([enrollment({ status: "payment_under_verification", allowResubmission: true })]);
    expect(cycle).toHaveLength(1);
  });

  it("once Approved, the child is no longer mid-cycle — Renew/Add Program becomes usable again", () => {
    const cycle = childRejectionCycleEnrollments([enrollment({ status: "approved", allowResubmission: true })]);
    expect(cycle).toHaveLength(0);
  });

  it("a normal active enrollment that was never rejected is never mid-cycle", () => {
    const cycle = childRejectionCycleEnrollments([enrollment({ status: "approved", allowResubmission: false })]);
    expect(cycle).toHaveLength(0);
  });

  it("is computed per child's OWN enrollments array — a sibling's rejected enrollment never leaks in, since each card calls this with only its own child's list", () => {
    // This child's own enrollments: a normal, already-approved program. A separate call
    // for a DIFFERENT child's rejected enrollment (not included here) must never affect
    // this result — the function only ever sees what's passed to it.
    const thisChildsOwnEnrollments = [enrollment({ _id: "sibling-active", status: "approved", allowResubmission: false })];
    const cycle = childRejectionCycleEnrollments(thisChildsOwnEnrollments);
    expect(cycle).toHaveLength(0);
  });
});
