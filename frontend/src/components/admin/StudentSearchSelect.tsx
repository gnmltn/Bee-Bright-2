import { useMemo, useRef, useState } from "react";
import { Check, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface StudentSearchOption {
  key: string;
  label: string;
}

interface StudentSearchSelectProps {
  options: StudentSearchOption[];
  value: string;
  onChange: (key: string) => void;
  placeholder: string;
  emptyMessage: string;
  disabled?: boolean;
}

// BeeBright Scheduling Spec follow-up fix, 2026-09-14 (2nd round) — the search box and
// the "Select a student" dropdown are two INDEPENDENT controls, not one merged
// combobox:
//   - "Select a student" is a plain, always-fully-populated dropdown (admin can still
//     browse/select from it directly, per the original spec — never filtered).
//   - The search box shows its own results list in a plain absolutely-positioned panel
//     directly below itself (not inside the Select's dropdown). It never steals focus
//     on open (no Popover/focus-trap primitive involved — a Popover's focus management
//     was exactly why a single click didn't activate the text cursor last round: opening
//     the Popover immediately moved focus into its content). Each result button uses
//     onMouseDown={preventDefault} so clicking it never fires the input's onBlur before
//     the click's onClick — the standard non-stealing-focus autocomplete pattern.
//   - Selecting a result sets the SAME value the dropdown would, then clears the search
//     text and closes the results panel; "Select a student" stays empty until a result
//     (or a direct dropdown pick) actually happens.
export function StudentSearchSelect({ options, value, onChange, placeholder, emptyMessage, disabled }: StudentSearchSelectProps) {
  const [query, setQuery] = useState("");
  const [resultsOpen, setResultsOpen] = useState(false);
  const blurTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.label.toLowerCase().includes(q));
  }, [options, query]);

  const handlePick = (key: string) => {
    onChange(key);
    setQuery("");
    setResultsOpen(false);
  };

  const handleBlur = () => {
    // Small delay so a result button's onClick still fires even though the input blurs
    // first in some browsers; the onMouseDown preventDefault below is the primary guard,
    // this is a defensive second layer.
    blurTimeout.current = setTimeout(() => setResultsOpen(false), 120);
  };

  const handleFocus = () => {
    if (blurTimeout.current) clearTimeout(blurTimeout.current);
    if (!disabled) setResultsOpen(true);
  };

  return (
    <div className="flex flex-wrap gap-2">
      <div className="relative w-56">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          value={query}
          onChange={(e) => { setQuery(e.target.value); if (!disabled) setResultsOpen(true); }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder="Search by name…"
          className="pl-8"
          disabled={disabled}
        />
        {resultsOpen && (
          <div className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md">
            {filtered.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {options.length === 0 ? emptyMessage : `No matches for "${query}"`}
              </div>
            ) : (
              filtered.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handlePick(option.key)}
                  className="relative flex w-full items-center gap-2 rounded-sm py-1.5 pl-2 pr-2 text-sm text-left hover:bg-accent hover:text-accent-foreground"
                >
                  <Check className={cn("h-3.5 w-3.5 flex-shrink-0", option.key === value ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{option.label}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-56">
          <SelectValue placeholder={options.length === 0 ? emptyMessage : placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.key} value={option.key}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
