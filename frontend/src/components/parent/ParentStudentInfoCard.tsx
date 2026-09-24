import { useState } from "react";
import { GraduationCap, Camera } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserAvatar } from "@/components/UserAvatar";
import { useToast } from "@/hooks/use-toast";
import { useSelectedChild } from "@/hooks/useSelectedChild";
import { enrollmentService } from "@/services/api";
import { resolveUploadUrl } from "@/lib/children";

/**
 * Parent Settings → "Student Information": the currently selected child's name,
 * permanent Student ID and profile picture. Reads/writes the ONE shared selected child
 * (SelectedChildContext), so switching child here or on any other page updates
 * everything at once. The parent's OWN picture/name (header + the card above) never
 * changes with the selection.
 */
export function ParentStudentInfoCard() {
  const { toast } = useToast();
  const { childList: children, activeChild, setActiveChildId, setChildPhoto, loading } = useSelectedChild();
  const [uploading, setUploading] = useState(false);

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file || !activeChild) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      toast({ title: "Invalid file", description: "Please choose a JPG, PNG, or WEBP image.", variant: "destructive" });
      input.value = "";
      return;
    }
    setUploading(true);
    const childKey = activeChild.key;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const { data } = await enrollmentService.setChildPhoto(childKey, reader.result as string);
        if (data?.success && data.studentProfileImage) {
          setChildPhoto(childKey, data.studentProfileImage);
          toast({ title: "Student picture updated", description: `${activeChild.name}'s profile picture has been saved.` });
        } else {
          toast({ title: "Error", description: data?.message || "Failed to update the picture", variant: "destructive" });
        }
      } catch (err) {
        const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
        toast({ title: "Error", description: message || "Failed to update the picture", variant: "destructive" });
      } finally {
        setUploading(false);
        input.value = "";
      }
    };
    reader.onerror = () => {
      setUploading(false);
      input.value = "";
      toast({ title: "Error", description: "Failed to read the image file", variant: "destructive" });
    };
    reader.readAsDataURL(file);
  };

  return (
    <Card data-testid="student-information-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GraduationCap className="h-5 w-5" />
          Student Information
        </CardTitle>
        <CardDescription>Your child&apos;s name, Student ID and profile picture</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !activeChild ? (
          <p className="text-sm text-muted-foreground">No student on this account yet.</p>
        ) : (
          <>
            {children.length > 1 && (
              <div className="space-y-2 max-w-xs">
                <Label>Viewing child</Label>
                <Select value={activeChild.key} onValueChange={setActiveChildId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {children.map((child) => (
                      <SelectItem key={child.key} value={child.key}>
                        {child.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative">
                <UserAvatar
                  src={resolveUploadUrl(activeChild.photoPath)}
                  fallback={activeChild.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "S"}
                  size={20}
                />
                <label className="absolute bottom-0 right-0 flex items-center justify-center h-8 w-8 rounded-full bg-primary text-primary-foreground cursor-pointer hover:opacity-90 shadow-md">
                  <Camera className="h-4 w-4" />
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    aria-label="Change student profile picture"
                    disabled={uploading}
                    onChange={handlePhotoChange}
                  />
                </label>
              </div>
              <dl className="space-y-1 text-sm">
                <div>
                  <dt className="text-muted-foreground text-xs">Student name</dt>
                  <dd className="text-base font-semibold text-foreground" data-testid="student-info-name">{activeChild.name}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Student ID</dt>
                  <dd className="font-mono font-semibold text-foreground" data-testid="student-info-id">{activeChild.studentId || "—"}</dd>
                </div>
              </dl>
            </div>
            <p className="text-xs text-muted-foreground">
              This is your child&apos;s picture. Your own profile picture (above) does not change when you switch children.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
