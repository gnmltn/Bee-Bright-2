import { useState, useEffect, lazy, Suspense, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, GraduationCap, Users, Eye, EyeOff, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Navbar } from "@/components/layout/Navbar";
import beeMascot from "@/assets/bee-mascot.png";

const ForgotPasswordModal = lazy(() => import("@/components/ForgotPasswordModal"));

const roles: Array<{
  id: "student" | "tutor";
  name: string;
  icon: typeof GraduationCap;
  description: string;
  sampleEmail: string;
  color: string;
}> = [
  {
    id: "student",
    name: "Student",
    icon: GraduationCap,
    description: "Access your lessons and progress",
    sampleEmail: "student@beebright.com",
    color: "from-primary to-primary/80",
  },
  {
    id: "tutor",
    name: "Tutor",
    icon: Users,
    description: "Manage your classes and students",
    sampleEmail: "tutor@beebright.com",
    color: "from-primary to-primary/80",
  },
];

function formatExpiry(expiresAt?: string) {
  if (!expiresAt) return "Code expires soon.";

  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "Code expires soon.";

  return `Code expires at ${date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}.`;
}

export default function Login() {
  const [selectedRole, setSelectedRole] = useState<"student" | "tutor" | null>(null);
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
  const { startOtpLogin, verifyOtpLogin, isAuthenticated, user, authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const pendingMessage = (location.state as { message?: string })?.message;
  const expiryLabel = useMemo(() => formatExpiry(otpExpiresAt), [otpExpiresAt]);

  const dashboardRoutes: Record<"student" | "tutor" | "admin" | "super_admin", string> = {
    student: "/student-dashboard",
    tutor: "/tutor-dashboard",
    admin: "/admin-dashboard",
    super_admin: "/super-admin-dashboard",
  };

  useEffect(() => {
    const sessionExpired = sessionStorage.getItem("session_expired_message");
    if (sessionExpired) {
      sessionStorage.removeItem("session_expired_message");
      toast({ title: "Session expired", description: sessionExpired, variant: "destructive" });
    }
  }, [toast]);

  const canAccessDashboard = user && (user.role !== "student" || user.enrollmentStatus === "active");

  useEffect(() => {
    if (authLoading) return;
    if (isAuthenticated && canAccessDashboard) {
      navigate(dashboardRoutes[user!.role], { replace: true });
    }
  }, [isAuthenticated, user, authLoading, navigate, canAccessDashboard, dashboardRoutes]);

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

  const handleRoleSelect = (role: "student" | "tutor") => {
    setSelectedRole(role);
    resetOtpStep();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRole) {
      toast({
        title: "Please select a role",
        description: "Choose whether you're a Student or Tutor",
        variant: "destructive",
      });
      return;
    }

    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      const result = await startOtpLogin(email.trim().toLowerCase(), password, selectedRole);
      if (!result.success) {
        if (typeof result.retryAfterSeconds === "number") {
          setResendCountdown(result.retryAfterSeconds);
        }
        if (result.code === "PASSWORD_EXPIRED") {
          setShowForgotPassword(true);
        }
        if (result.code === "SYSTEM_MAINTENANCE") {
          navigate("/maintenance", { replace: true });
          return;
        }

        toast({
          title: "Login failed",
          description: result.message || "Please check your credentials",
          variant: "destructive",
        });
        return;
      }

      if (!result.verificationId) {
        const role = result.user?.role ?? selectedRole;
        toast({
          title: "Welcome back!",
          description: result.message || "Logged in using trusted device.",
        });
        window.location.replace(dashboardRoutes[role]);
        return;
      }

      setVerificationId(result.verificationId);
      setMaskedEmail(result.maskedEmail || "");
      setOtpExpiresAt(result.expiresAt);
      setOtpCode("");
      setShowOtpStep(true);
      setResendCountdown(result.nextResendAvailableInSeconds || 0);
      toast({
        title: "Verification code sent",
        description: result.message || "Please check your email for the code.",
      });
      if (result.devOtp) {
        toast({
          title: "Development OTP",
          description: result.devOtp,
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerifyOtp = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!selectedRole || !verificationId || !otpCode.trim() || isVerifyingOtp) return;

    setIsVerifyingOtp(true);
    try {
      const result = await verifyOtpLogin(
        email.trim().toLowerCase(),
        verificationId,
        otpCode.trim(),
        selectedRole
      );

      if (!result.success) {
        if (result.code === "SYSTEM_MAINTENANCE") {
          navigate("/maintenance", { replace: true });
          return;
        }

        toast({
          title: "Verification failed",
          description: result.message || "Please try again.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "Welcome back!",
        description: `Logged in as ${selectedRole}`,
      });
      const role = result.user?.role ?? selectedRole;
      window.location.replace(dashboardRoutes[role]);
    } finally {
      setIsVerifyingOtp(false);
    }
  };

  const handleResendOtp = async () => {
    if (!selectedRole || !email.trim() || !password || isResendingOtp || resendCountdown > 0) return;

    setIsResendingOtp(true);
    try {
      const result = await startOtpLogin(email.trim().toLowerCase(), password, selectedRole);
      if (!result.success) {
        if (typeof result.retryAfterSeconds === "number") {
          setResendCountdown(result.retryAfterSeconds);
        }

        toast({
          title: "Resend unavailable",
          description: result.message || "Could not send another code yet.",
          variant: "destructive",
        });
        return;
      }

      if (!result.verificationId) {
        const role = result.user?.role ?? selectedRole;
        toast({
          title: "Welcome back!",
          description: result.message || "Logged in using trusted device.",
        });
        window.location.replace(dashboardRoutes[role]);
        return;
      }

      setVerificationId(result.verificationId);
      setMaskedEmail(result.maskedEmail || "");
      setOtpExpiresAt(result.expiresAt);
      setOtpCode("");
      setShowOtpStep(true);
      setResendCountdown(result.nextResendAvailableInSeconds || 0);
      toast({
        title: "Verification code sent",
        description: result.message || "Please check your email for the code.",
      });
      if (result.devOtp) {
        toast({
          title: "Development OTP",
          description: result.devOtp,
        });
      }
    } finally {
      setIsResendingOtp(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (isAuthenticated && canAccessDashboard) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">Redirecting to dashboard...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="pt-24 flex items-center justify-center p-4">
        <div className="w-full max-w-4xl">
          {pendingMessage && (
            <div className="mb-4 p-4 rounded-lg bg-warning/10 text-warning border border-warning/20 text-sm text-center">
              {pendingMessage}
            </div>
          )}

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center mb-8"
          >
            <img src={beeMascot} alt="Bee Bright" className="h-20 w-20 mx-auto mb-4" />
            <h1 className="font-display text-3xl md:text-4xl font-bold mb-2">
              <span className="text-primary">Bee</span>
              <span className="text-foreground"> Bright</span> Login
            </h1>
            <p className="text-muted-foreground">
              {showOtpStep ? "Finish login with the code sent to your email" : "Select your role to continue"}
            </p>
          </motion.div>

          <div className="flex justify-center gap-4 mb-8">
            <div className="grid grid-cols-2 gap-4 max-w-xl mx-auto">
              {roles.map((role, index) => (
                <motion.div
                  key={role.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.1 }}
                >
                  <Card
                    className={`cursor-pointer transition-all duration-300 hover:shadow-lg ${
                      selectedRole === role.id ? "ring-2 ring-primary border-primary" : "hover:border-primary/50"
                    }`}
                    onClick={() => handleRoleSelect(role.id)}
                  >
                    <CardHeader className="text-center pb-2">
                      <div
                        className={`w-16 h-16 mx-auto rounded-full bg-gradient-to-br ${role.color} flex items-center justify-center mb-3`}
                      >
                        <role.icon className="h-8 w-8 text-primary-foreground" />
                      </div>
                      <CardTitle className="text-xl">{role.name}</CardTitle>
                      <CardDescription>{role.description}</CardDescription>
                    </CardHeader>
                  </Card>
                </motion.div>
              ))}
            </div>
          </div>

          <motion.div initial={{ opacity: 0 }} animate={{ opacity: selectedRole ? 1 : 0.6 }}>
            <Card className="max-w-md mx-auto">
              <CardHeader>
                <CardTitle>{showOtpStep ? "Verify your email code" : "Enter your credentials"}</CardTitle>
                <CardDescription>
                  {showOtpStep
                    ? "Use the 6-digit code we sent to your email to finish signing in."
                    : selectedRole
                      ? "Enter your registered account credentials"
                      : "Select a role above first, then enter credentials"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!showOtpStep ? (
                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder={
                          selectedRole
                            ? roles.find((role) => role.id === selectedRole)?.sampleEmail || "your@email.com"
                            : "your@email.com"
                        }
                        value={email}
                        onChange={(e) => setEmail(e.target.value.toLowerCase())}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        required
                        disabled={!selectedRole}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="password">Password</Label>
                      <div className="relative">
                        <Input
                          id="password"
                          type={showPassword ? "text" : "password"}
                          placeholder="••••••••"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          required
                          disabled={!selectedRole}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          tabIndex={-1}
                        >
                          {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      After your password is confirmed, we&apos;ll send a one-time verification code to your email.
                    </p>
                    <Button type="submit" className="w-full btn-glow" size="lg" disabled={!selectedRole || isSubmitting}>
                      {isSubmitting
                        ? "Sending code..."
                        : `Send Code for ${selectedRole ? roles.find((role) => role.id === selectedRole)?.name : "..."}`}
                    </Button>
                    <p className="mt-4 text-center text-sm text-muted-foreground">
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
                      <Label htmlFor="otp">Email OTP</Label>
                      <Input
                        id="otp"
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
                      <Button type="button" variant="ghost" className="flex-1" onClick={resetOtpStep}>
                        <ArrowLeft className="mr-2 h-4 w-4" />
                        Back
                      </Button>
                    </div>
                  </form>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </div>

      {showForgotPassword && (
        <Suspense fallback={null}>
          <ForgotPasswordModal defaultEmail={email} onClose={() => setShowForgotPassword(false)} />
        </Suspense>
      )}
    </div>
  );
}
