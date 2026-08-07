/**
 * Public enrollment tracking page.
 * Route: /track-enrollment
 * Parents enter their Enrollment ID + email to check status.
 */
import { useState, useEffect } from 'react';
import { Search, CheckCircle2, Clock, XCircle, AlertCircle, Upload, RefreshCw } from 'lucide-react';
import { Layout } from '@/components/layout/Layout';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { enrollmentService } from '@/services/api';
import { useNavigate, useSearchParams } from 'react-router-dom';

interface TrackResult {
  enrollmentId: string;
  status: string;
  statusLabel: string;
  studentName: string;
  submittedAt: string;
  rejectionReason: string | null;
  allowResubmission: boolean;
  paymentStatus: string;
  payment: {
    status: string;
    paymentMethod: string;
    amountDue: number;
    submittedAt: string | null;
    resubmissionCount: number;
    referenceNumber: string | null;
  } | null;
}

const STATUS_CONFIG: Record<string, { icon: React.ElementType; color: string; bg: string; border: string; desc: string }> = {
  draft:                    { icon: Clock,         color: 'text-gray-600',    bg: 'bg-gray-50',    border: 'border-gray-200',   desc: 'Your enrollment form is not yet submitted.' },
  submitted:                { icon: Clock,         color: 'text-blue-600',    bg: 'bg-blue-50',    border: 'border-blue-200',   desc: 'Your enrollment has been submitted. Please upload payment proof if not yet done.' },
  payment_under_verification:{ icon: RefreshCw,    color: 'text-amber-600',   bg: 'bg-amber-50',   border: 'border-amber-200',  desc: 'Our team is verifying your payment proof. This usually takes 1–2 business days.' },
  pending_approval:         { icon: Clock,         color: 'text-purple-600',  bg: 'bg-purple-50',  border: 'border-purple-200', desc: 'Payment verified! Your enrollment is awaiting final admin approval.' },
  approved:                 { icon: CheckCircle2,  color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200',desc: 'Congratulations! Your enrollment has been approved. Check your email for next steps.' },
  active:                   { icon: CheckCircle2,  color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200',desc: 'Your enrollment is active. Welcome to Bee Bright!' },
  rejected:                 { icon: XCircle,       color: 'text-red-600',     bg: 'bg-red-50',     border: 'border-red-200',    desc: 'Your enrollment was not approved. See reason below.' },
  cancelled:                { icon: XCircle,       color: 'text-gray-600',    bg: 'bg-gray-50',    border: 'border-gray-200',   desc: 'This enrollment has been cancelled.' },
};

const PAYMENT_METHOD_LABELS: Record<string, string> = { gcash: 'GCash', seabank: 'SeaBank', bdo: 'BDO' };

export default function EnrollmentTracking() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Pre-fill from URL query param (?enrollmentId=BB-...)
  const [enrollmentId, setEnrollmentId] = useState(
    () => searchParams.get('enrollmentId')?.trim().toUpperCase() || ''
  );
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TrackResult | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [emailMismatch, setEmailMismatch] = useState(false);

  const handleTrack = async () => {
    const trimId = enrollmentId.trim().toUpperCase();
    const trimEmail = email.trim().toLowerCase();
    if (!trimId || !trimEmail) {
      toast({ title: 'Missing fields', description: 'Enter your Enrollment ID and registered email.', variant: 'destructive' });
      return;
    }
    setLoading(true);
    setResult(null);
    setNotFound(false);
    setEmailMismatch(false);
    try {
      const res = await enrollmentService.trackEnrollment(trimId, trimEmail);
      const data = (res.data as { enrollment: TrackResult }).enrollment;
      setResult(data);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 403) {
        setEmailMismatch(true); // enrollment exists but email doesn't match
      } else if (status === 404) {
        setNotFound(true);
      } else {
        toast({ title: 'Error', description: 'Failed to look up enrollment. Please try again.', variant: 'destructive' });
      }
    } finally {
      setLoading(false);
    }
  };

  const cfg = result ? (STATUS_CONFIG[result.status] || STATUS_CONFIG.submitted) : null;

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-amber-50 via-background to-amber-50 py-16">
        <div className="container mx-auto px-4 max-w-lg">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="text-4xl mb-3">🐝</div>
            <h1 className="text-2xl font-bold">Track Your Enrollment</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Enter your Enrollment ID and registered email to check your application status.
            </p>
          </div>

          {/* Search form */}
          <div className="bg-card border border-border rounded-2xl p-6 shadow-md space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="trackId">Enrollment ID</Label>
              <Input
                id="trackId"
                placeholder="BB-20260803-0001"
                value={enrollmentId}
                onChange={(e) => { setEnrollmentId(e.target.value.toUpperCase()); setNotFound(false); setEmailMismatch(false); setResult(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleTrack(); }}
                className="font-mono tracking-wider"
              />
              <p className="text-xs text-muted-foreground">This was sent to your email after submitting the enrollment form.</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="trackEmail">Registered Email</Label>
              <Input
                id="trackEmail"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setNotFound(false); setEmailMismatch(false); setResult(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleTrack(); }}
              />
            </div>

            <Button
              onClick={handleTrack}
              disabled={loading}
              className="w-full bg-amber-500 hover:bg-amber-600 text-white gap-2"
            >
              {loading
                ? <><RefreshCw className="h-4 w-4 animate-spin" /> Searching…</>
                : <><Search className="h-4 w-4" /> Check Status</>
              }
            </Button>
          </div>

          {/* Not found */}
          {notFound && (
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-xl flex gap-3">
              <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-red-800 text-sm">Enrollment not found</p>
                <p className="text-red-700 text-xs mt-0.5">
                  No enrollment matches this ID. Double-check the Enrollment ID (e.g. BB-20260805-0001) and try again.
                </p>
              </div>
            </div>
          )}

          {/* Email mismatch */}
          {emailMismatch && (
            <div className="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-xl flex gap-3">
              <AlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-800 text-sm">Email does not match</p>
                <p className="text-amber-700 text-xs mt-0.5">
                  The enrollment ID was found, but the email address you entered doesn't match the registered email.
                  Please use the exact email you registered with.
                </p>
              </div>
            </div>
          )}

          {/* Result */}
          {result && cfg && (
            <div className={`mt-4 rounded-2xl border-2 ${cfg.border} overflow-hidden`}>
              {/* Status header */}
              <div className={`p-5 ${cfg.bg}`}>
                <div className="flex items-start gap-3">
                  <cfg.icon className={`h-6 w-6 flex-shrink-0 mt-0.5 ${cfg.color}`} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-bold text-foreground">{result.statusLabel}</p>
                      <Badge variant="outline" className={`${cfg.color} border-current text-xs`}>{result.status}</Badge>
                    </div>
                    <p className={`text-sm mt-1 ${cfg.color}`}>{cfg.desc}</p>
                  </div>
                </div>
              </div>

              {/* Details */}
              <div className="p-5 space-y-4 bg-card">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Enrollment ID</span>
                    <span className="font-mono font-bold text-foreground">{result.enrollmentId}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Student</span>
                    <span className="font-medium">{result.studentName || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Submitted</span>
                    <span>{result.submittedAt ? new Date(result.submittedAt).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}</span>
                  </div>
                </div>

                {/* Payment info */}
                {result.payment && (
                  <div className="p-3 bg-muted rounded-xl space-y-1.5 text-sm">
                    <p className="font-semibold text-foreground text-xs uppercase tracking-wide mb-2">Payment</p>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Method</span>
                      <span>{PAYMENT_METHOD_LABELS[result.payment.paymentMethod] || result.payment.paymentMethod || '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Amount Due</span>
                      <span className="font-medium">₱{(result.payment.amountDue || 0).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Payment Status</span>
                      <Badge variant={result.payment.status === 'verified' ? 'default' : 'outline'}
                        className={result.payment.status === 'verified' ? 'bg-emerald-100 text-emerald-800' : ''}>
                        {result.payment.status}
                      </Badge>
                    </div>
                    {result.payment.resubmissionCount > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Resubmissions</span>
                        <span>{result.payment.resubmissionCount}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Rejection reason */}
                {result.status === 'rejected' && result.rejectionReason && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm">
                    <p className="font-semibold text-red-800 mb-1">Reason for Rejection</p>
                    <p className="text-red-700">{result.rejectionReason}</p>
                  </div>
                )}

                {/* CTA buttons */}
                <div className="flex flex-col gap-2 pt-2">
                  {(result.status === 'submitted' && result.payment?.status === 'pending') && (
                    <Button variant="outline" className="gap-2 w-full" onClick={() => navigate('/enroll')}>
                      <Upload className="h-4 w-4" /> Upload Payment Proof
                    </Button>
                  )}
                  {result.allowResubmission && (
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
                      <p className="font-semibold mb-1">Resubmission Allowed</p>
                      <p>Log in to your parent account to upload new payment proof and resubmit your application.</p>
                    </div>
                  )}
                  {(result.status === 'approved' || result.status === 'active') && (
                    <Button className="bg-emerald-600 hover:bg-emerald-700 text-white w-full gap-2" onClick={() => navigate('/login')}>
                      <CheckCircle2 className="h-4 w-4" /> Log In to Your Dashboard
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Footer help */}
          <p className="text-center text-xs text-muted-foreground mt-6">
            Need help? Contact us at{' '}
            <a href="mailto:beebright@gmail.com" className="text-amber-600 hover:underline">beebright@gmail.com</a>
          </p>
        </div>
      </div>
    </Layout>
  );
}
