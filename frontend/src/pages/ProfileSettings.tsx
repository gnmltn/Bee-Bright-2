import { useState, useEffect, useMemo } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { UserAvatar } from "@/components/UserAvatar";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { User, Phone, Lock, GraduationCap, BookOpen, Shield, X, Pencil, Construction } from "lucide-react";
import { subjectService, authService, settingsService } from "@/services/api";
import { Switch } from "@/components/ui/switch";
import { sanitizeName, sanitizePhoneInput } from "@/utils/validation";
import { PasswordSecuritySection } from "@/components/auth/PasswordSecuritySection";

const gradeOptions = [
  "Toddler", "Pre-Kindergarten", "Kindergarten",
  "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6",
  "Grade 7", "Grade 8", "Grade 9", "Grade 10",
];

const AVAILABILITY_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const AVAILABILITY_TIME_SLOTS = [
  "08:00", "09:00", "10:00", "11:00", "12:00",
  "13:00", "14:00", "15:00", "16:00", "17:00", "18:00",
];

type AvailabilitySlot = {
  id: string;
  days: string[];
  start: string;
  end: string;
};

function formatAvailabilityTime(hhmm: string) {
  if (!hhmm) return "";
  const [hours, minutes] = hhmm.split(":").map(Number);
  const hour12 = hours % 12 || 12;
  const suffix = hours < 12 ? "AM" : "PM";
  return `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function buildAvailabilityString(days: string[], start: string, end: string): string {
  if (days.length === 0 || !start || !end) return "";
  return `${days.join(", ")} ${formatAvailabilityTime(start)} - ${formatAvailabilityTime(end)}`;
}

function createAvailabilitySlot(initial?: Partial<Omit<AvailabilitySlot, "id">>): AvailabilitySlot {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    days: initial?.days ?? [],
    start: initial?.start ?? "",
    end: initial?.end ?? "",
  };
}

function parseAvailabilityTime(value: string): string | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const suffix = (match[3] || "").toLowerCase();

  if (suffix === "pm" && hours < 12) hours += 12;
  if (suffix === "am" && hours === 12) hours = 0;
  if (!suffix && hours >= 8 && hours < 12) hours += 12;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseAvailabilityString(value: string): AvailabilitySlot[] {
  const trimmed = value.trim();
  if (!trimmed) return [createAvailabilitySlot()];

  const parsed = trimmed
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const days = (segment.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/gi) || [])
        .map((day) => `${day.slice(0, 1).toUpperCase()}${day.slice(1, 3).toLowerCase()}`)
        .filter((day, index, all) => AVAILABILITY_DAYS.includes(day) && all.indexOf(day) === index);
      const timeMatch = segment.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-–to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
      const start = timeMatch ? parseAvailabilityTime(timeMatch[1]) : null;
      const end = timeMatch ? parseAvailabilityTime(timeMatch[2]) : null;

      if (days.length === 0 && !start && !end) return null;

      return createAvailabilitySlot({
        days,
        start: start || "",
        end: end || "",
      });
    })
    .filter((slot): slot is AvailabilitySlot => slot !== null);

  return parsed.length > 0 ? parsed : [createAvailabilitySlot()];
}

function buildAvailabilitySummary(slots: AvailabilitySlot[]): string {
  return slots
    .map((slot) => buildAvailabilityString(slot.days, slot.start, slot.end))
    .filter(Boolean)
    .join("; ");
}

export interface SubjectOption {
  _id: string;
  name: string;
  code?: string;
}

export default function ProfileSettings() {
  const { user, updateUser } = useAuth();
  const { toast } = useToast();

  if (!user) return null;

  // Form state - use backend field names
  const [firstName, setFirstName] = useState(user?.firstName || user?.name?.split(' ')[0] || "");
  const [middleName, setMiddleName] = useState((user as { middleName?: string })?.middleName || "");
  const [lastName, setLastName] = useState(user?.lastName || user?.name?.split(' ')[1] || "");
  const [phone, setPhone] = useState(user?.phone || "");
  
  // Student fields - match backend names
  const [gradeLevel, setGradeLevel] = useState(user?.gradeLevel || "");
  const [guardianName, setGuardianName] = useState(user?.guardianName || "");
  const [guardianPhone, setGuardianPhone] = useState(user?.guardianPhone || "");

  // Tutor fields - store subject IDs (from API); same programs as enrollment/scheduling
  const tutorSubjectIds = Array.isArray(user?.subjectsTaught)
    ? (user.subjectsTaught as { _id: string }[]).map((s) => (typeof s === "object" && s?._id ? s._id : String(s)))
    : [];
  const [subjectsTaught, setSubjectsTaught] = useState<string[]>(tutorSubjectIds);
  const [employmentType, setEmploymentType] = useState<'full-time' | 'part-time'>(
    (user as { employmentType?: 'full-time' | 'part-time' })?.employmentType || 'full-time'
  );
  const [availabilitySlots, setAvailabilitySlots] = useState<AvailabilitySlot[]>(() =>
    parseAvailabilityString((user as { availability?: string })?.availability || "")
  );
  const [subjectOptions, setSubjectOptions] = useState<SubjectOption[]>([]);
  const [profileImageUploading, setProfileImageUploading] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);
  const [maintenanceFetched, setMaintenanceFetched] = useState(false);

  const syncFormFromUser = () => {
    setFirstName(user?.firstName || user?.name?.split(" ")[0] || "");
    setMiddleName((user as { middleName?: string })?.middleName || "");
    setLastName(user?.lastName || user?.name?.split(" ")[1] || "");
    setPhone(user?.phone || "");
    setGradeLevel(user?.gradeLevel || "");
    setGuardianName(user?.guardianName || "");
    setGuardianPhone(user?.guardianPhone || "");
    const ids = Array.isArray(user?.subjectsTaught)
      ? (user.subjectsTaught as { _id: string }[]).map((s) => (typeof s === "object" && s?._id ? s._id : String(s)))
      : [];
    setSubjectsTaught(ids);
    setEmploymentType((user as { employmentType?: "full-time" | "part-time" })?.employmentType || "full-time");
    setAvailabilitySlots(parseAvailabilityString((user as { availability?: string })?.availability || ""));
  };

  useEffect(() => {
    subjectService.getAllSubjects().then((res) => {
      if (res.data?.success && Array.isArray(res.data.subjects)) {
        setSubjectOptions(res.data.subjects);
      }
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!user || user.role !== "tutor") return;
    const ids = Array.isArray(user.subjectsTaught)
      ? (user.subjectsTaught as { _id: string }[]).map((s) => (typeof s === "object" && s?._id ? s._id : String(s)))
      : [];
    setSubjectsTaught(ids);
    setEmploymentType((user as { employmentType?: 'full-time' | 'part-time' }).employmentType || "full-time");
    setAvailabilitySlots(parseAvailabilityString((user as { availability?: string }).availability || ""));
  }, [user?.id, user?.role]);

  useEffect(() => {
    if (employmentType === "part-time" && availabilitySlots.length === 0) {
      setAvailabilitySlots([createAvailabilitySlot()]);
    }
  }, [employmentType, availabilitySlots.length]);

  const availabilitySummary = useMemo(
    () => buildAvailabilitySummary(availabilitySlots),
    [availabilitySlots]
  );

  const toggleAvailabilityDay = (slotId: string, day: string) => {
    setAvailabilitySlots((prev) =>
      prev.map((slot) =>
        slot.id !== slotId
          ? slot
          : {
              ...slot,
              days: slot.days.includes(day)
                ? slot.days.filter((item) => item !== day)
                : [...slot.days, day],
            }
      )
    );
  };

  const updateAvailabilitySlot = (slotId: string, updates: Partial<Omit<AvailabilitySlot, "id">>) => {
    setAvailabilitySlots((prev) =>
      prev.map((slot) => {
        if (slot.id !== slotId) return slot;
        const nextStart = updates.start ?? slot.start;
        const nextEnd = updates.end ?? slot.end;
        return {
          ...slot,
          ...updates,
          end: nextStart && nextEnd && nextEnd <= nextStart ? "" : nextEnd,
        };
      })
    );
  };

  const addAvailabilitySlot = () => {
    setAvailabilitySlots((prev) => [...prev, createAvailabilitySlot()]);
  };

  const removeAvailabilitySlot = (slotId: string) => {
    setAvailabilitySlots((prev) => {
      if (prev.length === 1) return [createAvailabilitySlot()];
      return prev.filter((slot) => slot.id !== slotId);
    });
  };

  useEffect(() => {
    if (user?.role !== "admin" || maintenanceFetched) return;
    settingsService
      .getMaintenance()
      .then((res) => {
        if (res.data?.success && typeof res.data.manualMaintenanceMode === "boolean") {
          setMaintenanceMode(res.data.manualMaintenanceMode);
        }
        setMaintenanceFetched(true);
      })
      .catch(() => setMaintenanceFetched(true));
  }, [user?.role, maintenanceFetched]);

  const handleMaintenanceToggle = async (enabled: boolean) => {
    if (maintenanceLoading) return;
    setMaintenanceLoading(true);
    try {
      const res = await settingsService.setMaintenance(enabled);
      if (res.data?.success) {
        setMaintenanceMode(!!res.data.maintenanceMode);
        toast({
          title: enabled ? "Maintenance mode on" : "Maintenance mode off",
          description: enabled
            ? "Students and tutors cannot log in until you turn it off."
            : "Students and tutors can log in again.",
        });
      } else {
        toast({ title: "Failed to update", variant: "destructive" });
      }
    } catch {
      toast({ title: "Failed to update maintenance setting", variant: "destructive" });
    } finally {
      setMaintenanceLoading(false);
    }
  };

  // Helper function to get full name
  const getFullName = () => [firstName, middleName, lastName].filter(Boolean).join(" ").trim();

  const handleSaveProfile = async () => {
    const hasIncompleteAvailability = availabilitySlots.some((slot) => {
      const hasAnyValue = slot.days.length > 0 || !!slot.start || !!slot.end;
      const isComplete = slot.days.length > 0 && !!slot.start && !!slot.end;
      return hasAnyValue && !isComplete;
    });

    if (user.role === "tutor" && employmentType === "part-time") {
      if (hasIncompleteAvailability) {
        toast({
          title: "Incomplete availability",
          description: "Complete or remove unfinished availability rows before saving.",
          variant: "destructive",
        });
        return;
      }

      if (!availabilitySummary) {
        toast({
          title: "Availability required",
          description: "Select at least one day and time block for part-time scheduling.",
          variant: "destructive",
        });
        return;
      }
    }

    try {
      const updates: any = {
        firstName: firstName.trim(),
        middleName: middleName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim(),
      };

      // Add role-specific fields
      if (user.role === "student") {
        updates.gradeLevel = gradeLevel;
        updates.guardianName = guardianName.trim();
        updates.guardianPhone = guardianPhone.trim();
      } else if (user.role === "tutor") {
        updates.subjectsTaught = subjectsTaught;
        updates.employmentType = employmentType;
        updates.availability = employmentType === "part-time" ? availabilitySummary : "";
      }

      const { data } = await authService.updateProfile(updates);
      
      if (data.success && data.user) {
        const u = data.user;
        const updatedUser = {
          ...user,
          firstName: u.firstName,
          middleName: u.middleName,
          lastName: u.lastName,
          name: u.name || getFullName(),
          phone: u.phone,
          gradeLevel: u.gradeLevel,
          guardianName: u.guardianName,
          guardianPhone: u.guardianPhone,
          subjectsTaught: u.subjectsTaught || [],
          employmentType: u.employmentType,
          availability: u.availability || "",
          profileImageUrl: (u as { profileImageUrl?: string | null }).profileImageUrl ?? user.profileImageUrl ?? null,
        };
        updateUser(updatedUser);
        setIsEditingProfile(false);
        toast({
          title: "Profile Updated",
          description: "Your profile has been saved successfully.",
        });
      } else {
        toast({
          title: "Error",
          description: data.message || "Failed to update profile",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error('Update error:', error);
      toast({
        title: "Error",
        description: "Failed to update profile",
        variant: "destructive",
      });
    }
  };

  const toggleSubject = (subjectId: string) => {
    setSubjectsTaught((prev) =>
      prev.includes(subjectId)
        ? prev.filter((id) => id !== subjectId)
        : [...prev, subjectId]
    );
  };

  const handleProfileImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) {
      toast({
        title: "Invalid file",
        description: "Please select an image file (e.g. JPG, PNG, GIF, WebP).",
        variant: "destructive",
      });
      return;
    }
    setProfileImageUploading(true);
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      try {
        const { data } = await authService.uploadProfileImage(dataUrl);
        if (data?.success && data.profileImageUrl) {
          updateUser({ profileImageUrl: data.profileImageUrl });
          toast({
            title: "Profile picture updated",
            description: "Your profile picture has been saved.",
          });
        } else {
          toast({
            title: "Error",
            description: data?.message || "Failed to upload profile picture",
            variant: "destructive",
          });
        }
      } catch (err) {
        toast({
          title: "Error",
          description: "Failed to upload profile picture",
          variant: "destructive",
        });
      } finally {
        setProfileImageUploading(false);
        e.target.value = "";
      }
    };
    reader.onerror = () => {
      setProfileImageUploading(false);
      e.target.value = "";
      toast({
        title: "Error",
        description: "Failed to read image file",
        variant: "destructive",
      });
    };
    reader.readAsDataURL(file);
  };

  return (
    <DashboardLayout>
      <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Profile Settings</h1>
          <p className="text-muted-foreground">Manage your account information and preferences</p>
        </div>

        {/* Profile Avatar Section */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative">
                <UserAvatar
                  src={user.profileImageUrl}
                  fallback={`${user.firstName?.[0] || user.name?.[0] || "U"}${user.lastName?.[0] || user.name?.split(" ")[1]?.[0] || ""}`}
                  size={20}
                />
                <label className="absolute bottom-0 right-0 flex items-center justify-center h-8 w-8 rounded-full bg-primary text-primary-foreground cursor-pointer hover:opacity-90 shadow-md">
                  <User className="h-4 w-4" />
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    disabled={profileImageUploading}
                    onChange={handleProfileImageChange}
                  />
                </label>
              </div>
              <div>
                <h2 className="text-lg font-semibold">{getFullName() || user.email}</h2>
                <p className="text-sm text-muted-foreground capitalize">{user.role}</p>
                <p className="text-sm text-muted-foreground">{user.email}</p>
                <p className="text-xs text-muted-foreground mt-1">Click the icon to change profile picture (any image type)</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Personal Information */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Personal Information
            </CardTitle>
            <CardDescription>Update your personal details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="firstName">First Name</Label>
                <Input
                  id="firstName"
                  value={firstName}
                  onChange={(e) => setFirstName(sanitizeName(e.target.value))}
                  placeholder="Enter your first name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="middleName">Middle Name <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Input
                  id="middleName"
                  value={middleName}
                  onChange={(e) => setMiddleName(sanitizeName(e.target.value))}
                  placeholder="Enter your middle name"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="lastName">Last Name</Label>
                <Input
                  id="lastName"
                  value={lastName}
                  onChange={(e) => setLastName(sanitizeName(e.target.value))}
                  placeholder="Enter your last name"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                value={user.email}
                disabled
                className="bg-muted"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone" className="flex items-center gap-2">
                <Phone className="h-4 w-4" />
                Phone Number
              </Label>
              <Input
                id="phone"
                value={phone}
                onChange={(e) => setPhone(sanitizePhoneInput(e.target.value))}
                placeholder="Enter your phone number"
              />
            </div>
          </CardContent>
        </Card>

        {/* Role-Specific Fields */}
        {user.role === "student" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GraduationCap className="h-5 w-5" />
                Student Information
              </CardTitle>
              <CardDescription>Your academic details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="gradeLevel">Grade Level</Label>
                <Select value={gradeLevel} onValueChange={setGradeLevel}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select your grade level" />
                  </SelectTrigger>
                  <SelectContent>
                    {gradeOptions.map((grade) => (
                      <SelectItem key={grade} value={grade}>
                        {grade}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="guardianName">Guardian Name</Label>
                <Input
                  id="guardianName"
                  value={guardianName}
                  onChange={(e) => setGuardianName(sanitizeName(e.target.value))}
                  placeholder="Guardian name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="guardianPhone">Guardian Phone</Label>
                <Input
                  id="guardianPhone"
                  value={guardianPhone}
                  onChange={(e) => setGuardianPhone(sanitizePhoneInput(e.target.value))}
                  placeholder="Guardian phone number"
                />
              </div>
            </CardContent>
          </Card>
        )}

        {user.role === "tutor" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="h-5 w-5" />
                Tutor Information
              </CardTitle>
              <CardDescription>Programs you can teach (same as enrollment; used for scheduling)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Subjects / Programs You Can Teach</Label>
                <div className="flex flex-wrap gap-2">
                  {subjectOptions.map((subject) => (
                    <Button
                      key={subject._id}
                      type="button"
                      variant={subjectsTaught.includes(subject._id) ? "default" : "outline"}
                      size="sm"
                      onClick={() => toggleSubject(subject._id)}
                      className="gap-1"
                    >
                      {subject.name}
                      {subjectsTaught.includes(subject._id) && (
                        <X className="h-3 w-3" />
                      )}
                    </Button>
                  ))}
                </div>
                {subjectOptions.length === 0 && (
                  <p className="text-sm text-muted-foreground">Loading programs...</p>
                )}
                {subjectsTaught.length > 0 && subjectOptions.length > 0 && (
                  <p className="text-sm text-muted-foreground">
                    Selected: {subjectsTaught.length} program(s)
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Employment Type</Label>
                <Select value={employmentType} onValueChange={(v) => setEmploymentType(v as 'full-time' | 'part-time')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full-time">Full-time</SelectItem>
                    <SelectItem value="part-time">Part-time</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {employmentType === "part-time" && (
                <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <Label>Availability for scheduling</Label>
                      <p className="text-xs text-muted-foreground">Use the same organized day-and-time picker style as admin scheduling.</p>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={addAvailabilitySlot}>
                      Add time block
                    </Button>
                  </div>

                  <div className="space-y-4">
                    {availabilitySlots.map((slot, index) => (
                      <div key={slot.id} className="space-y-4 rounded-lg border border-border bg-background/70 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-medium text-foreground">Availability {index + 1}</p>
                          {availabilitySlots.length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-muted-foreground hover:text-destructive"
                              onClick={() => removeAvailabilitySlot(slot.id)}
                            >
                              <X className="mr-1 h-3.5 w-3.5" />
                              Remove
                            </Button>
                          )}
                        </div>

                        <div className="space-y-2">
                          <Label>Days available</Label>
                          <p className="text-xs text-muted-foreground">Click the days this schedule block should cover.</p>
                          <div className="flex flex-wrap gap-2">
                            {AVAILABILITY_DAYS.map((day) => (
                              <Button
                                key={`${slot.id}-${day}`}
                                type="button"
                                variant={slot.days.includes(day) ? "default" : "outline"}
                                size="sm"
                                onClick={() => toggleAvailabilityDay(slot.id, day)}
                              >
                                {day}
                              </Button>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label>Time available</Label>
                          <p className="text-xs text-muted-foreground">Choose a start and end time for this block.</p>
                          <div className="grid gap-4 lg:grid-cols-2">
                            <div>
                              <p className="mb-1 text-xs font-medium text-muted-foreground">Start time</p>
                              <div className="flex flex-wrap gap-1">
                                {AVAILABILITY_TIME_SLOTS.map((timeSlot) => (
                                  <Button
                                    key={`${slot.id}-start-${timeSlot}`}
                                    type="button"
                                    variant={slot.start === timeSlot ? "default" : "outline"}
                                    size="sm"
                                    className="text-xs"
                                    onClick={() => updateAvailabilitySlot(slot.id, { start: timeSlot })}
                                  >
                                    {formatAvailabilityTime(timeSlot)}
                                  </Button>
                                ))}
                              </div>
                            </div>

                            <div>
                              <p className="mb-1 text-xs font-medium text-muted-foreground">End time</p>
                              <div className="flex flex-wrap gap-1">
                                {AVAILABILITY_TIME_SLOTS.filter((timeSlot) => !slot.start || timeSlot > slot.start).map((timeSlot) => (
                                  <Button
                                    key={`${slot.id}-end-${timeSlot}`}
                                    type="button"
                                    variant={slot.end === timeSlot ? "default" : "outline"}
                                    size="sm"
                                    className="text-xs"
                                    onClick={() => updateAvailabilitySlot(slot.id, { end: timeSlot })}
                                  >
                                    {formatAvailabilityTime(timeSlot)}
                                  </Button>
                                ))}
                                {slot.start && AVAILABILITY_TIME_SLOTS.filter((timeSlot) => timeSlot > slot.start).length === 0 && (
                                  <span className="text-xs text-muted-foreground">Pick an earlier start time first.</span>
                                )}
                              </div>
                            </div>
                          </div>

                          {slot.days.length > 0 && slot.start && slot.end && (
                            <p className="pt-1 text-xs text-muted-foreground">
                              Summary: {buildAvailabilityString(slot.days, slot.start, slot.end)}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {availabilitySummary && (
                    <p className="text-xs text-muted-foreground">Saved summary: {availabilitySummary}</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {user.role === "admin" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Admin Settings
              </CardTitle>
              <CardDescription>System-wide settings (only admins can change these)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-lg border border-border p-4">
                <div className="flex items-center gap-3">
                  <Construction className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium text-foreground">System maintenance</p>
                    <p className="text-sm text-muted-foreground">
                      When enabled, student and tutor logins are temporarily disabled. They will see a professional maintenance notice and be redirected to the home page.
                    </p>
                  </div>
                </div>
                <Switch
                  checked={maintenanceMode}
                  onCheckedChange={handleMaintenanceToggle}
                  disabled={maintenanceLoading || !maintenanceFetched}
                />
              </div>
              {!maintenanceFetched && (
                <p className="text-sm text-muted-foreground">Loading maintenance status...</p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Save Profile Button */}
        <div className="flex justify-end">
          <Button onClick={handleSaveProfile} size="lg">
            Save Profile
          </Button>
        </div>

        <PasswordSecuritySection
          passwordExpired={user.passwordExpired}
          passwordExpiresAt={user.passwordExpiresAt}
          passwordExpiresInDays={user.passwordExpiresInDays}
          onPasswordSecurityUpdate={(updates) => updateUser(updates)}
        />
      </div>
    </DashboardLayout>
  );
}
