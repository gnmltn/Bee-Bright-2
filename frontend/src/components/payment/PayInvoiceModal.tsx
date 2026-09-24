import { useState } from "react";
import { Copy, CheckCheck, Loader2, CheckCircle2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import DocUploadField from "@/components/enrollment/DocUploadField";
import { toast } from "sonner";
import { enrollmentService } from "@/services/api";

// Reuses the enrollment wizard's Step10Billing visual pattern (GCash/MariBank/BDO
// cards + instructions + proof upload) for BOTH the down payment (kind="down" —
// legacy path, in case an enrollment's down payment somehow wasn't submitted during
// the wizard) and the new pay-remaining-balance flow (kind="remaining"). See
// Parent_Payments_50Percent_Display_and_Payment_Methods.pdf.
import bdoLogo from "@/assets/bdo_logo.jpg";
import maribankLogo from "@/assets/maribank_logo.png";

const METHODS = [
  {
    id: "gcash" as const,
    label: "GCash",
    accentColor: "#0166FF",
    bgSelected: "#EBF3FF",
    accountName: "Bee Bright Tutorial Center",
    accountNumber: "09307517208",
    branch: null as string | null,
    logo: (
      <svg viewBox="0 0 88 32" className="h-9 w-auto" aria-label="GCash" role="img">
        <rect width="88" height="32" rx="7" fill="#0166FF" />
        <text x="44" y="22" fontSize="17" fontWeight="bold" fill="white" fontFamily="Arial, sans-serif" textAnchor="middle">
          GCash
        </text>
      </svg>
    ),
  },
  {
    id: "maribank" as const,
    label: "MariBank",
    accentColor: "#F97316",
    bgSelected: "#FFF3E8",
    accountName: "Bee Bright Tutorial Center",
    accountNumber: "5678-9012-3456",
    branch: "Main Branch",
    logo: <img src={maribankLogo} alt="MariBank" className="h-9 w-auto object-contain" draggable={false} />,
  },
  {
    id: "bdo" as const,
    label: "BDO",
    accentColor: "#003087",
    bgSelected: "#EEF1F9",
    accountName: "Bee Bright Tutorial Center",
    accountNumber: "0098-7654-3210",
    branch: "Main Branch",
    logo: <img src={bdoLogo} alt="BDO" className="h-9 w-auto object-contain" draggable={false} />,
  },
];

interface PayInvoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The enrollment's human-readable enrollmentId (e.g. BB-20260101-0001) — the
   * backend routes key on this, not the Mongo _id. */
  enrollmentId: string;
  invoiceLabel: string;
  amount: number;
  kind: "down" | "remaining";
  onSubmitted: () => void;
  /**
   * True when the caller already knows this invoice is fully settled (should
   * normally mean this modal is never opened at all — StudentPayments.tsx only
   * ever shows a "Pay" button for an unpaid invoice). Kept as a defensive guard
   * for a race (e.g. paid in another tab while this modal was already open):
   * shows a plain "already paid" panel instead of the payment form. See
   * Payments_FullyPaid_NewProgramRefinements_AdminWalkIn.pdf Section A.
   */
  alreadyPaid?: boolean;
}

