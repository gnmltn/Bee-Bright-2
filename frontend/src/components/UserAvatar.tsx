import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

type UserAvatarProps = {
  /** Full URL to profile image (e.g. from user.profileImageUrl or uploadsBaseUrl + '/uploads/' + profileImage) */
  src?: string | null;
  /** Fallback initials when no image (e.g. "JD" for John Doe) */
  fallback: string;
  /** Optional class for the root Avatar */
  className?: string;
  /** Size: default 10 (h-10 w-10), 8 (h-8 w-8), 20 (h-20 w-20) */
  size?: 8 | 10 | 20;
};

const sizeClasses = {
  8: "h-8 w-8",
  10: "h-10 w-10",
  20: "h-20 w-20",
};

export function UserAvatar({ src, fallback, className, size = 10 }: UserAvatarProps) {
  return (
    <Avatar className={cn(sizeClasses[size], "shrink-0", className)}>
      {src ? (
        <AvatarImage src={src} alt="" className="object-cover" />
      ) : null}
      <AvatarFallback className="text-primary bg-primary/10 font-semibold">
        {fallback}
      </AvatarFallback>
    </Avatar>
  );
}
