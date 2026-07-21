const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const User = require("../models/User");
const { sendOtpEmail, getEmailErrorMessage, logEmailError } = require("../utils/emailService");
const { buildEmailLookupFilter, normalizeEmailAddress } = require("../utils/email");
const { invalidateAllTrustedDevicesForUser } = require("../utils/trustedDevice");
const {
  PASSWORD_REGEX,
  getPasswordSecurityState,
} = require("../utils/passwordPolicy");

const PASSWORD_RESET_OTP_EXPIRES_MINUTES = 5;
const PASSWORD_RESET_OTP_MAX_ATTEMPTS = 5;
const PASSWORD_CHANGE_OTP_EXPIRES_MINUTES = 5;
const PASSWORD_CHANGE_OTP_MAX_ATTEMPTS = 5;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

function clearResetOtpState(user) {
  user.resetPasswordOtpHash = undefined;
  user.resetPasswordOtpExpires = undefined;
  user.resetPasswordOtpLastSentAt = undefined;
  user.resetPasswordOtpAttempts = 0;
}

function clearPasswordChangeOtpState(user) {
  user.passwordChangeOtpHash = undefined;
  user.passwordChangeOtpExpires = undefined;
  user.passwordChangeOtpLastSentAt = undefined;
  user.passwordChangeOtpAttempts = 0;
}

function buildPasswordSecurityResponse(user) {
  const state = getPasswordSecurityState(user);
  return {
    passwordChangedAt: state.passwordChangedAt.toISOString(),
    passwordExpiresAt: state.passwordExpiresAt.toISOString(),
    passwordExpired: state.passwordExpired,
    passwordExpiresInDays: state.passwordExpiresInDays,
  };
}

async function ensureNewPasswordIsDifferent(user, newPassword) {
  return bcrypt.compare(newPassword, user.password);
}

// POST /api/auth/forgot_password
const forgotPassword = async (req, res) => {
  try {
    const email = normalizeEmailAddress(req.body?.email);
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }

    const user = await User.findOne(buildEmailLookupFilter(email)).select(
      "+resetPasswordOtpHash +resetPasswordOtpExpires +resetPasswordOtpAttempts +resetPasswordOtpLastSentAt"
    );

    if (!user) {
      return res.json({ success: true, message: "If this email exists, OTP was sent." });
    }

    const now = Date.now();
    if (user.resetPasswordOtpExpires && user.resetPasswordOtpExpires.getTime() > now) {
      const secondsLeft = Math.ceil((user.resetPasswordOtpExpires.getTime() - now) / 1000);
      return res.status(429).json({
        success: false,
        message: `OTP already sent. Please wait ${secondsLeft} seconds before requesting again.`,
      });
    }

    const otp = generateOtp();
    let devOtp = null;
    try {
      await sendOtpEmail(user.email, otp, PASSWORD_RESET_OTP_EXPIRES_MINUTES);
    } catch (emailErr) {
      logEmailError("forgotPassword email send failed", emailErr, { email: user.email });
      // Local development fallback: allow password reset flow even if SMTP is unavailable.
      if (process.env.NODE_ENV !== "production") {
        devOtp = otp;
      } else {
        return res.status(502).json({ success: false, message: getEmailErrorMessage(emailErr) });
      }
    }

    user.resetPasswordOtpHash = hashOtp(otp);
    user.resetPasswordOtpExpires = new Date(now + PASSWORD_RESET_OTP_EXPIRES_MINUTES * 60 * 1000);
    user.resetPasswordOtpLastSentAt = new Date(now);
    user.resetPasswordOtpAttempts = 0;
    await user.save();

    return res.json({
      success: true,
      message: devOtp
        ? "Email OTP delivery is unavailable in local mode. Use the development OTP shown in the UI."
        : `OTP sent. Check your email. Code expires in ${PASSWORD_RESET_OTP_EXPIRES_MINUTES} minutes.`,
      expiresAt: user.resetPasswordOtpExpires.toISOString(),
      ...(devOtp ? { devOtp } : {}),
    });
  } catch (err) {
    console.error("forgotPassword error:", err);
    return res.status(500).json({ success: false, message: "Failed to send OTP" });
  }
};

