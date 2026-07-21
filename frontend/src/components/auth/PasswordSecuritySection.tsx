import { useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { useToast } from "@/hooks/use-toast";
import { authService } from "@/services/api";

type Props = {
  passwordExpired?: boolean;
  passwordExpiresAt?: string;
  passwordExpiresInDays?: number;
  onPasswordSecurityUpdate?: (updates: {
    passwordChangedAt?: string;
    passwordExpiresAt?: string;
    passwordExpired?: boolean;
    passwordExpiresInDays?: number;
  }) => void;
};

const PASSWORD_MESSAGE =
  "Password must be at least 8 characters long and include uppercase, lowercase, number, and special character.";
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

function formatExpirySummary(passwordExpired?: boolean, passwordExpiresAt?: string, passwordExpiresInDays?: number) {
  if (passwordExpired) {
    return "Your password has expired. Change it now to keep your account secure.";
  }

  if (!passwordExpiresAt) {
    return "Passwords expire every 30 days and require an email verification code before they can be changed.";
  }

  const expiresAt = new Date(passwordExpiresAt);
  const formattedDate = Number.isNaN(expiresAt.getTime())
    ? "soon"
    : expiresAt.toLocaleString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

  if (typeof passwordExpiresInDays === "number") {
    return `Your password expires in ${passwordExpiresInDays} day(s), on ${formattedDate}.`;
  }

  return `Your password expires on ${formattedDate}.`;
}

export function PasswordSecuritySection({
  passwordExpired,
  passwordExpiresAt,
  passwordExpiresInDays,
  onPasswordSecurityUpdate,
}: Props) {
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [otpExpiresAt, setOtpExpiresAt] = useState<string | undefined>();
  const [codeSent, setCodeSent] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  const expirySummary = useMemo(
    () => formatExpirySummary(passwordExpired, passwordExpiresAt, passwordExpiresInDays),
    [passwordExpired, passwordExpiresAt, passwordExpiresInDays]
  );

  const codeExpirySummary = useMemo(() => {
    if (!otpExpiresAt) return "Verification code expires in 5 minutes.";
    const expiresAt = new Date(otpExpiresAt);
    if (Number.isNaN(expiresAt.getTime())) return "Verification code expires in 5 minutes.";
    return `Verification code expires at ${expiresAt.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })}.`;
  }, [otpExpiresAt]);

  const resetForm = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setOtp("");
    setOtpExpiresAt(undefined);
    setCodeSent(false);
  };

  const validateBeforeSendingCode = () => {
    if (!currentPassword) {
      toast({
        title: "Current password required",
        description: "Enter your current password first.",
        variant: "destructive",
      });
      return false;
    }

    if (!PASSWORD_REGEX.test(newPassword)) {
      toast({
        title: "Invalid new password",
        description: PASSWORD_MESSAGE,
        variant: "destructive",
      });
      return false;
    }

    if (newPassword !== confirmPassword) {
      toast({
        title: "Passwords do not match",
        description: "Confirm your new password before continuing.",
        variant: "destructive",
      });
      return false;
    }

    return true;
  };

  const handleSendCode = async () => {
    if (sendingCode || !validateBeforeSendingCode()) return;

    setSendingCode(true);
    try {
      const { data } = await authService.requestPasswordChangeCode({
        currentPassword,
        newPassword,
      });

      if (!data?.success) {
        toast({
          title: "Could not send code",
          description: data?.message || "Please try again.",
          variant: "destructive",
        });
        return;
      }

      setCodeSent(true);
      setOtp("");
      setOtpExpiresAt((data as { expiresAt?: string }).expiresAt);
      toast({
        title: "Verification code sent",
        description: data.message || "Check your email for the code.",
      });
    } catch (error: any) {
      toast({
        title: "Could not send code",
        description: error?.response?.data?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSendingCode(false);
    }
  };

  const handleChangePassword = async () => {
    if (changingPassword || !validateBeforeSendingCode()) return;

    if (otp.trim().length !== 6) {
      toast({
        title: "Verification code required",
        description: "Enter the 6-digit email code before changing your password.",
        variant: "destructive",
      });
      return;
    }

    setChangingPassword(true);
    try {
      const { data } = await authService.changePassword({
        currentPassword,
        newPassword,
        otp: otp.trim(),
      });

      if (!data?.success) {
        toast({
          title: "Could not change password",
          description: data?.message || "Please try again.",
          variant: "destructive",
        });
        return;
      }

      onPasswordSecurityUpdate?.({
        passwordChangedAt: data.passwordChangedAt,
        passwordExpiresAt: data.passwordExpiresAt,
        passwordExpired: data.passwordExpired,
        passwordExpiresInDays: data.passwordExpiresInDays,
      });
      toast({
        title: "Password updated",
        description: data.message || "Your password has been changed successfully.",
      });
      resetForm();
    } catch (error: any) {
      toast({
        title: "Could not change password",
        description: error?.response?.data?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="h-5 w-5" />
          Password & Security
        </CardTitle>
        <CardDescription>{expirySummary}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="currentPassword">Current Password</Label>
          <PasswordInput
            id="currentPassword"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Enter current password"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="newPassword">New Password</Label>
            <PasswordInput
              id="newPassword"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter new password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm New Password</Label>
            <PasswordInput
              id="confirmPassword"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
            />
          </div>
        </div>

        <p className="text-sm text-muted-foreground">{PASSWORD_MESSAGE}</p>

        {codeSent && (
          <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-4">
            <p className="text-sm font-medium text-foreground">Email verification required</p>
            <p className="text-sm text-muted-foreground">
              Enter the 6-digit code we sent to your account email before changing your password.
            </p>
            <p className="text-xs text-muted-foreground">{codeExpirySummary}</p>
            <Label htmlFor="passwordChangeOtp">Verification Code</Label>
            <Input
              id="passwordChangeOtp"
              type="text"
              inputMode="numeric"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="Enter 6-digit code"
              maxLength={6}
            />
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={handleSendCode} disabled={sendingCode}>
            {sendingCode ? "Sending..." : codeSent ? "Resend Code" : "Send Verification Code"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={handleChangePassword}
            disabled={changingPassword || !codeSent}
          >
            {changingPassword ? "Changing..." : "Change Password"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
