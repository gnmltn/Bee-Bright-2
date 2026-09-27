import { useState } from "react";
import { Camera } from "lucide-react";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

/**
 * Shared "select → preview → confirm → save" profile-picture flow
 * (Redundant_Switchers_Settings_Rules_EnrollmentBugs.pdf, item D) — used for the parent's own
 * picture, a student's own picture, a tutor's own picture, an admin's own picture (all via
 * ProfileSettings.tsx) and a parent-viewed child's picture (ParentStudentInfoCard.tsx).
 * Nothing is uploaded until the user explicitly confirms; closing the preview discards the pick.
 */
interface Props {
  src: string | null;
  fallback: string;
  size?: 8 | 10 | 20;
  accept?: string;
  /** Actually performs the save (the caller's API call). Rejecting keeps the confirm step open so the user can retry. */
  onConfirm: (dataUrl: string) => Promise<void>;
  ariaLabel?: string;
  disabled?: boolean;
  /** Shown once the upload succeeds — the caller still owns any additional toast/state update. */
  onSaved?: () => void;
}

export function ProfilePicturePicker({ src, fallback, size = 20, accept = "image/png,image/jpeg,image/webp", onConfirm, ariaLabel = "Change profile picture", disabled, onSaved }: Props) {
  const { toast } = useToast();
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Invalid file", description: "Please select an image file (JPG, PNG, or WEBP).", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPreviewDataUrl(reader.result as string);
    reader.onerror = () => toast({ title: "Error", description: "Failed to read the image file.", variant: "destructive" });
    reader.readAsDataURL(file);
  };

  const closePreview = () => {
    setPreviewDataUrl(null);
    setConfirmOpen(false);
  };

  const handleConfirmSave = async () => {
    if (!previewDataUrl) return;
    setSaving(true);
    try {
      await onConfirm(previewDataUrl);
      onSaved?.();
      closePreview();
    } catch (err) {
      const message = (err as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message
        || (err as Error)?.message;
      toast({ title: "Error", description: message || "Failed to update the picture.", variant: "destructive" });
      setConfirmOpen(false);
      // Keep the preview open so the user can retry Save without re-picking the file.
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="relative inline-block">
        <UserAvatar src={src} fallback={fallback} size={size} />
        <label className="absolute bottom-0 right-0 flex items-center justify-center h-8 w-8 rounded-full bg-primary text-primary-foreground cursor-pointer hover:opacity-90 shadow-md">
          <Camera className="h-4 w-4" />
          <input type="file" accept={accept} className="sr-only" aria-label={ariaLabel} disabled={disabled} onChange={handleFileChange} />
        </label>
      </div>

      <Dialog open={!!previewDataUrl} onOpenChange={(open) => { if (!open) closePreview(); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Preview picture</DialogTitle>
            <DialogDescription>Review before saving. Nothing changes until you confirm.</DialogDescription>
          </DialogHeader>
          {previewDataUrl && (
            <div className="flex justify-center py-2">
              <img src={previewDataUrl} alt="New picture preview" className="h-40 w-40 rounded-full object-cover border border-border" />
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={closePreview} disabled={saving}>Cancel</Button>
            <Button type="button" onClick={() => setConfirmOpen(true)} disabled={saving}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => { if (!saving) setConfirmOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change profile picture?</AlertDialogTitle>
            <AlertDialogDescription>This replaces the current picture. You can change it again later.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void handleConfirmSave(); }} disabled={saving}>
              {saving ? "Saving…" : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
