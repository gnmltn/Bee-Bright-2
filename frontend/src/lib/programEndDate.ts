/**
 * Parent-facing "program ends on" display — e.g. "Toddlers Playgroup – 16 Hours · Oct
 * 17 to Nov 26, 2026". The dates come straight from the backend (attachRemainingDueDates
 * in backend/utils/remainingDueDate.js — the SAME source invoiceDueDate already uses,
 * not a frontend estimate): `endDate` stays null until every one of the package's
 * sessions actually exists in the schedule, so this never shows a premature guess.
 *
 * Shown only while the enrollment is still genuinely in progress — the same status set
 * ({'approved','active'}) aiController.js's RENEW_PROGRAM_BLOCKING_STATUSES already
 * treats as "program not yet finished," so this display can never disagree with that
 * existing lock. It disappears on 'completed'/'rejected'/'cancelled' automatically.
 */
export type ProgramPackage = {
  displayName?: string;
  programCode?: string;
  startDate?: string | null;
  endDate?: string | null;
  sessionsScheduled?: number;
  sessionCount?: number | null;
  /** The owning enrollment's status — when given, formatProgramLabelWithRange hides the
   *  range once the program is no longer in progress (see isProgramInProgress above). */
  status?: string | null;
};

const IN_PROGRESS_STATUSES = new Set(["approved", "active"]);

export function isProgramInProgress(status?: string): boolean {
  return IN_PROGRESS_STATUSES.has(status || "");
}

function formatShortDate(iso: string, includeYear: boolean): string {
  return new Date(iso).toLocaleDateString("en-US", includeYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
}

/** True once this package has both a real start and end date to show. */
export function hasProgramEndRange(pkg: ProgramPackage): boolean {
  return Boolean(pkg.startDate && pkg.endDate);
}

/** "Oct 17 to Nov 26, 2026" — the year is shown once, on the end date, unless the
 *  range spans a calendar year boundary, in which case both dates show their year. */
function formatRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sameYear = start.getFullYear() === end.getFullYear();
  return `${formatShortDate(startIso, !sameYear)} to ${formatShortDate(endIso, true)}`;
}

/** "Toddlers Playgroup – 16 Hours · Oct 17 to Nov 26, 2026", or null if not ready to show
 *  (not yet fully scheduled). `displayName` already carries the "– 16 Hours" part. */
export function formatProgramEndRange(pkg: ProgramPackage): string | null {
  if (!hasProgramEndRange(pkg)) return null;
  const name = pkg.displayName || "Program";
  return `${name} · ${formatRange(pkg.startDate as string, pkg.endDate as string)}`;
}

/** Just the "Oct 17 to Nov 26, 2026" range, for places that already show the program
 *  name separately (e.g. next to an existing "• {program}" line). */
export function formatDateRangeOnly(pkg: ProgramPackage): string | null {
  if (!hasProgramEndRange(pkg)) return null;
  return formatRange(pkg.startDate as string, pkg.endDate as string);
}

/** "Academic Tutorial · Oct 17 to Nov 26, 2026", or just the plain name when there's no
 *  range to show yet (not fully scheduled) or the program isn't in progress (`status`
 *  given and outside {'approved','active'} — e.g. already completed). Tutor Dashboard's
 *  "My Students" cards use this per program, so each program on a multi-program card
 *  gets its own independent range/label. */
export function formatProgramLabelWithRange(pkg: ProgramPackage): string {
  const name = pkg.displayName || "Program";
  if (pkg.status !== undefined && pkg.status !== null && !isProgramInProgress(pkg.status)) return name;
  const range = formatDateRangeOnly(pkg);
  return range ? `${name} · ${range}` : name;
}
