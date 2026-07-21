type ActivityListener = () => void;

const listeners = new Set<ActivityListener>();
let lastNotifiedAt = 0;

const THROTTLE_MS = 1000;

export function subscribeSessionActivity(listener: ActivityListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifySessionActivity(): void {
  const now = Date.now();
  if (now - lastNotifiedAt < THROTTLE_MS) return;
  lastNotifiedAt = now;

  listeners.forEach((listener) => {
    listener();
  });
}

export function shouldTrackApiActivity(url?: string): boolean {
  if (!url) return true;
  const normalized = url.toLowerCase();

  // Maintenance polling runs automatically in the background.
  // Excluding it prevents artificial session keep-alive without user activity.
  if (normalized.includes('/settings/maintenance')) return false;

  return true;
}