export default function PayInvoiceModal({ isOpen, onClose, enrollmentId, invoiceLabel, amount, kind, onSubmitted, alreadyPaid }: PayInvoiceModalProps) {
  const [selectedMethodId, setSelectedMethodId] = useState<(typeof METHODS)[number]["id"]>("gcash");
  const [proof, setProof] = useState<{ dataUrl: string; fileName: string; fileSize: number } | null>(null);
  const [payerReference, setPayerReference] = useState("");
  const [copying, setCopying] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [backendSaysAlreadyPaid, setBackendSaysAlreadyPaid] = useState(false);

  const selectedMethod = METHODS.find((m) => m.id === selectedMethodId) ?? METHODS[0];

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopying(key);
      setTimeout(() => setCopying(null), 2000);
    } catch {
      toast.error("Copy failed — please copy manually.");
    }
  };

  const instructionRows = [
    { label: "Account Name", value: selectedMethod.accountName },
    { label: "Account Number", value: selectedMethod.accountNumber },
    ...(selectedMethod.branch ? [{ label: "Branch", value: selectedMethod.branch }] : []),
    { label: "Amount", value: `₱${amount.toLocaleString()}` },
  ];

  const reset = () => {
    setSelectedMethodId("gcash");
    setProof(null);
    setPayerReference("");
    setBackendSaysAlreadyPaid(false);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!proof) {
      toast.error("Please upload your proof of payment.");
      return;
    }
    setSubmitting(true);
    try {
      const data = { proofDataUrl: proof.dataUrl, payerReference: payerReference.trim() || undefined, paymentMethod: selectedMethodId };
      const res = kind === "remaining"
        ? await enrollmentService.submitRemainingProof(enrollmentId, data)
        : await enrollmentService.submitPaymentProof(enrollmentId, data);
      if (res.data?.success) {
        toast.success(res.data.message || "Payment proof submitted.");
        reset();
        onSubmitted();
      } else {
        toast.error(res.data?.message || "Failed to submit payment proof.");
      }
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { message?: string; alreadyPaid?: boolean } } })?.response?.data;
      if (data?.alreadyPaid) {
        setBackendSaysAlreadyPaid(true);
      } else {
        toast.error(data?.message ?? "Failed to submit payment proof.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const showAlreadyPaidPanel = alreadyPaid || backendSaysAlreadyPaid;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{kind === "remaining" ? "Pay Remaining Balance" : "Pay Invoice"}</DialogTitle>
          <DialogDescription>{invoiceLabel} · ₱{amount.toLocaleString()} due</DialogDescription>
        </DialogHeader>

        {showAlreadyPaidPanel ? (
          <div className="space-y-5">
            <div className="p-4 bg-success/10 border border-success/30 rounded-xl flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-success flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-foreground">Already fully paid</p>
                <p className="text-sm text-muted-foreground mt-0.5">
                  This enrollment is already fully paid — no payment proof is needed.
                </p>
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={handleClose}>Close</Button>
            </div>
          </div>
        ) : (
        <div className="space-y-5">
          <div>
            <Label className="mb-3 block font-semibold">Select Payment Method</Label>
            <div className="grid grid-cols-3 gap-3">
              {METHODS.map((m) => {
                const isSelected = selectedMethodId === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setSelectedMethodId(m.id)}
                    aria-pressed={isSelected}
                    className={`relative p-3 rounded-xl border-2 flex flex-col items-center gap-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isSelected ? "border-amber-500 shadow-sm" : "border-border hover:border-amber-300"
                    }`}
                    style={{ background: isSelected ? m.bgSelected : undefined }}
                  >
                    <div className="h-10 flex items-center justify-center">{m.logo}</div>
                    <span className="text-xs font-semibold text-foreground">{m.label}</span>
                    {isSelected && (
                      <span className="absolute top-1.5 right-1.5 h-4 w-4 rounded-full bg-amber-500 flex items-center justify-center">
                        <svg viewBox="0 0 10 8" className="h-2.5 w-2.5" fill="none">
                          <path d="M1 4l2.5 2.5L9 1" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="p-4 border-2 border-dashed rounded-xl space-y-3" style={{ borderColor: selectedMethod.accentColor }}>
            <p className="font-semibold text-sm" style={{ color: selectedMethod.accentColor }}>
              {selectedMethod.label} Payment Instructions
            </p>
            <div className="space-y-2.5 text-sm">
              {instructionRows.map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground shrink-0">{label}:</span>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-medium truncate">{value}</span>
                    <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0 flex-shrink-0" onClick={() => copyToClipboard(value, label)} aria-label={`Copy ${label}`}>
                      {copying === label ? <CheckCheck className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Send the <strong>exact amount</strong> shown above. Keep your transaction receipt — you will upload it below.
            </p>
          </div>

          <div className="space-y-3">
            <DocUploadField
              label="Upload Proof of Payment"
              desc="Screenshot of your GCash / bank transfer receipt, or a PDF."
              value={proof}
              onChange={setProof}
              onRemove={() => setProof(null)}
            />
            <div className="space-y-1.5">
              <Label htmlFor="pay-invoice-reference">
                Reference / Transaction Number <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="pay-invoice-reference"
                placeholder="e.g. GCash ref no. or bank transaction ID"
                value={payerReference}
                onChange={(e) => setPayerReference(e.target.value)}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={handleClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="button" className="btn-glow" onClick={handleSubmit} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Submit Payment Proof
            </Button>
          </div>
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
