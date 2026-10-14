import { useCallback, useEffect, useState } from "react";
import { Award, Eye, RefreshCw, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { certificateService, type AdminEnrollment, type CertificateItem } from "@/services/api";
import { UploadCertificateModal } from "./UploadCertificateModal";
import FilePreview from "@/components/enrollment/FilePreview";

function personName(person?: { firstName?: string; lastName?: string } | null) {
  if (!person) return "";
  return [person.firstName, person.lastName].filter(Boolean).join(" ");
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

interface CertificatesPanelProps {
  enrollments: AdminEnrollment[];
}

// Right column of the admin Remarks tab (left column is the existing, untouched
// Student Remarks section). Mirrors RemarksReviewHistory.tsx's layout conventions.
export function CertificatesPanel({ enrollments }: CertificatesPanelProps) {
  const [history, setHistory] = useState<CertificateItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editingCertificate, setEditingCertificate] = useState<CertificateItem | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<CertificateItem | null>(null);
  const [previewCertificate, setPreviewCertificate] = useState<CertificateItem | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await certificateService.getHistory();
      setHistory(res.data?.success ? res.data.history || [] : []);
    } catch {
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Opens the certificate in an in-page preview Dialog instead of window.open(), which
  // used to navigate the current tab away with no way back short of the browser's own
  // back button — window.open's popup-vs-navigation behavior is unreliable once it
  // happens after an async gap like this file fetch. Mirrors RemarkDetailDialog.tsx's
  // object-URL-fetch pattern.
  useEffect(() => {
    setPreviewUrl(null);
    if (!previewCertificate) return;
    let cancelled = false;
    certificateService.getFileObjectUrl(previewCertificate._id).then((url) => {
      if (!cancelled) setPreviewUrl(url);
    }).catch(() => {
      if (!cancelled) { toast.error("Could not open this certificate."); setPreviewCertificate(null); }
    });
    return () => { cancelled = true; };
  }, [previewCertificate]);

  const handleRemove = async (certificate: CertificateItem) => {
    setActioningId(certificate._id);
    try {
      const res = await certificateService.retract(certificate._id);
      if (res.data?.success) {
        toast.success("Certificate removed.");
        load();
      } else {
        toast.error(res.data?.message || "Failed to remove.");
      }
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || "Failed to remove certificate.");
    } finally {
      setActioningId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h4 className="font-semibold text-foreground flex items-center gap-1.5">
            <Award className="h-4 w-4" /> Certificates
          </h4>
          <p className="text-xs text-muted-foreground">Publish a ready-made certificate to one or more students.</p>
        </div>
        <Button type="button" size="sm" className="btn-glow" onClick={() => { setEditingCertificate(null); setUploadOpen(true); }}>
          Upload Certificate
        </Button>
      </div>

      <div className="space-y-2">
        <h5 className="text-sm font-medium text-foreground">History</h5>
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : history.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No certificates published yet.</p>
        ) : (
          <div className="space-y-2">
            {history.map((certificate) => {
              const names = certificate.students.map((s) => personName(s)).join(", ") || "—";
              const isActing = actioningId === certificate._id;
              return (
                <div key={certificate._id} className="rounded-md border border-border bg-card p-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <p className="text-sm font-medium text-foreground">{names}</p>
                      <p className="text-xs text-muted-foreground">
                        Published {formatDate(certificate.publishedAt)}
                        {certificate.replacedAt ? ` · Replaced ${formatDate(certificate.replacedAt)}` : ""}
                        {certificate.publishedBy ? ` · by ${personName(certificate.publishedBy)}` : ""}
                      </p>
                      {certificate.message && <p className="text-xs text-foreground mt-1">{certificate.message}</p>}
                    </div>
                    {certificate.status === "retracted" && (
                      <Badge variant="outline" className="text-muted-foreground flex-shrink-0">Retracted</Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => setPreviewCertificate(certificate)}>
                      <Eye className="h-3.5 w-3.5 mr-1" /> View
                    </Button>
                    {certificate.canModify && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={isActing}
                          onClick={() => { setEditingCertificate(certificate); setUploadOpen(true); }}
                        >
                          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Replace
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:text-destructive"
                          disabled={isActing}
                          onClick={() => setRemoveTarget(certificate)}
                        >
                          {isActing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 mr-1" />}
                          Remove
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <UploadCertificateModal
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        enrollments={enrollments}
        editingCertificate={editingCertificate}
        onPublished={load}
      />

      <FilePreview
        open={!!previewCertificate}
        onOpenChange={(open) => { if (!open) setPreviewCertificate(null); }}
        hideTrigger
        label={previewCertificate ? `Certificate — ${previewCertificate.students.map((s) => personName(s)).join(", ")}` : undefined}
        src={previewUrl && previewCertificate ? { dataUrl: previewUrl, fileName: previewCertificate.file.fileName, fileSize: previewCertificate.file.size } : undefined}
      />

      {/* Remove confirmation — mirrors AdminDashboard.tsx's "Delete session" dialog
          pattern instead of the native browser confirm(). Internal behavior (7-day
          window, Certificate.status, etc.) is unchanged — only this label reads
          "Remove" instead of "Retract". */}
      <Dialog open={!!removeTarget} onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove certificate</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove this certificate for{" "}
              {removeTarget ? removeTarget.students.map((s) => personName(s)).join(", ") || "this student" : ""}?
              It will no longer be visible to the parent(s).
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const target = removeTarget;
                setRemoveTarget(null);
                if (target) handleRemove(target);
              }}
            >
              Yes, remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
