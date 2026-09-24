import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  FileText,
  CreditCard,
  CheckCircle,
  Clock,
  AlertCircle,
  Download,
  Calendar,
  Loader2,
} from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import PayInvoiceModal from "@/components/payment/PayInvoiceModal";
import { enrollmentService } from "@/services/api";
import { useAuth } from "@/hooks/useAuth";
import { useActiveChildId } from "@/hooks/useActiveChildId";
import { downloadPaymentReceipt } from "@/lib/receiptPdf";

interface PaymentRecord {
  _id: string;
  status: "pending" | "submitted" | "verified" | "rejected";
  paymentType?: "full" | "down" | "remaining";
  amount?: number;
  amountDue?: number;
  amountPaid?: number;
  paymentMethod?: string;
  proofUrl?: string | null;
  submittedAt?: string;
  verifiedAt?: string;
  rejectionReason?: string | null;
  referenceNumber?: string;
}

interface EnrollmentItem {
  _id: string;
  enrollmentId?: string;
  referenceNumber?: string;
  totalFee: number;
  paymentOption: "full" | "down";
  paymentStatus: string;
  status: string;
  createdAt: string;
  selectedSubjects?: { name: string; price?: number }[];
  packages?: { displayName?: string; price?: number }[];
  payments?: PaymentRecord[];
  studentSnapshot?: { firstName?: string; lastName?: string };
}

// Every current write path (adminApproveEnrollment, adminVerifyPayment, the
// submitPaymentProof self-heal) only ever sets this to 'paid' once both the
// down payment AND remaining balance are verified — so it's now safe to trust
// as an additional "definitely fully paid" signal, on top of the verified-
// Payment-records total. This specifically covers legacy/edge-case enrollments
// that are genuinely fully paid but have no matching Payment documents to derive
// amountPaid from (Payments_FullyPaid_NewProgramRefinements_AdminWalkIn.pdf A).


// Amount actually settled (verified) so far — Parent_Payments_50Percent_Display_and_
// Payment_Methods.pdf: never trust the coarse enrollment.paymentStatus string alone,
// since older records may still carry pre-fix values. The verified Payment rows are
// the source of truth for "how much has genuinely gone through."
function computeAmountPaid(payments: PaymentRecord[]): number {
  return payments
    .filter((p) => p.status === "verified")
    .reduce((sum, p) => sum + (p.amountPaid ?? p.amountDue ?? p.amount ?? 0), 0);
}

type InvoiceLike = {
  id: string;
  _id: string;
  enrollmentId: string; // human-readable id the backend payment routes key on
  date: string;
  dueDate: string;
  items: { name: string; quantity: number; price: number }[];
  total: number;
  amountPaid: number;
  remainingBalance: number;
  downPayment: PaymentRecord | null;
  remainingPayment: PaymentRecord | null;
  paymentStatus: string;
  childName: string;
};

const fallbackInvoices: InvoiceLike[] = [
  {
    id: "demo-1",
    _id: "",
    enrollmentId: "",
    date: new Date().toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }),
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }),
    items: [{ name: "Sample subject", quantity: 1, price: 2500 }],
    total: 2500,
    amountPaid: 0,
    remainingBalance: 2500,
    downPayment: null,
    remainingPayment: null,
    paymentStatus: "pending",
    childName: "",
  },
];

function mapEnrollmentToInvoice(e: EnrollmentItem): InvoiceLike {
  const date = e.createdAt ? new Date(e.createdAt).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }) : "";
  const dueDate = e.createdAt ? new Date(new Date(e.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }) : "";
  const items = (e.packages && e.packages.length > 0)
    ? e.packages.map((p) => ({ name: p.displayName || "Package", quantity: 1, price: p.price ?? 0 }))
    : (e.selectedSubjects && e.selectedSubjects.length > 0)
      ? e.selectedSubjects.map((s) => ({ name: s.name || "Subject", quantity: 1, price: (s as { price?: number }).price ?? Math.floor(e.totalFee / (e.selectedSubjects?.length || 1)) }))
      : [{ name: "Enrollment", quantity: 1, price: e.totalFee }];

  const payments = e.payments || [];
  const downPayment = payments.find((p) => p.paymentType !== "remaining") || null;
  const remainingPayment = payments.find((p) => p.paymentType === "remaining") || null;
  const amountPaid = computeAmountPaid(payments);
  const remainingBalance = Math.max(0, (e.totalFee || 0) - amountPaid);

  return {
    id: e.referenceNumber || e.enrollmentId || e._id,
    _id: e._id,
    enrollmentId: e.enrollmentId || "",
    date,
    dueDate,
    items,
    total: e.totalFee,
    amountPaid,
    remainingBalance,
    downPayment,
    remainingPayment,
    paymentStatus: e.paymentStatus,
    childName: [e.studentSnapshot?.firstName, e.studentSnapshot?.lastName].filter(Boolean).join(" "),
  };
}

