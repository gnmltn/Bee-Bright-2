import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  FileText,
  CreditCard,
  CheckCircle,
  Clock,
  AlertCircle,
  Download,
  Printer,
  Calendar,
  Loader2,
} from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import StudentPaymentModal from "@/components/payment/StudentPaymentModal";
import { enrollmentService } from "@/services/api";

interface EnrollmentItem {
  _id: string;
  referenceNumber?: string;
  totalFee: number;
  paymentOption: "full" | "down";
  paymentStatus: string;
  status: string;
  createdAt: string;
  selectedSubjects?: { name: string; price?: number }[];
}

type InvoiceLike = {
  id: string;
  _id: string;
  date: string;
  dueDate: string;
  status: string;
  items: { name: string; quantity: number; price: number }[];
  total: number;
  paymentOption: "full" | "down";
  paidDate?: string;
};

const fallbackInvoices: InvoiceLike[] = [
  {
    id: "demo-1",
    _id: "",
    date: new Date().toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }),
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }),
    status: "pending",
    items: [{ name: "Sample subject", quantity: 1, price: 2500 }],
    total: 2500,
    paymentOption: "full",
  },
];

const paymentMethods = [
  { id: "gcash", name: "GCash", icon: "📱" },
  { id: "blockchain", name: "MetaMask Blockchain", icon: "⛓️" },
];

const statusConfig = {
  pending: {
    label: "Pending",
    icon: Clock,
    color: "bg-warning/10 text-warning",
  },
  paid: {
    label: "Paid",
    icon: CheckCircle,
    color: "bg-success/10 text-success",
  },
  overdue: {
    label: "Overdue",
    icon: AlertCircle,
    color: "bg-destructive/10 text-destructive",
  },
};

function mapEnrollmentToInvoice(e: EnrollmentItem): InvoiceLike {
  const status = e.paymentStatus === "paid" ? "paid" : e.paymentStatus === "pending_verification" ? "pending" : e.paymentStatus === "pending" ? "pending" : "pending";
  const date = e.createdAt ? new Date(e.createdAt).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }) : "";
  const dueDate = e.createdAt ? new Date(new Date(e.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }) : "";
  const items = (e.selectedSubjects && e.selectedSubjects.length > 0)
    ? e.selectedSubjects.map((s) => ({ name: s.name || "Subject", quantity: 1, price: (s as { price?: number }).price ?? Math.floor(e.totalFee / (e.selectedSubjects?.length || 1)) }))
    : [{ name: "Enrollment", quantity: 1, price: e.totalFee }];
  return {
    id: e.referenceNumber || e._id,
    _id: e._id,
    date,
    dueDate,
    status,
    items,
    total: e.totalFee,
    paymentOption: e.paymentOption as "full" | "down",
  };
}

