import { ratingLabel, type PreEnrollmentAssessment } from '@/components/enrollment/assessment-types';

interface Props {
  assessment?: PreEnrollmentAssessment | null;
  compact?: boolean;
}

export function EnrollmentAssessmentView({ assessment, compact }: Props) {
  if (!assessment || assessment.applicable === null || assessment.applicable === undefined) {
    return <p className="text-sm text-muted-foreground">No pre-enrollment assessment on file.</p>;
  }

  if (assessment.applicable === false) {
    return (
      <div className="text-sm text-muted-foreground">
        Assessment skipped{assessment.skipReason ? `: ${assessment.skipReason}` : '.'}
      </div>
    );
  }

  const snapshot = assessment.snapshot;
  const ratings = assessment.ratings || {};
  const infoValues = assessment.infoValues || {};

  return (
    <div className={compact ? 'space-y-3 text-sm' : 'space-y-5 text-sm'}>
      <div>
        <p className="font-semibold text-foreground">{assessment.templateTitle || snapshot?.title}</p>
        {snapshot?.description ? <p className="text-xs text-muted-foreground mt-1">{snapshot.description}</p> : null}
      </div>

      {snapshot?.infoFields?.map((field) => (
        <div key={field.key} className="flex justify-between gap-4">
          <span className="text-muted-foreground">{field.label}</span>
          <span className="font-medium text-right">{infoValues[field.key] || '—'}</span>
        </div>
      ))}

      {snapshot?.sections?.map((section) => (
        <div key={section.key} className="space-y-2">
          <p className="font-semibold text-foreground text-xs uppercase tracking-wide">{section.title}</p>
          <div className="rounded-lg border border-border divide-y divide-border">
            {section.items.map((item) => (
              <div key={item.key} className="flex justify-between gap-3 px-3 py-2">
                <span className="text-muted-foreground">{item.label}</span>
                <span className="font-medium shrink-0">{ratingLabel(snapshot, ratings[item.key])}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {snapshot?.remarksEnabled && assessment.remarks ? (
        <div>
          <p className="font-semibold text-foreground text-xs uppercase tracking-wide mb-1">{snapshot.remarksLabel}</p>
          <p className="whitespace-pre-wrap">{assessment.remarks}</p>
        </div>
      ) : null}

      {snapshot && (assessment.goals || []).some((row) => row.goal || row.timeline) ? (
        <div>
          <p className="font-semibold text-foreground text-xs uppercase tracking-wide mb-2">{snapshot.goalsTitle}</p>
          <div className="space-y-1">
            {(assessment.goals || []).map((row, index) => (
              row.goal || row.timeline ? (
                <div key={index} className="grid grid-cols-2 gap-2">
                  <span>{index + 1}. {row.goal || '—'}</span>
                  <span className="text-muted-foreground">{row.timeline || '—'}</span>
                </div>
              ) : null
            ))}
          </div>
        </div>
      ) : null}

      {assessment.assessedBy ? (
        <p><span className="text-muted-foreground">{snapshot?.assessedByLabel || 'Assessed by'}:</span> {assessment.assessedBy}</p>
      ) : null}
    </div>
  );
}
