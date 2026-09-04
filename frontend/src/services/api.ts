import axios from 'axios';
import { clearAuthSession, getAuthToken } from '@/utils/authStorage';
import { notifySessionActivity, shouldTrackApiActivity } from '@/utils/sessionActivity';

// Create axios instance - FIXED: Use correct environment variable
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5001/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 40000, // Increased for Ollama requests (up to 20s server-side + buffer)
});

// Add auth token to requests
api.interceptors.request.use(
  (config) => {
    if (shouldTrackApiActivity(config.url)) {
      notifySessionActivity();
    }
    const token = getAuthToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // Don't redirect on 401 when the request was for login – let the login page show the error
    const isLoginRequest =
      error.config?.url?.includes('/auth/login') ||
      error.config?.url?.includes('/auth/admin-login') ||
      error.config?.url?.includes('/auth/login-start') ||
      error.config?.url?.includes('/auth/login-verify-otp') ||
      error.config?.url?.includes('/auth/admin-login-start') ||
      error.config?.url?.includes('/auth/admin-login-verify-otp') ||
      error.config?.url?.includes('/auth/login-complete');
    if (error.response?.status === 401 && !isLoginRequest) {
      const msg = String(error.response?.data?.message || '');
      const code = String(error.response?.data?.code || '');
      const requestUrl = String(error.config?.url || '');
      const lowerMsg = msg.toLowerCase();
      const lowerUrl = requestUrl.toLowerCase();
      const currentPath = window.location.pathname || '';
      const isProtectedArea =
        currentPath.startsWith('/student-dashboard') ||
        currentPath.startsWith('/tutor-dashboard') ||
        currentPath.startsWith('/admin-dashboard') ||
        currentPath.startsWith('/super-admin-dashboard');

      // Only force logout for true token/session failures.
      // Some feature endpoints may return 401 for business/role rules and should not wipe auth state.
      const isTokenAuthFailure =
        code === 'TOKEN_EXPIRED' ||
        code === 'TOKEN_INACTIVE_EXPIRED' ||
        lowerMsg.includes('session expired') ||
        lowerMsg.includes('token expired') ||
        lowerMsg.includes('not authorized, no token') ||
        lowerMsg.includes('not authorized, token failed') ||
        lowerUrl.includes('/auth/me');

      if (isTokenAuthFailure) {
        if (lowerMsg.includes('expired') || code === 'TOKEN_EXPIRED') {
          sessionStorage.setItem('session_expired_message', 'Session expired. Please log in again.');
        }
        clearAuthSession({ clearLegacyLocalStorage: true });
        if (isProtectedArea) {
          const isAdminArea =
            currentPath.startsWith('/admin-dashboard') ||
            currentPath.startsWith('/super-admin-dashboard') ||
            currentPath.startsWith('/admin-login');
          window.location.href = isAdminArea ? '/admin-login' : '/login';
        }
      }
    }
    return Promise.reject(error);
  }
);

// ── Parent Auth (enrollment wizard) ─────────────────────────────────────
export const parentAuthService = {
  register: (data: { name: string; email: string; mobile: string; password: string }) =>
    api.post<{ success: boolean; message: string; verificationSentTo: string; parentId: string }>(
      '/auth/register-parent', data
    ),
  sendOtp: (email: string) =>
    api.post<{ success: boolean; message: string; verificationSentTo: string }>(
      '/auth/parent-otp/send', { email }
    ),
  verifyOtp: (email: string, code: string) =>
    api.post<{ success: boolean; token: string; emailVerifiedAt: string; parentId: string }>(
      '/auth/parent-otp/verify', { email, code }
    ),
};

