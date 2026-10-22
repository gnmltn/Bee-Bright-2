import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LogoutConfirmDialog } from "@/components/layout/LogoutConfirmDialog";
import PayInvoiceModal from "@/components/payment/PayInvoiceModal";
import { useAuth } from "@/hooks/useAuth";
import type { DashboardEnrollment } from "@/contexts/SelectedChildContext";

interface RejectedAccountGateProps {
  enrollment: DashboardEnrollment;
  needsNewProof: boolean;
  onSubmitted: () => void;
}

/**
 * The ENTIRE screen a parent sees while their account is mid a reject/resubmit cycle —
 * no dashboard chrome, no other tab/route reachable. See lib/rejectionGate.ts for the
 * decision logic (computeRejectionGateState) that decides when this renders at all, and
 * components/auth/RejectionGateGuard.tsx for what keeps the parent on this screen across
 * Back/Forward navigation instead of escaping to another route.
 *
 * The one way out while genuinely unresolved is Logout (same confirm-dialog + logout()
 * call as DashboardLayout/Navbar use) — fixed above everything, including the
 * needsNewProof PayInvoiceModal, whose own forceOpen mode deliberately has no Cancel/X
 * of its own (nothing behind it to cancel back to).
 */
export function RejectedAccountGate({ enrollment, needsNewProof, onSubmitted }: RejectedAccountGateProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);

  const confirmLogout = () => {
    setLogoutDialogOpen(false);
    logout();
    navigate("/", { replace: true });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted p-4">
      <div className="fixed top-4 right-4 z-[60]">
        <Button variant="outline" size="sm" className="bg-card" onClick={() => setLogoutDialogOpen(true)}>
          <LogOut className="h-4 w-4 mr-2" />
          Logout
        </Button>
      </div>

      {needsNewProof ? (
        <PayInvoiceModal
          isOpen
          forceOpen
          onClose={() => {}}
          enrollmentId={enrollment.enrollmentId || ""}
          invoiceLabel={`Enrollment ${enrollment.enrollmentId || ""}`}
          amount={Math.ceil((enrollment.totalFee || 0) * 0.5)}
          kind="down"
          onSubmitted={onSubmitted}
        />
      ) : (
        <div className="max-w-md w-full rounded-2xl border border-border bg-card p-8 text-center shadow-sm" data-testid="awaiting-verification-screen">
          <h2 className="font-display text-xl font-bold text-foreground mb-2">Please wait for 1-2 days for verification</h2>
          <p className="text-sm text-muted-foreground">
            We received your payment proof and our team is verifying it. You'll be able to access your full dashboard once it's approved.
          </p>
        </div>
      )}

      <LogoutConfirmDialog
        open={logoutDialogOpen}
        onOpenChange={setLogoutDialogOpen}
        onConfirm={confirmLogout}
        userName={user?.name}
      />
    </div>
  );
}
