import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RejectedAccountGate } from "@/components/dashboard/RejectedAccountGate";
import type { DashboardEnrollment } from "@/contexts/SelectedChildContext";

const submitPaymentProof = vi.fn();
const logoutMock = vi.fn();

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

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { name: "Gaea Azutillio" }, logout: logoutMock }),
}));

const ENROLLMENT: DashboardEnrollment = {
  _id: "enr-1",
  enrollmentId: "BB-20260101-0001",
  status: "rejected",
  allowResubmission: true,
  totalFee: 5000,
};

function renderGate(props: Partial<React.ComponentProps<typeof RejectedAccountGate>> = {}) {
  return render(
    <MemoryRouter>
      <RejectedAccountGate enrollment={ENROLLMENT} needsNewProof onSubmitted={vi.fn()} {...props} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  submitPaymentProof.mockReset();
  logoutMock.mockReset();
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

// Panel-required change: this IS the entire screen while a rejected-and-not-yet-
// resubmitted account is logged in — nothing else from the dashboard renders alongside
// it, there's no Cancel button (nothing to cancel back to), and it reuses the exact
// existing payment-proof upload UI (PayInvoiceModal/Step10Billing visual pattern).
describe("RejectedAccountGate", () => {
  it("needsNewProof=true renders the payment-upload screen with no Cancel/close affordance — nothing else from the dashboard", () => {
    renderGate();

    expect(screen.getByText("Select Payment Method")).toBeTruthy();
    expect(screen.getByText(/upload proof of payment/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /submit payment proof/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    // No dashboard chrome anywhere nearby (sidebar/tab labels that only the real
    // dashboard would render).
    expect(screen.queryByText("Parent Dashboard")).toBeNull();
    expect(screen.queryByText(/viewing child/i)).toBeNull();
  });

  it("needsNewProof=false renders only the 'please wait' screen, not the upload form", () => {
    renderGate({ needsNewProof: false });

    expect(screen.getByTestId("awaiting-verification-screen")).toBeTruthy();
    expect(screen.getByText(/please wait for 1-2 days for verification/i)).toBeTruthy();
    expect(screen.queryByText("Select Payment Method")).toBeNull();
  });

  it("submitting a new proof calls submitPaymentProof for THIS enrollment and fires onSubmitted", async () => {
    submitPaymentProof.mockResolvedValue({ data: { success: true, message: "Payment proof submitted." } });
    const onSubmitted = vi.fn();
    renderGate({ onSubmitted });

    // DocUploadField's file input — simulate a file selection via its hidden input.
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const file = new File(["fake-image-bytes"], "proof.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file] });
    fireEvent.change(fileInput);

    await waitFor(() => expect(screen.queryByText(/proof\.png/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /submit payment proof/i }));

    await waitFor(() => expect(submitPaymentProof).toHaveBeenCalledTimes(1));
    expect(submitPaymentProof.mock.calls[0][0]).toBe("BB-20260101-0001");
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });

  it("the upload amount is 50% of the enrollment's total fee, matching the standard down-payment rule", () => {
    renderGate({ enrollment: { ...ENROLLMENT, totalFee: 5000 } });
    expect(screen.getByText(/₱2,500 due/)).toBeTruthy();
  });
});

// Issue 1 — the restricted screen had no way to sign out. Reuses the exact same
// LogoutConfirmDialog + AuthContext.logout() mechanism as Navbar/DashboardLayout, not a
// new one — and must be reachable in BOTH sub-states, including needsNewProof's
// PayInvoiceModal (forceOpen), whose own Cancel/X is deliberately absent.
describe("RejectedAccountGate — Logout", () => {
  it("a Logout button is present and reachable on the 'please wait' screen", () => {
    renderGate({ needsNewProof: false });
    expect(screen.getByRole("button", { name: /logout/i })).toBeTruthy();
  });

  it("a Logout button is present and reachable on the payment-upload screen too", () => {
    renderGate({ needsNewProof: true });
    expect(screen.getByRole("button", { name: /logout/i })).toBeTruthy();
  });

  it("clicking Logout asks for confirmation, and confirming actually signs the user out", () => {
    renderGate({ needsNewProof: false });

    fireEvent.click(screen.getByRole("button", { name: /logout/i }));
    expect(screen.getByText(/are you sure you want to log out/i)).toBeTruthy();
    expect(logoutMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^logout$/i }));
    expect(logoutMock).toHaveBeenCalledTimes(1);
  });

  it("cancelling the confirmation never signs the user out", () => {
    renderGate({ needsNewProof: false });

    fireEvent.click(screen.getByRole("button", { name: /logout/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(logoutMock).not.toHaveBeenCalled();
  });
});
