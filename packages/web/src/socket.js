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
