import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Eye, EyeOff, RotateCcw, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { Navbar } from "@/components/layout/Navbar";
import ForgotPasswordModal from "@/components/ForgotPasswordModal";
import beeMascot from "@/assets/bee-mascot.png";

function formatExpiry(expiresAt?: string) {
  if (!expiresAt) return "Code expires soon.";

  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "Code expires soon.";

  return `Code expires at ${date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}.`;
}

export default function AdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [verificationId, setVerificationId] = useState("");
  const [maskedEmail, setMaskedEmail] = useState("");
  const [otpExpiresAt, setOtpExpiresAt] = useState<string | undefined>();
  const [showOtpStep, setShowOtpStep] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);
  const [isResendingOtp, setIsResendingOtp] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(0);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const {
    startPrivilegedLogin,
    verifyPrivilegedLogin,
    isAuthenticated,
    user,
    authLoading,
  } = useAuth();
  const navigate = useNavigate();

  const dashboardRoute = user?.role === "super_admin" ? "/super-admin-dashboard" : "/admin-dashboard";
  const canAccessDashboard = user && (user.role === "admin" || user.role === "super_admin");
  const expiryLabel = useMemo(() => formatExpiry(otpExpiresAt), [otpExpiresAt]);

  useEffect(() => {
    if (authLoading) return;
    if (isAuthenticated && canAccessDashboard) {
      navigate(dashboardRoute, { replace: true });
    }
  }, [isAuthenticated, authLoading, navigate, canAccessDashboard, dashboardRoute]);

  useEffect(() => {
    if (resendCountdown <= 0) return;

    const timer = window.setInterval(() => {
      setResendCountdown((current) => {
        if (current <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return current - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [resendCountdown]);

  const resetOtpStep = () => {
    setShowOtpStep(false);
    setOtpCode("");
    setVerificationId("");
    setMaskedEmail("");
    setOtpExpiresAt(undefined);
    setResendCountdown(0);
  };

  const handleStartLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    try {
      const result = await startPrivilegedLogin(email.trim().toLowerCase(), password);
      if (!result.success) {
        if (typeof result.retryAfterSeconds === "number") {
          setResendCountdown(result.retryAfterSeconds);
        }
        if (result.code === "PASSWORD_EXPIRED") {
          setShowForgotPassword(true);
        }
        toast.error(result.message || "Please check your credentials.");
        return;
      }

      if (!result.verificationId) {
        const role = result.user?.role;
        toast.success(result.message || "Logged in using trusted device.");
        window.location.replace(role === "super_admin" ? "/super-admin-dashboard" : "/admin-dashboard");
        return;
      }

      setVerificationId(result.verificationId);
      setMaskedEmail(result.maskedEmail || "");
      setOtpExpiresAt(result.expiresAt);
      setOtpCode("");
      setShowOtpStep(true);
      setResendCountdown(result.nextResendAvailableInSeconds || 0);
      toast.success(result.message || "Verification code sent.");
      if (result.devOtp) {
        toast.info(`Development OTP: ${result.devOtp}`);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerifyOtp = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isVerifyingOtp || !verificationId || !otpCode.trim()) return;

    setIsVerifyingOtp(true);
    try {
      const result = await verifyPrivilegedLogin(
        email.trim().toLowerCase(),
        verificationId,
        otpCode.trim()
      );

      if (!result.success) {
        toast.error(result.message || "Invalid verification code.");
        return;
      }

      toast.success("Welcome back! Logged in successfully.");
      const role = result.user?.role;
      window.location.replace(role === "super_admin" ? "/super-admin-dashboard" : "/admin-dashboard");
    } finally {
      setIsVerifyingOtp(false);
    }
  };

  const handleResendOtp = async () => {
    if (isResendingOtp || !email.trim() || !password) return;

    setIsResendingOtp(true);
    try {
      const result = await startPrivilegedLogin(email.trim().toLowerCase(), password);
      if (!result.success) {
        if (typeof result.retryAfterSeconds === "number") {
          setResendCountdown(result.retryAfterSeconds);
        }
        toast.error(result.message || "Could not send another code right now.");
        return;
      }

      if (!result.verificationId) {
        const role = result.user?.role;
        toast.success(result.message || "Logged in using trusted device.");
        window.location.replace(role === "super_admin" ? "/super-admin-dashboard" : "/admin-dashboard");
        return;
      }

      setVerificationId(result.verificationId);
      setMaskedEmail(result.maskedEmail || "");
      setOtpExpiresAt(result.expiresAt);
      setOtpCode("");
      setShowOtpStep(true);
      setResendCountdown(result.nextResendAvailableInSeconds || 0);
      toast.success(result.message || "Verification code sent.");
      if (result.devOtp) {
        toast.info(`Development OTP: ${result.devOtp}`);
      }
    } finally {
      setIsResendingOtp(false);
    }
  };

  if (authLoading || (isAuthenticated && canAccessDashboard)) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar />
        <div className="pt-24 flex flex-col items-center justify-center gap-4 min-h-[calc(100vh-6rem)]">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" />
          {isAuthenticated && canAccessDashboard && (
            <p className="text-sm text-muted-foreground">Redirecting to admin dashboard...</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="pt-24 flex flex-col items-center justify-center p-4 min-h-[calc(100vh-6rem)]">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <img src={beeMascot} alt="Bee Bright" className="h-20 w-20 mx-auto mb-4" />
            <h1 className="font-display text-3xl md:text-4xl font-bold mb-2">
              <span className="text-primary">Bee</span>
              <span className="text-foreground"> Bright</span> Admin Login
            </h1>
            <p className="text-muted-foreground">
              {showOtpStep ? "Finish login with your email verification code" : "Administrator access only"}
            </p>
          </div>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-center gap-2 mb-2">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-accent to-accent/80 flex items-center justify-center">
                  <Shield className="h-6 w-6 text-primary-foreground" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {!showOtpStep ? (
                <form onSubmit={handleStartLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="admin-email">Email</Label>
                    <Input
                      id="admin-email"
                      type="email"
                      placeholder="admin@beebright.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value.toLowerCase())}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="admin-password">Password</Label>
                    <div className="relative">
                      <Input
                        id="admin-password"
                        type={showPassword ? "text" : "password"}
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        tabIndex={-1}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    After your password is confirmed, we&apos;ll send a one-time verification code to your admin email.
                  </p>
                  <Button
                    type="submit"
                    className="w-full btn-glow"
                    size="lg"
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? "Sending code..." : "Send Verification Code"}
                  </Button>
                  <p className="text-center text-sm text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => setShowForgotPassword(true)}
                      className="text-primary hover:underline"
                    >
                      Forgot Password?
                    </button>
                  </p>
                </form>
              ) : (
                <form onSubmit={handleVerifyOtp} className="space-y-4">
                  <div className="rounded-xl border border-border/70 bg-muted/30 p-4 space-y-2">
                    <p className="text-sm font-medium text-foreground">Verification code sent</p>
                    <p className="text-sm text-muted-foreground">
                      Enter the 6-digit code sent to <span className="font-medium text-foreground">{maskedEmail || email}</span>.
                    </p>
                    <p className="text-xs text-muted-foreground">{expiryLabel}</p>
                    <p className="text-xs text-muted-foreground">
                      You can resend once immediately, then the wait becomes 3 minutes, then 5 minutes for the next resends.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="admin-otp">Email OTP</Label>
                    <Input
                      id="admin-otp"
                      type="text"
                      inputMode="numeric"
                      placeholder="Enter 6-digit code"
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      maxLength={6}
                      autoComplete="one-time-code"
                      required
                    />
                  </div>

                  <Button
                    type="submit"
                    className="w-full btn-glow"
                    size="lg"
                    disabled={isVerifyingOtp || otpCode.trim().length !== 6}
                  >
                    {isVerifyingOtp ? "Verifying..." : "Verify and Login"}
                  </Button>

                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={handleResendOtp}
                      disabled={isResendingOtp || resendCountdown > 0}
                    >
                      <RotateCcw className="mr-2 h-4 w-4" />
                      {isResendingOtp
                        ? "Sending..."
                        : resendCountdown > 0
                          ? `Resend in ${Math.ceil(resendCountdown / 60)}m`
                          : "Resend Code"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="flex-1"
                      onClick={resetOtpStep}
                    >
                      <ArrowLeft className="mr-2 h-4 w-4" />
                      Back
                    </Button>
                  </div>
                </form>
              )}

              <p className="mt-4 text-center text-sm text-muted-foreground">
                Not an admin?{" "}
                <Link to="/login" className="text-primary hover:underline">
                  Go to regular login
                </Link>
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
      {showForgotPassword && (
        <ForgotPasswordModal defaultEmail={email} onClose={() => setShowForgotPassword(false)} />
      )}
    </div>
  );
}