// ── Pricing ──────────────────────────────────────────────────────────────
export interface PricingPackage {
  _id: string;
  programCode: string;
  packageSlug: string;
  displayName: string;
  durationDesc: string;
  /** Explicit session count for this package — how many sessions to generate. */
  sessionCount: number | null;
  priceFull: number;
  priceDown: number;
  currency: string;
  ageMin: number | null;
  ageMax: number | null;
  displayOrder: number;
  active: boolean;
  meta: {
    qrUrl?: string | null;
    accountName?: string | null;
    accountNumber?: string | null;
    bankBranch?: string | null;
  };
}
export const pricingService = {
  getAll: () => api.get<{ success: boolean; count: number; pricing: PricingPackage[] }>('/enrollments/pricing'),
  getPaymentInstructions: (method: 'gcash' | 'seabank' | 'bdo') =>
    api.get<{ success: boolean; method: string; instructions: Record<string, string> }>(`/payments/instructions/${method}`),
};

// Auth Service - FIXED endpoints
export const authService = {
  getCaptchaChallenge: () =>
    api.get<{
      success: boolean;
      challenge: {
        captchaId: string;
        imageData: string;
        prompt: string;
        maxAttempts: number;
        attemptsRemaining: number;
        expiresInSeconds: number;
      };
    }>('/auth/captcha-challenge'),
  loginStart: (credentials: { email: string; password: string; role: 'student' | 'tutor' | 'parent' }) =>
    api.post<{
      success: boolean;
      requiresOtp?: boolean;
      trustedDeviceBypass?: boolean;
      verificationId?: string;
      maskedEmail?: string;
      expiresAt?: string;
      nextResendAvailableInSeconds?: number;
      retryAfterSeconds?: number;
      message?: string;
      code?: string;
      token?: string;
      user?: Record<string, unknown>;
    }>('/auth/login-start', credentials),
  adminLoginStart: (credentials: { email: string; password: string }) =>
    api.post<{
      success: boolean;
      requiresOtp?: boolean;
      trustedDeviceBypass?: boolean;
      verificationId?: string;
      maskedEmail?: string;
      expiresAt?: string;
      nextResendAvailableInSeconds?: number;
      retryAfterSeconds?: number;
      message?: string;
      code?: string;
      token?: string;
      user?: Record<string, unknown>;
    }>('/auth/admin-login-start', credentials),
  verifyLoginOtp: (payload: { email: string; verificationId: string; otp: string }) =>
    api.post('/auth/login-verify-otp', payload),
  adminVerifyOtp: (payload: { email: string; verificationId: string; otp: string }) =>
    api.post('/auth/admin-login-verify-otp', payload),
  logout: () => api.post('/auth/logout'),
  completeLogin: (payload: { captchaId: string; captchaAnswer: string }) =>
    api.post('/auth/login-complete', payload),
  register: (userData) => api.post('/auth/register', userData),
  login: (credentials: { email: string; password: string; role: 'student' | 'tutor'; captchaId: string; captchaAnswer: string }) =>
    api.post('/auth/login', credentials),
  forgotPassword: (email: string) => api.post("/auth/forgot_password", { email }),
  resetPassword: (payload: { email: string; otp: string; newPassword: string }) =>
    api.post("/auth/reset_password", payload),
  requestPasswordChangeCode: (payload: { currentPassword: string; newPassword: string }) =>
    api.post('/auth/change-password/request-code', payload),
  adminLogin: (credentials: { email: string; password: string }) =>
    api.post('/auth/admin-login', credentials),
  getMe: () => api.get('/auth/me'),
  updateProfile: (profileData) => api.put('/auth/update-profile', profileData),
  /** Upload profile picture (image as base64 data URL, e.g. from FileReader) */
  uploadProfileImage: (image: string) => api.put('/auth/profile-image', { image }),
  changePassword: (passwordData: { currentPassword: string; newPassword: string; otp: string }) =>
    api.put('/auth/change-password', passwordData),
};

// Settings (maintenance mode – admin only for set)
export const settingsService = {
  getMaintenance: () => api.get<{ success: boolean; maintenanceMode: boolean; manualMaintenanceMode: boolean; scheduledMaintenanceMode: boolean }>('/settings/maintenance'),
  setMaintenance: (enabled: boolean) => api.put<{ success: boolean; maintenanceMode: boolean }>('/settings/maintenance', { enabled }),
};

