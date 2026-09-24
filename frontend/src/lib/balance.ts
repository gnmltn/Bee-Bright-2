/** Client-side twin of backend/utils/remainingBalance.js — the second 50% a parent still owes. */
export type BalanceEnrollment = {
  status?: string;
  totalFee?: number;
  payments?: { status?: string; paymentType?: string; amount?: number; amountDue?: number; amountPaid?: number }[];
};

const EXCLUDED = ["draft", "rejected", "cancelled"];
const amountOf = (p: { amount?: number; amountDue?: number; amountPaid?: number }) => Number(p.amountPaid ?? p.amountDue ?? p.amount ?? 0) || 0;

/** Remaining amount owed, or 0 when nothing is owed (down payment not yet verified, fully paid,
 *  or the remaining payment is already submitted and awaiting review). */
export function remainingBalanceOf(e: BalanceEnrollment): number {
  if (!e || EXCLUDED.includes(e.status || "")) return 0;
  const payments = e.payments || [];
  const downVerified = payments.some((p) => p.status === "verified" && p.paymentType !== "remaining");
  if (!downVerified) return 0;
  if (payments.some((p) => p.paymentType === "remaining" && p.status === "submitted")) return 0;
  const paid = payments.filter((p) => p.status === "verified").reduce((sum, p) => sum + amountOf(p), 0);
  return Math.max(0, Math.round((Number(e.totalFee) || 0) - paid));
}

/** What the remaining 50% will be for a just-submitted enrollment (down payment = half the total). */
export function expectedRemainingAfterDown(e: BalanceEnrollment): number {
  const total = Number(e.totalFee) || 0;
  const down = e.payments?.find((p) => p.paymentType !== "remaining");
  const downAmount = Number(down?.amountDue ?? down?.amount ?? total / 2) || 0;
  return Math.max(0, Math.round(total - downAmount));
}

export const peso = (n: number) => `₱${n.toLocaleString("en-PH")}`;
