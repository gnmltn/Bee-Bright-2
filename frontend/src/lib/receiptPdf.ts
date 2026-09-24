import { jsPDF } from "jspdf";

export interface ReceiptData {
  /** The enrollment's human-readable BB-format ID (e.g. BB-20260904-0001) —
   * shown as "Application ID" and used as the downloaded file's name. */
  bbId: string;
  fullName: string;
  amount: number;
  /** System-generated reference number (Payment.referenceNumber), if one exists. */
  transactionId?: string | null;
  transactionDate: string | Date;
}

/**
 * Payment receipt PDF — Invoice_Display_DownPaymentBug_Receipt_RemarksPolicy.pdf
 * Section E. Deliberately plain: no checkmark/circle graphic, no "Order ID", no
 * generic "application ID" — just the fields the parent actually needs for their
 * own records/reimbursement, with a clean "Paid" status label.
 */
export function downloadPaymentReceipt(data: ReceiptData) {
  const doc = new jsPDF({ unit: "pt", format: [360, 480] });
  const pageWidth = 360;
  const marginX = 32;
  let y = 48;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(31, 41, 55);
  doc.text("Bee Bright Tutorial Center", pageWidth / 2, y, { align: "center" });

  y += 22;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(13);
  doc.setTextColor(107, 114, 128);
  doc.text("Payment Receipt", pageWidth / 2, y, { align: "center" });

  y += 14;
  doc.setDrawColor(229, 231, 235);
  doc.line(marginX, y, pageWidth - marginX, y);

  y += 30;
  const row = (label: string, value: string) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(107, 114, 128);
    doc.text(label, marginX, y);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(31, 41, 55);
    doc.text(value, pageWidth - marginX, y, { align: "right" });
    y += 26;
  };

  // jsPDF's built-in Helvetica font only supports WinAnsi encoding, which has no
  // glyph for the Peso sign (U+20B1) — it silently renders as "±". Use "PHP"
  // instead of the symbol so the amount is never garbled.
  row("Application ID", data.bbId || "—");
  row("Full Name", data.fullName || "—");
  row("Amount", `PHP ${Math.round(data.amount).toLocaleString()}`);
  if (data.transactionId) row("Transaction ID", data.transactionId);
  const dateObj = typeof data.transactionDate === "string" ? new Date(data.transactionDate) : data.transactionDate;
  row("Transaction Date", dateObj.toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }));

  y += 10;
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 30;

  // Clean "Paid" status pill instead of a generic "Success" label.
  doc.setFillColor(220, 252, 231);
  const pillWidth = 70;
  const pillHeight = 26;
  const pillX = (pageWidth - pillWidth) / 2;
  doc.roundedRect(pillX, y - 18, pillWidth, pillHeight, 13, 13, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(22, 101, 52);
  doc.text("Paid", pageWidth / 2, y, { align: "center" });

  y += 46;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(156, 163, 175);
  doc.text("This receipt is computer-generated and valid without a signature.", pageWidth / 2, y, { align: "center" });

  doc.save(`${data.bbId || "receipt"}.pdf`);
}