// POST /api/auth/reset_password
const resetPassword = async (req, res) => {
  try {
    const email = normalizeEmailAddress(req.body?.email);
    const { otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ success: false, message: "Email, OTP, and new password are required" });
    }

    if (!PASSWORD_REGEX.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: "New password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number and one special character (@$!%*?&)",
      });
    }

    const user = await User.findOne(buildEmailLookupFilter(email)).select(
      "+resetPasswordOtpHash +resetPasswordOtpExpires +resetPasswordOtpAttempts +resetPasswordOtpLastSentAt +password"
    );

    if (!user || !user.resetPasswordOtpHash || !user.resetPasswordOtpExpires) {
      return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
    }

    if ((user.resetPasswordOtpAttempts || 0) >= PASSWORD_RESET_OTP_MAX_ATTEMPTS) {
      clearResetOtpState(user);
      await user.save();
      return res.status(429).json({ success: false, message: "Too many incorrect attempts. Request a new OTP." });
    }

    if (user.resetPasswordOtpExpires.getTime() < Date.now()) {
      clearResetOtpState(user);
      await user.save();
      return res.status(400).json({ success: false, message: "OTP expired. Request a new one." });
    }

    const isSamePassword = await ensureNewPasswordIsDifferent(user, newPassword);
    if (isSamePassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from your current password.",
      });
    }

    const otpHash = hashOtp(String(otp).trim());
    if (otpHash !== user.resetPasswordOtpHash) {
      user.resetPasswordOtpAttempts = (user.resetPasswordOtpAttempts || 0) + 1;
      if (user.resetPasswordOtpAttempts >= PASSWORD_RESET_OTP_MAX_ATTEMPTS) {
        clearResetOtpState(user);
      }
      await user.save();

      return res.status(user.resetPasswordOtpAttempts >= PASSWORD_RESET_OTP_MAX_ATTEMPTS ? 429 : 400).json({
        success: false,
        message:
          user.resetPasswordOtpAttempts >= PASSWORD_RESET_OTP_MAX_ATTEMPTS
            ? "Too many incorrect attempts. Request a new OTP."
            : "Invalid OTP",
      });
    }

    user.password = newPassword;
    clearResetOtpState(user);
    clearPasswordChangeOtpState(user);
    await user.save();
    await invalidateAllTrustedDevicesForUser(user._id, "password_changed");

    return res.json({
      success: true,
      message: "Password reset successful. You can now log in.",
      ...buildPasswordSecurityResponse(user),
    });
  } catch (err) {
    console.error("resetPassword error:", err);
    return res.status(500).json({ success: false, message: "Reset password failed" });
  }
};

// POST /api/auth/change-password/request-code
const requestPasswordChangeCode = async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required.",
      });
    }

    if (!PASSWORD_REGEX.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: "New password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number and one special character (@$!%*?&)",
      });
    }

    const user = await User.findById(req.user.id).select(
      "+password +passwordChangeOtpHash +passwordChangeOtpExpires +passwordChangeOtpAttempts +passwordChangeOtpLastSentAt"
    );

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    const isSamePassword = await ensureNewPasswordIsDifferent(user, newPassword);
    if (isSamePassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from your current password.",
      });
    }

    const now = Date.now();
    if (user.passwordChangeOtpExpires && user.passwordChangeOtpExpires.getTime() > now) {
      const secondsLeft = Math.ceil((user.passwordChangeOtpExpires.getTime() - now) / 1000);
      return res.status(429).json({
        success: false,
        message: `A verification code was already sent. Please wait ${secondsLeft} seconds before requesting again.`,
      });
    }

    const otp = generateOtp();
    let devOtp = null;
    try {
      await sendOtpEmail(user.email, otp, PASSWORD_CHANGE_OTP_EXPIRES_MINUTES);
    } catch (emailErr) {
      logEmailError("password change email send failed", emailErr, { email: user.email });
      // Local development fallback: allow password change flow even if SMTP is unavailable.
      if (process.env.NODE_ENV !== "production") {
        devOtp = otp;
      } else {
        return res.status(502).json({ success: false, message: getEmailErrorMessage(emailErr) });
      }
    }

    user.passwordChangeOtpExpires = new Date(now + PASSWORD_CHANGE_OTP_EXPIRES_MINUTES * 60 * 1000);
    user.passwordChangeOtpLastSentAt = new Date(now);
    user.passwordChangeOtpAttempts = 0;
    await user.save();

    await user.save();

    return res.json({
      success: true,
      message: devOtp
        ? "Email OTP delivery is unavailable in local mode. Use the development OTP shown in the UI."
        : `Verification code sent to ${user.email}.`,
      expiresAt: user.passwordChangeOtpExpires.toISOString(),
      ...(devOtp ? { devOtp } : {}),
    });
  } catch (err) {
    console.error("requestPasswordChangeCode error:", err);
    return res.status(500).json({ success: false, message: "Failed to send verification code" });
  }
};

