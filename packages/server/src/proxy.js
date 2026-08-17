/**
 * AI service proxy.
 *
 * The glasses plugin and web dashboard are static bundles. Anything compiled
 * into them is published — so they cannot hold the AI service key. Instead
 * they call the realtime server, which already knows them, and it attaches the
 * key server-side.
 *
 * Mount before the socket wiring in packages/server/src/index.js:
 *
 *   import { createAiProxy } from "./proxy.js";
 *   app.use(createAiProxy({ aiServiceUrl: AI_SERVICE_URL, apiKey: process.env.GAPVISION_API_KEY }));
 *
 * Then rebuild the clients with VITE_AI_URL pointed at the realtime server
 * instead of the AI service. After that, the AI service can be reached only by
 * something holding the key.
 */
import express from "express";

/**
 * The one route whose body is an image, and the limit it gets.
 *
 * Exported because index.js has to let this path past the global
 * `express.json()` — that parser is capped at 100kb, which every photograph
 * exceeds, and its rejection is an opaque 413 from a middleware that has no
 * idea why the request was large.
 *
 * Deliberately above the AI service's own 3 MB image ceiling. The service is
 * the thing that knows the number and says it in a sentence an associate can
 * act on ("resize to about 1600px"); this limit exists only to stop an
 * unbounded body reaching the parser, so it must not fire first.
 */
export const VISION_PATH = "/api/vision/analyze";
export const VISION_BODY_LIMIT = "6mb";

