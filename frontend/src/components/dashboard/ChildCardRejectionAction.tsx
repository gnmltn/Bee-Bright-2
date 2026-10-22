import { useState } from "react";
import { Button } from "@/components/ui/button";
import PayInvoiceModal from "@/components/payment/PayInvoiceModal";
import { enrollmentNeedsNewProof } from "@/lib/rejectionGate";
import type { DashboardEnrollment } from "@/contexts/SelectedChildContext";

interface ChildCardRejectionActionProps {
  enrollment: DashboardEnrollment;
  onSubmitted: () => void;
}

/**
 * The Add Child / Renew counterpart to RejectedAccountGate.tsx — same reject/resubmit
 * cycle (see lib/rejectionGate.ts), but scoped to ONE child's card on the "My Child"
 * page instead of locking the whole dashboard: the rest of the parent's account stays
 * fully usable while this specific child isn't viewable/active yet. A normal (non-
 * forced) PayInvoiceModal, so it keeps its own Cancel/close affordance.
 */
export function ChildCardRejectionAction({ enrollment, onSubmitted }: ChildCardRejectionActionProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const needsNewProof = enrollmentNeedsNewProof(enrollment);

  if (!needsNewProof) {
    return (
      <div
        data-testid="child-card-awaiting-verification"
        className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800"
      >
        Please wait for 1-2 days for verification.
      </div>
    );
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-2 w-full border-red-200 text-red-700 hover:bg-red-50"
        onClick={() => setModalOpen(true)}
      >
        Submit Proof of Payment
      </Button>
      <PayInvoiceModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        enrollmentId={enrollment.enrollmentId || ""}
        invoiceLabel={`Enrollment ${enrollment.enrollmentId || ""}`}
        amount={Math.ceil((enrollment.totalFee || 0) * 0.5)}
        kind="down"
        onSubmitted={() => {
          setModalOpen(false);
          onSubmitted();
        }}
      />
    </>
  );
}
