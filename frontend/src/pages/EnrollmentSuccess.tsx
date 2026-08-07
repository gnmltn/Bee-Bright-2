import { useSearchParams } from "react-router-dom";
import { CheckCircle2, Search, LogIn, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout/Layout";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";

export default function EnrollmentSuccess() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const enrollmentId = params.get('id') || '';

  return (
    <Layout>
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 via-background to-amber-50 py-16">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
          className="max-w-md w-full mx-4"
        >
          <div className="bg-card rounded-2xl shadow-xl border border-emerald-200 p-8 text-center space-y-6">
            {/* Icon */}
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
              className="flex items-center justify-center"
            >
              <div className="h-20 w-20 rounded-full bg-emerald-100 flex items-center justify-center">
                <CheckCircle2 className="h-10 w-10 text-emerald-600" />
              </div>
            </motion.div>

            {/* Text */}
            <div>
              <div className="text-3xl mb-2">🐝</div>
              <h1 className="text-2xl font-bold text-foreground">Enrollment Submitted!</h1>
              <p className="text-muted-foreground mt-2">
                Thank you! Your enrollment application has been received and your payment proof is under review.
              </p>
            </div>

            {/* Enrollment ID */}
            {enrollmentId && (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl">
                <p className="text-xs text-amber-700 font-medium uppercase tracking-wide mb-1">Your Enrollment ID</p>
                <p className="text-xl font-mono font-bold text-amber-800">{enrollmentId}</p>
                <p className="text-xs text-amber-600 mt-1">Save this — you'll need it to track your application.</p>
              </div>
            )}

            {/* Timeline */}
            <div className="text-left space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">What happens next?</p>
              {[
                { step: '1–2 business days', desc: 'Admin verifies your payment proof.' },
                { step: 'After verification',  desc: 'Enrollment is reviewed and approved.' },
                { step: 'After approval',       desc: "You'll receive a confirmation email with your student account." },
              ].map((item, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <span className="flex-shrink-0 h-5 w-5 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-xs font-bold">{i + 1}</span>
                  <span className="text-muted-foreground"><strong className="text-foreground">{item.step}:</strong> {item.desc}</span>
                </div>
              ))}
            </div>

            {/* Buttons */}
            <div className="flex flex-col gap-2 pt-2">
              {enrollmentId && (
                <Button variant="outline" className="gap-2 w-full" onClick={() => navigate(`/track-enrollment?enrollmentId=${enrollmentId}`)}>
                  <Search className="h-4 w-4" /> Track My Enrollment
                </Button>
              )}
              <Button variant="outline" className="gap-2 w-full" onClick={() => navigate('/login')}>
                <LogIn className="h-4 w-4" /> Log In Later
              </Button>
              <Link to="/">
                <Button variant="ghost" className="gap-2 w-full">
                  <Home className="h-4 w-4" /> Back to Home
                </Button>
              </Link>
            </div>

            <p className="text-xs text-muted-foreground">A confirmation email has been sent to your registered email address.</p>
          </div>
        </motion.div>
      </div>
    </Layout>
  );
}
