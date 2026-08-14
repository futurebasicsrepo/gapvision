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

  return router;
}

/** Header helper for the server's own direct calls (beacon:guest-enter). */
export function aiHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { "x-gapvision-key": apiKey } : {}),
  };
}
