import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import FilePreview from "@/components/enrollment/FilePreview";
import { remarkService, type RemarkItem } from "@/services/api";

const TEMPLATE_LABELS: Record<string, string> = {
  toddler_observation: "Toddler Observation Note",
  academic_progress: "Academic Progress Report",
  examination_progress: "Examination Preparation Report",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending_admin_review: "Pending Admin Review",
  published: "Published",
};

interface Props {
  remark: RemarkItem | null;
  onClose: () => void;
}

/**
 * Read-only detail view for a past remark, opened from Remark History — lets a
 * tutor compare an older remark against a newer one to gauge whether a student
 * has improved. No edit affordance anywhere: this is strictly a viewer.
 * ChildSelector_AddChildModal_TutorRemarksView.pdf C.
 */
export function RemarkDetailDialog({ remark, onClose }: Props) {
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);

  useEffect(() => {
    setAttachmentUrl(null);
    if (!remark?.attachment) return;
    let cancelled = false;
    remarkService.getAttachmentObjectUrl(remark._id).then((url) => {
      if (!cancelled) setAttachmentUrl(url);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [remark]);

  const studentName = remark?.student ? `${remark.student.firstName} ${remark.student.lastName}` : "—";

  return (
    <Dialog open={!!remark} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        {remark && (
          <>
            <DialogHeader>
              <DialogTitle>{studentName}'s remark</DialogTitle>
              <DialogDescription>
                {TEMPLATE_LABELS[remark.templateType] || remark.templateType} ·{" "}
                {new Date(remark.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ·{" "}
                {STATUS_LABEL[remark.status] || remark.status}
                {remark.status === "published" && !remark.isCurrentVersion ? " (superseded)" : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 text-sm">
              <div>
                <Label className="text-xs">Activities</Label>
                <p className="text-foreground">{remark.activities.join(", ") || "—"}</p>
              </div>

              {remark.templateType === "toddler_observation" && remark.ratings && (
                <div>
                  <Label className="text-xs">Ratings</Label>
                  <p className="text-foreground">
                    Participation {remark.ratings.participationEngagement}/3 · Social {remark.ratings.socialInteraction}/3 · Directions {remark.ratings.followingDirections}/3 · Behavior {remark.ratings.overallBehavior}/3
                  </p>
                </div>
              )}

              <div>
                <Label className="text-xs">Remark bullets</Label>
                <ul className="list-disc pl-5 text-foreground">
                  {remark.remarkBullets.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </div>

              <div>
                <Label className="text-xs">Next Focus</Label>
                <p className="text-foreground">{remark.nextFocus || "—"}</p>
              </div>

              {remark.parentSupportSuggestion && (
                <div>
                  <Label className="text-xs">Parent support suggestion</Label>
                  <p className="text-foreground">{remark.parentSupportSuggestion}</p>
                </div>
              )}

              {remark.templateType === "examination_progress" && remark.examInfo && (
                <div>
                  <Label className="text-xs">Examination info</Label>
                  <p className="text-foreground">
                    {[remark.examInfo.topic, remark.examInfo.scoreResult, remark.examInfo.mistakesToReview, remark.examInfo.studyGoal].filter(Boolean).join(" · ") || "—"}
                  </p>
                </div>
              )}

              {remark.status === "draft" && remark.rejectionReason && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2">
                  <Label className="text-xs text-destructive">Admin's rejection reason</Label>
                  <p className="text-destructive">{remark.rejectionReason}</p>
                </div>
              )}

              {remark.attachment && (
                <div>
                  <Label className="text-xs">Attachment</Label>
                  <FilePreview src={attachmentUrl ? { dataUrl: attachmentUrl, fileName: remark.attachment.fileName || "attachment", fileSize: remark.attachment.size } : undefined} />
                  {!attachmentUrl && <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Loading attachment…</p>}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Close</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
