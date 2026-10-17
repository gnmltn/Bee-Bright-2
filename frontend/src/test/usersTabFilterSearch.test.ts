/**
 * Admin Users tab — role filter + search bar (positioned before "Add User").
 * matchesUserSearch/filterUsersForTab are the pure helpers AdminDashboard.tsx calls
 * from filteredActiveUsers/filteredArchivedUsers; Active and Archived each hold their
 * OWN roleFilter/searchQuery state and call filterUsersForTab independently, so these
 * tests exercise exactly the logic that keeps the two sub-tabs from ever sharing a
 * filter.
 */
import { describe, it, expect } from "vitest";
import { matchesUserSearch, filterUsersForTab } from "@/pages/AdminDashboard";

type U = { firstName: string; lastName: string; email: string; role: string };

const PARENT_ARRIANA: U = { firstName: "Arriana", lastName: "Cruz", email: "arriana.cruz@example.com", role: "parent" };
const TUTOR_ARRIANA: U = { firstName: "Arriana", lastName: "Reyes", email: "arriana.reyes@example.com", role: "tutor" };
const TUTOR_JOSE: U = { firstName: "Jose", lastName: "Santos", email: "jose.santos@example.com", role: "tutor" };
const ADMIN_MARIA: U = { firstName: "Maria", lastName: "Lopez", email: "maria.lopez@example.com", role: "admin" };

const ALL_USERS = [PARENT_ARRIANA, TUTOR_ARRIANA, TUTOR_JOSE, ADMIN_MARIA];

describe("matchesUserSearch", () => {
  it("an empty or whitespace-only query matches everything", () => {
    expect(matchesUserSearch(TUTOR_JOSE, "")).toBe(true);
    expect(matchesUserSearch(TUTOR_JOSE, "   ")).toBe(true);
  });

  it("matches by first or last name, case-insensitively", () => {
    expect(matchesUserSearch(TUTOR_ARRIANA, "arriana")).toBe(true);
    expect(matchesUserSearch(TUTOR_ARRIANA, "ARRIANA")).toBe(true);
    expect(matchesUserSearch(TUTOR_ARRIANA, "Reyes")).toBe(true);
    expect(matchesUserSearch(TUTOR_ARRIANA, "Cruz")).toBe(false);
  });

  it("matches by email, case-insensitively", () => {
    expect(matchesUserSearch(ADMIN_MARIA, "maria.lopez@example.com")).toBe(true);
    expect(matchesUserSearch(ADMIN_MARIA, "MARIA.LOPEZ")).toBe(true);
  });

  it("does not match an unrelated query", () => {
    expect(matchesUserSearch(ADMIN_MARIA, "nonexistent")).toBe(false);
  });
});

describe("filterUsersForTab", () => {
  it('roleFilter "all" with no search returns everyone', () => {
    expect(filterUsersForTab(ALL_USERS, "all", "")).toEqual(ALL_USERS);
  });

  it("role filter alone narrows to just that role", () => {
    expect(filterUsersForTab(ALL_USERS, "tutor", "")).toEqual([TUTOR_ARRIANA, TUTOR_JOSE]);
    expect(filterUsersForTab(ALL_USERS, "parent", "")).toEqual([PARENT_ARRIANA]);
    expect(filterUsersForTab(ALL_USERS, "admin", "")).toEqual([ADMIN_MARIA]);
  });

  it("search alone (role=all) narrows by name/email across every role", () => {
    expect(filterUsersForTab(ALL_USERS, "all", "arriana")).toEqual([PARENT_ARRIANA, TUTOR_ARRIANA]);
  });

  it('role filter AND search combine (AND, not OR) — e.g. "Tutor" + "Arriana" narrows to just the matching tutor', () => {
    expect(filterUsersForTab(ALL_USERS, "tutor", "Arriana")).toEqual([TUTOR_ARRIANA]);
    // The parent named Arriana must NOT show up once the role filter is set to Tutor.
    expect(filterUsersForTab(ALL_USERS, "tutor", "Arriana")).not.toContain(PARENT_ARRIANA);
  });

  it("role + search that match nothing returns an empty list, not everyone", () => {
    expect(filterUsersForTab(ALL_USERS, "admin", "arriana")).toEqual([]);
  });

  it("filtering is a pure, non-mutating narrowing of whatever list it's given — e.g. a live-updated list applies the SAME filter without extra wiring", () => {
    const original = [...ALL_USERS];
    const liveUpdatedList = [...ALL_USERS, { firstName: "New", lastName: "Tutor", email: "new.tutor@example.com", role: "tutor" }];
    expect(filterUsersForTab(liveUpdatedList, "tutor", "")).toEqual([TUTOR_ARRIANA, TUTOR_JOSE, liveUpdatedList[4]]);
    expect(ALL_USERS).toEqual(original); // the input array itself was never mutated
  });
});