export function createAiProxy({ aiServiceUrl, apiKey, allowRoster = false }) {
  const router = express.Router();

  if (!apiKey) {
    console.warn(
      "[gapvision] WARNING: GAPVISION_API_KEY is not set on the realtime server. " +
        "Proxied calls to the AI service will be rejected."
    );
  }

  const headers = () => ({
    "content-type": "application/json",
    ...(apiKey ? { "x-gapvision-key": apiKey } : {}),
  });

  /**
   * Roster passthrough.
   *
   * Off by default. A list of every customer in the store is the exact shape
   * the tap-to-reveal design exists to eliminate, and it is enumerable: the
   * ids it returns are the ids the context endpoint takes. Enable it only for
   * the demo roster on synthetic tenants.
   */
  router.get("/api/guests", async (req, res) => {
    const tenant = String(req.query.tenant ?? "gap").toLowerCase();

    if (!allowRoster && tenant !== "gap") {
      return res.status(403).json({
        error: "roster_disabled",
        message: "Roster listing is available for demo tenants only.",
      });
    }

    try {
      const r = await fetch(
        `${aiServiceUrl}/api/guests?tenant=${encodeURIComponent(tenant)}`,
        { headers: headers() }
      );
      const body = await r.text();
      res.status(r.status).type("application/json").send(body);
    } catch (e) {
      console.error(`[proxy] roster failed: ${e.message}`);
      res.status(502).json({ error: "upstream_unavailable" });
    }
  });

  /**
   * Guest context.
   *
   * Note this is still open to anyone who can reach the realtime server — the
   * proxy protects the AI service, it does not authorize the caller. Once tap
   * check-in is live, this route should require a session id issued by
   * /v1/checkin/complete, so a guest card can only be fetched for a guest who
   * just consented. Until then, keep the realtime server's URL out of public
   * pages.
   */
  router.post("/api/guest-context", express.json(), async (req, res) => {
    try {
      const r = await fetch(`${aiServiceUrl}/api/guest-context`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(req.body ?? {}),
      });
      const body = await r.text();
      res.status(r.status).type("application/json").send(body);
    } catch (e) {
      console.error(`[proxy] context failed: ${e.message}`);
      res.status(502).json({ error: "upstream_unavailable" });
    }
  });

  /**
   * What the plugin is allowed to offer.
   *
   * Booleans, from the AI service, with our key attached — the plugin is a
   * static bundle and cannot hold one. It calls this on launch to decide what
   * to draw: no camera button when the retailer has not enabled capture.
   *
   * Drawing is all this decides. The capture endpoint re-reads the flag
   * server-side, so a bundle that ignores this answer gets a 403 rather than a
   * capability the retailer never agreed to.
   */
  router.get("/api/tenant/capabilities", async (req, res) => {
    const tenant = String(req.query.tenant ?? "gap").toLowerCase();
    try {
      const r = await fetch(
        `${aiServiceUrl}/api/tenant/capabilities?tenant=${encodeURIComponent(tenant)}`,
        { headers: headers() }
      );
      const body = await r.text();
      res.status(r.status).type("application/json").send(body);
    } catch (e) {
      console.error(`[proxy] capabilities failed: ${e.message}`);
      res.status(502).json({ error: "upstream_unavailable" });
    }
  });

  /**
   * A floor checkout link, minted with our key attached.
   *
   * Machine call, exactly like guest-context: the plugin is a static bundle
   * that cannot hold the service key, and the AI service is the thing that
   * holds the store's credential and re-reads the tenant's checkout switch.
   * Nothing about the payment passes through here — the response is a URL
   * (the store's own checkout) and an inert QR matrix the phone page draws.
   */
  router.post("/api/checkout-link", express.json(), async (req, res) => {
    try {
      const r = await fetch(`${aiServiceUrl}/api/checkout-link`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(req.body ?? {}),
      });
      const body = await r.text();
      res.status(r.status).type("application/json").send(body);
    } catch (e) {
      console.error(`[proxy] checkout-link failed: ${e.message}`);
      res.status(502).json({ error: "upstream_unavailable" });
    }
  });

  /**
   * One photograph of an object, on its way to the AI service.
   *
   * Its own JSON parser because the body is an image and the global one is
   * capped at 100kb. Its own route rather than a passthrough entry because the
   * passthrough deliberately withholds the service key, and this is a machine
   * call with no human bearer token behind it.
   *
   * The image is relayed and never written here either — no disk, no log line.
   * `console.error` below prints the transport failure and never the body.
   */
  router.post(VISION_PATH, express.json({ limit: VISION_BODY_LIMIT }), async (req, res) => {
    try {
      const r = await fetch(`${aiServiceUrl}${VISION_PATH}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(req.body ?? {}),
      });
      const body = await r.text();
      res.status(r.status).type("application/json").send(body);
    } catch (e) {
      console.error(`[proxy] vision failed: ${e.message}`);
      res.status(502).json({ error: "upstream_unavailable" });
    }
  });

  /**
   * Signed-in-human routes, passed straight through.
   *
   * These carry a *user's* bearer token, and the AI service authorizes them on
   * its own — so this proxy deliberately does NOT attach the service key here.
   * Adding it would turn the realtime server into an open door: any browser
   * could reach tenant data without an account. The key is for machine calls
   * (guest context, voice) where there is no human to authenticate.
   *
   * Everything the dashboard needs therefore lives on one origin, which keeps
   * CORS out of the deployment story entirely.
   */
  const PASSTHROUGH = ["/auth", "/api/analytics", "/api/admin"];

  router.use(async (req, res, next) => {
    if (!PASSTHROUGH.some((p) => req.path === p || req.path.startsWith(p + "/"))) {
      return next();
    }
    try {
      const init = {
        method: req.method,
        headers: {
          "content-type": "application/json",
          // Forward the caller's identity, and nothing of ours.
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        },
      };
      if (!["GET", "HEAD"].includes(req.method)) {
        init.body = JSON.stringify(req.body ?? {});
      }
      const url = new URL(req.originalUrl, aiServiceUrl);
      const r = await fetch(url, init);
      const body = await r.text();
      res.status(r.status).type("application/json").send(body);
    } catch (e) {
      console.error(`[proxy] ${req.path} failed: ${e.message}`);
      res.status(502).json({ error: "upstream_unavailable" });
    }
  });

  return router;
}

/** Header helper for the server's own direct calls (beacon:guest-enter). */
export function aiHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { "x-gapvision-key": apiKey } : {}),
  };
}
