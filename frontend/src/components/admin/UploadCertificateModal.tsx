import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import DocUploadField, { type UploadedFile } from "@/components/enrollment/DocUploadField";
import { certificateService, type AdminEnrollment, type CertificateItem } from "@/services/api";

// Same Dialog/DialogContent structure as TutorDashboard.tsx's "Post announcement"
// modal, with Quick select / Title / Category / Date removed — only the student
// selector, the file, and an optional message are relevant to a certificate.

interface StudentOption {
  _id: string;
  name: string;
}

interface UploadCertificateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enrollments: AdminEnrollment[];
  onPublished: () => void;
  /** When set, the modal is in "Replace" mode for this certificate: the student list
   * is shown read-only (a replacement keeps the same recipients) and only the file +
   * message can change. */
  editingCertificate?: CertificateItem | null;
}

function personName(person?: { firstName?: string; lastName?: string } | null) {
  if (!person) return "";
  return [person.firstName, person.lastName].filter(Boolean).join(" ");
}

export function UploadCertificateModal({ open, onOpenChange, enrollments, onPublished, editingCertificate }: UploadCertificateModalProps) {
  const isReplacing = Boolean(editingCertificate);

  const studentOptions = useMemo<StudentOption[]>(() => {
    const seen = new Map<string, StudentOption>();
    for (const enrollment of enrollments) {
      const student = enrollment.student;
      if (!student?._id) continue;
      if (!seen.has(student._id)) {
        seen.set(student._id, { _id: student._id, name: personName(student) || "Unnamed student" });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [enrollments]);

  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editingCertificate) {
      setSelectedStudentIds(editingCertificate.students.map((s) => s._id));
      setMessage(editingCertificate.message || "");
    } else {
      setSelectedStudentIds([]);
      setMessage("");
    }
    setFile(null);
  }, [open, editingCertificate]);

  const toggleStudent = (id: string) => {
    if (isReplacing) return; // recipients are locked once a certificate already exists
    setSelectedStudentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const canSubmit = selectedStudentIds.length > 0 && Boolean(file);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !file) {
      toast.error("Select at least one student and upload a certificate file.");
      return;
    }
    setSubmitting(true);
    const request = isReplacing && editingCertificate
      ? certificateService.replace(editingCertificate._id, { fileDataUrl: file.dataUrl, fileName: file.fileName, message: message.trim() })
      : certificateService.upload({ studentIds: selectedStudentIds, fileDataUrl: file.dataUrl, fileName: file.fileName, message: message.trim() });
    request
      .then((res) => {
        if (res.data?.success) {
          toast.success(isReplacing ? "Certificate replaced." : "Certificate published.");
          onOpenChange(false);
          onPublished();
        } else {
          toast.error(res.data?.message || "Failed to save.");
        }
      })
      .catch((err) => {
        toast.error(err?.response?.data?.message || "Failed to save certificate.");
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{isReplacing ? "Replace certificate" : "Upload certificate"}</DialogTitle>
          <DialogDescription>
            {isReplacing
              ? "Upload a new file to replace this certificate. The recipients stay the same."
              : "Publish a ready-made certificate (PDF or image) to one or more students."}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4 overflow-y-auto pr-2" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label>Students *</Label>
            {isReplacing ? (
              <p className="text-sm text-muted-foreground">
                {editingCertificate?.students.map((s) => personName(s)).join(", ") || "—"}
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">Select every student who should receive this certificate.</p>
                <ScrollArea className="h-40 rounded-md border border-border p-2">
                  {studentOptions.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2">Loading students...</p>
                  ) : (
                    <div className="space-y-2">
                      {studentOptions.map((s) => (
                        <div key={s._id} className="flex items-center space-x-2">
                          <Checkbox
                            id={`cert-stu-${s._id}`}
                            checked={selectedStudentIds.includes(s._id)}
                            onCheckedChange={() => toggleStudent(s._id)}
                          />
                          <label htmlFor={`cert-stu-${s._id}`} className="text-sm font-medium cursor-pointer">{s.name}</label>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </>
            )}
          </div>

          <div className="grid gap-2">
            <Label>Certificate file *</Label>
            <DocUploadField
              label="Certificate file"
              desc="PDF or image (JPG/PNG), up to 5 MB."
              value={file}
              onChange={setFile}
              onRemove={() => setFile(null)}
            />
          </div>

          <div className="grid gap-2">
            <Label>Message (optional)</Label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Write a short note for the parent..."
              rows={3}
              className="resize-none"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!canSubmit || submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {isReplacing ? "Replace" : "Publish"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
