/**
 * Parent / Guardian Dashboard
 *
 * This is the landing page for authenticated Parent accounts.
 * A parent manages their enrolled child(ren) from here.
 *
 * Current scope:
 *  - View enrolled child info
 *  - Track enrollment status
 *  - View payment info
 *  - Logout
 *
 * Future scope (once scheduling/attendance are linked to enrollments):
 *  - View child's schedule
 *  - View attendance
 *  - View grades / progress
 *  - Announcements
 *  - Messaging with tutor
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { LogOut, User, FileText, CheckCircle2, Clock, XCircle, RefreshCw, Baby, CalendarDays, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { enrollmentService } from "@/services/api";
import beeMascot from "@/assets/bee-mascot.png";

interface EnrollmentRecord {
  _id: string;
  enrollmentId?: string;
  status: string;
  paymentStatus: string;
  studentSnapshot?: { firstName?: string; lastName?: string; birthdate?: string; computedAge?: number } | null;
  packages?: { displayName?: string; price?: number }[];
  totalFee?: number;
  preferredStartDate?: string | null;
  preferredTime?: string | null;
  rejectionReason?: string | null;
  allowResubmission?: boolean;
  studentId?: string | null;
  createdAt?: string;
  payments?: {
    _id: string;
    status: string;
    paymentMethod?: string;
    amountDue?: number;
    proofUrl?: string;
    submittedAt?: string;
    verifiedAt?: string;
  }[];
}

const STATUS_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string; bg: string; desc: string }> = {
  draft:                     { label: "Draft",                  icon: Clock,         color: "text-gray-600",    bg: "bg-gray-50 dark:bg-gray-900/20",      desc: "Your enrollment form is not yet submitted." },
  submitted:                 { label: "Submitted",              icon: Clock,         color: "text-blue-600",    bg: "bg-blue-50 dark:bg-blue-900/20",       desc: "Submitted and awaiting payment verification." },
  payment_under_verification:{ label: "Payment Under Review",  icon: RefreshCw,     color: "text-amber-600",   bg: "bg-amber-50 dark:bg-amber-900/20",     desc: "Our team is verifying your payment. This usually takes 1–2 business days." },
  pending_approval:          { label: "Pending Approval",       icon: Clock,         color: "text-purple-600",  bg: "bg-purple-50 dark:bg-purple-900/20",   desc: "Payment verified! Awaiting final admin approval." },
  approved:                  { label: "Approved",               icon: CheckCircle2,  color: "text-emerald-600", bg: "bg-emerald-50 dark:bg-emerald-900/20", desc: "Enrollment approved! Your child's classes will be scheduled soon." },
  active:                    { label: "Active",                 icon: CheckCircle2,  color: "text-emerald-600", bg: "bg-emerald-50 dark:bg-emerald-900/20", desc: "Enrollment is active. Welcome to Bee Bright!" },
  rejected:                  { label: "Rejected",               icon: XCircle,       color: "text-red-600",     bg: "bg-red-50 dark:bg-red-900/20",         desc: "Enrollment was not approved. See reason below." },
  cancelled:                 { label: "Cancelled",              icon: XCircle,       color: "text-gray-600",    bg: "bg-gray-50 dark:bg-gray-900/20",       desc: "This enrollment has been cancelled." },
};

const TIME_LABELS: Record<string, string> = {
  morning: "Morning (8:00 AM – 12:00 PM)",
  afternoon: "Afternoon (12:00 PM – 6:00 PM)",
  no_preference: "No Preference",
};

const METHOD_LABELS: Record<string, string> = { gcash: "GCash", seabank: "SeaBank", bdo: "BDO" };

export default function ParentDashboard() {
  const { user, logout, authLoading } = useAuth();
  const navigate = useNavigate();
  const [enrollments, setEnrollments] = useState<EnrollmentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Wait for auth to finish loading before deciding to redirect
    if (authLoading) return;
    if (!user) { navigate("/login", { replace: true }); return; }
    enrollmentService
      .getMyEnrollments()
      .then((res) => {
        const data = res.data as { success: boolean; enrollments?: EnrollmentRecord[] };
        if (data?.success && Array.isArray(data.enrollments)) {
          setEnrollments(data.enrollments);
        }
      })
      .catch(() => setError("Failed to load enrollment data. Please try again."))
      .finally(() => setLoading(false));
  }, [user, authLoading, navigate]);

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const parentName = user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() : "Parent";

  // Show full-page spinner while auth context is still initialising
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-40 bg-card border-b border-border shadow-sm">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={beeMascot} alt="Bee Bright" className="h-9 w-9" />
            <div>
              <span className="font-display font-bold text-lg">
                <span className="text-primary">Bee</span> Bright
              </span>
              <p className="text-xs text-muted-foreground leading-none">Parent Portal</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-sm">
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                <User className="h-4 w-4 text-primary" />
              </div>
              <div className="hidden sm:block">
                <p className="font-medium text-foreground text-sm">{parentName}</p>
                <p className="text-xs text-muted-foreground">{user?.email}</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleLogout} className="gap-1.5">
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Logout</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="container mx-auto px-4 py-8 max-w-3xl">

        {/* Welcome */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <h1 className="text-2xl font-bold text-foreground">
            Welcome back, <span className="text-primary">{parentName.split(" ")[0]}</span>!
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Here you can view and track your child's enrollment application.
          </p>
        </motion.div>

        {/* Enrollment cards */}
        {loading ? (
          <div className="flex items-center justify-center py-20 gap-3">
            <RefreshCw className="h-5 w-5 animate-spin text-primary" />
            <span className="text-muted-foreground">Loading your enrollment…</span>
          </div>
        ) : error ? (
          <div className="p-6 bg-red-50 dark:bg-red-900/20 border border-red-200 rounded-xl text-red-700 text-sm">
            {error}
          </div>
        ) : enrollments.length === 0 ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-16 space-y-4">
            <Baby className="h-12 w-12 text-muted-foreground mx-auto" />
            <h2 className="text-lg font-semibold text-foreground">No enrollments yet</h2>
            <p className="text-muted-foreground text-sm">You haven't enrolled your child yet. Click below to get started.</p>
            <Button onClick={() => navigate("/enroll")} className="btn-glow mt-2">
              Enroll Your Child
            </Button>
          </motion.div>
        ) : (
          <div className="space-y-5">
            {enrollments.map((enrollment, idx) => {
              const cfg = STATUS_CONFIG[enrollment.status] ?? STATUS_CONFIG.submitted;
              const StatusIcon = cfg.icon;
              const snap = enrollment.studentSnapshot;
              const childName = snap ? `${snap.firstName || ""} ${snap.lastName || ""}`.trim() : "—";
              const latestPayment = Array.isArray(enrollment.payments) ? enrollment.payments[0] : null;
              const totalFull = (enrollment.packages || []).reduce((s, p) => s + (p.price || 0), 0);
              const amountDue = latestPayment?.amountDue ?? Math.ceil(totalFull * 0.5);

              return (
                <motion.div
                  key={enrollment._id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.1 }}
                  className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm"
                >
                  {/* Status header */}
                  <div className={`px-5 py-4 flex items-start gap-3 ${cfg.bg}`}>
                    <StatusIcon className={`h-5 w-5 flex-shrink-0 mt-0.5 ${cfg.color}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className={`${cfg.color} border-current font-semibold`}>{cfg.label}</Badge>
                        {enrollment.enrollmentId && (
                          <span className="font-mono text-xs text-muted-foreground">{enrollment.enrollmentId}</span>
                        )}
                        {enrollment.studentId && (
                          <span className="text-xs text-emerald-600 font-medium">Student ID: {enrollment.studentId}</span>
                        )}
                      </div>
                      <p className={`text-sm mt-1 ${cfg.color}`}>{cfg.desc}</p>
                    </div>
                  </div>

                  {/* Details */}
                  <div className="p-5 space-y-4">

                    {/* Child info */}
                    <div className="flex items-start gap-3">
                      <div className="h-9 w-9 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0">
                        <Baby className="h-4 w-4 text-amber-600" />
                      </div>
                      <div>
                        <p className="font-semibold text-foreground">{childName}</p>
                        {snap?.birthdate && (
                          <p className="text-xs text-muted-foreground">
                            Born: {new Date(snap.birthdate).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" })}
                            {snap.computedAge ? ` · ${snap.computedAge.toFixed(1)} years old` : ""}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Programs */}
                    {(enrollment.packages || []).length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                          <FileText className="h-3.5 w-3.5 inline mr-1" />Programs
                        </p>
                        <div className="space-y-1">
                          {enrollment.packages!.map((pkg, i) => (
                            <div key={i} className="flex justify-between text-sm">
                              <span className="text-foreground">{pkg.displayName}</span>
                              <span className="text-muted-foreground">₱{(pkg.price || 0).toLocaleString()}</span>
                            </div>
                          ))}
                          <div className="flex justify-between text-sm font-semibold border-t border-border pt-1.5 mt-1.5">
                            <span>Due Now (50% Down)</span>
                            <span className="text-amber-700">₱{amountDue.toLocaleString()}</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Preferred schedule */}
                    {enrollment.preferredStartDate && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <CalendarDays className="h-4 w-4 flex-shrink-0" />
                        <span>
                          Preferred start:{" "}
                          <strong className="text-foreground">
                            {new Date(enrollment.preferredStartDate).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" })}
                          </strong>
                          {enrollment.preferredTime && enrollment.preferredTime !== "no_preference" && (
                            <> · {TIME_LABELS[enrollment.preferredTime] || enrollment.preferredTime}</>
                          )}
                        </span>
                      </div>
                    )}

                    {/* Payment */}
                    {latestPayment && (
                      <div className="p-3 bg-muted/40 rounded-xl text-sm space-y-1">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          <CreditCard className="h-3.5 w-3.5 inline mr-1" />Payment
                        </p>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Method</span>
                          <span>{METHOD_LABELS[latestPayment.paymentMethod || ""] || latestPayment.paymentMethod || "—"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Amount Due</span>
                          <span className="font-medium">₱{(latestPayment.amountDue || 0).toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Status</span>
                          <Badge variant="outline" className={`text-xs ${latestPayment.status === "verified" ? "text-emerald-600 border-emerald-400" : latestPayment.status === "submitted" ? "text-amber-600 border-amber-400" : ""}`}>
                            {latestPayment.status}
                          </Badge>
                        </div>
                        {latestPayment.submittedAt && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Submitted</span>
                            <span className="text-xs">{new Date(latestPayment.submittedAt).toLocaleDateString("en-PH")}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Rejection reason */}
                    {enrollment.status === "rejected" && enrollment.rejectionReason && (
                      <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 rounded-xl text-sm">
                        <p className="font-semibold text-red-800 mb-1">Reason for Rejection</p>
                        <p className="text-red-700">{enrollment.rejectionReason}</p>
                        {enrollment.allowResubmission && (
                          <Button size="sm" variant="outline" className="mt-2 text-xs" onClick={() => navigate("/enroll")}>
                            Resubmit Application
                          </Button>
                        )}
                      </div>
                    )}

                    {/* Enroll another child CTA */}
                    {(enrollment.status === "approved" || enrollment.status === "active") && (
                      <Button variant="outline" size="sm" className="w-full text-xs gap-1.5" onClick={() => navigate("/enroll")}>
                        <Baby className="h-3.5 w-3.5" /> Enroll Another Child
                      </Button>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}

        {/* Enroll another CTA (when has enrollments) */}
        {enrollments.length > 0 && !enrollments.some((e) => e.status === "draft") && (
          <div className="mt-6 text-center">
            <Button variant="ghost" size="sm" onClick={() => navigate("/enroll")} className="text-muted-foreground gap-1.5 text-xs">
              <Baby className="h-3.5 w-3.5" /> Enroll another child
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
