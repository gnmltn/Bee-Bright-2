import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface StarRatingProps {
  value: number | null;
  onChange: (value: number) => void;
  max?: number;
  disabled?: boolean;
  className?: string;
}

/** Simple 1-N star input (Student Remarks' Toddler template uses 1-3). No existing
 * equivalent elsewhere in the codebase — built from scratch. */
export function StarRating({ value, onChange, max = 3, disabled = false, className }: StarRatingProps) {
  return (
    <div className={cn("flex items-center gap-1", className)} role="radiogroup">
      {Array.from({ length: max }, (_, i) => i + 1).map((star) => {
        const filled = value !== null && star <= value;
        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={value === star}
            aria-label={`${star} star${star === 1 ? "" : "s"}`}
            disabled={disabled}
            onClick={() => onChange(star)}
            className={cn(
              "p-0.5 rounded transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              !disabled && "hover:scale-110"
            )}
          >
            <Star
              className={cn("h-5 w-5", filled ? "fill-warning text-warning" : "text-muted-foreground")}
            />
          </button>
        );
      })}
    </div>
  );
}