export const assessmentService = {
  getTemplates: (programCodes: string[]) =>
    api.get('/assessments/templates', {
      params: { programCodes: programCodes.join(',') },
    }),
};

// Payment Service - FIXED endpoints
export const paymentService = {
  getGcashInfo: () => api.get('/payments/gcash-info'),

  initiateStudentPayment: (enrollmentId, paymentMethod?: 'gcash' | 'blockchain') =>
    api.post('/payments/initiate/student', { enrollmentId, paymentMethod }),

  submitPaymentProof: (paymentId, data) =>
    api.post(`/payments/${paymentId}/submit-proof`, data),

  getPaymentStatus: (paymentId) =>
    api.get(`/payments/${paymentId}/status`),

  getMyPayments: () => api.get('/payments/student/my-payments'),

  getEnrollmentPaymentStatus: (enrollmentId) =>
    api.get(`/payments/student/status/${enrollmentId}`),
  getAdminPayments: (status: 'all' | 'pending' | 'submitted' | 'verified' | 'rejected' = 'all') =>
    api.get<{ success: boolean; count: number; payments: AdminPaymentItem[] }>('/payments/admin/payments', {
      params: status === 'all' ? {} : { status },
    }),
  getPendingPayments: () => api.get('/payments/admin/payments/pending'),
  verifyPayment: (paymentId: string, verified: boolean, rejectionReason?: string) =>
    api.put(`/payments/admin/payments/${paymentId}/verify`, { verified, rejectionReason }),
};

export interface AdminPaymentItem {
  _id: string;
  referenceNumber?: string;
  amount: number;
  paymentType: 'full' | 'down' | 'remaining';
  status: 'pending' | 'submitted' | 'verified' | 'rejected';
  paymentMethod?: 'gcash' | 'blockchain';
  createdAt?: string;
  verifiedAt?: string;
  rejectionReason?: string;
  student?: { firstName?: string; lastName?: string; email?: string; phone?: string } | null;
  enrollment?: {
    _id?: string;
    referenceNumber?: string;
    paymentStatus?: string;
    status?: string;
    totalFee?: number;
    paymentOption?: string;
  } | null;
  gcashDetails?: {
    mobileNumber?: string;
    transactionId?: string;
    screenshotUrl?: string;
  };
  blockchainPayment?: {
    transactionHash?: string;
    fromAddress?: string;
    amountEth?: number;
    network?: string;
  };
  verifiedBy?: { firstName?: string; lastName?: string; role?: string } | null;
}

