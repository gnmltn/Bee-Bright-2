import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChildCardRejectionAction } from "@/components/dashboard/ChildCardRejectionAction";
import type { DashboardEnrollment } from "@/contexts/SelectedChildContext";

const submitPaymentProof = vi.fn();

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    enrollmentService: {
      ...actual.enrollmentService,
      submitPaymentProof: (...args: unknown[]) => submitPaymentProof(...args),
    },
  };
});

const ENROLLMENT: DashboardEnrollment = {
  _id: "enr-2",
  enrollmentId: "BB-20260101-0002",
  status: "rejected",
  allowResubmission: true,
  totalFee: 5000,
  source: "add_child",
};

beforeEach(() => {
  submitPaymentProof.mockReset();
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

// Panel-required change: the Add Child counterpart to RejectedAccountGate — the SAME
// reject/resubmit cycle, but scoped to one child's "My Child" card instead of the whole
// dashboard, with a normal (non-forced) Cancel/close affordance since the rest of the
// dashboard stays usable around it.
describe("ChildCardRejectionAction", () => {
  it("needsNewProof=true (status rejected) shows a 'Submit Proof of Payment' button, not the 'please wait' message", () => {
    render(<ChildCardRejectionAction enrollment={ENROLLMENT} onSubmitted={vi.fn()} />);
    expect(screen.getByRole("button", { name: /submit proof of payment/i })).toBeTruthy();
    expect(screen.queryByTestId("child-card-awaiting-verification")).toBeNull();
  });

  it("clicking the button opens the SAME payment-proof upload UI as the full-screen gate, scoped to this one enrollment, with a working Cancel", () => {
    render(<ChildCardRejectionAction enrollment={ENROLLMENT} onSubmitted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /submit proof of payment/i }));

    expect(screen.getByText("Select Payment Method")).toBeTruthy();
    expect(screen.getByText(/upload proof of payment/i)).toBeTruthy();
    const cancelButton = screen.getByRole("button", { name: /^cancel$/i });
    expect(cancelButton).toBeTruthy();
    fireEvent.click(cancelButton);
    expect(screen.queryByText("Select Payment Method")).toBeNull();
  });

  it("needsNewProof=false (resubmitted, awaiting re-verification) shows the 'please wait' message, not the button", () => {
    render(
      <ChildCardRejectionAction
        enrollment={{ ...ENROLLMENT, status: "payment_under_verification", payments: [{ status: "submitted", paymentType: "down" }] }}
        onSubmitted={vi.fn()}
      />
    );
    expect(screen.getByTestId("child-card-awaiting-verification")).toBeTruthy();
    expect(screen.getByText(/please wait for 1-2 days for verification/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /submit proof of payment/i })).toBeNull();
  });

  it("submitting a new proof calls submitPaymentProof for THIS enrollment and fires onSubmitted", async () => {
    submitPaymentProof.mockResolvedValue({ data: { success: true, message: "Payment proof submitted." } });
    const onSubmitted = vi.fn();
    render(<ChildCardRejectionAction enrollment={ENROLLMENT} onSubmitted={onSubmitted} />);

    fireEvent.click(screen.getByRole("button", { name: /submit proof of payment/i }));
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fake-image-bytes"], "proof.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file] });
    fireEvent.change(fileInput);

    await waitFor(() => expect(screen.queryByText(/proof\.png/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /submit payment proof/i }));

    await waitFor(() => expect(submitPaymentProof).toHaveBeenCalledTimes(1));
    expect(submitPaymentProof.mock.calls[0][0]).toBe("BB-20260101-0002");
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });
});
