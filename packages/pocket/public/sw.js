/* eslint-env serviceworker */
/**
 * Pocket's service worker.
 *
 * Hand-written, ~120 lines, no Workbox. The alternative is a generated file
 * nobody in this repo can read, controlling the one piece of the stack that
 * can serve a stale app to a shop floor and keep doing it after a deploy. This
 * is the wrong place to trade legibility for convenience.
 *
 * ── What it is for ───────────────────────────────────────────────────────
 *
 * Retail wifi is not down; it is intermittent behind steel fixtures, in the
 * exact aisle where the denim is. Two failures follow from that, and both are
 * fatal to a phone pilot:
 *
 *   · A cold start spins on a dead network instead of painting. An associate
 *     who has seen that twice stops opening the app.
 *   · A tap goes nowhere and says nothing.
 *
 * The first is this file's job. The second belongs to `queue.ts` — the queue
 * lives in the page, not here, because an action taken by a person needs to be
 * visible to that person immediately, and the service worker cannot draw.
 *
 * ── The caching rule ─────────────────────────────────────────────────────
 *
 * Navigations and static assets are both **stale-while-revalidate**: serve
 * from cache instantly, fetch in the background, update the cache for next
 * time. It is the pattern that makes an app paint on a dead network, and its
 * cost is exactly one thing — a deploy takes effect on the *second* launch.
 * That cost is paid explicitly with `SKIP_WAITING` plus a reload nudge in the
 * page, rather than by making every cold start wait for the network.
 *
 * **API calls are never cached.** Not stale-while-revalidate, not
 * network-first — not cached at all. A cached guest card is customer data on
 * disk, which is the thing `store.ts` exists to prevent, and it would be
 * bypassing that policy from underneath.
 */

const VERSION = "pocket-v1";
const SHELL = `${VERSION}-shell`;

/** The document itself. Hashed assets are cached on first use rather than
 *  listed, so this file never has to know Vite's output names. */
const SHELL_URLS = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Individually, not `addAll`: one 404 in the list fails the entire install
    // and leaves the app with no worker at all.
    await Promise.all(SHELL_URLS.map((u) => cache.add(u).catch(() => {})));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)));
    // Take over open tabs now. Without this, an update sits idle behind a page
    // the associate never closes — a phone left on the counter for a week.
    await self.clients.claim();
  })());
});

/** The page asks for this after telling the associate an update is ready. */
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function isApiRequest(url) {
  return /\/(api|auth|socket\.io)\//.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Anything that carries a guest, a token or a session goes straight to the
  // network and is never written down. Cross-origin too: the AI service and
  // the realtime server are separate origins in every deployment.
  if (isApiRequest(url) || url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(navigateWith(event, req));
    return;
  }
  event.respondWith(assetWith(req));
});

/**
 * A navigation: the cached document immediately, refreshed behind it.
 *
 * Falls back to the cached `./` when the exact URL was never cached, which is
 * what makes a deep link (a launch URL with `?t=`, a push that opened a
 * request) work offline rather than showing the browser's dinosaur.
 */
async function navigateWith(event, req) {
  const cache = await caches.open(SHELL);
  const cached = (await cache.match(req, { ignoreSearch: true })) || (await cache.match("./"));
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put("./", res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    // Hold the worker alive past the response, or the browser is free to kill
    // it before the background fetch lands and the app never updates at all.
    event.waitUntil(network);
    return cached;
  }
  const fresh = await network;
  return fresh || new Response(
    "<!doctype html><meta charset=utf-8><title>cue</title>" +
    "<body style='background:#141920;color:#F2EEE7;font:17px system-ui;padding:40px'>" +
    "<p>cue is not on this phone yet, and there is no connection to fetch it.</p>",
    { headers: { "content-type": "text/html; charset=utf-8" }, status: 503 },
  );
}

/** A hashed asset: cache-first, because the hash means it cannot go stale. */
async function assetWith(req) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return cached || Response.error();
  }
}

/**
 * A request arriving while the app is closed.
 *
 * ── Deliberately not switched on yet ─────────────────────────────────────
 *
 * These two handlers are complete and correct, and **no code in the app asks
 * for notification permission**. That is on purpose. A browser grants the
 * notification prompt once; a "Not now" is effectively permanent on iOS, and
 * on Android it poisons the origin for a long time. Asking before the server
 * can actually deliver a push would burn the single most valuable prompt this
 * product gets, on a feature that does nothing yet.
 *
 * So the receiving half ships now — it costs nothing dormant, and it means the
 * server-side milestone (VAPID keys, a subscription store, the send) does not
 * also have to get the service worker right under time pressure. The asking
 * happens on the day the sending works.
 *
 * The body is whatever the server sent. It is not read from any cache and
 * nothing here is written to one.
 */
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* malformed */ }
  const title = data.title || "Someone needs you";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    tag: data.tag || "cue-request",
    // Replace rather than stack: three notifications for one guest is three
    // decisions to make about one person.
    renotify: true,
    requireInteraction: false,
    data: { requestId: data.requestId || null, url: data.url || "./" },
    actions: [
      { action: "claim", title: "I've got it" },
      { action: "pass", title: "Pass" },
    ],
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { requestId, url } = event.notification.data || {};
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = all.find((c) => "focus" in c);
    const message = { kind: "notification", action: event.action || "open", requestId };
    if (open) {
      // The app is already running: hand it the decision and let it draw.
      open.postMessage(message);
      return open.focus();
    }
    // Cold: open the app and let it read the action off the URL. Claiming from
    // a closed app still has to reach the server, so it goes through the same
    // queue as everything else rather than a second code path here.
    const target = new URL(url || "./", self.location.href);
    if (event.action) target.searchParams.set("act", event.action);
    if (requestId) target.searchParams.set("req", requestId);
    return self.clients.openWindow(target.href);
  })());
});
