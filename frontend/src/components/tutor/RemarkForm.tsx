import { useEffect, useState } from "react";
import { Loader2, Plus, X, Paperclip, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StarRating } from "@/components/ui/star-rating";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import FilePreview from "@/components/enrollment/FilePreview";
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
  /** Present when editing an existing draft (mode="edit") or correcting a published one (mode="correct"). */
  existingRemark?: RemarkItem | null;
  mode: "create" | "edit" | "correct";
  onSaved: () => void;
  /** Dismiss with no server-side change — a plain close, or "Keep Editing". */
  onCancel?: () => void;
  /** Called after a draft was actually deleted server-side (mode="edit" only) — lets the
   * caller refresh Remark History so the deleted draft disappears from it. Falls back to
   * onCancel if not provided. */
  onDeleted?: () => void;
}

export function RemarkForm({ studentId, studentLabel, programCode, templateType, existingRemark, mode, onSaved, onCancel, onDeleted }: RemarkFormProps) {
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
  // Holds the data URL alongside the file so the preview (FilePreview, shared with the
  // enrollment wizard and the admin review queue) can render immediately with no round
  // trip — and so buildPayload doesn't need to re-read the file at submit time.
  const [attachmentPreview, setAttachmentPreview] = useState<{ dataUrl: string; fileName: string; fileSize: number } | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [submitting, setSubmitting] = useState<"draft" | "publish" | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  // The attachment already stored on this remark, if any. The backend always sends the
  // `attachment` subdocument, with null fields when there is no file — so `path` is what
  // actually tells them apart.
  const savedAttachment = existingRemark?.attachment?.path ? existingRemark.attachment : null;

  useEffect(() => {
    setErrors([]);
  }, [activities, remarkBullets, nextFocus, ratings, examInfo, attachmentPreview]);

  // Attachment consent is no longer a tutor-facing gate (Spec v3.1) — a tutor can always
  // choose a file, and consent is surfaced to the admin at Pending Admin Review instead.
  const handleAttachmentChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) { setAttachmentPreview(null); return; }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setAttachmentPreview({ dataUrl, fileName: file.name, fileSize: file.size });
    } catch {
      toast.error("Could not read the selected file.");
      setAttachmentPreview(null);
    }
  };

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

  const buildPayload = (
    action: "draft" | "publish",
    submittedActivities: string[],
    submittedBullets: string[],
  ) => ({
    studentId,
    programCode,
    action,
    date,
    activities: submittedActivities,
    ratings: templateType === "toddler_observation" ? ratings : undefined,
    remarkBullets: submittedBullets,
    nextFocus,
    parentSupportSuggestion: templateType === "academic_progress" ? parentSupportSuggestion : undefined,
    examInfo: templateType === "examination_progress" ? examInfo : undefined,
    attachmentDataUrl: attachmentPreview?.dataUrl,
    attachmentFileName: attachmentPreview?.fileName,
  });

  const handleSubmit = async (action: "draft" | "publish") => {
    if (mode === "correct" && !correctionReason.trim()) {
      toast.error("A correction reason is required.");
      return;
    }

    // Activities and remark bullets are the only two fields that need an explicit "+"
    // (or Enter) to turn the typed text into a chip. Text still sitting in those inputs
    // when Save Draft/Publish is clicked used to be dropped silently, which is why they
    // were the only fields that appeared not to persist. Commit it here instead — state
    // updates don't apply until the next render, so the committed values are also passed
    // straight into the payload rather than read back from state.
    const pendingActivity = activityDraft.trim();
    const pendingBullet = bulletDraft.trim();
    const submittedActivities = pendingActivity ? [...activities, pendingActivity] : activities;
    const submittedBullets = pendingBullet ? [...remarkBullets, pendingBullet] : remarkBullets;
    if (pendingActivity) { setActivities(submittedActivities); setActivityDraft(""); }
    if (pendingBullet) { setRemarkBullets(submittedBullets); setBulletDraft(""); }

    setSubmitting(action);
    setErrors([]);
    try {
      let res;
      if (mode === "correct" && existingRemark) {
        // Corrections always run full publish validation.
        const payload = buildPayload("publish", submittedActivities, submittedBullets);
        res = await remarkService.correct(existingRemark._id, { ...payload, correctionReason: correctionReason.trim() });
      } else if (mode === "edit" && existingRemark) {
        const payload = buildPayload(action, submittedActivities, submittedBullets);
        res = await remarkService.update(existingRemark._id, payload);
      } else {
        const payload = buildPayload(action, submittedActivities, submittedBullets);
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

  // ─── Cancel -> Delete Draft (with confirmation) ────────────────────────────────
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // A brand-new, still-blank remark has nothing worth confirming over — today's
  // default date doesn't count as "entered content."
  const hasEnteredContent =
    activities.length > 0 ||
    remarkBullets.length > 0 ||
    activityDraft.trim() !== "" ||
    bulletDraft.trim() !== "" ||
    nextFocus.trim() !== "" ||
    parentSupportSuggestion.trim() !== "" ||
    attachmentPreview !== null ||
    Object.values(ratings).some((v) => v !== null) ||
    Object.values(examInfo).some((v) => (v || "").trim() !== "");

  const isExistingDraft = mode === "edit" && Boolean(existingRemark);

  const handleCancelClick = () => {
    // Correcting a published remark isn't a draft — there's nothing to delete, so
    // Cancel here always just closes, same as before this feature.
    if (mode === "correct") {
      onCancel?.();
      return;
    }
    if (isExistingDraft || hasEnteredContent) {
      setConfirmDeleteOpen(true);
    } else {
      onCancel?.();
    }
  };

  const handleConfirmDelete = async () => {
    if (!isExistingDraft || !existingRemark) {
      // Nothing was ever persisted — just discard the in-memory content.
      setConfirmDeleteOpen(false);
      onCancel?.();
      return;
    }
    setDeleting(true);
    try {
      const res = await remarkService.deleteDraft(existingRemark._id);
      if (res.data?.success) {
        toast.success(res.data.message || "Draft deleted.");
        setConfirmDeleteOpen(false);
        (onDeleted || onCancel)?.();
      } else {
        toast.error(res.data?.message || "Failed to delete draft.");
      }
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { message?: string } } })?.response?.data;
      toast.error(data?.message || "Failed to delete draft.");
    } finally {
      setDeleting(false);
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

      {/* Attachment — never gated on consent (Spec v3.1): a tutor can always choose a
          file, on a brand-new form or an existing draft. Consent is surfaced to the
          admin at Pending Admin Review instead (see RemarksReviewQueue.tsx), not
          enforced here. A newly chosen file gets an immediate local preview (thumbnail
          for images, a filename row for PDFs, via the same FilePreview used by the
          enrollment wizard and the admin review queue) so the tutor can visually
          confirm it's the right file before saving. */}
      <div className="space-y-1">
        <Label htmlFor="remark-attachment" className="flex items-center gap-1"><Paperclip className="h-3.5 w-3.5" /> Attachment (optional)</Label>
        {savedAttachment && !attachmentPreview && (
          <p className="text-xs text-foreground">
            Currently attached: {savedAttachment.fileName}
            {savedAttachment.size ? ` (${Math.round(savedAttachment.size / 1024)} KB)` : ""}
          </p>
        )}
        <Input
          id="remark-attachment"
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          onChange={handleAttachmentChange}
        />
        {attachmentPreview ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{savedAttachment ? "Replacing with:" : "Preview:"}</p>
            <FilePreview src={attachmentPreview} className="max-w-xs" />
          </div>
        ) : savedAttachment ? (
          <p className="text-xs text-muted-foreground">Choose a file to replace the attachment above.</p>
        ) : null}
      </div>

      {errors.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 space-y-1">
          {errors.map((e) => <p key={e} className="text-sm text-destructive">{e}</p>)}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={handleCancelClick} disabled={Boolean(submitting)}>Cancel</Button>
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

      <AlertDialog open={confirmDeleteOpen} onOpenChange={(open) => { if (!deleting) setConfirmDeleteOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this draft? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Keep Editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleConfirmDelete(); }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete Draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