// PUT /api/auth/change-password
const changePassword = async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    const otp = String(req.body?.otp || "").trim();

    if (!currentPassword || !newPassword || !otp) {
      return res.status(400).json({
        success: false,
        message: "Current password, new password, and verification code are required.",
      });
    }

    if (!PASSWORD_REGEX.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: "New password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number and one special character (@$!%*?&)",
      });
    }

    const user = await User.findById(req.user.id).select(
      "+password +passwordChangeOtpHash +passwordChangeOtpExpires +passwordChangeOtpAttempts +passwordChangeOtpLastSentAt"
    );

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    const isSamePassword = await ensureNewPasswordIsDifferent(user, newPassword);
    if (isSamePassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from your current password.",
      });
    }

    if (!user.passwordChangeOtpHash || !user.passwordChangeOtpExpires) {
      return res.status(400).json({
        success: false,
        message: "Request a verification code first before changing your password.",
      });
    }

    if ((user.passwordChangeOtpAttempts || 0) >= PASSWORD_CHANGE_OTP_MAX_ATTEMPTS) {
      clearPasswordChangeOtpState(user);
      await user.save();
      return res.status(429).json({
        success: false,
        message: "Too many incorrect attempts. Request a new verification code.",
      });
    }

    if (user.passwordChangeOtpExpires.getTime() < Date.now()) {
      clearPasswordChangeOtpState(user);
      await user.save();
      return res.status(400).json({
        success: false,
        message: "Verification code expired. Request a new one.",
      });
    }

    if (hashOtp(otp) !== user.passwordChangeOtpHash) {
      user.passwordChangeOtpAttempts = (user.passwordChangeOtpAttempts || 0) + 1;
      if (user.passwordChangeOtpAttempts >= PASSWORD_CHANGE_OTP_MAX_ATTEMPTS) {
        clearPasswordChangeOtpState(user);
      }
      await user.save();

      return res.status(user.passwordChangeOtpAttempts >= PASSWORD_CHANGE_OTP_MAX_ATTEMPTS ? 429 : 400).json({
        success: false,
        message:
          user.passwordChangeOtpAttempts >= PASSWORD_CHANGE_OTP_MAX_ATTEMPTS
            ? "Too many incorrect attempts. Request a new verification code."
            : "Invalid verification code.",
      });
    }

    user.password = newPassword;
    clearPasswordChangeOtpState(user);
    await user.save();
    await invalidateAllTrustedDevicesForUser(user._id, "password_changed");

    return res.status(200).json({
      success: true,
      message: "Password updated successfully.",
      ...buildPasswordSecurityResponse(user),
    });
  } catch (err) {
    console.error("changePassword error:", err);
    return res.status(500).json({ success: false, message: "Failed to change password" });
  }
};

module.exports = {
  forgotPassword,
  resetPassword,
  requestPasswordChangeCode,
  changePassword,
};
