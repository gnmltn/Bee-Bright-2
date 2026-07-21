import { cn } from "@/lib/utils";

interface ProgressBarProps {
  value: number;
  max?: number;
  label?: string;
  showPercentage?: boolean;
  variant?: "default" | "primary" | "success" | "info" | "warning";
  size?: "sm" | "md" | "lg";
  className?: string;
}

const variantStyles = {
  default: "bg-muted-foreground",
  primary: "bg-primary",
  success: "bg-success",
  info: "bg-info",
  warning: "bg-warning",
};

const sizeStyles = {
  sm: "h-1.5",
  md: "h-2.5",
  lg: "h-4",
};

export function ProgressBar({
  value,
  max = 100,
  label,
  showPercentage = true,
  variant = "primary",
  size = "md",
  className,
}: ProgressBarProps) {
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100);

  return (
    <div className={cn("space-y-2", className)}>
      {(label || showPercentage) && (
        <div className="flex items-center justify-between text-sm">
          {label && <span className="text-muted-foreground font-medium">{label}</span>}
          {showPercentage && (
            <span className="text-foreground font-semibold">{Math.round(percentage)}%</span>
          )}
        </div>
      )}
      <div className={cn("w-full bg-muted rounded-full overflow-hidden", sizeStyles[size])}>
        <div
          className={cn(
            "h-full rounded-full transition-all duration-700 ease-out progress-animate",
            variantStyles[variant]
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