// Status the invoice list badge + detail panel show — deliberately never says the
// whole invoice is "Paid" unless the remaining balance is actually settled too.
function invoiceStatus(invoice: InvoiceLike): "pending" | "under_review" | "down_paid" | "remaining_review" | "paid" | "rejected" {
  if (invoice.paymentStatus === "paid") return "paid";
  if (invoice.total > 0 && invoice.remainingBalance <= 0) return "paid";
  if (invoice.remainingPayment?.status === "submitted") return "remaining_review";
  if (invoice.downPayment?.status === "verified") return "down_paid";
  if (invoice.downPayment?.status === "rejected") return "rejected";
  if (invoice.downPayment?.status === "submitted") return "under_review";
  return "pending";
}

const statusConfig = {
  pending: { label: "Pending", icon: Clock, color: "bg-warning/10 text-warning" },
  under_review: { label: "Under Review", icon: Clock, color: "bg-warning/10 text-warning" },
  down_paid: { label: "Paid 50%", icon: CheckCircle, color: "bg-primary/10 text-primary" },
  remaining_review: { label: "Remaining Balance Under Review", icon: Clock, color: "bg-warning/10 text-warning" },
  paid: { label: "Fully Paid", icon: CheckCircle, color: "bg-success/10 text-success" },
  rejected: { label: "Rejected", icon: AlertCircle, color: "bg-destructive/10 text-destructive" },
} as const;