// Enrollment Service
export const enrollmentService = {
  getPricing: () => api.get<{ success: boolean; pricing: {
    programCode: string; packageSlug: string; displayName: string;
    durationDesc?: string; priceFull: number; priceDown?: number | null;
    ageMin?: number | null; ageMax?: number | null;
  }[] }>('/enrollments/pricing'),
  sendVerificationCode: (email: string) =>
    api.post<{ success: boolean; message: string }>('/enrollments/send-verification-code', { email }),
  verifyEmailCode: (email: string, code: string) =>
    api.post<{ success: boolean; message: string; verifiedAt?: string }>('/enrollments/verify-email-code', { email, code }),

  // ── New wizard submit ─────────────────────────────────────────────────
  submitWizard: (data: {
    packages: { programCode: string; packageSlug: string; displayName: string; price: number; paymentOption: 'down' }[];
    paymentOption: 'down'; // always 50% down — backend enforces this
    paymentMethod: 'gcash' | 'seabank' | 'bdo';
    studentFirstName: string;
    studentLastName: string;
    studentMiddleName?: string;
    birthdate: string;
    preferredStartDate?: string;
    preferredTime?: 'morning' | 'afternoon' | 'no_preference';
    /** Days the child is available — Mon to Sat. Empty = no preference. */
    preferredDays?: string[];
    allergies?: string;
    medications?: string;
    specialNeeds?: boolean;
    specialNeedsDetails?: string;
    emergencyContact?: string;
    consentVersion: string;
    consentItems: { name: string; accepted: boolean; version: string }[];
    assessment?: {
      applicable: boolean;
      skipReason?: string;
      templateId?: string;
      infoValues?: Record<string, string>;
      ratings?: Record<string, string>;
      remarks?: string;
      goals?: { goal: string; timeline: string }[];
      assessedBy?: string;
    };
  }) => api.post<{
    success: boolean; enrollmentId: string; enrollmentDbId: string;
    paymentId: string; amountDue: number; totalFee: number;
    paymentMethod: string; instructions: Record<string, string>;
  }>('/enrollments/submit', data),

  submitPaymentProof: (enrollmentId: string, data: {
    proofDataUrl: string;
    payerReference?: string;
    paymentMethod?: string;
  }) => api.post(`/enrollments/${enrollmentId}/submit-proof`, data),

  trackEnrollment: (enrollmentId: string, email: string) =>
    api.get('/enrollments/track', { params: { enrollmentId, email } }),

  getMyEnrollments: () => api.get('/enrollments/my-enrollments'),
  getTutorAssessments: () => api.get('/enrollments/tutor/assessments'),

  // ── Legacy ────────────────────────────────────────────────────────────
  submitEnrollment: (data: {
    firstName?: string; middleName?: string; lastName?: string;
    email?: string; phone?: string; password?: string; gradeLevel?: string;
    guardianName?: string; guardianPhone?: string;
    selectedSubjectCodes: string[]; totalFee: number;
    paymentOption: 'full' | 'down'; paymentMethod?: 'gcash' | 'blockchain';
  }) => api.post('/enrollments/submit', data),
  createEnrollment: (data: Record<string, unknown>) => api.post('/enrollments', data),
  getEnrollment: (enrollmentId: string) => api.get(`/enrollments/${enrollmentId}`),
  getEnrollmentByStudent: (studentId: string) => api.get(`/enrollments/student/${studentId}`),
  getAllEnrollments: (params?: { status?: string; q?: string; page?: number; limit?: number }) =>
    api.get('/enrollments/admin/all', { params }),
  getEnrollmentById: (id: string) => api.get(`/enrollments/${id}`),
  updateEnrollmentStatus: (enrollmentId: string, status: string) =>
    api.put(`/enrollments/${enrollmentId}/status`, { status }),
  verifyEnrollmentPayment: (enrollmentId: string, verified: boolean, note?: string) =>
    api.put(`/enrollments/${enrollmentId}/verify-payment`, { verified, note }),
  approveEnrollment: (enrollmentId: string) =>
    api.put(`/enrollments/${enrollmentId}/approve`),
  rejectEnrollment: (enrollmentId: string, reason: string, allowResubmission = true) =>
    api.put(`/enrollments/${enrollmentId}/reject`, { reason, allowResubmission }),
  adminAddStudent: (data: {
    firstName: string; middleName?: string; lastName: string; email: string;
    phone: string; password: string; gradeLevel: string; guardianName: string;
    guardianPhone?: string; selectedSubjectIds: string[]; paymentOption: 'full' | 'down';
    totalFee: number; paymentStatus: string; status: string; enrollmentDate?: string;
  }) => api.post('/enrollments/admin/add-student', data),
  resubmitPayment: (paymentId: string, data: { proofDataUrl: string; payerReference?: string }) =>
    api.put(`/payments/${paymentId}/resubmit`, data),
};

