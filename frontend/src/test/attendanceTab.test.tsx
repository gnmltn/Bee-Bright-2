import { render, screen, fireEvent, waitFor, within, cleanup, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AttendanceTab } from "@/components/tutor/AttendanceTab";
import { scheduleService } from "@/services/api";

vi.mock("@/services/api", () => ({
  scheduleService: {
    markAttendance: vi.fn(() => Promise.resolve({ data: { success: true } })),
  },
}));

// Explicit cleanup between tests — several tests in this file reuse the same fixture
// names ("Ana Cruz", "Academic Tutorial"); without this, a previous test's unmounted-
// but-not-cleaned-up DOM can leak into the next one's queries.
afterEach(() => {
  cleanup();
});

// 2026-09-17: previously BOTH Present/Absent buttons stayed independently clickable
// after one was already marked, so a stray click could silently flip an already-marked
// session's attendance. Decision: keep both buttons clickable (support correcting a
// mistake), but switching away from an already-marked status now requires an explicit
// confirmation — re-clicking the SAME status is a harmless no-op, no confirmation and
// no re-submit needed.
function makeTodaySession(overrides: Record<string, unknown> = {}) {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return {
    _id: "sched-1",
    date: `${todayStr}T00:00:00.000Z`,
    startTime: "08:00",
    endTime: "09:00",
    student: { _id: "student-1", firstName: "Ana", lastName: "Cruz" },
    subject: { name: "Academic Tutorial" },
    ...overrides,
  };
}

function daysAgoDateStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function makePastSession(daysAgo: number, overrides: Record<string, unknown> = {}) {
  return {
    _id: `sched-past-${daysAgo}`,
    date: `${daysAgoDateStr(daysAgo)}T00:00:00.000Z`,
    startTime: "08:00",
    endTime: "09:00",
    student: { _id: "student-1", firstName: "Ana", lastName: "Cruz" },
    subject: { name: "Academic Tutorial" },
    ...overrides,
  };
}

// "Past sessions" is temporarily hidden (SHOW_LEGACY_ATTENDANCE_TABS = false in
// AttendanceTab.tsx) — Calendar Sessions is now the default/only way to reach an old
// session, and it reuses the exact same renderSessionRow/isLocked/getStatus logic
// these tests exist to exercise, so navigating via the calendar is a faithful
// replacement, not a different code path. react-day-picker's day cells are real
// <button> elements but override their role to "gridcell", not the implicit "button".
function clickCalendarDay(dayOfMonth: number) {
  fireEvent.click(screen.getByRole("gridcell", { name: String(dayOfMonth) }));
}

/** Clicks the calendar day matching this session's date — skips (returns false)
 *  if that day's number isn't safely earlier in the month than today, avoiding the
 *  month-boundary ambiguity showOutsideDays={false} introduces (same tolerance
 *  attendanceTabCalendar.test.tsx's own calendar tests already accept). */
function goToSessionDayOnCalendar(session: { date: string }): boolean {
  const todayDay = new Date().getDate();
  const targetDay = new Date(session.date).getDate();
  if (targetDay >= todayDay) return false;
  clickCalendarDay(targetDay);
  return true;
}

describe("AttendanceTab: Present/Absent button locking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks attendance immediately for an unmarked session (no confirmation needed)", async () => {
    const session = makeTodaySession();
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /present/i }));

    await waitFor(() => {
      expect(scheduleService.markAttendance).toHaveBeenCalledWith("sched-1", "present");
    });
    expect(screen.queryByText(/change attendance/i)).toBeNull();
  });

  it("re-clicking the already-marked status is a no-op — no confirmation, no API call", async () => {
    const session = makeTodaySession({ attendanceStatus: "present" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /present/i }));

    expect(screen.queryByText(/change attendance/i)).toBeNull();
    expect(scheduleService.markAttendance).not.toHaveBeenCalled();
  });

  it("clicking the opposite status on an already-marked session opens a confirmation instead of submitting immediately", async () => {
    const session = makeTodaySession({ attendanceStatus: "present" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /absent/i }));

    expect(await screen.findByText(/change attendance to absent\?/i)).toBeTruthy();
    expect(scheduleService.markAttendance).not.toHaveBeenCalled();
  });

  it("confirming the switch submits the new status", async () => {
    const session = makeTodaySession({ attendanceStatus: "present" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /absent/i }));
    expect(await screen.findByText(/change attendance to absent\?/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /yes, mark as absent/i }));

    await waitFor(() => {
      expect(scheduleService.markAttendance).toHaveBeenCalledWith("sched-1", "absent");
    });
  });

  it("cancelling the switch does not submit anything", async () => {
    const session = makeTodaySession({ attendanceStatus: "present" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /absent/i }));
    expect(await screen.findByText(/change attendance to absent\?/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(screen.queryByText(/change attendance to absent\?/i)).toBeNull();
    });
    expect(scheduleService.markAttendance).not.toHaveBeenCalled();
  });
});

