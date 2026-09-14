import { useEffect, useState } from "react";
import { Loader2, Plus, X, Paperclip, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StarRating } from "@/components/ui/star-rating";
import { toast } from "sonner";
import {
  remarkService,
  type RemarkItem,
  type RemarkTemplateType,
  type RemarkProgramCode,
  type RemarkRatings,
  type RemarkExamInfo,
} from "@/services/api";

// BeeBright Student Remarks Spec v2 — the single form component behind all three
// templates (Toddler Observation Note Card / Academic Tutorial Remark / Examination
// Preparedness Remark), plus editing a draft and correcting a published remark.

const PROMPT_SUGGESTIONS = [
  "The student independently…",
  "The student showed improvement in…",
  "The student participated well in…",
  "The student needed support with…",
  "The student is developing…",
  "Next session, we will…",
];

const BANNED_WORDS = ["poor", "lazy", "weak", "bad behavior"];

function bannedWordsIn(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_WORDS.filter((w) => lower.includes(w));
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

function todayDateInput() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface RemarkFormProps {
  studentId: string;
  studentLabel: string;
  /** The remark type (program) chosen in the "Choose Remark Type" step (Spec v3) —
   * fixed for the lifetime of a create/edit/correct flow, threaded straight into every
   * submitted payload rather than inferred from the student. */
  programCode: RemarkProgramCode;
  templateType: RemarkTemplateType;
  hasMediaConsent: boolean;
  /** Present when editing an existing draft (mode="edit") or correcting a published one (mode="correct"). */
  existingRemark?: RemarkItem | null;
  mode: "create" | "edit" | "correct";
  onSaved: () => void;
  onCancel?: () => void;
}

export function RemarkForm({ studentId, studentLabel, programCode, templateType, hasMediaConsent, existingRemark, mode, onSaved, onCancel }: RemarkFormProps) {
  const [date, setDate] = useState(existingRemark?.date ? existingRemark.date.slice(0, 10) : todayDateInput());
  const [activities, setActivities] = useState<string[]>(existingRemark?.activities || []);
  const [activityDraft, setActivityDraft] = useState("");
  const [ratings, setRatings] = useState<RemarkRatings>(
    existingRemark?.ratings || { participationEngagement: null, socialInteraction: null, followingDirections: null, overallBehavior: null }
  );
  const [remarkBullets, setRemarkBullets] = useState<string[]>(existingRemark?.remarkBullets || []);
  const [bulletDraft, setBulletDraft] = useState("");
  const [nextFocus, setNextFocus] = useState(existingRemark?.nextFocus || "");
  const [parentSupportSuggestion, setParentSupportSuggestion] = useState(existingRemark?.parentSupportSuggestion || "");
  const [examInfo, setExamInfo] = useState<RemarkExamInfo>(existingRemark?.examInfo || { topic: "", scoreResult: "", mistakesToReview: "", studyGoal: "" });
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [submitting, setSubmitting] = useState<"draft" | "publish" | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    setErrors([]);
  }, [activities, remarkBullets, nextFocus, ratings, examInfo, attachmentFile]);

  const addActivity = () => {
    const trimmed = activityDraft.trim();
    if (!trimmed) return;
    setActivities((prev) => [...prev, trimmed]);
    setActivityDraft("");
  };
  const addBullet = () => {
    const trimmed = bulletDraft.trim();
    if (!trimmed) return;
    setRemarkBullets((prev) => [...prev, trimmed]);
    setBulletDraft("");
  };

  const bulletWarning = bannedWordsIn(bulletDraft);

  const buildPayload = async (action: "draft" | "publish") => {
    const attachmentDataUrl = attachmentFile ? await readFileAsDataUrl(attachmentFile) : undefined;
    return {
      studentId,
      programCode,
      action,
      date,
      activities,
      ratings: templateType === "toddler_observation" ? ratings : undefined,
      remarkBullets,
      nextFocus,
      parentSupportSuggestion: templateType === "academic_progress" ? parentSupportSuggestion : undefined,
      examInfo: templateType === "examination_progress" ? examInfo : undefined,
      attachmentDataUrl,
      attachmentFileName: attachmentFile?.name,
    };
  };

  const handleSubmit = async (action: "draft" | "publish") => {
    if (mode === "correct" && !correctionReason.trim()) {
      toast.error("A correction reason is required.");
      return;
    }
    setSubmitting(action);
    setErrors([]);
    try {
      let res;
      if (mode === "correct" && existingRemark) {
        const payload = await buildPayload("publish"); // corrections always run full publish validation
        res = await remarkService.correct(existingRemark._id, { ...payload, correctionReason: correctionReason.trim() });
      } else if (mode === "edit" && existingRemark) {
        const payload = await buildPayload(action);
        res = await remarkService.update(existingRemark._id, payload);
      } else {
        const payload = await buildPayload(action);
        res = await remarkService.create(payload);
      }
      if (res.data?.success) {
        toast.success(res.data.message || "Saved.");
        onSaved();
      } else {
        setErrors(res.data?.errors || [res.data?.message || "Failed to save."]);
      }
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { message?: string; errors?: string[] } } })?.response?.data;
      setErrors(data?.errors || [data?.message || "Failed to save."]);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/20 p-3">
        <p className="text-sm font-medium text-foreground">{studentLabel}</p>
        <p className="text-xs text-muted-foreground">
          {templateType === "toddler_observation" ? "Toddler Observation Note Card" : templateType === "academic_progress" ? "Academic Tutorial Remark" : "Examination Preparedness Remark"}
        </p>
      </div>

      {mode === "correct" && (
        <div className="space-y-1">
          <Label htmlFor="correction-reason">Correction reason *</Label>
          <Textarea id="correction-reason" value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} placeholder="Why is this remark being corrected?" className="min-h-[60px]" />
        </div>
      )}

      <div className="space-y-1">
        <Label htmlFor="remark-date">Date</Label>
        <Input id="remark-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      {/* Activities */}
      <div className="space-y-1">
        <Label>Activities</Label>
        <div className="flex gap-2">
          <Input
            value={activityDraft}
            onChange={(e) => setActivityDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addActivity(); } }}
            placeholder="e.g. Reading comprehension worksheet"
          />
          <Button type="button" variant="outline" onClick={addActivity}><Plus className="h-4 w-4" /></Button>
        </div>
        {activities.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1">
            {activities.map((a, i) => (
              <span key={`${a}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-foreground">
                {a}
                <button type="button" onClick={() => setActivities((prev) => prev.filter((_, idx) => idx !== i))}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Toddler ratings */}
      {templateType === "toddler_observation" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-md border border-border p-3">
          {([
            ["participationEngagement", "Participation and Engagement"],
            ["socialInteraction", "Social Interaction"],
            ["followingDirections", "Following Directions"],
            ["overallBehavior", "Overall Behavior"],
          ] as const).map(([key, label]) => (
            <div key={key} className="space-y-1">
              <Label className="text-xs">{label}</Label>
              <StarRating value={ratings[key]} onChange={(v) => setRatings((prev) => ({ ...prev, [key]: v }))} max={3} />
            </div>
          ))}
        </div>
      )}

      {/* Remark bullets + professional-language prompts (guidance only, never blocking) */}
      <div className="space-y-1">
        <Label>Tutor remark bullets</Label>
        <div className="flex flex-wrap gap-1.5">
          {PROMPT_SUGGESTIONS.map((p) => (
            <Button key={p} type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => setBulletDraft(p)}>
              {p}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={bulletDraft}
            onChange={(e) => setBulletDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addBullet(); } }}
            placeholder="Write a factual, supportive observation…"
          />
          <Button type="button" variant="outline" onClick={addBullet}><Plus className="h-4 w-4" /></Button>
        </div>
        {bulletWarning.length > 0 && (
          <p className="text-xs text-warning flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" /> Consider rephrasing — avoid: {bulletWarning.join(", ")}. This won't block saving.
          </p>
        )}
        {remarkBullets.length > 0 && (
          <ul className="space-y-1 mt-1">
            {remarkBullets.map((b, i) => (
              <li key={`${b}-${i}`} className="flex items-start justify-between gap-2 rounded-md border border-border p-2 text-sm">
                <span>{b}</span>
                <button type="button" onClick={() => setRemarkBullets((prev) => prev.filter((_, idx) => idx !== i))}>
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1">
        <Label htmlFor="next-focus">Next Focus</Label>
        <Textarea id="next-focus" value={nextFocus} onChange={(e) => setNextFocus(e.target.value)} placeholder="Next session, we will…" className="min-h-[60px]" />
      </div>

      {/* Academic optional */}
      {templateType === "academic_progress" && (
        <div className="space-y-1">
          <Label htmlFor="parent-support">Parent support suggestion (optional)</Label>
          <Textarea id="parent-support" value={parentSupportSuggestion} onChange={(e) => setParentSupportSuggestion(e.target.value)} className="min-h-[60px]" />
        </div>
      )}

      {/* Exam prep optional */}
      {templateType === "examination_progress" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-md border border-border p-3">
          <div className="space-y-1">
            <Label className="text-xs">Practice test / exam topic (optional)</Label>
            <Input value={examInfo.topic || ""} onChange={(e) => setExamInfo((prev) => ({ ...prev, topic: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Score/result (optional)</Label>
            <Input value={examInfo.scoreResult || ""} onChange={(e) => setExamInfo((prev) => ({ ...prev, scoreResult: e.target.value }))} placeholder='e.g. "18/20" or "85%"' />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Mistakes or concepts to review (optional)</Label>
            <Textarea value={examInfo.mistakesToReview || ""} onChange={(e) => setExamInfo((prev) => ({ ...prev, mistakesToReview: e.target.value }))} className="min-h-[50px]" />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Study goal (optional)</Label>
            <Textarea value={examInfo.studyGoal || ""} onChange={(e) => setExamInfo((prev) => ({ ...prev, studyGoal: e.target.value }))} className="min-h-[50px]" />
          </div>
        </div>
      )}

      {/* Attachment */}
      <div className="space-y-1">
        <Label className="flex items-center gap-1"><Paperclip className="h-3.5 w-3.5" /> Attachment (optional)</Label>
        {!hasMediaConsent ? (
          <p className="text-xs text-muted-foreground">Attachment upload is disabled — this student's guardian has not yet provided media/attachment consent. An admin can record consent from the student's record.</p>
        ) : (
          <>
            <Input type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => setAttachmentFile(e.target.files?.[0] || null)} />
            {attachmentFile && <p className="text-xs text-muted-foreground">{attachmentFile.name} ({Math.round(attachmentFile.size / 1024)} KB)</p>}
          </>
        )}
      </div>

      {errors.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 space-y-1">
          {errors.map((e) => <p key={e} className="text-sm text-destructive">{e}</p>)}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={Boolean(submitting)}>Cancel</Button>
        )}
        {mode !== "correct" && (
          <Button type="button" variant="outline" onClick={() => handleSubmit("draft")} disabled={Boolean(submitting)}>
            {submitting === "draft" ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Save Draft
          </Button>
        )}
        <Button type="button" className="btn-glow" onClick={() => handleSubmit("publish")} disabled={Boolean(submitting)}>
          {submitting === "publish" ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          {mode === "correct" ? "Submit Correction" : "Publish"}
        </Button>
      </div>
    </div>
  );
}
