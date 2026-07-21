import type { User } from "@/contexts/AuthContext";

const TOKEN_KEY = "token";
const USER_KEY = "beebright_user";
const AUTH_HINT_KEY = "beebright_auth_hint";

function safeSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getAuthToken(): string | null {
  const session = safeSessionStorage();
  const local = safeLocalStorage();
  return session?.getItem(TOKEN_KEY) || local?.getItem(TOKEN_KEY) || null;
}

export function getStoredUser(): User | null {
  const session = safeSessionStorage();
  const raw = session?.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function hasAuthSessionHint(): boolean {
  const session = safeSessionStorage();
  return session?.getItem(AUTH_HINT_KEY) === "1";
}

export function setAuthSession(user: User, token?: string | null): void {
  const session = safeSessionStorage();
  if (!session) return;

  // Preserve the current tab token unless token is explicitly provided.
  if (token !== undefined) {
    if (token) {
      session.setItem(TOKEN_KEY, token);
    } else {
      session.removeItem(TOKEN_KEY);
    }
  }

  session.setItem(USER_KEY, JSON.stringify(user));
  session.setItem(AUTH_HINT_KEY, "1");
}

export function setStoredUser(user: User): void {
  const session = safeSessionStorage();
  if (!session) return;
  session.setItem(USER_KEY, JSON.stringify(user));
  session.setItem(AUTH_HINT_KEY, "1");
}

export function clearAuthSession(options?: { clearLegacyLocalStorage?: boolean }): void {
  const session = safeSessionStorage();
  if (session) {
    session.removeItem(TOKEN_KEY);
    session.removeItem(USER_KEY);
    session.removeItem(AUTH_HINT_KEY);
  }

  const local = safeLocalStorage();

  if (options?.clearLegacyLocalStorage) {
    if (!local) return;
    local.removeItem(AUTH_HINT_KEY);
    local.removeItem(TOKEN_KEY);
    local.removeItem("user");
    local.removeItem(USER_KEY);
  }
}

/**
 * One-time migration helper to avoid breaking already logged-in users
 * after moving auth from localStorage to sessionStorage.
 */
export function migrateLegacyAuthStorage(): void {
  const session = safeSessionStorage();
  const local = safeLocalStorage();
  if (!session || !local) return;

  const hasSessionToken = !!session.getItem(TOKEN_KEY);
  const hasSessionUser = !!session.getItem(USER_KEY);
  if (!hasSessionToken) {
    const legacyToken = local.getItem(TOKEN_KEY);
    if (legacyToken) session.setItem(TOKEN_KEY, legacyToken);
  }

  if (!hasSessionUser) {
    const legacyUser = local.getItem(USER_KEY) || local.getItem("user");
    if (legacyUser) session.setItem(USER_KEY, legacyUser);
  }

  if (session.getItem(TOKEN_KEY) || session.getItem(USER_KEY)) {
    session.setItem(AUTH_HINT_KEY, "1");
  }

  local.removeItem(TOKEN_KEY);
  local.removeItem("user");
  local.removeItem(USER_KEY);
}
