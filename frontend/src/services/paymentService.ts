import api from "./api";

export const paymentService = {
  initiateStudentPayment: (enrollmentId: string, amount: number) =>
    api.post("/payments/initiate/student", { enrollmentId, amount }),

  submitPaymentProof: (paymentId: string, data: any) =>
    api.post(`/payments/${paymentId}/submit-proof`, data)
};
