/**
 * Temporary product decision: the Tutor Dashboard's Attendance tab shows only
 * "Calendar Sessions" and "Student summary" for now — "Today's sessions" and "Past
 * sessions" are hidden, not deleted, and Calendar Sessions is the default tab.
 *
 * Flip this one value back to `true` to restore both legacy tabs (and the original
 * "Today's sessions" default) exactly as they were — nothing else needs to change.
 * Kept in its own tiny module (rather than a local const in AttendanceTab.tsx) so
 * tests can mock it directly to exercise the "flag back on" path without needing a
 * second copy of the component.
 */
export const SHOW_LEGACY_ATTENDANCE_TABS = false;