export interface AdminEnrollment {
  _id: string;
  enrollmentId?: string;
  // The parent/guardian who submitted the enrollment — the only login account
  parent?: { _id: string; firstName: string; lastName: string; email: string; phone?: string } | null;
  // Child info captured at submission time — NOT a separate User account
  studentSnapshot?: { firstName?: string; lastName?: string; middleName?: string; birthdate?: string; computedAge?: number } | null;
  // Generated on approval and stored on the Enrollment, not on a User
  studentId?: string | null;
  packages?: { programCode?: string; packageSlug?: string; displayName?: string; price?: number; paymentOption?: string }[];
  preferredStartDate?: string | null;
  preferredTime?: string | null;
  /** Days the child is available — Mon to Sat values. Empty = no preference. */
  preferredDays?: string[];
  rejectionReason?: string | null;
  allowResubmission?: boolean;
  statusHistory?: { status?: string; at?: string; byRole?: string; note?: string }[];
  consentItems?: { name?: string; accepted?: boolean }[];
  latestPayment?: {
    _id?: string;
    status?: string;
    paymentMethod?: string;
    amountDue?: number;
    proofUrl?: string;
    submittedAt?: string;
    verifiedAt?: string;
    resubmissionCount?: number;
    referenceNumber?: string;
  } | null;
  // Legacy fields kept for backward compat with old enrollment records
  student?: {
    _id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    profileImage?: string;
  } | null;
  selectedSubjects?: { _id: string; name: string; code?: string; price?: number }[];
  totalFee: number;
  paymentOption: string;
  paymentStatus: string;
  status: string;
  referenceNumber?: string;
  enrollmentDate?: string;
  createdAt?: string;
}

// User Service (Admin)
export const userService = {
  /** Admin: get all users from database */
  getAllUsers: () => api.get('/users'),
  /** Admin: create tutor with employment type and availability. */
  createTutor: (data: {
    firstName: string;
    middleName?: string;
    lastName: string;
    email: string;
    password: string;
    phone: string;
    employmentType: 'full-time' | 'part-time';
    availability?: string;
  }) => api.post('/users/tutors', data),
  /** Admin: create admin user */
  deleteUser: (userId: string) => api.delete(`/users/${userId}`),
  permanentlyDeleteUser: (userId: string) => api.delete(`/users/${userId}/permanent`),
  unarchiveUser: (userId: string) => api.patch(`/users/${userId}/unarchive`),
  createAdmin: (data: {
    firstName: string;
    middleName?: string;
    lastName: string;
    email: string;
    password: string;
    phone: string;
  }) => api.post('/users/admins', data),
};

// Dashboard Service (Admin)
export const dashboardService = {
  /** Admin: get dashboard summary stats from database */
  getStats: () => api.get('/dashboard/stats'),
  /** Public: landing page stats */
  getPublicStats: () => api.get<{ success: boolean; stats: PublicDashboardStats }>('/dashboard/public-stats'),
};

export interface DashboardStats {
  totalStudents: number;
  activeTutors: number;
  pendingEnrollments: number;
  monthlyRevenue: number;
}

export interface PublicDashboardStats {
  monthlyNewStudents: number;
}

export interface AdminUser {
  _id: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  email: string;
  phone?: string;
  role: string;
  isActive?: boolean;
  isArchived?: boolean;
  gradeLevel?: string;
  enrollmentStatus?: string;
  subjectsTaught?: { _id: string; name: string; code?: string }[];
  employmentType?: 'full-time' | 'part-time';
  availability?: string;
  profileImage?: string;
  createdAt?: string;
  archivedAt?: string;
  deletedAt?: string | null;
}

export interface AdminSchedule {
  _id: string;
  date: string;
  startTime: string;
  endTime: string;
  sessionType?: 'one-on-one' | 'small-group' | 'playgroup';
  maxCapacity?: number;
  students?: Array<{ _id: string; firstName?: string; middleName?: string; lastName?: string; profileImage?: string; email?: string }>;
  tutors?: Array<{ _id: string; firstName?: string; middleName?: string; lastName?: string; email?: string }>;
  dayOfWeek?: number;
  tutoringAreaId?: { _id: string; name?: string; areaType?: 'tutoring_area' | 'toddler_room' } | string | null;
  isSubstitution?: boolean;
  substitutionReason?: string;
  originalTutor?: { _id: string; firstName: string; lastName: string; middleName?: string; email?: string } | string | null;
  student?: { _id: string; firstName: string; lastName: string; middleName?: string; email?: string; gradeLevel?: string; profileImage?: string };
  tutor?: { _id: string; firstName: string; lastName: string; middleName?: string; email?: string; profileImage?: string };
  subject?: { _id: string; name: string; code?: string };
}

