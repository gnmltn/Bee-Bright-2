import { useEffect, useState } from "react";
import { Loader2, Check, X, Paperclip, ShieldCheck, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import FilePreview from "@/components/enrollment/FilePreview";
import { toast } from "sonner";
import { remarkService, userService, type RemarkItem } from "@/services/api";

const TEMPLATE_LABELS: Record<string, string> = {
  toddler_observation: "Toddler Observation Note Card",
  academic_progress: "Academic Tutorial Remark",
  examination_progress: "Examination Preparedness Remark",
};

function personName(person?: { firstName?: string; middleName?: string; lastName?: string } | null) {
  if (!person) return "—";
  return [person.firstName, person.middleName, person.lastName].filter(Boolean).join(" ");
}

// BeeBright Student Remarks Spec v2, Section D — admin approval gate for any remark
// that includes an attachment. Self-contained (not grown inline into AdminDashboard.tsx),
// mounted from a thin tab there, matching the OneOnOneSchedulingWizard.tsx precedent.
export function RemarksReviewQueue() {
  const [remarks, setRemarks] = useState<RemarkItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<RemarkItem | null>(null);
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [grantingConsent, setGrantingConsent] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await remarkService.listPendingReview();
      setRemarks(res.data?.remarks || []);
    } catch {
      setRemarks([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    setAttachmentUrl(null);
    setRejectReason("");
    setShowRejectInput(false);
    if (!selected?.attachment) return;
    let cancelled = false;
    remarkService.getAttachmentObjectUrl(selected._id).then((url) => {
      if (!cancelled) setAttachmentUrl(url);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selected]);

  const handleDecision = async (decision: "approve" | "reject") => {
    if (!selected) return;
    if (decision === "reject" && !rejectReason.trim()) {
      setShowRejectInput(true);
      toast.error("Provide a rejection reason.");
      return;
    }
    setActionLoading(true);
    try {
      const res = await remarkService.review(selected._id, { decision, reason: decision === "reject" ? rejectReason.trim() : undefined });
      if (res.data?.success) {
        toast.success(res.data.message || "Done.");
        setSelected(null);
        load();
      } else {
        toast.error(res.data?.message || "Failed to review remark.");
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to review remark.";
      toast.error(msg);
    } finally {
      setActionLoading(false);
    }
  };

  // Spec v3.1 — consent is no longer a tutor-facing blocker; it's information shown here
  // for the admin to weigh alongside the attachment itself. The existing grant-consent
  // action (also available from the Users tab) is surfaced directly in this dialog too,
  // so an admin can grant it and then Approve in the same review without leaving the
  // queue. Updates both the list and the open dialog optimistically — no need to
  // re-fetch the whole queue just to see the flag flip.
  const handleGrantConsent = async () => {
    if (!selected?.student) return;
    const studentId = selected.student._id;
    const studentName = personName(selected.student);
    setGrantingConsent(true);
    try {
      const res = await userService.grantMediaConsent(studentId);
      if (res.data?.success) {
        toast.success(res.data.message || `Media consent recorded for ${studentName}.`);
        setSelected((prev) => (prev ? { ...prev, studentHasMediaConsent: true } : prev));
        setRemarks((prev) => prev.map((r) => (r._id === selected._id ? { ...r, studentHasMediaConsent: true } : r)));
      } else {
        toast.error(res.data?.message || "Failed to record media consent.");
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to record media consent.";
      toast.error(msg);
    } finally {
      setGrantingConsent(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="font-semibold text-foreground">Pending Admin Review</h4>
          <p className="text-xs text-muted-foreground">Remarks with an attachment must be approved before a parent can see them.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Refresh"}
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : remarks.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">No remarks are awaiting review.</p>
      ) : (
        <div className="space-y-2">
          {remarks.map((r) => (
            <button
              key={r._id}
              type="button"
              onClick={() => setSelected(r)}
              className="w-full text-left rounded-md border border-border bg-card p-3 hover:border-primary transition-colors flex items-center justify-between gap-2"
            >
              <div>
                <p className="text-sm font-medium text-foreground">{personName(r.student)} <span className="text-muted-foreground font-normal">· {personName(r.tutor)}</span></p>
                <p className="text-xs text-muted-foreground">{TEMPLATE_LABELS[r.templateType] || r.templateType} · {new Date(r.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${r.studentHasMediaConsent ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>
                  {r.studentHasMediaConsent ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
                  {r.studentHasMediaConsent ? "Consent" : "No consent"}
                </span>
                <Paperclip className="h-4 w-4 text-muted-foreground" />
              </div>
            </button>
          ))}
        </div>
      )}

      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>{personName(selected.student)}'s remark</DialogTitle>
                <DialogDescription>
                  {TEMPLATE_LABELS[selected.templateType] || selected.templateType} · by {personName(selected.tutor)} · {new Date(selected.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                {/* Spec v3.1 — consent is no longer enforced on the tutor; this is now the
                    only place it matters. The admin weighs it, together with the
                    attachment content below, to decide Approve or Reject. */}
                <div className={`flex items-center justify-between gap-2 rounded-md border p-2 ${selected.studentHasMediaConsent ? "border-success/40 bg-success/10" : "border-warning/40 bg-warning/10"}`}>
                  <span className={`flex items-center gap-1.5 text-xs font-medium ${selected.studentHasMediaConsent ? "text-success" : "text-warning"}`}>
                    {selected.studentHasMediaConsent ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
                    Consent: {selected.studentHasMediaConsent ? "Granted" : "Not on record"}
                  </span>
                  {!selected.studentHasMediaConsent && (
                    <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={handleGrantConsent} disabled={grantingConsent}>
                      {grantingConsent ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                      Grant consent
                    </Button>
                  )}
                </div>
                <div>
                  <Label className="text-xs">Activities</Label>
                  <p className="text-foreground">{selected.activities.join(", ") || "—"}</p>
                </div>
                {selected.templateType === "toddler_observation" && selected.ratings && (
                  <div>
                    <Label className="text-xs">Ratings</Label>
                    <p className="text-foreground">
                      Participation {selected.ratings.participationEngagement}/3 · Social {selected.ratings.socialInteraction}/3 · Directions {selected.ratings.followingDirections}/3 · Behavior {selected.ratings.overallBehavior}/3
                    </p>
                  </div>
                )}
                <div>
                  <Label className="text-xs">Remark bullets</Label>
                  <ul className="list-disc pl-5 text-foreground">
                    {selected.remarkBullets.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
                <div>
                  <Label className="text-xs">Next Focus</Label>
                  <p className="text-foreground">{selected.nextFocus || "—"}</p>
                </div>
                {selected.parentSupportSuggestion && (
                  <div>
                    <Label className="text-xs">Parent support suggestion</Label>
                    <p className="text-foreground">{selected.parentSupportSuggestion}</p>
                  </div>
                )}
                {selected.templateType === "examination_progress" && selected.examInfo && (
                  <div>
                    <Label className="text-xs">Examination info</Label>
                    <p className="text-foreground">
                      {[selected.examInfo.topic, selected.examInfo.scoreResult, selected.examInfo.mistakesToReview, selected.examInfo.studyGoal].filter(Boolean).join(" · ") || "—"}
                    </p>
                  </div>
                )}
                {selected.attachment && (
                  <div>
                    <Label className="text-xs">Attachment</Label>
                    <FilePreview src={attachmentUrl ? { dataUrl: attachmentUrl, fileName: selected.attachment.fileName || "attachment", fileSize: selected.attachment.size } : undefined} />
                    {!attachmentUrl && <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Loading attachment…</p>}
                  </div>
                )}

                {showRejectInput && (
                  <div className="space-y-1">
                    <Label htmlFor="reject-reason" className="text-xs">Rejection reason *</Label>
                    <Textarea id="reject-reason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} className="min-h-[60px]" />
                  </div>
                )}
              </div>
              <DialogFooter className="flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => setSelected(null)} disabled={actionLoading}>Close</Button>
                <Button type="button" variant="destructive" onClick={() => handleDecision("reject")} disabled={actionLoading}>
                  <X className="h-4 w-4 mr-1" /> Reject
                </Button>
                <Button type="button" className="bg-success hover:bg-success/90" onClick={() => handleDecision("approve")} disabled={actionLoading}>
                  {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Check className="h-4 w-4 mr-1" />}
                  Approve
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