export default function StudentPayments() {
  const [invoices, setInvoices] = useState<InvoiceLike[]>(() =>
    fallbackInvoices.map((inv) => ({ ...inv, _id: inv._id || inv.id, paymentOption: inv.paymentOption || "full" }))
  );
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceLike | null>(null);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState("");
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    enrollmentService
      .getMyEnrollments()
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.enrollments) && res.data.enrollments.length > 0) {
          const list = res.data.enrollments.map((e: EnrollmentItem) => mapEnrollmentToInvoice(e));
          setInvoices(list);
          setSelectedInvoice((prev) => (prev ? list.find((i) => i._id === prev._id) || list[0] : list[0]));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const displayInvoices = invoices.length > 0 ? invoices : fallbackInvoices.map((inv) => ({ ...inv, _id: inv._id || inv.id }));
  const currentInvoice = selectedInvoice || displayInvoices[0];
  const StatusIcon = currentInvoice ? statusConfig[currentInvoice.status as keyof typeof statusConfig]?.icon ?? Clock : Clock;

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
                  const status = statusConfig[invoice.status as keyof typeof statusConfig] ?? statusConfig.pending;
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
                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${status.color}`}>
                          {status.label}
                        </span>
                      </div>
                      <p className="font-bold text-lg text-foreground">
                        ₱{invoice.total.toLocaleString()}
                      </p>
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
                      <div
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${
                          (currentInvoice && statusConfig[currentInvoice.status as keyof typeof statusConfig]?.color) ?? statusConfig.pending.color
                        }`}
                      >
                        <StatusIcon className="h-4 w-4" />
                        <span className="font-medium text-sm">
                          {(currentInvoice && statusConfig[currentInvoice.status as keyof typeof statusConfig]?.label) ?? "Pending"}
                        </span>
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
                          <td className="pt-4 text-right font-bold text-xl text-primary">
                            ₱{(currentInvoice?.total ?? 0).toLocaleString()}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {/* Payment Section */}
                  {currentInvoice?.status === "pending" && (
                    <div className="p-6 border-t border-border bg-muted/30">
                      <h4 className="font-semibold text-foreground mb-4">Select Payment Method</h4>
                      <div className="grid sm:grid-cols-3 gap-3 mb-6">
                        {paymentMethods.map((method) => (
                          <div
                            key={method.id}
                            onClick={() => setSelectedPaymentMethod(method.id)}
                            className={`p-4 rounded-xl border-2 cursor-pointer text-center transition-all ${
                              selectedPaymentMethod === method.id
                                ? "border-primary bg-primary/5"
                                : "border-border hover:border-primary/30"
                            }`}
                          >
                            <span className="text-2xl mb-2 block">{method.icon}</span>
                            <span className="text-sm font-medium text-foreground">{method.name}</span>
                          </div>
                        ))}
                      </div>
                      <Button
                        onClick={() => setShowPaymentModal(true)}
                        disabled={!selectedPaymentMethod}
                        className="w-full btn-glow"
                        size="lg"
                      >
                        <CreditCard className="h-4 w-4 mr-2" />
                        Pay ₱{(currentInvoice?.total ?? 0).toLocaleString()}
                      </Button>
                    </div>
                  )}

                  {/* Paid Invoice Actions */}
                  {currentInvoice?.status === "paid" && (
                    <div className="p-6 border-t border-border bg-success/5">
                      <div className="flex items-center gap-3 mb-4">
                        <CheckCircle className="h-5 w-5 text-success" />
                        <p className="text-success font-medium">
                          Paid on {currentInvoice.paidDate ?? "—"}
                        </p>
                      </div>
                      <div className="flex gap-3">
                        <Button variant="outline" className="flex-1">
                          <Download className="h-4 w-4 mr-2" />
                          Download
                        </Button>
                        <Button variant="outline" className="flex-1">
                          <Printer className="h-4 w-4 mr-2" />
                          Print
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            </div>
          </TabsContent>

          <TabsContent value="history" className="mt-6">
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="p-4 border-b border-border">
                <h3 className="font-display font-bold text-lg text-foreground">
                  Payment History
                </h3>
              </div>
              <div className="divide-y divide-border">
                {displayInvoices
                  .filter((inv) => inv.status === "paid")
                  .map((invoice) => (
                    <div
                      key={invoice.id}
                      className="flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-4">
                        <div className="h-10 w-10 rounded-full bg-success/10 flex items-center justify-center">
                          <CheckCircle className="h-5 w-5 text-success" />
                        </div>
                        <div>
                          <p className="font-semibold text-foreground">{invoice.id}</p>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Calendar className="h-3 w-3" />
                            Paid on {invoice.paidDate}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-foreground">₱{invoice.total.toLocaleString()}</p>
                        <p className="text-sm text-success">Completed</p>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Payment Modal – GCash flow with admin details popup */}
      <StudentPaymentModal
        isOpen={showPaymentModal}
        onClose={() => setShowPaymentModal(false)}
        enrollmentId={currentInvoice?._id || undefined}
        preferredPaymentMethod={selectedPaymentMethod === "gcash" ? "gcash" : "blockchain"}
        amount={currentInvoice?.total ?? 0}
        paymentOption={currentInvoice?.paymentOption ?? "full"}
        onPaymentComplete={() => {
          setShowPaymentModal(false);
          enrollmentService.getMyEnrollments().then((res) => {
            if (res.data?.success && Array.isArray(res.data.enrollments) && res.data.enrollments.length > 0) {
              const list = res.data.enrollments.map((e: EnrollmentItem) => mapEnrollmentToInvoice(e));
              setInvoices(list);
              setSelectedInvoice((prev) => (prev ? list.find((i) => i._id === prev._id) || list[0] : list[0]));
            }
          });
        }}
      />
    </DashboardLayout>
  );
}