export interface WeeklyScheduleAreaOption {
  _id: string;
  name: string;
  areaType: 'tutoring_area' | 'toddler_room';
  capacity?: number;
  isActive?: boolean;
}

export interface WeeklyScheduleSubjectOption {
  _id: string;
  name: string;
  code?: string;
}

export interface WeeklyScheduleTutorOption {
  _id: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  email?: string;
  isActive?: boolean;
  employmentType?: 'full-time' | 'part-time';
  availability?: string;
}

export interface WeeklyScheduleTemplateEntryPayload {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  tutorId?: string;
  tutorIds?: string[];
  sessionType: 'one-on-one' | 'small-group' | 'playgroup';
  tutoringAreaId: string;
  subjectId: string;
  notes?: string;
}

// Subject Service
export const subjectService = {
  getAllSubjects: () => api.get('/subjects'),
  getSubject: (subjectId) => api.get(`/subjects/${subjectId}`),
};

// Schedule Service – admin list; tutor my-sessions; student my-classes
export const scheduleService = {
  getOptions: () => api.get('/schedules/options'),
  getTutorsBySubject: (subjectId: string) => api.get('/schedules/tutors', { params: { subjectId } }),
  /**
   * Returns the required tutor count for a Toddlers Playgroup session based on child count.
   * Uses the variable ratio: ceil(childCount / 3), capped at 4.
   */
  getPlaygroupTutorRequirement: (childCount: number) =>
    api.get<{
      success: boolean;
      childCount: number;
      tutorRequirement: { min: number; max: number; recommended: number };
      availableTutorCount: number;
      hasSufficient: boolean;
      message: string;
    }>('/schedules/playgroup-tutor-requirement', { params: { childCount } }),
  getAvailableSlots: (tutorId: string, date: string) =>
    api.get('/schedules/available-slots', { params: { tutorId, date } }),
  getSlotsTemplate: (tutorId: string) =>
    api.get('/schedules/slots-template', { params: { tutorId } }),
  getAvailableSlotsMonthly: (tutorId: string, monthStart: string, daysOfWeek: number[], studentId?: string) =>
    api.get('/schedules/available-slots-monthly', {
      params: { tutorId, monthStart, daysOfWeek: daysOfWeek.join(','), ...(studentId ? { studentId } : {}) },
    }),
  getAvailableSlotsByDay: (tutorId: string, monthStart: string, studentId?: string) =>
    api.get('/schedules/available-slots-by-day', {
      params: { tutorId, monthStart, ...(studentId ? { studentId } : {}) },
    }),
  create: (data: { studentId?: string; students?: string[]; tutorId?: string; tutorIds?: string[]; subjectId: string; date: string; startTime: string; endTime: string; sessionType?: 'one-on-one' | 'small-group' | 'playgroup' }) =>
    api.post('/schedules', data),
  createMonthly: (data: {
    studentId: string;
    tutorId: string;
    subjectId: string;
    daySlots: { dayOfWeek: number; startTime: string; endTime: string }[];
  }) => api.post('/schedules/monthly', data),
  markTutorUnavailability: (data: {
    tutorId: string;
    startDate: string;
    endDate: string;
    reason?: string;
    autoAssign?: boolean;
  }) => api.post('/schedules/tutor-unavailability', data),
  assignSubstitute: (scheduleId: string, data: { replacementTutorId: string; reason?: string }) =>
    api.patch(`/schedules/${scheduleId}/substitute`, data),
  cleanupDuplicates: () => api.post('/schedules/cleanup-duplicates'),
  list: () => api.get('/schedules', { params: { _t: Date.now() } }),
  delete: (scheduleId: string) => api.delete(`/schedules/${scheduleId}`),
  enrollStudent: (scheduleId: string, data: { studentId?: string; enrollmentId?: string; overridePreference?: boolean; overrideReason?: string }) =>
    api.post(`/schedules/${scheduleId}/enroll-student`, data),
  removeStudent: (scheduleId: string, studentId: string) => api.post(`/schedules/${scheduleId}/remove-student`, { studentId }),
  getMySessions: () => api.get('/schedules/my-sessions'),
  getMyClasses: () => api.get('/schedules/student/my-classes'),
  markAttendance: (scheduleId: string, status: 'present' | 'absent') =>
    api.patch(`/schedules/${scheduleId}/attendance`, { status }),
};

