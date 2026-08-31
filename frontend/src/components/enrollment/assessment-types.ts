export interface AssessmentRatingOption {
  value: string;
  label: string;
}

export interface AssessmentField {
  key: string;
  label: string;
  type?: string;
}

export interface AssessmentItem {
  key: string;
  label: string;
}

export interface AssessmentSection {
  key: string;
  title: string;
  items: AssessmentItem[];
}

export interface AssessmentTemplate {
  _id: string;
  slug: string;
  title: string;
  description?: string;
  programCodes: string[];
  displayOrder?: number;
  active?: boolean;
  ratingScale: AssessmentRatingOption[];
  infoFields: AssessmentField[];
  sections: AssessmentSection[];
  remarksEnabled?: boolean;
  remarksLabel?: string;
  goalsCount?: number;
  goalsTitle?: string;
  goalColumnLabel?: string;
  timelineColumnLabel?: string;
  assessedByLabel?: string;
  notApplicableLabel?: string;
}

export interface AssessmentGoal {
  goal: string;
  timeline: string;
}

export interface PreEnrollmentAssessment {
  applicable: boolean | null;
  skipReason?: string | null;
  templateId?: string | null;
  templateSlug?: string | null;
  templateTitle?: string | null;
  snapshot?: AssessmentTemplate | null;
  infoValues?: Record<string, string>;
  ratings?: Record<string, string>;
  remarks?: string;
  goals?: AssessmentGoal[];
  assessedBy?: string;
  completedAt?: string | null;
}

export function ratingLabel(snapshot: AssessmentTemplate | null | undefined, value: string | undefined) {
  if (!value) return '—';
  const match = snapshot?.ratingScale?.find((option) => option.value === value);
  return match?.label || value;
}
