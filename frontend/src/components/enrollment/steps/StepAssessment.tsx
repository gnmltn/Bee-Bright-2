import { useEffect, useMemo, useState } from 'react';
import { Loader2, X, Check, CircleCheckBig } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';
import type { AssessmentTemplate } from '../assessment-types';
import { assessmentService } from '@/services/api';
import { formatAge, computeAgeYears } from '../wizard-types';

interface Props {
  data: WizardData;
  update: (p: Partial<WizardData>) => void;
  onNext: () => void;
  onBack: () => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
}

export default function StepAssessment({ data, update, onNext, onBack, toast }: Props) {
  const [templates, setTemplates] = useState<AssessmentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTemplate, setActiveTemplate] = useState<AssessmentTemplate | null>(null);
  const [showAssessmentModal, setShowAssessmentModal] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [draftInfoValues, setDraftInfoValues] = useState<Record<string, string>>({});
  const [draftRatings, setDraftRatings] = useState<Record<string, string>>({});
  const [draftRemarks, setDraftRemarks] = useState('');
  const [draftGoals, setDraftGoals] = useState<{ goal: string; timeline: string }[]>([]);
  const [draftAssessedBy, setDraftAssessedBy] = useState('');

  const programCodes = useMemo(
    () => Array.from(new Set(data.selectedPackages.map((pkg) => pkg.programCode))),
    [data.selectedPackages]
  );
  const relevantProgramCodes = new Set(['ACT102', 'EXP106']);
  const shouldAutoSkipAssessment = !programCodes.some((code) => relevantProgramCodes.has(code));
  const childAgeYears = data.birthdate ? computeAgeYears(data.birthdate) : 0;
  const isToddlerOrNotApplicable = shouldAutoSkipAssessment || childAgeYears < 2;

  useEffect(() => {
    if (isToddlerOrNotApplicable) {
      const shouldReset =
        data.assessmentApplicable !== false ||
        data.assessmentTemplateId !== null ||
        data.assessmentSkipReason !== 'This form does not apply for the selected program or age group.' ||
        Object.keys(data.assessmentRatings || {}).length > 0 ||
        Object.keys(data.assessmentInfoValues || {}).length > 0 ||
        (data.assessmentGoals || []).length > 0 ||
        Boolean(data.assessmentAssessedBy) ||
        Boolean(data.assessmentSnapshot);

      if (shouldReset) {
        update({
          assessmentApplicable: false,
          assessmentTemplateId: null,
          assessmentSkipReason: 'This form does not apply for the selected program or age group.',
          assessmentRatings: {},
          assessmentInfoValues: {},
          assessmentRemarks: '',
          assessmentGoals: [],
          assessmentAssessedBy: '',
          assessmentSnapshot: null,
        });
      }
      setTemplates([]);
      setLoading(false);
      return;
    }

    let mounted = true;
    setLoading(true);
    assessmentService
      .getTemplates(programCodes)
      .then((res) => {
        if (!mounted) return;
        setTemplates(res.data?.templates || []);
      })
      .catch(() => {
        if (mounted) {
          toast({ title: 'Could not load assessment forms', variant: 'destructive' });
          setTemplates([]);
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, [programCodes.join(','), isToddlerOrNotApplicable]);

  const selectedTemplate = templates.find((t) => t._id === data.assessmentTemplateId) || null;

  const allItemsRated = useMemo(() => {
    if (!selectedTemplate || data.assessmentApplicable === false) return true;
    return (selectedTemplate.sections || []).every((section) =>
      (section.items || []).every((item) => Boolean(data.assessmentRatings[item.key]))
    );
  }, [selectedTemplate, data.assessmentApplicable, data.assessmentRatings]);

  const canContinue =
    data.assessmentApplicable === false
    || (data.assessmentApplicable === true && Boolean(data.assessmentTemplateId) && allItemsRated);

  const chooseNotApplicable = () => {
    update({
      assessmentApplicable: false,
      assessmentTemplateId: null,
      assessmentSnapshot: null,
      assessmentSkipReason: templates[0]?.notApplicableLabel || 'not applicable',
      assessmentRatings: {},
      assessmentInfoValues: {},
      assessmentRemarks: '',
      assessmentGoals: [],
      assessmentAssessedBy: '',
    });
    setSavedNotice(false);
  };

  const openAssessmentModal = (template: AssessmentTemplate) => {
    const goalsCount = template.goalsCount || 0;
    const existingInfoValues = data.assessmentInfoValues || {};
    const existingRatings = data.assessmentRatings || {};
    const existingGoals = data.assessmentGoals?.length ? data.assessmentGoals : Array.from({ length: goalsCount }, () => ({ goal: '', timeline: '' }));

    setActiveTemplate(template);
    setDraftInfoValues({ ...existingInfoValues });
    setDraftRatings({ ...existingRatings });
    setDraftRemarks(data.assessmentRemarks || '');
    setDraftGoals(existingGoals.map((goal) => ({ ...goal })));
    setDraftAssessedBy(data.assessmentAssessedBy || '');
    setShowAssessmentModal(true);
    setSavedNotice(false);
  };

  const saveAssessment = () => {
    if (!activeTemplate) return;

    const requiredInfoMissing = (activeTemplate.infoFields || []).some((field) => !(draftInfoValues[field.key] || '').trim());
    const requiredRatingsMissing = (activeTemplate.sections || []).some((section) =>
      (section.items || []).some((item) => !(draftRatings[item.key] || '').trim())
    );

    if (requiredInfoMissing || requiredRatingsMissing) {
      toast({
        title: 'Assessment incomplete',
        description: 'Please complete all required fields before saving the assessment.',
        variant: 'destructive',
      });
      return;
    }

    const nextGoals = draftGoals.length ? draftGoals : Array.from({ length: activeTemplate.goalsCount || 0 }, () => ({ goal: '', timeline: '' }));

    update({
      assessmentApplicable: true,
      assessmentSkipReason: '',
      assessmentTemplateId: activeTemplate._id,
      assessmentSnapshot: activeTemplate,
      assessmentRatings: { ...draftRatings },
      assessmentInfoValues: { ...draftInfoValues },
      assessmentRemarks: draftRemarks,
      assessmentGoals: nextGoals,
      assessmentAssessedBy: draftAssessedBy,
    });

    setShowAssessmentModal(false);
    setSavedNotice(true);
    toast({ title: 'Assessment saved', description: `${activeTemplate.title} was saved successfully.` });
  };

  const studentName = `${data.studentFirstName} ${data.studentMiddleName || ''} ${data.studentLastName}`.replace(/\s+/g, ' ').trim();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Pre-Enrollment Assessment</h2>
        <p className="text-muted-foreground text-sm mt-1">
          {templates[0]?.description
            || 'This assessment is required for manual processing when the selected program requires it.'}
        </p>
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
          Please complete and submit this assessment for the relevant program. It is required for manual review.
        </div>
      </div>

      <div className="p-3 rounded-lg bg-muted text-sm space-y-1">
        <p><span className="text-muted-foreground">Student:</span> <strong>{studentName || '—'}</strong></p>
        <p><span className="text-muted-foreground">Age:</span> {data.birthdate ? formatAge(data.birthdate) : '—'}</p>
        <p><span className="text-muted-foreground">Parent/Guardian:</span> {data.parentName || '—'}</p>
        <p><span className="text-muted-foreground">Contact:</span> {data.parentMobile || '—'}</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No assessment form is required for the selected program.</p>
      ) : (
        <>
          <div className="space-y-2">
            <Label>Which form applies to your child?</Label>
            <div className="grid gap-2">
              {templates.map((template) => {
                const isSelected = data.assessmentApplicable === true && data.assessmentTemplateId === template._id;
                return (
                  <button
                    key={template._id}
                    type="button"
                    onClick={() => openAssessmentModal(template)}
                    className={`text-left p-3 rounded-xl border transition-colors ${
                      isSelected
                        ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/20'
                        : 'border-border hover:bg-muted/60'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-semibold">{template.title}</p>
                        {template.description ? <p className="text-xs text-muted-foreground mt-1">{template.description}</p> : null}
                      </div>
                      {isSelected ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700">
                          <Check className="h-3 w-3" />
                          Saved
                        </span>
                      ) : (
                        <span className="text-xs font-medium text-muted-foreground">Open form</span>
                      )}
                    </div>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={chooseNotApplicable}
                className={`text-left p-3 rounded-xl border transition-colors ${
                  data.assessmentApplicable === false
                    ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/20'
                    : 'border-border hover:bg-muted/60'
                }`}
              >
                <p className="font-semibold">{templates[0]?.notApplicableLabel || 'This form does not apply'}</p>
                <p className="text-xs text-muted-foreground mt-1">{templates[0]?.notApplicableLabel || 'Choose this if none of the listed forms apply.'}</p>
              </button>
            </div>
          </div>

          {savedNotice && data.assessmentApplicable === true && selectedTemplate && (
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 dark:bg-emerald-950/20 dark:text-emerald-300">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-white">
                <Check className="h-3 w-3" />
              </span>
              Assessment form saved: {selectedTemplate.title}
            </div>
          )}
        </>
      )}

      {showAssessmentModal && activeTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="relative w-full max-w-4xl max-h-[85vh] overflow-y-auto rounded-[28px] border border-border bg-background shadow-2xl" style={{ clipPath: 'inset(0 round 28px)' }}>
            <div className="sticky top-0 z-10 mb-4 flex items-center justify-between gap-4 border-b border-border bg-background/95 px-6 py-4 backdrop-blur-sm rounded-t-[28px]">
              <div>
                <h3 className="text-2xl font-bold">{activeTemplate.title}</h3>
                {activeTemplate.description ? <p className="text-sm text-muted-foreground mt-1">{activeTemplate.description}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => setShowAssessmentModal(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground transition-colors hover:bg-amber-50 hover:text-amber-700"
                aria-label="Close assessment"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-6 pb-6 pt-2">

            <div className="space-y-6">
              {activeTemplate.infoFields?.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={`modal-${field.key}`}>{field.label}</Label>
                  <Input
                    id={`modal-${field.key}`}
                    value={draftInfoValues[field.key] || ''}
                    onChange={(e) => setDraftInfoValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  />
                </div>
              ))}

              {activeTemplate.sections?.map((section) => (
                <div key={section.key} className="space-y-3">
                  <h4 className="font-semibold text-sm">{section.title}</h4>
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/60">
                          <th className="text-left p-2 font-medium">Skill</th>
                          {activeTemplate.ratingScale.map((option) => (
                            <th key={option.value} className="p-2 font-medium text-center whitespace-nowrap">{option.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {section.items.map((item) => (
                          <tr key={item.key} className="border-t border-border">
                            <td className="p-2 pr-3">{item.label}</td>
                            {activeTemplate.ratingScale.map((option) => (
                              <td key={option.value} className="p-2 text-center">
                                <input
                                  type="radio"
                                  name={`modal-rating-${item.key}`}
                                  checked={draftRatings[item.key] === option.value}
                                  onChange={() => setDraftRatings((prev) => ({ ...prev, [item.key]: option.value }))}
                                  aria-label={`${item.label}: ${option.label}`}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}

              {activeTemplate.remarksEnabled && (
                <div className="space-y-1.5">
                  <Label htmlFor="modal-assessment-remarks">{activeTemplate.remarksLabel}</Label>
                  <Textarea
                    id="modal-assessment-remarks"
                    value={draftRemarks}
                    onChange={(e) => setDraftRemarks(e.target.value)}
                    rows={4}
                  />
                </div>
              )}

              {(activeTemplate.goalsCount || 0) > 0 && (
                <div className="space-y-2">
                  <p className="font-semibold text-sm">{activeTemplate.goalsTitle}</p>
                  <div className="grid grid-cols-2 gap-2 text-xs font-medium text-muted-foreground">
                    <span>{activeTemplate.goalColumnLabel}</span>
                    <span>{activeTemplate.timelineColumnLabel}</span>
                  </div>
                  {Array.from({ length: activeTemplate.goalsCount || 0 }).map((_, index) => (
                    <div key={index} className="grid grid-cols-2 gap-2">
                      <Input
                        placeholder={`${index + 1}.`}
                        value={draftGoals[index]?.goal || ''}
                        onChange={(e) => setDraftGoals((prev) => {
                          const next = [...prev];
                          if (!next[index]) next[index] = { goal: '', timeline: '' };
                          next[index] = { ...next[index], goal: e.target.value };
                          return next;
                        })}
                      />
                      <Input
                        value={draftGoals[index]?.timeline || ''}
                        onChange={(e) => setDraftGoals((prev) => {
                          const next = [...prev];
                          if (!next[index]) next[index] = { goal: '', timeline: '' };
                          next[index] = { ...next[index], timeline: e.target.value };
                          return next;
                        })}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="modal-assessed-by">{activeTemplate.assessedByLabel}</Label>
                <Input
                  id="modal-assessed-by"
                  value={draftAssessedBy}
                  onChange={(e) => setDraftAssessedBy(e.target.value)}
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3 border-t border-border pt-4">
              <button
                type="button"
                onClick={() => setShowAssessmentModal(false)}
                className="rounded-xl border border-border px-4 py-2 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveAssessment}
                className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-600"
              >
                Save
              </button>
            </div>
            </div>
          </div>
        </div>
      )}

      <StepNav onBack={onBack} onNext={onNext} disableNext={!canContinue || loading} />
    </div>
  );
}
