import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { uploadsBaseUrl } from "@/services/api";
import { getAuthToken } from "@/utils/authStorage";
import type { User } from "@/contexts/AuthContext";
import { REALTIME_EVENTS, dispatchRealtimeEvent } from "@/lib/realtimeBridge";
import { notifyBadgesChanged } from "@/lib/navBadges";
import { notifyRequestsChanged } from "@/lib/escalations";

const SERVER_EVENT_TO_BRIDGE = {
  "enrollment:new": REALTIME_EVENTS.ENROLLMENT_NEW,
  "payment:new": REALTIME_EVENTS.PAYMENT_NEW,
  "schedule:changed": REALTIME_EVENTS.SCHEDULE_CHANGED,
  "announcement:new": REALTIME_EVENTS.ANNOUNCEMENT_NEW,
  "remark:published": REALTIME_EVENTS.REMARK_PUBLISHED,
  "remark:reviewed": REALTIME_EVENTS.REMARK_REVIEWED,
  "remark:new": REALTIME_EVENTS.REMARK_NEW,
  "payment:statusChanged": REALTIME_EVENTS.PAYMENT_STATUS_CHANGED,
  "assessment:completed": REALTIME_EVENTS.ASSESSMENT_COMPLETED,
  "user:changed": REALTIME_EVENTS.USER_CHANGED,
  "request:new": REALTIME_EVENTS.REQUEST_NEW,
} as const;

/**
 * The ONE Socket.io connection for the whole app, mounted once above the router
 * (App.tsx) so it survives navigation between routes (including the several pages that
 * are logically part of a dashboard but are actually separate routes — AdminEscalations,
 * StudentPayments). Connects for any authenticated admin/super_admin/parent/tutor
 * session; the server's own handshake auth independently re-verifies the role and
 * decides which room the connection actually joins — this hook never claims a room
 * itself. Every server event is republished as a plain `window` CustomEvent (see
 * lib/realtimeBridge.ts) — individual pages listen for only the events their own
 * screens care about and call their OWN existing fetch functions, exactly like the
 * pilot did for the Admin dashboard.
 */
export function useRealtimeConnection(user: User | null | undefined) {
  const socketRef = useRef<Socket | null>(null);
  const enabled = user?.role === "admin" || user?.role === "super_admin" || user?.role === "parent" || user?.role === "tutor";

  useEffect(() => {
    if (!enabled) return;
    const token = getAuthToken();
    if (!token) return;

    const socket = io(uploadsBaseUrl, {
      auth: { token },
      reconnection: true,
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    for (const [serverEvent, bridgeEvent] of Object.entries(SERVER_EVENT_TO_BRIDGE)) {
      socket.on(serverEvent, (payload: unknown) => {
        dispatchRealtimeEvent(bridgeEvent, payload);
        // The sidebar nav badges (navBadges.ts) and the separate Requests badge
        // (lib/escalations.ts) each run their OWN pre-existing 60s poll, entirely
        // unconnected to this socket — a schedule/remark/etc. change wouldn't move the
        // badge for up to 60s otherwise ("bug (18).pdf" Group AW: the badge itself was
        // never wired into the realtime work at all, a pre-existing characteristic of
        // navBadges.ts, not a regression this expansion introduced). Nudging both here
        // means the badge and the actual data it's counting move together.
        notifyBadgesChanged();
        if (serverEvent === "request:new") notifyRequestsChanged();
      });
    }
    socket.on("connect_error", (err) => {
      // Expected on a network blip or a session that isn't (yet) one of the eligible
      // roles — never surfaced to the user as an error; the next event still arrives.
      console.debug("[realtime] connect_error", err.message);
    });
    // Manager-level event — fires only on a RECONNECT after a drop, never on the
    // initial connect. Every page's own reconnect listener does its own silent
    // (no-toast) refetch here, so a blip resolves to "caught up," not stale.
    socket.io.on("reconnect", () => {
      dispatchRealtimeEvent(REALTIME_EVENTS.RECONNECT_CATCHUP);
      notifyBadgesChanged();
      notifyRequestsChanged();
    });
    socket.io.on("reconnect_attempt", (n) => console.debug("[realtime] reconnect_attempt", n));
    socket.on("disconnect", (reason) => console.debug("[realtime] disconnect", reason));
    // Dev-only introspection hook (never ships in a production build) — lets a
    // Playwright/devtools session inspect live connection state.
    if (import.meta.env.DEV) {
      (window as unknown as { __bbRealtimeSocket?: Socket }).__bbRealtimeSocket = socket;
    }

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
    // Re-connect if the signed-in user's own id changes (a genuine account switch),
    // not on every unrelated user-object re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, user?.id]);
}
