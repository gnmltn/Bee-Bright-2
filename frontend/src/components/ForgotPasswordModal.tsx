import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { authService } from "@/services/api"; // adjust path if yours is different

type Props = {
  defaultEmail?: string;
  onClose: () => void;
};

type Step = "request" | "verify";

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

export default function ForgotPasswordModal({ defaultEmail = "", onClose }: Props) {
  const { toast } = useToast();

  const [step, setStep] = useState<Step>("request");
  const [email, setEmail] = useState(defaultEmail.toLowerCase());
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  

  const [loading, setLoading] = useState(false);

  // Close on ESC
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

const requestOtp = async () => {
  if (!email.trim()) {
    toast({ title: "Email required", variant: "destructive" });
    return;
  }

  setLoading(true);
  try {
    const res = await authService.forgotPassword(email.trim().toLowerCase());
    const data = res.data as { success: boolean; message?: string; devOtp?: string };

    if (!data.success) {
      toast({
        title: "Failed to send OTP",
        description: data.message || "Please try again.",
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "OTP sent",
      description: data.message || "Check your email. Code expires in 5 minutes.",
    });
    if (data.devOtp) {
      toast({
        title: "Development OTP",
        description: data.devOtp,
      });
    }
    setStep("verify");
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.message || "Backend not reachable.";
    // 429 = cooldown: OTP was already sent; show "please wait" (not "failed")
    if (status === 429) {
      toast({
        title: "Please wait",
        description: msg,
        variant: "destructive",
      });
    } else {
      toast({
        title: "Failed to send OTP",
        description: msg,
        variant: "destructive",
      });
    }
  } finally {
    setLoading(false);
  }
};

const resetPassword = async () => {
  if (otp.trim().length !== 6) {
    toast({
      title: "OTP required",
      description: "Enter the 6-digit code from your email.",
      variant: "destructive",
    });
    return;
  }

  if (!newPassword.trim()) {
    toast({ title: "New password required", variant: "destructive" });
    return;
  }
  if (!PASSWORD_REGEX.test(newPassword.trim())) {
    toast({
      title: "Weak password",
      description: "Password must be at least 8 characters and include uppercase, lowercase, number, and special character.",
      variant: "destructive",
    });
    return;
  }
  setLoading(true);
  try {
    const res = await authService.resetPassword({
      email: email.trim().toLowerCase(),
      otp,
      newPassword: newPassword.trim(),
    });
    const data = res.data;

    if (!data.success) {
      toast({
        title: "Reset failed",
        description: data.message || "Invalid/expired code.",
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Password updated",
      description: "You can now log in with your new password.",
    });
    onClose();
  } catch (err: any) {
    const msg = err?.response?.data?.message || "Backend not reachable.";
    toast({
      title: "Reset failed",
      description: msg,
      variant: "destructive",
    });
  } finally {
    setLoading(false);
  }
};

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-card border border-border shadow-xl">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="font-semibold text-foreground">Forgot Password</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-md hover:bg-muted"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="space-y-2">
            <Label>Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value.toLowerCase())}
              placeholder="your@email.com"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={step === "verify"} // lock email after sending OTP
            />
          </div>

          {step === "request" ? (
            <>
              <p className="text-sm text-muted-foreground">
                We’ll send a 6-digit OTP to your email (valid for 5 minutes).
              </p>
              <Button className="w-full" onClick={requestOtp} disabled={loading}>
                {loading ? "Sending..." : "Send OTP"}
              </Button>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>OTP Code</Label>
                <Input
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="Enter OTP"
                  inputMode="numeric"
                  maxLength={6}
                />
              </div>

              <div className="space-y-2">
                <Label>New Password</Label>
                <PasswordInput
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password"
                />
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => setStep("request")}
                  disabled={loading}
                >
                  Back
                </Button>
                <Button className="w-full" onClick={resetPassword} disabled={loading}>
                  {loading ? "Updating..." : "Reset Password"}
                </Button>
              </div>

              <button
                type="button"
                className="text-sm text-primary hover:underline"
                onClick={requestOtp}
                disabled={loading}
              >
                Resend OTP
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
