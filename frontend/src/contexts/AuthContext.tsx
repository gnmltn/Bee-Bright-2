import { createContext, useState, useEffect, ReactNode } from "react";
import { authService } from "@/services/api";
import {
  clearAuthSession,
  hasAuthSessionHint,
  migrateLegacyAuthStorage,
  setAuthSession,
  setStoredUser,
} from "@/utils/authStorage";

export type UserRole = "student" | "tutor" | "admin" | "super_admin" | "parent";

export interface User {
  id: string;
  name: string; // Combined name for frontend display
  firstName: string;
  middleName?: string;
  lastName: string;
  email: string;
  role: UserRole;
  phone?: string;
  isActive?: boolean;
  // Student fields
  gradeLevel?: string;
  guardianName?: string;
  guardianPhone?: string;
  // Tutor/Student fields
  enrolledSubjects?: string[];
  subjectsTaught?: { _id: string; name: string; code?: string }[];
  employmentType?: 'full-time' | 'part-time';
  availability?: string;
  enrollmentStatus?: string;
  paymentStatus?: string;
  lastLogin?: string;
  profileImageUrl?: string | null;
  passwordChangedAt?: string;
  passwordExpiresAt?: string;
  passwordExpired?: boolean;
  passwordExpiresInDays?: number;
  // Admin fields (optional)
  adminLevel?: "admin" | "super_admin";
}

type LoginResult = {
  success: boolean;
  message?: string;
  user?: User;
  code?: string;
  retryAfterSeconds?: number;
};

type OtpLoginStartResult = {
  success: boolean;
  message?: string;
  user?: User;
  trustedDeviceBypass?: boolean;
  verificationId?: string;
  maskedEmail?: string;
  expiresAt?: string;
  nextResendAvailableInSeconds?: number;
  retryAfterSeconds?: number;
  code?: string;
  devOtp?: string;
};

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  /** True until initial session restore (getMe) has finished. Prevents redirect-to-login on refresh. */
  authLoading: boolean;
  login: (
    email: string,
    password: string,
    role: UserRole,
    captchaId?: string,
    captchaAnswer?: string
  ) => Promise<LoginResult>;
  startOtpLogin: (email: string, password: string, role: UserRole) => Promise<OtpLoginStartResult>;
  verifyOtpLogin: (email: string, verificationId: string, otp: string, role?: UserRole) => Promise<LoginResult>;
  startPrivilegedLogin: (email: string, password: string) => Promise<OtpLoginStartResult>;
  verifyPrivilegedLogin: (email: string, verificationId: string, otp: string) => Promise<LoginResult>;
  /** Set auth from enrollment/register response (token + user) so user is logged in after submitting enrollment */
  setAuthFromEnrollment: (token: string, userData: { id: string; firstName: string; middleName?: string; lastName: string; email: string; role: string; gradeLevel?: string }) => void;
  logout: () => void;
  updateUser: (updates: Partial<User>) => void;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

function clearStoredAuth() {
  clearAuthSession({ clearLegacyLocalStorage: true });
}

