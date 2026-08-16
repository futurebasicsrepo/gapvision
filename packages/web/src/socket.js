import { io } from "socket.io-client";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

export const socket = io(SERVER_URL, { autoConnect: true });

/**
 * Which retailer's floor this browser belongs to.
 *
 * The realtime server partitions rosters, radio and the live dashboard by
 * tenant, so a client that doesn't say who it is lands in the demo world. A
 * signed-in manager has their tenant on the session; the standalone demo
 * surfaces don't, and `gap` is the correct answer for them.
 */
export function currentTenant() {
  try {
    const user = JSON.parse(sessionStorage.getItem("cue.user") || "null");
    return user?.tenant_slug || "gap";
  } catch {
    return "gap";
  }
}

/**
 * The registration this socket should be holding, kept so it can be restated.
 *
 * Two things go wrong without it, and both are silent:
 *
 * **A reconnect used to un-register the dashboard.** Registration happened
 * once, in a component effect. The server keeps room membership on the socket,
 * so when the realtime server restarts — or a laptop lid closes — the browser
 * reconnects as a socket that never said who it was, stops receiving
 * `dashboard:update`, and shows a floor frozen at whenever the link dropped.
 * Nothing on screen says so.
 *
 * **A CueSea admin registered as the wrong store.** `currentTenant()` falls
 * back to `gap` for an account with no tenant of its own, so staff looking at
 * a retailer through the store picker were pinned to the demo world: the
 * roster they read was Gap's, not the store they had chosen.
 */
let registration = null;

/**
 * Say who this dashboard is, and make sure it stays said.
 *
 * The server pins a socket's tenant at register and refuses to move it — that
 * refusal is a security property, not an inconvenience, so switching stores
 * cannot be done by restating the payload. It takes a new socket, which is
 * what the reconnect below is for.
 */
export function registerDashboard({ tenant, name }) {
  const t = tenant || currentTenant();
  const rebinding = registration && registration.tenant !== t;
  registration = { role: "dashboard", tenant: t, name: name || null };
  if (rebinding) {
    // A fresh socket, because the old one is bound for life. The emit below is
    // buffered by socket.io and flushed once the new connection is up.
    socket.disconnect();
    socket.connect();
  }
  socket.emit("register", registration);
}

// One listener for every surface: whatever this socket last registered as, it
// registers as again the moment it is back. A dashboard that reconnects into
// no room is a dashboard showing stale numbers with no way to know.
socket.on("connect", () => {
  if (registration) socket.emit("register", registration);
});
