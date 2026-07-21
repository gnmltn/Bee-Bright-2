import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  User,
  Mail,
  Phone,
  BookOpen,
  Calendar,
  CheckCircle,
  ArrowRight,
  GraduationCap,
  Lock,
  Eye,
  EyeOff,
} from "lucide-react";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import StudentPaymentModal, { type BlockchainPaymentData } from "@/components/payment/StudentPaymentModal";
import { useAuth } from "@/hooks/useAuth";
import { enrollmentService } from "@/services/api";
import { useToast } from "@/hooks/use-toast";
import { sanitizePhoneInput, formatNameCapitalize, formatNameWhileTyping } from "@/utils/validation";

const SCHEDULE_ALL = "Mon - Sat 8:00 AM - 6:00 PM";

const services = [
  { id: "toddlers", name: "Toddlers Playgroup", focus: "Socialization, sensory play, early development", schedule: SCHEDULE_ALL, price: 3000 },
  { id: "prek", name: "Pre-Kindergarten Readiness Program", focus: "Foundational academic skills, phonics, basic reading & writing", schedule: SCHEDULE_ALL, price: 3200 },
  { id: "academic", name: "Academic Tutorial", focus: "Subject-based support Grade 1 to Junior High", schedule: SCHEDULE_ALL, price: 2500 },
  { id: "sped", name: "SPED Tutorial", focus: "Individualized learning support, IEP-based", schedule: SCHEDULE_ALL, price: 3500 },
  { id: "examprep", name: "Examination Preparation", focus: "Test mastery, mock exams, test-taking strategies", schedule: SCHEDULE_ALL, price: 3500 },
  { id: "kinder", name: "Kindergarten Readiness Program", focus: "School-entry preparation, reading & writing readiness", schedule: SCHEDULE_ALL, price: 3000 },
];

const gradeLevels = [
  "Toddler", "Pre-Kindergarten", "Kindergarten",
  "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6",
  "Grade 7", "Grade 8", "Grade 9", "Grade 10",
];

/** Program IDs recommended for each grade level. Only these programs are shown in Step 2. */
const PROGRAMS_BY_GRADE: Record<string, string[]> = {
  Toddler: ["toddlers", "sped"],
  "Pre-Kindergarten": ["prek", "kinder", "sped"],
  Kindergarten: ["kinder", "sped"],
  "Grade 1": ["academic", "sped", "examprep"],
  "Grade 2": ["academic", "sped", "examprep"],
  "Grade 3": ["academic", "sped", "examprep"],
  "Grade 4": ["academic", "sped", "examprep"],
  "Grade 5": ["academic", "sped", "examprep"],
  "Grade 6": ["academic", "sped", "examprep"],
  "Grade 7": ["academic", "sped", "examprep"],
  "Grade 8": ["academic", "sped", "examprep"],
  "Grade 9": ["academic", "sped", "examprep"],
  "Grade 10": ["academic", "sped", "examprep"],
};

const PASSWORD_MIN_LENGTH = 8;
/** Backend allows only these special characters: @$!%*?& */
const HAS_SPECIAL = /[@$!%*?&]/;
/** Any valid email (not Gmail-only) */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Philippine mobile: exactly 11 digits (09xxxxxxxxx) or 12 digits (639xxxxxxxxx) */
const PH_PHONE_DIGITS_11 = /^09\d{9}$/;
const PH_PHONE_DIGITS_12 = /^639\d{9}$/;
const PH_PHONE_REGEX = /^(0?9|639)\d{9}$/;
const ENROLLMENT_STORAGE_KEY = "beebright-enrollment-checkout-v2";

function validatePassword(password: string): { valid: boolean; message: string } {
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return { valid: false, message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: "Password must contain at least one number." };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: "Password must contain at least one uppercase letter." };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: "Password must contain at least one lowercase letter." };
  }
  if (!HAS_SPECIAL.test(password)) {
    return { valid: false, message: "Password must contain at least one special character (@$!%*?&)." };
  }
  if (!/^[A-Za-z0-9@$!%*?&]+$/.test(password)) {
    return { valid: false, message: "Password may only contain letters, numbers, and @$!%*?&." };
  }
  return { valid: true, message: "" };
}

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test((email || "").trim().toLowerCase());
}

/** Returns { valid, message } for Philippine mobile. Use one message for "not exactly 11 digits" and keep current for invalid prefix (09/+63). */
function validatePHPhone(phone: string): { valid: boolean; message: string } {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length !== 11 && digits.length !== 12) {
    return { valid: false, message: "Phone number must be exactly 11 digits." };
  }
  if (!PH_PHONE_REGEX.test(digits)) {
    return { valid: false, message: "Please enter a valid Philippine mobile number (e.g. 09XX XXX XXXX or +63 9XX XXX XXXX)." };
  }
  return { valid: true, message: "" };
}

