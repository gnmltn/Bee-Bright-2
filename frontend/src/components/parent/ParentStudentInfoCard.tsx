import { useEffect, useState } from "react";
import { GraduationCap } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ProfilePicturePicker } from "@/components/ProfilePicturePicker";
import { useToast } from "@/hooks/use-toast";
import { useSelectedChild } from "@/hooks/useSelectedChild";
import { enrollmentService } from "@/services/api";
import { resolveUploadUrl } from "@/lib/children";
import { sanitizeName } from "@/utils/validation";

/**
 * Parent Settings → "Student Information": the currently selected child's name,
 * permanent Student ID and profile picture. Reads/writes the ONE shared selected child
 * (SelectedChildContext) — displays whichever child is selected via the single "Viewing
 * child" switcher elsewhere; no separate switch control here (item A). The parent's OWN
 * picture/name (header + the card above) never changes with the selection.
 *
 * Name fields are editable the same way the parent's own Personal Information is (plain
 * inputs + an explicit Save — item B/C); the Student ID stays locked/read-only. The picture
 * goes through the shared preview-then-confirm flow (item D).
 */
export function ParentStudentInfoCard() {
  const { toast } = useToast();
  const { activeChild, setChildPhoto, setChildName, loading } = useSelectedChild();

  const [firstName, setFirstName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [lastName, setLastName] = useState("");
  const [savingName, setSavingName] = useState(false);

  // Resync the editable fields whenever the selected child changes (or first loads).
  useEffect(() => {
    setFirstName(activeChild?.firstName || "");
    setMiddleName(activeChild?.middleName || "");
    setLastName(activeChild?.lastName || "");
  }, [activeChild?.key, activeChild?.firstName, activeChild?.middleName, activeChild?.lastName]);

  const nameDirty = !!activeChild && (
    firstName.trim() !== (activeChild.firstName || "")
    || middleName.trim() !== (activeChild.middleName || "")
    || lastName.trim() !== (activeChild.lastName || "")
  );

  const handleSaveName = async () => {
    if (!activeChild) return;
    if (!firstName.trim() || !lastName.trim()) {
      toast({ title: "Error", description: "First name and last name are required.", variant: "destructive" });
      return;
    }
    setSavingName(true);
    try {
      const { data } = await enrollmentService.setChildName(activeChild.key, firstName.trim(), middleName.trim(), lastName.trim());
      if (data?.success) {
        setChildName(activeChild.key, firstName.trim(), middleName.trim(), lastName.trim());
        toast({ title: "Student name updated", description: "The change has been saved." });
      } else {
        toast({ title: "Error", description: data?.message || "Failed to update the name.", variant: "destructive" });
      }
    } catch (err) {
      const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast({ title: "Error", description: message || "Failed to update the name.", variant: "destructive" });
    } finally {
      setSavingName(false);
    }
  };

  const handlePhotoConfirm = async (dataUrl: string) => {
    if (!activeChild) return;
    const { data } = await enrollmentService.setChildPhoto(activeChild.key, dataUrl);
    if (data?.success && data.studentProfileImage) {
      setChildPhoto(activeChild.key, data.studentProfileImage);
      toast({ title: "Student picture updated", description: `${activeChild.name}'s profile picture has been saved.` });
    } else {
      throw new Error(data?.message || "Failed to update the picture");
    }
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
            <div className="flex items-center gap-4 flex-wrap">
              <ProfilePicturePicker
                src={resolveUploadUrl(activeChild.photoPath)}
                fallback={activeChild.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "S"}
                size={20}
                accept="image/png,image/jpeg,image/webp"
                ariaLabel="Change student profile picture"
                onConfirm={handlePhotoConfirm}
              />
              <div>
                <p className="text-xs text-muted-foreground">Student ID</p>
                <p className="font-mono font-semibold text-foreground" data-testid="student-info-id">{activeChild.studentId || "—"}</p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="child-firstName">First Name</Label>
                <Input
                  id="child-firstName"
                  data-testid="student-info-firstname"
                  value={firstName}
                  onChange={(e) => setFirstName(sanitizeName(e.target.value))}
                  placeholder="First name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="child-middleName">Middle Name <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Input
                  id="child-middleName"
                  data-testid="student-info-middlename"
                  value={middleName}
                  onChange={(e) => setMiddleName(sanitizeName(e.target.value))}
                  placeholder="Middle name"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="child-lastName">Last Name</Label>
                <Input
                  id="child-lastName"
                  data-testid="student-info-lastname"
                  value={lastName}
                  onChange={(e) => setLastName(sanitizeName(e.target.value))}
                  placeholder="Last name"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Button data-testid="student-info-save" onClick={handleSaveName} disabled={!nameDirty || savingName}>
                {savingName ? "Saving…" : "Save"}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              This is your child&apos;s picture and name. Your own profile picture and name (above) do not change when you switch children.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
