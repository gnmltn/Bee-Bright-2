import api from "./api";

type EnrollmentPayload = Record<string, unknown> & {
  selectedSubjectCodes?: string[];
  selectedSubjects?: string[];
};

const normalizeEnrollmentPayload = (data: EnrollmentPayload) => {
  const selectedSubjectCodes = Array.isArray(data.selectedSubjectCodes)
    ? data.selectedSubjectCodes
    : Array.isArray(data.selectedSubjects)
    ? data.selectedSubjects
    : [];

  return {
    ...data,
    selectedSubjectCodes,
  };
};

export const enrollmentService = {
  register: (data: Record<string, unknown>) =>
    api.post("/auth/register", data),

  // Compatibility wrapper: old imports named this createEnrollment,
  // but public checkout now starts with /enrollments/submit.
  createEnrollment: (data: EnrollmentPayload) =>
    api.post("/enrollments/submit", normalizeEnrollmentPayload(data)),

  submitEnrollment: (data: EnrollmentPayload) =>
    api.post("/enrollments/submit", normalizeEnrollmentPayload(data)),

  getStudentEnrollment: (studentId: string) =>
    api.get(`/enrollments/student/${studentId}`),

  // Current payment proof endpoint is payment-based, not enrollment-based.
  submitPaymentProof: (paymentId: string, proofData: Record<string, unknown>) =>
    api.post(`/payments/${paymentId}/submit-proof`, proofData),

  getPaymentStatus: (paymentId: string) =>
    api.get(`/payments/${paymentId}/status`),
};