export const weeklyScheduleService = {
  getOptions: () =>
    api.get<{
      success: boolean;
      tutoringAreas: WeeklyScheduleAreaOption[];
      tutors: WeeklyScheduleTutorOption[];
      subjects: WeeklyScheduleSubjectOption[];
    }>('/admin/weekly-schedules/options'),
  createTemplate: (data: {
    name: string;
    description?: string;
    effectiveStartDate: string;
    effectiveEndDate?: string;
    scheduleEntries: WeeklyScheduleTemplateEntryPayload[];
  }) => api.post('/admin/weekly-schedules', data),
  activateTemplate: (templateId: string) => api.patch(`/admin/weekly-schedules/${templateId}/activate`),
  generateSessions: (templateId: string, weekStartDate: string, monthSpan: 1 | 2 | 3 = 1) =>
    api.post(`/admin/weekly-schedules/${templateId}/generate-sessions`, { weekStartDate, monthSpan }),
};

// AI: recommendations (by role) + chatbot
export const aiService = {
  getRecommendations: () => api.get('/ai/recommendations'),
  chat: (message: string, history?: { role: 'user' | 'assistant'; content: string }[]) => api.post('/ai/chat', { message, history }),
  publicChat: (message: string) => api.post<{ success: boolean; reply?: string; message?: string }>('/ai/public-chat', { message }),
  getModelMetrics: () => api.get<{
    success: boolean;
    metrics: {
      modelType: string;
      evaluationMethod: string;
      datasetSize: number;
      trainingSamplesPerFold: number;
      evaluationSamples: number;
      accuracy: number;
      precision: number;
      recall: number;
      f1Score: number;
      classes: {
        intent: string;
        precision: number;
        recall: number;
        f1Score: number;
        support: number;
      }[];
    };
  }>('/ai/metrics'),
  /** Ollama (phi) chatbot – uses backend proxy to local Ollama. No auth required. */
  ollamaChat: (message: string, history?: { role: 'user' | 'assistant'; content: string }[]) =>
    api.post<{ success: boolean; reply?: string; message?: string }>('/ai/ollama-chat', { message, history }),
};

// Learning materials (tutor upload, student view assigned)
const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:5001/api';
export const uploadsBaseUrl = apiBase.replace(/\/api\/?$/, '');

export interface LearningMaterialItem {
  _id: string;
  title: string;
  description?: string;
  materialType: 'pdf' | 'video' | 'web_link' | 'image' | 'document' | 'other';
  category: string;
  storageType: 'file' | 'url';
  filePath?: string | null;
  fileName?: string | null;
  url?: string | null;
  uploadedBy?: { _id: string; firstName: string; lastName: string };
  assignedStudents?: { _id: string; firstName: string; lastName: string; middleName?: string }[];
  subject?: { _id: string; name: string; code?: string } | null;
  createdAt?: string;
}

export const materialService = {
  getMyMaterials: () => api.get<{ success: boolean; materials: LearningMaterialItem[] }>('/materials'),
  getAssignedMaterials: () => api.get<{ success: boolean; materials: LearningMaterialItem[] }>('/materials/student/assigned'),
  createMaterial: (formData: FormData) => api.post<{ success: boolean; material: LearningMaterialItem }>('/materials', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }),
  deleteMaterial: (id: string) => api.delete(`/materials/${id}`),
};

// Grades (tutor: add/list; student: my progress)
export interface GradeItem {
  _id: string;
  student?: { _id: string; firstName: string; lastName: string; middleName?: string; gradeLevel?: string };
  tutor?: { _id: string; firstName: string; lastName: string };
  programCategory: string;
  subjectItem: string;
  score: number;
  maxScore: number;
  percentage?: number;
  period: string;
  remarks?: string;
  createdAt?: string;
}

