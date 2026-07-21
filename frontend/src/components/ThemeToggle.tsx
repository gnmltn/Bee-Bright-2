import { Sun, Moon } from "lucide-react";
import { useThemeMode } from "@/contexts/ThemeContext";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function ThemeToggle() {
  const { theme, toggleTheme } = useThemeMode();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
          <button
            type="button"
            onClick={toggleTheme}
            className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-primary/30 bg-card shadow-lg ring-2 ring-primary/10 transition-all duration-300 hover:scale-110 hover:shadow-xl hover:ring-primary/30 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 dark:border-amber-500/40 dark:ring-amber-500/20 dark:hover:ring-amber-500/40"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? (
              <Sun className="h-6 w-6 text-amber-400" />
            ) : (
              <Moon className="h-6 w-6 text-primary" />
            )}
          </button>
      </TooltipTrigger>
      <TooltipContent side="left" className="font-medium">
        {theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      </TooltipContent>
    </Tooltip>
  );
}
