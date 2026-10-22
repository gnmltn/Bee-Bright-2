import { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { adminEmailService, type AdminEmailRecipient } from "@/services/api";

// Panel-required change: admin shouldn't have to open Gmail by hand to email a parent or
// tutor. Same Dialog/ScrollArea/Checkbox structure as UploadCertificateModal.tsx, with
// the file upload removed entirely (this composer only ever sends text) and the student
// list replaced by a Parents/Tutors-filtered recipient list that deliberately INCLUDES
// rejected/unverified/not-yet-active accounts — email is exactly how admin reaches them
// to say what's needed — tagged with their status (e.g. "Jake Soriano - rejected") so
// admin can tell at a glance who they're emailing and why.

interface AdminEmailComposerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function statusLabel(status: string | null): string | null {
  if (!status) return null;
  return status.replace(/_/g, " ");
}

export function AdminEmailComposerModal({ open, onOpenChange }: AdminEmailComposerModalProps) {
  const [roleFilter, setRoleFilter] = useState<"parent" | "tutor">("parent");
  const [recipients, setRecipients] = useState<AdminEmailRecipient[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoadingRecipients(true);
    adminEmailService
      .getRecipients(roleFilter)
      .then((res) => setRecipients(res.data?.success ? res.data.recipients : []))
      .catch(() => setRecipients([]))
      .finally(() => setLoadingRecipients(false));
  }, [open, roleFilter]);

  useEffect(() => {
    if (!open) {
      setRoleFilter("parent");
      setRecipients([]);
      setSelectedIds([]);
      setSubject("");
      setMessage("");
    }
  }, [open]);

  // Switching the Parents/Tutors filter starts recipient selection over — the previous
  // filter's user ids wouldn't mean anything in the new list anyway.
  const handleRoleFilterChange = (role: "parent" | "tutor") => {
    if (role === roleFilter) return;
    setRoleFilter(role);
    setSelectedIds([]);
  };

  const toggleRecipient = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const canSubmit = selectedIds.length > 0 && subject.trim().length > 0 && message.trim().length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      toast.error("Select at least one recipient, and fill in both Subject and Message.");
      return;
    }
    setSubmitting(true);
    adminEmailService
      .send({ userIds: selectedIds, subject: subject.trim(), message: message.trim() })
      .then((res) => {
        if (res.data?.success) {
          toast.success(res.data.message || "Email sent.");
          onOpenChange(false);
        } else {
          toast.error(res.data?.message || "Failed to send email.");
        }
      })
      .catch((err) => {
        toast.error(err?.response?.data?.message || "Failed to send email.");
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Email a parent or tutor</DialogTitle>
          <DialogDescription>
            Sends a real email through Bee Bright's own system — no need to open Gmail.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4 overflow-y-auto pr-2" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label>Send to</Label>
            <div className="flex gap-2" role="group" aria-label="Recipient type">
              <Button
                type="button"
                size="sm"
                variant={roleFilter === "parent" ? "default" : "outline"}
                aria-pressed={roleFilter === "parent"}
                onClick={() => handleRoleFilterChange("parent")}
              >
                Parents
              </Button>
              <Button
                type="button"
                size="sm"
                variant={roleFilter === "tutor" ? "default" : "outline"}
                aria-pressed={roleFilter === "tutor"}
                onClick={() => handleRoleFilterChange("tutor")}
              >
                Tutors
              </Button>
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Recipients *</Label>
            <p className="text-xs text-muted-foreground">Select one or more. Accounts still pending/rejected are shown too, tagged with their status.</p>
            <ScrollArea className="h-40 rounded-md border border-border p-2">
              {loadingRecipients ? (
                <p className="text-sm text-muted-foreground py-2">Loading...</p>
              ) : recipients.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No {roleFilter}s found.</p>
              ) : (
                <div className="space-y-2">
                  {recipients.map((r) => {
                    const label = statusLabel(r.status);
                    return (
                      <div key={r._id} className="flex items-center space-x-2">
                        <Checkbox
                          id={`email-recipient-${r._id}`}
                          checked={selectedIds.includes(r._id)}
                          onCheckedChange={() => toggleRecipient(r._id)}
                        />
                        <label htmlFor={`email-recipient-${r._id}`} className="text-sm font-medium cursor-pointer">
                          {r.name}
                          {label && <span className="text-muted-foreground font-normal"> - {label}</span>}
                        </label>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="admin-email-subject">Subject *</Label>
            <Input
              id="admin-email-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Bee Bright login verification code"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="admin-email-message">Message *</Label>
            <Textarea
              id="admin-email-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Write the message the recipient will see..."
              rows={5}
              className="resize-none"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!canSubmit || submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