function mapApiUserToFrontendUser(u: Record<string, unknown>): User {
  const firstName = String(u.firstName || "");
  const middleName = String(u.middleName || "");
  const lastName = String(u.lastName || "");
  const fullName = [firstName, middleName, lastName].filter(Boolean).join(" ").trim();

  return {
    id: String(u.id),
    firstName,
    middleName,
    lastName,
    name: fullName || `${firstName} ${lastName}`.trim(),
    email: String(u.email || ""),
    role: u.role as UserRole,
    phone: u.phone ? String(u.phone) : undefined,
    isActive: Boolean(u.isActive),
    gradeLevel: u.gradeLevel ? String(u.gradeLevel) : undefined,
    guardianName: u.guardianName ? String(u.guardianName) : undefined,
    guardianPhone: u.guardianPhone ? String(u.guardianPhone) : undefined,
    enrolledSubjects: (u.enrolledSubjects as string[] | undefined) || [],
    subjectsTaught: (u.subjectsTaught as { _id: string; name: string; code?: string }[] | undefined) || [],
    employmentType: u.employmentType as 'full-time' | 'part-time' | undefined,
    availability: u.availability ? String(u.availability) : undefined,
    enrollmentStatus: u.enrollmentStatus ? String(u.enrollmentStatus) : undefined,
    paymentStatus: u.paymentStatus ? String(u.paymentStatus) : undefined,
    lastLogin: u.lastLogin ? String(u.lastLogin) : undefined,
    profileImageUrl: (u.profileImageUrl as string | null | undefined) ?? null,
    passwordChangedAt: u.passwordChangedAt ? String(u.passwordChangedAt) : undefined,
    passwordExpiresAt: u.passwordExpiresAt ? String(u.passwordExpiresAt) : undefined,
    passwordExpired: typeof u.passwordExpired === "boolean" ? Boolean(u.passwordExpired) : undefined,
    passwordExpiresInDays:
      typeof u.passwordExpiresInDays === "number" ? Number(u.passwordExpiresInDays) : undefined,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Verify token with backend on mount – only restore session if token is valid.
  // This prevents showing a stale "logged in as admin" from localStorage when the token is expired or invalid.
  useEffect(() => {
    // ============ DEV BYPASS - remove when backend is ready ============
const DEV_BYPASS =false; // set to false to disable
const DEV_ROLE: UserRole = "student"; // change to "student", "tutor", or "admin"

if (DEV_BYPASS) {
  const devUsers: Record<UserRole, User> = {
    student: {
      id: "dev-student-1",
      firstName: "Student",
      middleName: "",
      lastName: "Dev",
      name: "Student Dev",
      email: "student@dev.com",
      role: "student",
      gradeLevel: "Grade 10",
      enrollmentStatus: "active",
      paymentStatus: "paid",
      enrolledSubjects: [],
      subjectsTaught: [],
    },
    tutor: {
      id: "dev-tutor-1",
      firstName: "Tutor",
      middleName: "",
      lastName: "Dev",
      name: "Tutor Dev",
      email: "tutor@dev.com",
      role: "tutor",
      employmentType: "full-time",
      enrolledSubjects: [],
      subjectsTaught: [],
    },
    admin: {
      id: "dev-admin-1",
      firstName: "Admin",
      middleName: "",
      lastName: "Dev",
      name: "Admin Dev",
      email: "admin@dev.com",
      role: "admin",
      adminLevel: "super_admin",
      enrolledSubjects: [],
      subjectsTaught: [],
    },
  };

  setUser(devUsers[DEV_ROLE]);
  setAuthLoading(false);
  return;
}
// ============ END DEV BYPASS ============
    migrateLegacyAuthStorage();

    const hasStoredSessionHint = hasAuthSessionHint();
    if (!hasStoredSessionHint) {
      clearStoredAuth();
      setAuthLoading(false);
      return;
    }

    authService
      .getMe()
      .then((res) => {
        if (res.data?.success && res.data?.user) {
          const frontendUser = mapApiUserToFrontendUser(res.data.user as Record<string, unknown>);
          setUser(frontendUser);
          setAuthSession(frontendUser);
        } else {
          clearStoredAuth();
          setUser(null);
        }
      })
      .catch(() => {
        clearStoredAuth();
        setUser(null);
      })
      .finally(() => {
        setAuthLoading(false);
      });
  }, []);

  const login = async (
    email: string,
    password: string,
    role: UserRole,
    captchaId?: string,
    captchaAnswer?: string
  ): Promise<LoginResult> => {
    void email;
    void password;
    void role;
    void captchaId;
    void captchaAnswer;

    return {
      success: false,
      message: "Login now uses email OTP verification.",
    };
  };

  const startOtpLogin = async (
    email: string,
    password: string,
    role: UserRole
  ): Promise<OtpLoginStartResult> => {
    try {
      const request =
        role === "admin" || role === "super_admin"
          ? authService.adminLoginStart({ email, password })
          : authService.loginStart({ email, password, role: role as "student" | "tutor" | "parent" });

      const { data } = await request;
      if (data?.success && data?.user) {
        const apiUser = data.user as Record<string, unknown>;
        const authToken = (data as { token?: string })?.token;
        const frontendUser = mapApiUserToFrontendUser(apiUser);

        setAuthSession(frontendUser, authToken || null);
        setUser(frontendUser);

        return {
          success: true,
          message: data.message,
          user: frontendUser,
          trustedDeviceBypass: Boolean((data as { trustedDeviceBypass?: boolean }).trustedDeviceBypass),
        };
      }

      if (data?.success && data?.requiresOtp && data?.verificationId) {
        return {
          success: true,
          message: data.message,
          verificationId: data.verificationId,
          maskedEmail: data.maskedEmail,
          expiresAt: data.expiresAt,
          nextResendAvailableInSeconds: data.nextResendAvailableInSeconds,
          retryAfterSeconds: data.retryAfterSeconds,
          code: data.code,
          devOtp: data.devOtp,
        };
      }

      return {
        success: false,
        message: data?.message || "Login failed. Please try again.",
        retryAfterSeconds: data?.retryAfterSeconds,
        code: data?.code,
      };
    } catch (err: unknown) {
      const axErr = err as { response?: { data?: { message?: string; retryAfterSeconds?: number; code?: string } } };
      return {
        success: false,
        message: axErr.response?.data?.message || "Network error. Please try again.",
        retryAfterSeconds: axErr.response?.data?.retryAfterSeconds,
        code: axErr.response?.data?.code,
      };
    }
  };

  const verifyOtpLogin = async (
    email: string,
    verificationId: string,
    otp: string,
    role?: UserRole
  ): Promise<LoginResult> => {
    try {
      const request =
        role === "admin" || role === "super_admin"
          ? authService.adminVerifyOtp({ email, verificationId, otp })
          : authService.verifyLoginOtp({ email, verificationId, otp });

      const { data } = await request;
      if (data?.success && data?.user) {
        const apiUser = data.user as Record<string, unknown>;
        const authToken = (data as { token?: string })?.token;
        // Legacy student accounts (not parent) that are pending approval cannot proceed
        if (apiUser.role === "student" && apiUser.enrollmentStatus !== "active") {
          return {
            success: false,
            message: "Your account is pending admin approval. You cannot log in until your enrollment is accepted.",
          };
        }
        // Parent accounts are always allowed through — they may be inactive (pending approval)
        // but they need to log in to track their enrollment status.

        const frontendUser = mapApiUserToFrontendUser(apiUser);
        setAuthSession(frontendUser, authToken || null);
        setUser(frontendUser);
        return { success: true, user: frontendUser, message: data.message };
      }

      return {
        success: false,
        message: (data as { message?: string })?.message || "Invalid verification code.",
        code: (data as { code?: string })?.code,
      };
    } catch (err: unknown) {
      const axErr = err as { response?: { data?: { message?: string; code?: string; retryAfterSeconds?: number } } };
      return {
        success: false,
        message: axErr.response?.data?.message || "Network error. Please try again.",
        code: axErr.response?.data?.code,
        retryAfterSeconds: axErr.response?.data?.retryAfterSeconds,
      };
    }
  };

  const startPrivilegedLogin = (email: string, password: string) =>
    startOtpLogin(email, password, "admin");

  const verifyPrivilegedLogin = (email: string, verificationId: string, otp: string) =>
    verifyOtpLogin(email, verificationId, otp, "admin");

  const setAuthFromEnrollment = (token: string, userData: { id: string; firstName: string; middleName?: string; lastName: string; email: string; role: string; gradeLevel?: string }) => {
    const fullName = [userData.firstName, userData.middleName, userData.lastName].filter(Boolean).join(" ").trim();
    const frontendUser: User = {
      id: userData.id,
      firstName: userData.firstName,
      middleName: userData.middleName,
      lastName: userData.lastName,
      name: fullName || `${userData.firstName} ${userData.lastName}`.trim(),
      email: userData.email,
      role: userData.role as UserRole,
      gradeLevel: userData.gradeLevel,
      enrolledSubjects: [],
      subjectsTaught: [],
    };
    setUser(frontendUser);
    setAuthSession(frontendUser, token);
  };

  const logout = () => {
    setUser(null);
    clearStoredAuth();
    authService.logout().catch(() => undefined);
  };

  const updateUser = (updates: Partial<User>) => {
    if (user) {
      const fn = updates.firstName ?? user.firstName;
      const mn = updates.middleName ?? user.middleName;
      const ln = updates.lastName ?? user.lastName;
      const updatedUser = { 
        ...user, 
        ...updates,
        name: [fn, mn, ln].filter(Boolean).join(" ").trim() || user.name,
        // Ensure enrolledSubjects exists
        enrolledSubjects: updates.enrolledSubjects || user.enrolledSubjects || []
      };
      setUser(updatedUser);
      setStoredUser(updatedUser);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        authLoading,
        login,
        startOtpLogin,
        verifyOtpLogin,
        startPrivilegedLogin,
        verifyPrivilegedLogin,
        setAuthFromEnrollment,
        logout,
        updateUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