export const gradeService = {
  addGrade: (data: { studentId: string; programCategory: string; subjectItem: string; score: number; maxScore?: number; period: string; remarks?: string }) =>
    api.post<{ success: boolean; grade: GradeItem }>('/grades', data),
  getGradesAsTutor: (studentId?: string) =>
    api.get<{ success: boolean; grades: GradeItem[] }>('/grades', studentId ? { params: { studentId } } : undefined),
  getGradesForStudent: (studentId: string) =>
    api.get<{ success: boolean; grades: GradeItem[] }>(`/grades/student/${studentId}`),
  getMyProgress: () => api.get<{ success: boolean; grades: GradeItem[] }>('/grades/my-progress'),
  updateGrade: (id: string, data: { score?: number; maxScore?: number; period?: string; remarks?: string }) =>
    api.put<{ success: boolean; grade: GradeItem }>(`/grades/${id}`, data),
  deleteGrade: (id: string) => api.delete(`/grades/${id}`),
};

export type AnnouncementItem = {
  _id: string;
  title: string;
  body: string;
  category: string;
  scheduledDate?: string | null;
  authorRole: 'tutor' | 'admin';
  author?: { firstName?: string; lastName?: string; email?: string };
  status: 'pending' | 'approved' | 'rejected';
  targetType: 'specific_students' | 'all';
  targetStudentIds?: { _id: string; firstName?: string; lastName?: string }[];
  rejectionReason?: string | null;
  approvedBy?: { firstName?: string; lastName?: string } | null;
  approvedAt?: string | null;
  createdAt: string;
};

export type AuditLogItem = {
  _id: string;
  action: string;
  module: string;
  description: string;
  status: 'SUCCESS' | 'FAILED';
  ipAddress?: string | null;
  createdAt: string;
};

export type AuditLogAdminItem = AuditLogItem & {
  userId?: string;
  userIdentifier?: string;
  userName?: string;
  userEmail?: string;
  userRole?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
};

type AnnouncementListResponse = {
  success: boolean;
  announcements: AnnouncementItem[];
  message?: string;
};

type AnnouncementMutationResponse = {
  success: boolean;
  announcement: AnnouncementItem;
  message?: string;
};

export const auditLogService = {
  getMyActivity: (limit?: number) =>
    api.get<{ success: boolean; logs: AuditLogItem[] }>('/audit-logs/me', { params: limit != null ? { limit } : {} }),
  getForAdmin: (params?: { module?: string; status?: string; userId?: string; startDate?: string; endDate?: string; limit?: number }) =>
    api.get<{ success: boolean; logs: AuditLogAdminItem[] }>('/audit-logs/admin', { params }),
};

export const announcementService = {
  getForStudent: () => api.get<AnnouncementListResponse>('/announcements/student'),
  getForTutor: () => api.get<AnnouncementListResponse>('/announcements/tutor'),
  getForAdmin: () => api.get<AnnouncementListResponse>('/announcements/admin'),
  getMyStudents: () => api.get<{ success: boolean; students: { _id: string; name: string; email?: string }[] }>('/announcements/my-students'),
  create: (data: { title: string; body: string; category: string; targetType: 'specific_students' | 'all'; targetStudentIds?: string[]; scheduledDate?: string }) =>
    api.post<AnnouncementMutationResponse>('/announcements', data),
  update: (id: string, data: { title: string; body: string; category: string; targetStudentIds?: string[]; scheduledDate?: string }) =>
    api.put<AnnouncementMutationResponse>(`/announcements/${id}`, data),
  delete: (id: string) => api.delete<{ success: boolean; message?: string }>(`/announcements/${id}`),
  approve: (id: string) => api.patch<AnnouncementMutationResponse>(`/announcements/${id}/approve`),
  reject: (id: string, reason?: string) => api.patch<AnnouncementMutationResponse>(`/announcements/${id}/reject`, reason != null ? { reason } : {}),
};

export default api;
