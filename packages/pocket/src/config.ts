/**
 * Where Pocket talks to, decided once.
 *
 * Everything the browser tier touches goes through the realtime server, which
 * proxies `/auth` and the admin routes upstream and attaches the AI service
 * key (`packages/server/src/proxy.js`). One origin for the socket and for
 * sign-in, because a static client cannot hold that key and there is no reason
 * for Pocket to be the exception Console and Studio are not.
 *
 * ── Why there is a hardcoded fallback ────────────────────────────────────
 *
 * A bare `localhost:4000` default is correct for a dev server and actively
 * dangerous for a static app that gets deployed: the build succeeds, the
 * deploy goes green, and the failure surfaces as "sign-in does not work" on an
 * associate's phone, because the one build-time variable nobody remembered to
 * set is invisible in every check that runs before that moment.
 *
 * So the default is environment-aware rather than absent. `VITE_SERVER_URL`
 * still wins when it is set, which is how a review deployment or a second
 * region points somewhere else. `packages/pos-app` carries its production URL
 * the same way, for the same reason.
 *
 * The cost, stated: if the realtime server moves, a build that predates the
 * move points at the old host until it is rebuilt. Pocket's service worker
 * updates itself on the next launch, so that window is one app open long —
 * and it is a smaller window than the one where nobody notices the variable
 * was never set at all.
 */

const PRODUCTION_SERVER = "https://realtime-production-80f4.up.railway.app";
const DEV_SERVER = "http://localhost:4000";

function localhost(): boolean {
  const h = globalThis.location?.hostname || "";
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".local");
}

export const SERVER_URL: string =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SERVER_URL ||
  (localhost() ? DEV_SERVER : PRODUCTION_SERVER);