// "bug (13).pdf" Group AR — tutors get a 3-day grace period after a session date to mark
// Present/Absent; past that, an unmarked session auto-resolves to Absent (display-only,
// never written to the DB until the tutor actually acts on it).
describe("AttendanceTab: 3-day grace period auto-resolves an unmarked past session to Absent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Tutor Attendance feature, Group 2 — once a past session has crossed the grace
  // period while still genuinely unmarked, BOTH buttons become non-interactive: a
  // tutor can no longer retroactively mark it Present (or re-click Absent) after the
  // window has closed. Previously only Absent's click was a no-op while Present
  // stayed fully clickable and even opened a "change attendance" confirmation.
  it("more than 3 days old, still unmarked: reads as Absent, and BOTH Present and Absent are disabled — neither is clickable anymore", async () => {
    const session = makePastSession(4); // 4 days ago -> past the grace period
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    if (!goToSessionDayOnCalendar(session)) return;

    const absentBtn = await screen.findByRole("button", { name: /^absent$/i });
    const presentBtn = screen.getByRole("button", { name: /^present$/i });
    expect(absentBtn).toBeDisabled();
    expect(presentBtn).toBeDisabled();

    fireEvent.click(absentBtn);
    fireEvent.click(presentBtn);
    expect(scheduleService.markAttendance).not.toHaveBeenCalled();
    expect(screen.queryByText(/change attendance/i)).toBeNull();
  });

  it("within the 3-day window, still unmarked: does NOT get forced to Absent — Present submits immediately, no confirmation", async () => {
    const session = makePastSession(2); // 2 days ago -> still inside the grace window
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    if (!goToSessionDayOnCalendar(session)) return;

    fireEvent.click(await screen.findByRole("button", { name: /^present$/i }));
    await waitFor(() => {
      expect(scheduleService.markAttendance).toHaveBeenCalledWith(session._id, "present");
    });
    expect(screen.queryByText(/change attendance/i)).toBeNull();
  });

  it("exactly 3 days old is still within the grace period — \"more than 3 days\" means day 4 onward, not day 3", async () => {
    const session = makePastSession(3);
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    if (!goToSessionDayOnCalendar(session)) return;

    fireEvent.click(await screen.findByRole("button", { name: /^present$/i }));
    await waitFor(() => {
      expect(scheduleService.markAttendance).toHaveBeenCalledWith(session._id, "present");
    });
    expect(screen.queryByText(/change attendance/i)).toBeNull();
  });

  // Follow-up fix: the lock used to early-return "not locked" whenever a real status
  // already existed, so an already-marked session that was simply old enough never
  // locked at all — exactly the "Ken Jen Soriano, already Present, Oct 5" screenshot
  // bug. The lock must be purely time-based: BOTH buttons disable once a session is
  // more than 3 days old, whether it was ever marked or not.
  it("more than 3 days old AND already marked Present: BOTH buttons are still disabled — the existing mark can no longer be changed", async () => {
    const session = makePastSession(10, { attendanceStatus: "present" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    if (!goToSessionDayOnCalendar(session)) return;

    const presentBtn = await screen.findByRole("button", { name: /^present$/i });
    const absentBtn = screen.getByRole("button", { name: /^absent$/i });
    expect(presentBtn).toBeDisabled();
    expect(absentBtn).toBeDisabled();

    fireEvent.click(absentBtn);
    expect(scheduleService.markAttendance).not.toHaveBeenCalled();
    expect(screen.queryByText(/change attendance/i)).toBeNull();
  });

  it("more than 3 days old AND already marked Absent: BOTH buttons are still disabled", async () => {
    const session = makePastSession(10, { attendanceStatus: "absent" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    if (!goToSessionDayOnCalendar(session)) return;

    expect(await screen.findByRole("button", { name: /^present$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^absent$/i })).toBeDisabled();
  });

  it("within the 3-day window AND already marked: stays fully editable — switching status still opens the confirmation dialog as before", async () => {
    const session = makePastSession(1, { attendanceStatus: "present" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    if (!goToSessionDayOnCalendar(session)) return;

    const absentBtn = await screen.findByRole("button", { name: /^absent$/i });
    expect(absentBtn).not.toBeDisabled();
    fireEvent.click(absentBtn);
    expect(await screen.findByText(/change attendance to absent\?/i)).toBeTruthy();
  });

  // Real-time requirement: the lock must engage live if the tab is left open across
  // the exact moment a session crosses the 3-day threshold, with no page refresh.
  // todayStr is re-checked on a timer specifically so this can happen. Uses only
  // synchronous getByRole/fireEvent here — RTL's async find*/waitFor poll via REAL
  // timers internally, which hangs indefinitely once fake timers are active, so this
  // test (and any assertion inside it) must stay fully synchronous.
  it("the lock engages live on a timer, with no remount/refresh, once a session crosses the 3-day threshold while the tab is open", () => {
    vi.useFakeTimers();
    try {
      const session = makePastSession(3, { attendanceStatus: "present" }); // still exactly within the window
      render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
      if (!goToSessionDayOnCalendar(session)) return;

      expect(screen.getByRole("button", { name: /^absent$/i })).not.toBeDisabled();

      // Advance real wall-clock + the component's re-check timer past midnight, crossing
      // into day 4 (now "more than 3 days old") — no re-render/refresh triggered manually.
      vi.setSystemTime(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
      act(() => {
        vi.advanceTimersByTime(61 * 1000);
      });

      expect(screen.getByRole("button", { name: /^present$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^absent$/i })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Tutor Attendance feature, Group 1 — a Toddlers Playgroup/group session shows one
// collapsed entry for the whole group; expanding it reveals each enrolled child with
// their OWN independent Present/Absent controls, so e.g. 2 Present + 1 Absent is a
// valid outcome for the same session. A one-on-one session must stay completely
// unaffected (covered by the describe blocks above, unchanged).
function makePlaygroupSession(overrides: Record<string, unknown> = {}) {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return {
    _id: "sched-group-1",
    date: `${todayStr}T00:00:00.000Z`,
    startTime: "08:00",
    endTime: "10:00",
    subject: { name: "Toddlers Playgroup" },
    students: [
      { _id: "child-a", firstName: "Ana", lastName: "Cruz" },
      { _id: "child-b", firstName: "Ben", lastName: "Reyes" },
      { _id: "child-c", firstName: "Cy", lastName: "Santos" },
    ],
    attendanceByStudent: [],
    ...overrides,
  };
}

describe("AttendanceTab: Toddlers Playgroup sessions are marked per child, not one toggle for the whole group", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the group as one collapsed entry; expanding it reveals each child with their own Present/Absent pair", async () => {
    const session = makePlaygroupSession();
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);

    expect(screen.getByText(/toddlers playgroup/i)).toBeTruthy();
    expect(screen.getByText(/3 children/i)).toBeTruthy();
    expect(screen.queryByText("Ana Cruz")).toBeNull();

    fireEvent.click(screen.getByText(/toddlers playgroup/i));
    expect(await screen.findByText("Ana Cruz")).toBeTruthy();
    expect(screen.getByText("Ben Reyes")).toBeTruthy();
    expect(screen.getByText("Cy Santos")).toBeTruthy();
    // 3 children x (Present + Absent) = 6 buttons, independent of each other.
    expect(screen.getAllByRole("button", { name: /^present$/i }).length).toBe(3);
    expect(screen.getAllByRole("button", { name: /^absent$/i }).length).toBe(3);
  });

  it("marking one child does not affect the others — 2 Present + 1 Absent is a valid, independently-submitted outcome", async () => {
    const session = makePlaygroupSession();
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    fireEvent.click(screen.getByText(/toddlers playgroup/i));
    await screen.findByText("Ana Cruz");

    const rowFor = (name: string) => screen.getByText(name).closest("div") as HTMLElement;
    fireEvent.click(within(rowFor("Ana Cruz")).getByRole("button", { name: /^present$/i }));
    fireEvent.click(within(rowFor("Ben Reyes")).getByRole("button", { name: /^present$/i }));
    fireEvent.click(within(rowFor("Cy Santos")).getByRole("button", { name: /^absent$/i }));

    await waitFor(() => expect(scheduleService.markAttendance).toHaveBeenCalledTimes(3));
    expect(scheduleService.markAttendance).toHaveBeenCalledWith("sched-group-1", "present", "child-a");
    expect(scheduleService.markAttendance).toHaveBeenCalledWith("sched-group-1", "present", "child-b");
    expect(scheduleService.markAttendance).toHaveBeenCalledWith("sched-group-1", "absent", "child-c");
  });

  it("a child already marked Present shows that state, and the group header summarizes present/absent/unmarked counts", async () => {
    const session = makePlaygroupSession({
      attendanceByStudent: [
        { student: "child-a", status: "present" },
        { student: "child-b", status: "absent" },
      ],
    });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);

    expect(screen.getByText(/1 present/i)).toBeTruthy();
    expect(screen.getByText(/1 absent/i)).toBeTruthy();
    expect(screen.getByText(/1 unmarked/i)).toBeTruthy();
  });

  it("a Playgroup entry in the History ('Past sessions') list is ALSO per-child, not a single group-wide row", async () => {
    const session = makePlaygroupSession({ date: `${daysAgoDateStr(10)}T00:00:00.000Z` });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    if (!goToSessionDayOnCalendar(session)) return;

    fireEvent.click(await screen.findByText(/toddlers playgroup/i));
    expect(await screen.findByText("Ana Cruz")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^present$/i }).length).toBe(3);
  });
});

// "Attendance by student" (Student summary tab) — previously grouped rows by a plain
// name string with no program shown, which also meant every Toddlers Playgroup child
// (no singular `student`) silently fell into one shared "—" bucket.
describe("AttendanceTab: Student summary shows the program per row and never merges Playgroup children into one '—' row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function openSummary() {
    fireEvent.click(screen.getByRole("button", { name: /student summary/i }));
  }

  it("shows the program name under the student's name", async () => {
    const session = makePastSession(10, { attendanceStatus: "present" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    openSummary();

    expect(await screen.findByText("Ana Cruz")).toBeTruthy();
    expect(screen.getByText("Academic Tutorial")).toBeTruthy();
  });

  it("a student enrolled in 2 programs gets 2 separate rows, each with its own accurate percentage (not a blended average)", async () => {
    const sessions = [
      makePastSession(10, { _id: "s1", attendanceStatus: "present", subject: { name: "Academic Tutorial" } }),
      makePastSession(20, { _id: "s2", attendanceStatus: "absent", subject: { name: "Examination Preparation" } }),
    ];
    render(<AttendanceTab sessions={sessions} onRefresh={() => {}} />);
    openSummary();

    expect(await screen.findByText("Academic Tutorial")).toBeTruthy();
    expect(screen.getByText("Examination Preparation")).toBeTruthy();
    // Two distinct rows, not one row averaging 50%.
    const rows = screen.getAllByText("Ana Cruz");
    expect(rows.length).toBe(2);
    expect(screen.getByText("1 / 1 present")).toBeTruthy(); // Academic Tutorial: present
    expect(screen.getByText("0 / 1 present")).toBeTruthy(); // Examination Preparation: absent
  });

  // Follow-up fix: the student's own id is PERMANENT and never changes across a
  // renewal/re-enrollment, so (studentId, program) alone isn't enough to tell an old,
  // finished cycle apart from a brand new one. The backend resolves which enrollment
  // cycle each session belongs to (cycleByStudent) from the student's real Enrollment
  // history — the frontend must honor that and never blend two different cycles.
  it("a renewed/re-enrolled program (same student, same program name, DIFFERENT enrollment cycle) gets 2 separate rows, not one blended row", async () => {
    const sessions = [
      makePastSession(100, {
        _id: "old-cycle-session",
        attendanceStatus: "present",
        subject: { name: "Academic Tutorial" },
        cycleByStudent: [{ student: "student-1", enrollmentId: "BB-20250101-0001" }],
      }),
      makePastSession(5, {
        _id: "new-cycle-session",
        attendanceStatus: "absent",
        subject: { name: "Academic Tutorial" },
        cycleByStudent: [{ student: "student-1", enrollmentId: "BB-20260601-0007" }],
      }),
    ];
    render(<AttendanceTab sessions={sessions} onRefresh={() => {}} />);
    openSummary();

    // Two rows for the SAME student + SAME program name — never collapsed into one
    // blended 50% row.
    expect(await screen.findAllByText("Academic Tutorial")).toHaveLength(2);
    expect(screen.getByText("1 / 1 present")).toBeTruthy(); // the old, finished cycle
    expect(screen.getByText("0 / 1 present")).toBeTruthy(); // the new renewed cycle
  });

  it("a Playgroup session's enrolled children each appear under their OWN real name and program — never merged into a single '—' row", async () => {
    const session = {
      _id: "sched-group-past",
      date: `${daysAgoDateStr(10)}T00:00:00.000Z`,
      startTime: "08:00",
      endTime: "10:00",
      subject: { name: "Toddlers Playgroup" },
      students: [
        { _id: "child-a", firstName: "Ana", lastName: "Cruz" },
        { _id: "child-b", firstName: "Ben", lastName: "Reyes" },
      ],
      attendanceByStudent: [
        { student: "child-a", status: "present" as const },
        { student: "child-b", status: "absent" as const },
      ],
    };
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    openSummary();

    expect(await screen.findByText("Ana Cruz")).toBeTruthy();
    expect(screen.getByText("Ben Reyes")).toBeTruthy();
    expect(screen.getAllByText("Toddlers Playgroup").length).toBe(2);
    expect(screen.queryByText("—")).toBeNull();
  });
});

// Tutor Dashboard "Student summary" — the same per-program start/end date range the
// parent side already shows (Request 3), carried on each session's cycleByStudent entry
// (attachProgramDateRangeToCycles, backend/utils/remainingDueDate.js) and reused here
// rather than re-estimated, so the tutor's view can never disagree with the parent's.
describe("AttendanceTab: Student summary shows each row's program date range (reusing the parent-side computation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function openSummary() {
    fireEvent.click(screen.getByRole("button", { name: /student summary/i }));
  }

  it("shows the correct 'Oct 17 to Nov 26, 2026' style range next to the program name", async () => {
    const session = makePastSession(10, {
      attendanceStatus: "present",
      cycleByStudent: [{ student: "student-1", enrollmentId: "BB-1", startDate: "2026-10-17T00:00:00.000Z", endDate: "2026-11-26T00:00:00.000Z", status: "approved" }],
    });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    openSummary();

    expect(await screen.findByText("Ana Cruz")).toBeTruthy();
    expect(screen.getByText(/Oct 17 to Nov 26, 2026/)).toBeTruthy();
  });

  it("a student in 2 programs gets a SEPARATE, independent date range on each row", async () => {
    const sessions = [
      makePastSession(10, {
        _id: "s1",
        attendanceStatus: "present",
        subject: { name: "Academic Tutorial" },
        cycleByStudent: [{ student: "student-1", enrollmentId: "BB-AT", startDate: "2026-10-17T00:00:00.000Z", endDate: "2026-11-26T00:00:00.000Z", status: "approved" }],
      }),
      makePastSession(20, {
        _id: "s2",
        attendanceStatus: "absent",
        subject: { name: "Toddlers Playgroup" },
        cycleByStudent: [{ student: "student-1", enrollmentId: "BB-TPG", startDate: "2026-09-01T00:00:00.000Z", endDate: "2026-10-13T00:00:00.000Z", status: "active" }],
      }),
    ];
    render(<AttendanceTab sessions={sessions} onRefresh={() => {}} />);
    openSummary();

    expect(await screen.findByText(/Oct 17 to Nov 26, 2026/)).toBeTruthy();
    expect(screen.getByText(/Sep 1 to Oct 13, 2026/)).toBeTruthy();
  });

  it("the range disappears once the program is no longer in progress (e.g. completed) — the row itself still shows", async () => {
    const session = makePastSession(10, {
      attendanceStatus: "present",
      cycleByStudent: [{ student: "student-1", enrollmentId: "BB-1", startDate: "2026-10-17T00:00:00.000Z", endDate: "2026-11-26T00:00:00.000Z", status: "completed" }],
    });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    openSummary();

    expect(await screen.findByText("Ana Cruz")).toBeTruthy();
    expect(screen.getByText("Academic Tutorial")).toBeTruthy();
    expect(screen.queryByText(/Oct 17 to Nov 26, 2026/)).toBeNull();
  });

  it("no range shown while the program isn't fully scheduled yet (endDate still null)", async () => {
    const session = makePastSession(10, {
      attendanceStatus: "present",
      cycleByStudent: [{ student: "student-1", enrollmentId: "BB-1", startDate: "2026-10-17T00:00:00.000Z", endDate: null, status: "approved" }],
    });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    openSummary();

    expect(await screen.findByText("Academic Tutorial")).toBeTruthy();
    expect(screen.queryByText(/ to /)).toBeNull();
  });
});

// Real bug report: marking a TODAY session present never moved "Attendance by student"
// at all (stayed at 0 / total), while a separate overall-percentage display elsewhere
// correctly reflected the same mark immediately. Root cause: this table's own tally
// previously only counted sessions where `date < todayStr`, which excludes today's
// sessions ENTIRELY, even after they're over and marked — unlike StudentDashboard.tsx's
// equivalent computation, which already correctly treats "today, past its end time" as
// completed. A today session is also exactly the normal case submitAttendance itself
// already allows marking (it only rejects a FUTURE date), so excluding it here was
// never intentional.
describe("AttendanceTab: Student summary correctly counts a TODAY session once it has ended and been marked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function openSummary() {
    fireEvent.click(screen.getByRole("button", { name: /student summary/i }));
  }

  it("a today session marked present, after its end time, counts immediately as 1 / 1 — not 0 / 1", () => {
    vi.useFakeTimers();
    const today = new Date();
    today.setHours(10, 0, 0, 0); // well after the 8-9AM session below has ended
    vi.setSystemTime(today);

    const session = makeTodaySession({ attendanceStatus: "present" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /student summary/i }));

    expect(screen.getByText("1 / 1 present")).toBeTruthy();
  });

  it("a today session marked present, BEFORE its own end time, is not yet counted as present (0 / 1 — same as unmarked/absent, since it isn't completed yet)", () => {
    vi.useFakeTimers();
    const today = new Date();
    today.setHours(8, 30, 0, 0); // mid-session, before its own 9AM end time
    vi.setSystemTime(today);

    const session = makeTodaySession({ attendanceStatus: "present" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    openSummary();

    // `overall` (the denominator) always counts every scheduled session regardless of
    // whether it's done yet — unchanged, pre-existing behavior. Only the numerator
    // (`present`, gated on isSessionDone) should still read 0 here, since the session
    // hasn't actually finished, even though it's already marked.
    expect(screen.getByText("0 / 1 present")).toBeTruthy();
  });

  it("a today session marked ABSENT, after its end time, counts immediately as 0 / 1 — not left out entirely", () => {
    vi.useFakeTimers();
    const today = new Date();
    today.setHours(10, 0, 0, 0);
    vi.setSystemTime(today);

    const session = makeTodaySession({ attendanceStatus: "absent" });
    render(<AttendanceTab sessions={[session]} onRefresh={() => {}} />);
    openSummary();

    expect(screen.getByText("0 / 1 present")).toBeTruthy();
  });
});
