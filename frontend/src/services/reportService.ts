import api from "./api";

export interface WeeklyDigestFollowUp {
  type: "enrollment" | "payment";
  label: string;
  date: string;
}

export interface WeeklyDigestItem {
  _id: string;
  weekStart: string;
  weekEnd: string;
  reportText: string;
  followUps: WeeklyDigestFollowUp[];
  createdAt: string;
}

export const reportService = {
  generateWeeklyDigest: (weekStart: string, weekEnd: string) =>
    api.post("/reports/weekly-digest", { weekStart, weekEnd }, { responseType: "blob" }),

  listWeeklyDigests: () =>
    api.get<{ success: boolean; digests: WeeklyDigestItem[]; message?: string }>("/reports/weekly-digest"),

  downloadWeeklyDigestPdf: (id: string) =>
    api.get(`/reports/weekly-digest/${id}/pdf`, { responseType: "blob" })
};
