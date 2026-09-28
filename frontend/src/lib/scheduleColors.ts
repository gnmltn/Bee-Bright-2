// "polishing prompt (1).pdf", Group I (+ "bug (4).pdf" Group O) — schedule entries
// color-coded by program. Originally implemented only in AdminDashboard.tsx; extracted here
// so the Parent and Tutor dashboards' calendar/schedule views render the exact same colors
// instead of duplicating (and risking drifting from) the same logic.
//
// Exact hex values as specified (not Tailwind's built-in cyan/yellow/orange shades). These
// three class strings must appear literally in the source (not built via string
// interpolation) for Tailwind's JIT scanner to generate the corresponding CSS at all — do
// not refactor this into a lookup that concatenates the hex value at runtime.
// TPG101 uses the same cyan (#7DE0E0) in BOTH light and dark mode — a separate, paler
// dark-mode shade rendered as washed-out near-white against the dark background.
export function scheduleEntryBgClass(code?: string): string {
  if (code === "TPG101") return "bg-[#7DE0E0]"; // Toddlers Playgroup — cyan (same shade, both modes)
  if (code === "ACT102") return "bg-[#ffff00]"; // Academic Tutorial — yellow
  if (code === "EXP106") return "bg-[#ffa500]"; // Examination Preparation — orange
  return "bg-primary/10";
}

/** Text is black in BOTH light and dark mode against these light program colors — no
 * dark: variant needed since black-on-light-color reads the same regardless of theme. */
export const SCHEDULE_ENTRY_TEXT_CLASS = "text-black";