export default function StudentPayments() {
  const { user } = useAuth();
  const isParent = user?.role === "parent";
  const [activeChildId] = useActiveChildId();
  const [invoices, setInvoices] = useState<InvoiceLike[]>(fallbackInvoices);
  // Every enrollment, unfiltered — needed to resolve which childName the
  // currently active (per-enrollment) child selection belongs to.
  const [allEnrollments, setAllEnrollments] = useState<EnrollmentItem[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceLike | null>(null);
  const [showPayModal, setShowPayModal] = useState(false);
  const [payKind, setPayKind] = useState<"down" | "remaining">("down");
  const [loading, setLoading] = useState(true);

  const loadEnrollments = () => {
    enrollmentService
      .getMyEnrollments()
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.enrollments) && res.data.enrollments.length > 0) {
          setAllEnrollments(res.data.enrollments);
          const list = res.data.enrollments.map((e: EnrollmentItem) => mapEnrollmentToInvoice(e));
          setInvoices(list);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadEnrollments();
  }, []);

  // Multi-child accounts: the dashboard's "Viewing child" selector is per-
  // enrollment — resolve its childName, then show only that child's invoices
  // (a child can have several enrollments/invoices; never mix children's
  // payment data together). Invoice_Display_DownPaymentBug_Receipt_
  // RemarksPolicy.pdf D. Falls back to every invoice for a single-child
  // account, a student-role account, or a stale/unset selection.
  const activeEnrollmentForChild = isParent ? allEnrollments.find((e) => e._id === activeChildId) : undefined;
  const activeChildName = activeEnrollmentForChild?.studentSnapshot
    ? [activeEnrollmentForChild.studentSnapshot.firstName, activeEnrollmentForChild.studentSnapshot.lastName].filter(Boolean).join(" ")
    : null;
  const displayInvoices = activeChildName
    ? invoices.filter((inv) => inv.childName === activeChildName)
    : invoices;
  const currentInvoice = (selectedInvoice && displayInvoices.some((i) => i._id === selectedInvoice._id))
    ? selectedInvoice
    : displayInvoices[0];

  useEffect(() => {
    // Switching the active child (or the invoice list reloading) may leave
    // `selectedInvoice` pointing at an invoice that's no longer in view.
    if (selectedInvoice && !displayInvoices.some((i) => i._id === selectedInvoice._id)) {
      setSelectedInvoice(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChildId, invoices]);

  const status = currentInvoice ? invoiceStatus(currentInvoice) : "pending";
  const StatusIcon = statusConfig[status].icon;

  // Payment History lists every individually VERIFIED payment (down payment and
  // remaining balance each get their own row) — not just invoices that are fully
  // settled. Otherwise the original 50% down payment has nowhere to be looked up
  // again once verified, while the remaining balance is still outstanding.
  const paymentHistoryEntries = displayInvoices.flatMap((inv) => {
    const entries: { key: string; invoiceId: string; enrollmentId: string; childName: string; label: string; amount: number; verifiedAt: string | null; referenceNumber?: string }[] = [];
    if (inv.downPayment?.status === "verified") {
      entries.push({
        key: `${inv._id}-down`,
        invoiceId: inv.id,
        enrollmentId: inv.enrollmentId,
        childName: inv.childName,
        label: "Down Payment (50%)",
        amount: inv.downPayment.amountPaid ?? inv.downPayment.amountDue ?? inv.downPayment.amount ?? 0,
        verifiedAt: inv.downPayment.verifiedAt ?? null,
        referenceNumber: inv.downPayment.referenceNumber,
      });
    }
    if (inv.remainingPayment?.status === "verified") {
      entries.push({
        key: `${inv._id}-remaining`,
        invoiceId: inv.id,
        enrollmentId: inv.enrollmentId,
        childName: inv.childName,
        label: "Remaining Balance (50%)",
        amount: inv.remainingPayment.amountPaid ?? inv.remainingPayment.amountDue ?? inv.remainingPayment.amount ?? 0,
        verifiedAt: inv.remainingPayment.verifiedAt ?? null,
        referenceNumber: inv.remainingPayment.referenceNumber,
      });
    }
    return entries;
  }).sort((a, b) => new Date(b.verifiedAt || 0).getTime() - new Date(a.verifiedAt || 0).getTime());

  const openPay = (kind: "down" | "remaining") => {
    setPayKind(kind);
    setShowPayModal(true);
  };

  return (
    <DashboardLayout>
      <div className="p-6 md:p-8">
        {/* Dashboard Header */}
        <div className="mb-8">
          <h1 className="font-display text-2xl md:text-3xl font-bold text-foreground">
            Invoices & Payments
          </h1>
          <p className="text-muted-foreground mt-1">
            View your invoices and manage payments for your tutoring sessions.
          </p>
        </div>

        <Tabs defaultValue="invoices" className="w-full">
          <TabsList className="bg-card border border-border w-full md:w-auto">
            <TabsTrigger value="invoices" className="flex-1 md:flex-none">Invoices</TabsTrigger>
            <TabsTrigger value="history" className="flex-1 md:flex-none">Payment History</TabsTrigger>
          </TabsList>

          <TabsContent value="invoices" className="mt-6">
            {loading ? (
              <div className="flex justify-center py-16">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
            <div className="grid lg:grid-cols-5 gap-6">
              {/* Invoice List */}
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                className="lg:col-span-2 space-y-3"
              >
                <h3 className="font-display font-bold text-lg text-foreground mb-4">
                  Your Invoices
                </h3>
                {displayInvoices.map((invoice) => {
                  const invStatus = invoiceStatus(invoice);
                  const cfg = statusConfig[invStatus];
                  return (
                    <div
                      key={invoice._id || invoice.id}
                      onClick={() => setSelectedInvoice(invoice)}
                      className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                        currentInvoice?.id === invoice.id
                          ? "border-primary bg-primary/5"
                          : "border-border bg-card hover:border-primary/30"
                      }`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <p className="font-mono font-semibold text-foreground">{invoice.id}</p>
                          <p className="text-sm text-muted-foreground">{invoice.date}</p>
                        </div>
                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${cfg.color}`}>
                          {cfg.label}
                        </span>
                      </div>
                      <p className="font-bold text-lg text-foreground">
                        ₱{invoice.total.toLocaleString()}
                      </p>
                      {invStatus !== "paid" && invStatus !== "pending" && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          ₱{invoice.remainingBalance.toLocaleString()} remaining
                        </p>
                      )}
                    </div>
                  );
                })}
              </motion.div>

              {/* Invoice Detail */}
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="lg:col-span-3"
              >
                <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                  {/* Invoice Header */}
                  <div className="p-6 border-b border-border bg-muted/50">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-3 mb-2">
                          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                            <FileText className="h-5 w-5 text-primary" />
                          </div>
                          <div>
                            <h3 className="font-display font-bold text-xl text-foreground">
                              {currentInvoice?.id ?? "—"}
                            </h3>
                            <p className="text-sm text-muted-foreground">Invoice</p>
                          </div>
                        </div>
                      </div>
                      <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${statusConfig[status].color}`}>
                        <StatusIcon className="h-4 w-4" />
                        <span className="font-medium text-sm">{statusConfig[status].label}</span>
                      </div>
                    </div>

                    <div className="grid sm:grid-cols-2 gap-4 mt-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">Issue Date</p>
                        <p className="font-semibold text-foreground">{currentInvoice?.date ?? "—"}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Due Date</p>
                        <p className="font-semibold text-foreground">{currentInvoice?.dueDate ?? "—"}</p>
                      </div>
                    </div>
                  </div>

                  {/* Invoice Items */}
                  <div className="p-6">
                    <table className="w-full">
                      <thead>
                        <tr className="text-sm text-muted-foreground">
                          <th className="text-left pb-3">Description</th>
                          <th className="text-center pb-3">Qty</th>
                          <th className="text-right pb-3">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {(currentInvoice?.items ?? []).map((item, index) => (
                          <tr key={index}>
                            <td className="py-3 text-foreground">{item.name}</td>
                            <td className="py-3 text-center text-muted-foreground">{item.quantity}</td>
                            <td className="py-3 text-right font-semibold text-foreground">
                              ₱{item.price.toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-border">
                          <td colSpan={2} className="pt-4 font-bold text-lg text-foreground">
                            Total
                          </td>
                          <td className="pt-4 text-right font-bold text-xl text-foreground">
                            ₱{(currentInvoice?.total ?? 0).toLocaleString()}
                          </td>
                        </tr>
                        {/* Per BeeBright's 50% down payment policy — never show the full
                            price as a single settled "Total" figure; always break it
                            into what's actually been paid vs what's still owed. */}
                        <tr>
                          <td colSpan={2} className="pt-1 text-sm text-success">
                            Amount Paid
                          </td>
                          <td className="pt-1 text-right text-sm font-semibold text-success">
                            ₱{(currentInvoice?.amountPaid ?? 0).toLocaleString()}
                          </td>
                        </tr>
                        {status !== "paid" && (
                          <tr>
                            <td colSpan={2} className="pt-1 text-sm text-muted-foreground">
                              Remaining Balance
                            </td>
                            <td className="pt-1 text-right text-sm font-semibold text-foreground">
                              ₱{(currentInvoice?.remainingBalance ?? 0).toLocaleString()}
                            </td>
                          </tr>
                        )}
                      </tfoot>
                    </table>
                  </div>

                  {/* Down payment not yet submitted/verified */}
                  {(status === "pending" || status === "rejected") && (
                    <div className="p-6 border-t border-border bg-muted/30">
                      {status === "rejected" && currentInvoice?.downPayment?.rejectionReason && (
                        <p className="text-sm text-destructive mb-4">
                          Your last payment proof was rejected: {currentInvoice.downPayment.rejectionReason}
                        </p>
                      )}
                      <Button onClick={() => openPay("down")} className="w-full btn-glow" size="lg">
                        <CreditCard className="h-4 w-4 mr-2" />
                        Pay ₱{(currentInvoice?.total != null ? Math.ceil(currentInvoice.total * 0.5) : 0).toLocaleString()} (50% Down Payment)
                      </Button>
                    </div>
                  )}

                  {status === "under_review" && (
                    <div className="p-6 border-t border-border bg-warning/5">
                      <div className="flex items-center gap-3">
                        <Clock className="h-5 w-5 text-warning" />
                        <p className="text-sm text-foreground">Your down payment proof is being reviewed. We'll notify you once it's verified.</p>
                      </div>
                    </div>
                  )}

                  {status === "remaining_review" && (
                    <div className="p-6 border-t border-border bg-warning/5">
                      <div className="flex items-center gap-3">
                        <Clock className="h-5 w-5 text-warning" />
                        <p className="text-sm text-foreground">Your remaining balance payment proof is being reviewed. We'll notify you once it's verified.</p>
                      </div>
                    </div>
                  )}

                  {/* Down payment settled, remaining balance still owed — Download / Pay / Print */}
                  {(status === "down_paid" || status === "paid") && (
                    <div className="p-6 border-t border-border bg-success/5">
                      <div className="flex items-center gap-3 mb-4">
                        <CheckCircle className="h-5 w-5 text-success" />
                        <p className="text-success font-medium">
                          {status === "paid"
                            ? `Fully paid${currentInvoice?.remainingPayment?.verifiedAt ? ` on ${new Date(currentInvoice.remainingPayment.verifiedAt).toLocaleDateString("en-PH")}` : ""}`
                            : `Down payment paid${currentInvoice?.downPayment?.verifiedAt ? ` on ${new Date(currentInvoice.downPayment.verifiedAt).toLocaleDateString("en-PH")}` : ""}`}
                        </p>
                      </div>
                      <div className="flex gap-3">
                        <Button
                          variant="outline"
                          className="flex-1"
                          onClick={() => {
                            if (!currentInvoice) return;
                            const latestPayment = status === "paid" ? currentInvoice.remainingPayment ?? currentInvoice.downPayment : currentInvoice.downPayment;
                            downloadPaymentReceipt({
                              bbId: currentInvoice.enrollmentId || currentInvoice.id,
                              fullName: currentInvoice.childName,
                              amount: currentInvoice.amountPaid,
                              transactionId: latestPayment?.referenceNumber,
                              transactionDate: latestPayment?.verifiedAt || new Date().toISOString(),
                            });
                          }}
                        >
                          <Download className="h-4 w-4 mr-2" />
                          Download
                        </Button>
                        {status === "down_paid" && (
                          <Button className="flex-1 btn-glow" onClick={() => openPay("remaining")}>
                            <CreditCard className="h-4 w-4 mr-2" />
                            Pay ₱{(currentInvoice?.remainingBalance ?? 0).toLocaleString()}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            </div>
            )}
          </TabsContent>

          <TabsContent value="history" className="mt-6">
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="p-4 border-b border-border">
                <h3 className="font-display font-bold text-lg text-foreground">
                  Payment History
                </h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Every verified payment — including the original 50% down payment made at
                  enrollment — with its own soft copy.
                </p>
              </div>
              <div className="divide-y divide-border">
                {paymentHistoryEntries.length === 0 ? (
                  <p className="p-6 text-center text-sm text-muted-foreground">No verified payments yet.</p>
                ) : (
                  paymentHistoryEntries.map((entry) => (
                    <div
                      key={entry.key}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-4">
                        <div className="h-10 w-10 rounded-full bg-success/10 flex items-center justify-center flex-shrink-0">
                          <CheckCircle className="h-5 w-5 text-success" />
                        </div>
                        <div>
                          <p className="font-semibold text-foreground">{entry.label}</p>
                          <p className="text-sm text-muted-foreground">{entry.invoiceId}</p>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Calendar className="h-3 w-3" />
                            Paid on {entry.verifiedAt ? new Date(entry.verifiedAt).toLocaleDateString("en-PH") : "—"}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="font-bold text-foreground">₱{entry.amount.toLocaleString()}</p>
                          <p className="text-sm text-success">Completed</p>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => downloadPaymentReceipt({
                              bbId: entry.enrollmentId || entry.invoiceId,
                              fullName: entry.childName,
                              amount: entry.amount,
                              transactionId: entry.referenceNumber,
                              transactionDate: entry.verifiedAt || new Date().toISOString(),
                            })}
                          >
                            <Download className="h-3.5 w-3.5 mr-1.5" />
                            Download
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {currentInvoice && (
        <PayInvoiceModal
          isOpen={showPayModal}
          onClose={() => setShowPayModal(false)}
          enrollmentId={currentInvoice.enrollmentId}
          invoiceLabel={currentInvoice.id}
          amount={payKind === "remaining" ? currentInvoice.remainingBalance : Math.ceil(currentInvoice.total * 0.5)}
          kind={payKind}
          alreadyPaid={invoiceStatus(currentInvoice) === "paid"}
          onSubmitted={() => {
            setShowPayModal(false);
            loadEnrollments();
          }}
        />
      )}
    </DashboardLayout>
  );
}