export default function EnrollmentPage() {
  const navigate = useNavigate();
  const { isAuthenticated, user } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selectedSubjects, setSelectedSubjects] = useState<string[]>([]);
  const [paymentOption, setPaymentOption] = useState<"down" | "full" | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<"gcash" | "blockchain" | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentSession, setPaymentSession] = useState<BlockchainPaymentData | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmPasswordError, setConfirmPasswordError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [guardianPhoneError, setGuardianPhoneError] = useState<string | null>(null);
  const [hasRestoredState, setHasRestoredState] = useState(false);
  const [showEmailVerification, setShowEmailVerification] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [verificationMessage, setVerificationMessage] = useState<string | null>(null);
  const [isSendingVerificationCode, setIsSendingVerificationCode] = useState(false);
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const [emailVerifiedFor, setEmailVerifiedFor] = useState<string | null>(
    isAuthenticated ? user?.email?.toLowerCase() ?? null : null
  );
  const latestFlowStateRef = useRef({
    step: 1,
    showPaymentModal: false,
  });
  const [formData, setFormData] = useState({
    firstName: user?.firstName ?? "",
    middleName: user?.middleName ?? "",
    lastName: user?.lastName ?? "",
    email: user?.email ?? "",
    phone: user?.phone ?? "",
    gradeLevel: user?.gradeLevel ?? "",
    guardianName: user?.guardianName ?? "",
    guardianPhone: user?.guardianPhone ?? "",
    password: "",
    confirmPassword: "",
  });

  /** Programs recommended for the enrollee's grade level; only these are shown in Step 2. */
  const allowedProgramIds = (formData.gradeLevel && PROGRAMS_BY_GRADE[formData.gradeLevel]) ?? [];
  const servicesForGrade = services.filter((s) => allowedProgramIds.includes(s.id));
  const normalizedFormEmail = formData.email.trim().toLowerCase();
  const isCurrentEmailVerified = emailVerifiedFor === normalizedFormEmail;

  /** Clear any selected programs that are not applicable to the current grade (e.g. after changing grade on Step 1). */
  useEffect(() => {
    if (step !== 2 || !formData.gradeLevel) return;
    const allowed = PROGRAMS_BY_GRADE[formData.gradeLevel] ?? [];
    if (allowed.length === 0) return;
    setSelectedSubjects((prev) => prev.filter((id) => allowed.includes(id)));
  }, [step, formData.gradeLevel]);

  const clearStoredEnrollmentFlow = useCallback(() => {
    sessionStorage.removeItem(ENROLLMENT_STORAGE_KEY);
  }, []);

  const closePaymentFlow = useCallback(() => {
    setShowPaymentModal(false);
    setPaymentSession(null);
  }, []);

  useEffect(() => {
    try {
      const savedState = sessionStorage.getItem(ENROLLMENT_STORAGE_KEY);
      if (savedState) {
        const parsed = JSON.parse(savedState);
        if (typeof parsed.step === "number") setStep(parsed.step);
        if (parsed.formData) {
          setFormData((prev) => ({ ...prev, ...parsed.formData }));
        }
        if (Array.isArray(parsed.selectedSubjects)) setSelectedSubjects(parsed.selectedSubjects);
        if (parsed.paymentOption === "down" || parsed.paymentOption === "full") setPaymentOption(parsed.paymentOption);
        if (parsed.paymentMethod === "gcash" || parsed.paymentMethod === "blockchain") setPaymentMethod(parsed.paymentMethod);
        if (parsed.paymentSession) setPaymentSession(parsed.paymentSession);
        if (parsed.showPaymentModal === true) setShowPaymentModal(true);
        if (parsed.showEmailVerification === true) setShowEmailVerification(true);
        if (typeof parsed.emailVerifiedFor === "string" || parsed.emailVerifiedFor === null) {
          setEmailVerifiedFor(parsed.emailVerifiedFor);
        }
      }
    } catch (_) {
      sessionStorage.removeItem(ENROLLMENT_STORAGE_KEY);
    } finally {
      setHasRestoredState(true);
    }
  }, []);

  useEffect(() => {
    if (!hasRestoredState) return;

    sessionStorage.setItem(
      ENROLLMENT_STORAGE_KEY,
      JSON.stringify({
        step,
        formData,
        selectedSubjects,
        paymentOption,
        paymentMethod,
        paymentSession,
        showPaymentModal,
        showEmailVerification,
        emailVerifiedFor,
      })
    );
  }, [
    hasRestoredState,
    step,
    formData,
    selectedSubjects,
    paymentOption,
    paymentMethod,
    paymentSession,
    showPaymentModal,
    showEmailVerification,
    emailVerifiedFor,
  ]);

  useEffect(() => {
    latestFlowStateRef.current = {
      step,
      showPaymentModal,
    };
  }, [step, showPaymentModal]);

  useEffect(() => {
    return () => {
      const { step: latestStep, showPaymentModal: latestShowPaymentModal } = latestFlowStateRef.current;
      if (latestStep === 1 && !latestShowPaymentModal) {
        clearStoredEnrollmentFlow();
      }
    };
  }, [clearStoredEnrollmentFlow]);

  const handleSubjectToggle = (subjectId: string) => {
    if (!allowedProgramIds.includes(subjectId)) return;
    setSelectedSubjects((prev) =>
      prev.includes(subjectId)
        ? prev.filter((id) => id !== subjectId)
        : [...prev, subjectId]
    );
  };

  const calculateTotal = () => {
    return services
      .filter((s) => selectedSubjects.includes(s.id))
      .reduce((sum, s) => sum + s.price, 0);
  };

  const validateStep1Inputs = () => {
    setEmailError(null);
    setPhoneError(null);
    setGuardianPhoneError(null);
    setVerificationError(null);
    if (!formData.gradeLevel?.trim()) {
      const msg = "Please select your grade level to see recommended programs.";
      toast({ title: "Grade level required", description: msg, variant: "destructive" });
      return false;
    }
    if (!isValidEmail(formData.email)) {
      const msg = "Please enter a valid email address.";
      setEmailError(msg);
      toast({ title: "Invalid email", description: msg, variant: "destructive" });
      return false;
    }
    const phoneValidation = validatePHPhone(formData.phone);
    if (!phoneValidation.valid) {
      setPhoneError(phoneValidation.message);
      toast({ title: "Invalid phone", description: phoneValidation.message, variant: "destructive" });
      return false;
    }
    if (formData.guardianPhone?.trim()) {
      const guardianValidation = validatePHPhone(formData.guardianPhone);
      if (!guardianValidation.valid) {
        setGuardianPhoneError(guardianValidation.message);
        toast({ title: "Invalid guardian phone", description: guardianValidation.message, variant: "destructive" });
        return false;
      }
    }
    if (!isAuthenticated) {
      const result = validatePassword(formData.password);
      if (!result.valid) {
        setPasswordError(result.message);
        setConfirmPasswordError(null);
        toast({ title: "Invalid password", description: result.message, variant: "destructive" });
        return false;
      }
      if (formData.password !== formData.confirmPassword) {
        const msg = "Password and confirm password do not match.";
        setConfirmPasswordError(msg);
        toast({ title: "Passwords do not match", description: msg, variant: "destructive" });
        return false;
      }
    }
    setPasswordError(null);
    setConfirmPasswordError(null);
    return true;
  };

  const sendVerificationCodeForCurrentEmail = async (autoTriggered: boolean) => {
    const normalizedEmail = formData.email.trim().toLowerCase();

    try {
      setIsSendingVerificationCode(true);
      setShowEmailVerification(true);
      setEmailVerifiedFor(null);
      setVerificationCode("");
      setVerificationError(null);
      setVerificationMessage(null);
      const response = await enrollmentService.sendVerificationCode(normalizedEmail);
      const data = response.data as { message?: string };

      const message =
        data.message ||
        "We've sent a 6-digit verification code to your email. Enter it below to continue.";
      setVerificationMessage(message);
      toast({
        title: "Verification code sent",
        description: autoTriggered
          ? "Check your email and enter the code to continue to Select Services."
          : "A new verification code was sent. Please enter it to continue.",
      });
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        "Failed to send verification code.";
      setVerificationError(msg);
      toast({ title: "Verification failed", description: msg, variant: "destructive" });
    } finally {
      setIsSendingVerificationCode(false);
    }
  };

  const handleSendVerificationCode = async () => {
    if (isCurrentEmailVerified) {
      toast({
        title: "Email already verified",
        description: "This email is already verified. You can click Continue to proceed.",
      });
      return;
    }
    if (!validateStep1Inputs()) return;
    await sendVerificationCodeForCurrentEmail(false);
  };

  const handleVerifyEmailCode = async () => {
    const normalizedEmail = formData.email.trim().toLowerCase();
    if (!normalizedEmail) return;
    if (!verificationCode.trim()) {
      const msg = "Enter the 6-digit verification code sent to your email.";
      setVerificationError(msg);
      toast({ title: "Verification code required", description: msg, variant: "destructive" });
      return;
    }

    try {
      setIsVerifyingCode(true);
      setVerificationError(null);
      const response = await enrollmentService.verifyEmailCode(normalizedEmail, verificationCode.trim());
      setEmailVerifiedFor(normalizedEmail);
      setVerificationMessage(response.data.message || "Email verified successfully.");
      toast({
        title: "Email verified",
        description: "Your email is verified. Click Continue to proceed to Select Services.",
      });
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        "Failed to verify the code.";
      setVerificationError(msg);
      toast({ title: "Verification failed", description: msg, variant: "destructive" });
    } finally {
      setIsVerifyingCode(false);
    }
  };

  const handleContinueFromStep1 = async () => {
    if (!validateStep1Inputs()) return;

    if (!isAuthenticated) {
      const normalizedEmail = formData.email.trim().toLowerCase();
      if (emailVerifiedFor !== normalizedEmail) {
        if (!showEmailVerification) {
          await sendVerificationCodeForCurrentEmail(true);
        } else {
          toast({
            title: "Email verification required",
            description: "Enter the verification code sent to your email to continue to Select Services.",
            variant: "destructive",
          });
        }
        setShowEmailVerification(true);
        return;
      }
    }

    setStep(2);
  };

  const steps = [
    { number: 1, label: "Personal Info" },
    { number: 2, label: "Select Services" },
    { number: 3, label: "Confirmation" },
  ];

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-muted via-background to-muted py-12 md:py-20">
        <div className="container mx-auto px-4">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center mb-12"
          >
            <span className="text-primary font-semibold text-sm uppercase tracking-wider">
              Join Bee Bright
            </span>
            <h1 className="font-display text-3xl md:text-4xl font-bold mt-2 mb-4">
              Student <span className="gradient-text">Enrollment</span>
            </h1>
            <p className="text-muted-foreground max-w-xl mx-auto">
              Complete the enrollment form below to start your learning journey with us.
            </p>
          </motion.div>

          {/* Progress Steps */}
          <div className="flex items-center justify-center gap-2 md:gap-4 mb-12">
            {steps.map((s, index) => (
              <div key={s.number} className="flex items-center">
                <div
                  className={`flex items-center gap-2 ${
                    step >= s.number ? "text-primary" : "text-muted-foreground"
                  }`}
                >
                  <div
                    className={`h-10 w-10 rounded-full flex items-center justify-center font-bold ${
                      step > s.number
                        ? "bg-success text-success-foreground"
                        : step === s.number
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {step > s.number ? <CheckCircle className="h-5 w-5" /> : s.number}
                  </div>
                  <span className="hidden md:inline font-medium">{s.label}</span>
                </div>
                {index < steps.length - 1 && (
                  <div className="w-8 md:w-16 h-0.5 bg-border mx-2 md:mx-4" />
                )}
              </div>
            ))}
          </div>

          {/* Form Card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-3xl mx-auto bg-card rounded-2xl border border-border shadow-lg overflow-hidden"
          >
            {/* Step 1: Personal Information */}
            {step === 1 && (
              <div className="p-6 md:p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <User className="h-5 w-5 text-primary" />
                  </div>
                  <h2 className="font-display font-bold text-xl text-foreground">
                    Personal Information
                  </h2>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="firstName">First Name</Label>
                    <Input
                      id="firstName"
                      placeholder="Juan"
                      value={formData.firstName}
                      onChange={(e) => setFormData({ ...formData, firstName: formatNameWhileTyping(e.target.value) })}
                      onBlur={(e) => setFormData({ ...formData, firstName: formatNameCapitalize(e.target.value) })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="middleName">Middle Name <span className="text-muted-foreground font-normal">(optional)</span></Label>
                    <Input
                      id="middleName"
                      placeholder="Santos"
                      value={formData.middleName}
                      onChange={(e) => setFormData({ ...formData, middleName: formatNameWhileTyping(e.target.value) })}
                      onBlur={(e) => setFormData({ ...formData, middleName: formatNameCapitalize(e.target.value) })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lastName">Last Name</Label>
                    <Input
                      id="lastName"
                      placeholder="Dela Cruz"
                      value={formData.lastName}
                      onChange={(e) => setFormData({ ...formData, lastName: formatNameWhileTyping(e.target.value) })}
                      onBlur={(e) => setFormData({ ...formData, lastName: formatNameCapitalize(e.target.value) })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email Address</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="email"
                        type="email"
                        placeholder="juan@example.com"
                        className={`pl-10 ${emailError ? "border-destructive focus-visible:ring-destructive" : ""}`}
                        value={formData.email}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(e) => {
                          const nextEmail = e.target.value.toLowerCase();
                          setFormData({ ...formData, email: nextEmail });
                          setEmailError(null);
                          if (!isAuthenticated && nextEmail.trim().toLowerCase() !== (emailVerifiedFor || "")) {
                            setEmailVerifiedFor(null);
                            setShowEmailVerification(false);
                            setVerificationCode("");
                            setVerificationError(null);
                            setVerificationMessage(null);
                          }
                        }}
                      />
                    </div>
                    {emailError && (
                      <p className="text-xs text-destructive font-medium" role="alert">{emailError}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="phone">Phone Number (Philippine)</Label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="phone"
                        type="tel"
                        placeholder="09XX XXX XXXX or +63 9XX XXX XXXX"
                        className={`pl-10 ${phoneError ? "border-destructive focus-visible:ring-destructive" : ""}`}
                        value={formData.phone}
                        onChange={(e) => {
                          setFormData({ ...formData, phone: sanitizePhoneInput(e.target.value) });
                          setPhoneError(null);
                        }}
                      />
                    </div>
                    {phoneError && (
                      <p className="text-xs text-destructive font-medium" role="alert">{phoneError}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="gradeLevel">Grade Level *</Label>
                    <Select
                      value={formData.gradeLevel}
                      onValueChange={(value) => setFormData({ ...formData, gradeLevel: value })}
                    >
                      <SelectTrigger id="gradeLevel">
                        <SelectValue placeholder="Select grade level" />
                      </SelectTrigger>
                      <SelectContent>
                        {gradeLevels.map((grade) => (
                          <SelectItem key={grade} value={grade}>
                            {grade}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="guardianName">Guardian Name</Label>
                    <Input
                      id="guardianName"
                      placeholder="Parent/Guardian full name"
                      value={formData.guardianName}
                      onChange={(e) => setFormData({ ...formData, guardianName: formatNameWhileTyping(e.target.value) })}
                      onBlur={(e) => setFormData({ ...formData, guardianName: formatNameCapitalize(e.target.value) })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="guardianPhone">Guardian Phone</Label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="guardianPhone"
                        type="tel"
                        placeholder="e.g. 09XX XXX XXXX"
                        className={`pl-10 ${guardianPhoneError ? "border-destructive focus-visible:ring-destructive" : ""}`}
                        value={formData.guardianPhone}
                        onChange={(e) => {
                          setFormData({ ...formData, guardianPhone: sanitizePhoneInput(e.target.value) });
                          setGuardianPhoneError(null);
                        }}
                      />
                    </div>
                    {guardianPhoneError && (
                      <p className="text-xs text-destructive font-medium" role="alert">{guardianPhoneError}</p>
                    )}
                  </div>
                  {!isAuthenticated && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="password">Password</Label>
                        <div className="relative">
                          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                          <Input
                            id="password"
                            type={showPassword ? "text" : "password"}
                            placeholder="Enter password"
                            className={`pl-10 pr-10 ${passwordError ? "border-destructive focus-visible:ring-destructive" : ""}`}
                            value={formData.password}
                            onChange={(e) => {
                              setFormData({ ...formData, password: e.target.value });
                              setPasswordError(null);
                              setConfirmPasswordError(null);
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword((p) => !p)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary rounded p-0.5"
                            aria-label={showPassword ? "Hide password" : "Show password"}
                          >
                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                        {passwordError && (
                          <p className="text-xs text-destructive font-medium" role="alert">
                            {passwordError}
                          </p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="confirmPassword">Confirm Password</Label>
                        <div className="relative">
                          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                          <Input
                            id="confirmPassword"
                            type={showPassword ? "text" : "password"}
                            placeholder="Re-enter password"
                            className={`pl-10 pr-10 ${confirmPasswordError ? "border-destructive focus-visible:ring-destructive" : ""}`}
                            value={formData.confirmPassword}
                            onChange={(e) => {
                              setFormData({ ...formData, confirmPassword: e.target.value });
                              setConfirmPasswordError(null);
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword((p) => !p)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary rounded p-0.5"
                            aria-label={showPassword ? "Hide password" : "Show password"}
                          >
                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                        {confirmPasswordError && (
                          <p className="text-xs text-destructive font-medium" role="alert">
                            {confirmPasswordError}
                          </p>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground md:col-span-2">
                        You will use this to log in after enrollment. Must be at least 8 characters long and include at least one uppercase, one lowercase, one number, and one special character (e.g. @$!%*?&).
                      </p>
                      <div className="md:col-span-2 rounded-xl border border-border bg-muted/40 p-4 space-y-4">
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                          <div>
                            <h3 className="font-semibold text-foreground">Email Verification</h3>
                            <p className="text-sm text-muted-foreground">
                              {isCurrentEmailVerified
                                ? "This email is already verified. Click Continue to proceed to Select Services."
                                : "After your personal information is valid, send a 6-digit code to this email and verify it before continuing."}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={isSendingVerificationCode || isCurrentEmailVerified}
                            onClick={() => void handleSendVerificationCode()}
                          >
                            {isSendingVerificationCode
                              ? "Sending..."
                              : showEmailVerification
                              ? "Resend Code"
                              : "Send Code"}
                          </Button>
                        </div>

                        {(showEmailVerification || isCurrentEmailVerified) && (
                          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                            <Input
                              value={verificationCode}
                              onChange={(e) => {
                                setVerificationCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                                setVerificationError(null);
                              }}
                              inputMode="numeric"
                              maxLength={6}
                              placeholder="Enter 6-digit code"
                              disabled={isCurrentEmailVerified}
                            />
                            <Button
                              type="button"
                              className="btn-glow"
                              disabled={isVerifyingCode || isCurrentEmailVerified}
                              onClick={() => void handleVerifyEmailCode()}
                            >
                              {isVerifyingCode ? "Verifying..." : "Verify Code"}
                            </Button>
                          </div>
                        )}

                        {verificationError && (
                          <p className="text-xs font-medium text-destructive">{verificationError}</p>
                        )}
                        {verificationMessage && !verificationError && (
                          <p className="text-xs font-medium text-primary">{verificationMessage}</p>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div className="flex justify-end mt-8">
                  <Button onClick={handleContinueFromStep1} className="btn-glow">
                    Continue
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* Step 2: Subject Selection */}
            {step === 2 && (
              <div className="p-6 md:p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <BookOpen className="h-5 w-5 text-primary" />
                  </div>
                  <h2 className="font-display font-bold text-xl text-foreground">
                    Select Subjects
                  </h2>
                </div>
                {formData.gradeLevel && (
                  <p className="text-sm text-muted-foreground mb-4">
                    Programs recommended for <span className="font-medium text-foreground">{formData.gradeLevel}</span>
                  </p>
                )}

                <div className="grid md:grid-cols-2 gap-4">
                  {servicesForGrade.length === 0 ? (
                    <p className="md:col-span-2 text-muted-foreground py-4">
                      {formData.gradeLevel
                        ? "No programs match this grade level."
                        : "Select your grade level in Step 1 to see recommended programs."}
                    </p>
                  ) : (
                  servicesForGrade.map((subject) => (
                    <div
                      key={subject.id}
                      className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                        selectedSubjects.includes(subject.id)
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/30"
                      }`}
                      onClick={() => handleSubjectToggle(subject.id)}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <Checkbox
                            checked={selectedSubjects.includes(subject.id)}
                            onCheckedChange={() => handleSubjectToggle(subject.id)}
                          />
                          <div>
                            <h4 className="font-semibold text-foreground">{subject.name}</h4>
                            {"focus" in subject && subject.focus && (
                              <p className="text-xs text-muted-foreground mt-0.5">{subject.focus}</p>
                            )}
                            <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
                              <Calendar className="h-3 w-3" />
                              {subject.schedule}
                            </div>
                          </div>
                        </div>
                        <span className="font-bold text-primary">₱{subject.price.toLocaleString()}</span>
                      </div>
                    </div>
                  ))
                  )}
                </div>

                {selectedSubjects.length > 0 && (
                  <div className="mt-6 p-4 bg-muted rounded-xl">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">
                        {selectedSubjects.length} subject(s) selected
                      </span>
                      <span className="font-bold text-lg text-foreground">
                        Total: ₱{calculateTotal().toLocaleString()}/month
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex justify-between mt-8">
                  <Button variant="outline" onClick={() => setStep(1)}>
                    Back
                  </Button>
                  <Button
                    onClick={() => setStep(3)}
                    className="btn-glow"
                    disabled={selectedSubjects.length === 0}
                  >
                    Continue
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* Step 3: Confirmation */}
            {step === 3 && (
              <div className="p-6 md:p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="h-10 w-10 rounded-lg bg-success/10 flex items-center justify-center">
                    <CheckCircle className="h-5 w-5 text-success" />
                  </div>
                  <h2 className="font-display font-bold text-xl text-foreground">
                    Review & Confirm
                  </h2>
                </div>

                <div className="space-y-6">
                  {/* Student Info */}
                  <div className="p-4 bg-muted rounded-xl">
                    <h4 className="font-semibold text-foreground mb-3">Student Information</h4>
                    <div className="grid md:grid-cols-2 gap-2 text-sm">
                      <p><span className="text-muted-foreground">Name:</span> {[formData.firstName, formData.middleName, formData.lastName].filter(Boolean).join(" ")}</p>
                      <p><span className="text-muted-foreground">Grade:</span> {formData.gradeLevel}</p>
                      <p><span className="text-muted-foreground">Email:</span> {formData.email}</p>
                      <p><span className="text-muted-foreground">Phone:</span> {formData.phone}</p>
                    </div>
                  </div>

                  {/* Selected Subjects */}
                  <div className="p-4 bg-muted rounded-xl">
                    <h4 className="font-semibold text-foreground mb-3">Selected Services</h4>
                    <div className="space-y-2">
                      {services
                        .filter((s) => selectedSubjects.includes(s.id))
                        .map((subject) => (
                          <div key={subject.id} className="flex items-center justify-between text-sm">
                            <span>{subject.name}</span>
                            <span className="font-semibold">₱{subject.price.toLocaleString()}</span>
                          </div>
                        ))}
                      <div className="pt-2 mt-2 border-t border-border flex items-center justify-between font-bold">
                        <span>Total Monthly Fee</span>
                        <span className="text-primary text-lg">₱{calculateTotal().toLocaleString()}</span>
                      </div>
                    </div>
                  </div>

                  {/* Payment Options */}
                  <div className="p-4 bg-muted rounded-xl">
                    <h4 className="font-semibold text-foreground mb-3">Payment Option</h4>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div
                        className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                          paymentOption === "down"
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/30"
                        }`}
                        onClick={() => setPaymentOption("down")}
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`h-5 w-5 rounded-full border-2 flex items-center justify-center ${
                              paymentOption === "down"
                                ? "border-primary"
                                : "border-muted-foreground"
                            }`}
                          >
                            {paymentOption === "down" && (
                              <div className="h-2.5 w-2.5 rounded-full bg-primary" />
                            )}
                          </div>
                          <div>
                            <h5 className="font-semibold text-foreground">Partial Payment</h5>
                            <p className="text-sm text-muted-foreground">
                              Pay ₱{Math.ceil(calculateTotal() * 0.5).toLocaleString()} now (50%)
                            </p>
                          </div>
                        </div>
                      </div>
                      <div
                        className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                          paymentOption === "full"
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/30"
                        }`}
                        onClick={() => setPaymentOption("full")}
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`h-5 w-5 rounded-full border-2 flex items-center justify-center ${
                              paymentOption === "full"
                                ? "border-primary"
                                : "border-muted-foreground"
                            }`}
                          >
                            {paymentOption === "full" && (
                              <div className="h-2.5 w-2.5 rounded-full bg-primary" />
                            )}
                          </div>
                          <div>
                            <h5 className="font-semibold text-foreground">Full Payment</h5>
                            <p className="text-sm text-muted-foreground">
                              Pay ₱{calculateTotal().toLocaleString()} now (100%)
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="p-4 bg-muted rounded-xl">
                    <h4 className="font-semibold text-foreground mb-3">Payment Method</h4>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div
                        className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                          paymentMethod === "gcash"
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/30"
                        }`}
                        onClick={() => setPaymentMethod("gcash")}
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`h-5 w-5 rounded-full border-2 flex items-center justify-center ${
                              paymentMethod === "gcash"
                                ? "border-primary"
                                : "border-muted-foreground"
                            }`}
                          >
                            {paymentMethod === "gcash" && (
                              <div className="h-2.5 w-2.5 rounded-full bg-primary" />
                            )}
                          </div>
                          <div>
                            <h5 className="font-semibold text-foreground">GCash</h5>
                            <p className="text-sm text-muted-foreground">Manual transfer with screenshot proof</p>
                          </div>
                        </div>
                      </div>

                      <div
                        className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                          paymentMethod === "blockchain"
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/30"
                        }`}
                        onClick={() => setPaymentMethod("blockchain")}
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`h-5 w-5 rounded-full border-2 flex items-center justify-center ${
                              paymentMethod === "blockchain"
                                ? "border-primary"
                                : "border-muted-foreground"
                            }`}
                          >
                            {paymentMethod === "blockchain" && (
                              <div className="h-2.5 w-2.5 rounded-full bg-primary" />
                            )}
                          </div>
                          <div>
                            <h5 className="font-semibold text-foreground">MetaMask Blockchain</h5>
                            <p className="text-sm text-muted-foreground">Pay in ETH and submit screenshot proof</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex justify-between mt-8">
                  <Button variant="outline" onClick={() => setStep(2)}>
                    Back
                  </Button>
                  <Button
                    className="btn-glow"
                    disabled={!paymentOption || !paymentMethod || isSubmitting}
                    onClick={async () => {
                      if (!paymentOption || !paymentMethod) return;
                      if (!formData.firstName?.trim() || !formData.lastName?.trim() || !formData.email?.trim() || !formData.phone?.trim() || !formData.gradeLevel || !formData.guardianName?.trim()) {
                        toast({
                          title: "Missing information",
                          description: "Please fill in all required personal and guardian fields.",
                          variant: "destructive",
                        });
                        return;
                      }
                      if (!isAuthenticated && (!formData.password || formData.password.length < 8)) {
                        toast({
                          title: "Password required",
                          description: "Please enter a password for your new account (min 8 characters).",
                          variant: "destructive",
                        });
                        return;
                      }
                      if (!isAuthenticated && formData.password !== formData.confirmPassword) {
                        toast({
                          title: "Passwords do not match",
                          description: "Password and confirm password must match.",
                          variant: "destructive",
                        });
                        return;
                      }
                      setIsSubmitting(true);
                      try {
                        const payload: Parameters<typeof enrollmentService.submitEnrollment>[0] = {
                          selectedSubjectCodes: selectedSubjects,
                          totalFee: calculateTotal(),
                          paymentOption,
                          paymentMethod,
                        };
                        if (!isAuthenticated) {
                          payload.firstName = formData.firstName;
                          payload.middleName = formData.middleName || undefined;
                          payload.lastName = formData.lastName;
                          payload.email = formData.email;
                          payload.phone = formData.phone;
                          payload.password = formData.password;
                          payload.gradeLevel = formData.gradeLevel;
                          payload.guardianName = formData.guardianName;
                          payload.guardianPhone = formData.guardianPhone || undefined;
                        }
                        // When authenticated, only enrollment fields are sent; backend uses req.user
                        const res = await enrollmentService.submitEnrollment(payload);
                        const data = res.data as {
                          success: boolean;
                          payment?: {
                            id?: string;
                            _id?: string;
                            amount?: number;
                            referenceNumber?: string;
                            checkoutToken?: string | null;
                            paymentMethod?: "gcash" | "blockchain";
                          };
                          blockchain?: {
                            amountEth: number;
                            contractAddress?: string;
                            recipientAddress?: string;
                            chainId?: number;
                            phpPerEth?: number;
                            referenceNumber?: string;
                          };
                          gcash?: {
                            accountNumber: string;
                            accountName: string;
                            qrImageDataUrl?: string;
                            qrImageUrl?: string;
                            instructions?: string[];
                          };
                          token?: string;
                          user?: { id: string; firstName: string; middleName?: string; lastName: string; email: string; role: string; gradeLevel?: string };
                        };
                        if (data.success && data.payment) {
                          const selectedMethod = data.payment.paymentMethod || paymentMethod;
                          setPaymentSession({
                            paymentId: String(data.payment.id || data.payment._id),
                            amount: Number(data.payment.amount || (paymentOption === "down" ? Math.ceil(calculateTotal() * 0.5) : calculateTotal())),
                            paymentMethod: selectedMethod,
                            amountEth: data.blockchain?.amountEth,
                            contractAddress: data.blockchain?.contractAddress || "",
                            recipientAddress: data.blockchain?.recipientAddress || "",
                            chainId: data.blockchain?.chainId ?? 1337,
                            phpPerEth: data.blockchain?.phpPerEth ?? 250000,
                            referenceNumber: data.payment.referenceNumber || data.blockchain?.referenceNumber || "",
                            checkoutToken: data.payment.checkoutToken || null,
                            gcash: data.gcash,
                          });
                          setShowPaymentModal(true);
                        } else {
                          toast({ title: "Payment setup failed", description: "Could not start the payment session. Please try again.", variant: "destructive" });
                        }
                      } catch (err: unknown) {
                        const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to submit enrollment. Please try again.";
                        toast({ title: "Error", description: msg, variant: "destructive" });
                      } finally {
                        setIsSubmitting(false);
                      }
                    }}
                  >
                    {isSubmitting ? "Saving..." : (
                      <>
                        <GraduationCap className="mr-2 h-4 w-4" />
                        {!paymentOption ? "Select Payment Option" : !paymentMethod ? "Select Payment Method" : paymentMethod === "gcash" ? "Proceed to GCash Payment" : "Proceed to Blockchain Payment"}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </motion.div>
        </div>
      </div>

      <StudentPaymentModal
        isOpen={showPaymentModal}
        onClose={() => closePaymentFlow()}
        paymentSession={paymentSession}
        checkoutStudent={!isAuthenticated ? {
          firstName: formData.firstName,
          middleName: formData.middleName || "",
          lastName: formData.lastName,
          email: formData.email,
          phone: formData.phone,
          password: formData.password,
          gradeLevel: formData.gradeLevel,
          guardianName: formData.guardianName,
          guardianPhone: formData.guardianPhone || "",
        } : undefined}
        amount={paymentOption === "down" ? Math.ceil(calculateTotal() * 0.5) : calculateTotal()}
        paymentOption={paymentOption ?? "full"}
        preferredPaymentMethod={paymentMethod ?? "blockchain"}
        studentName={[formData.firstName, formData.middleName, formData.lastName].filter(Boolean).join(" ") || undefined}
        email={formData.email || undefined}
        onPaymentComplete={() => {
          clearStoredEnrollmentFlow();
          closePaymentFlow();
          navigate("/", { replace: true });
        }}
      />
    </Layout>
  );
}
