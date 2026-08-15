/**
 * The public front door.
 *
 *   node packages/server/test/presence-door.mjs
 *
 * `POST /api/presence` is the one presence route open to the whole internet:
 * a guest taps a plate, their browser opens a page, and that page — which
 * cannot hold the service key, because nothing in a browser ever does — posts
 * here.
 *
 * Which makes the `source` field the interesting part. The AI service derives
 * `consent` from the source and refuses to take it from the caller, and
 * `tests/test_presence.py` proves that. But that guarantee is only worth as
 * much as the source itself: an open route that accepts any source lets a
 * stranger with curl mint `device`-class consent — the strongest provenance
 * we store — by typing `app-beacon`. So the assertions here are all negative,
 * and they are about which doors a browser is allowed to *claim*.
 *
 * Starts its own server on an unused port. No AI service required: the
 * rejections happen before any ingest call, and an allowed door failing to
 * reach the control plane (502) is itself the proof it got past the guard.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = process.env.TEST_PORT || 4124;
const URL = `http://localhost:${PORT}`;
const SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js"
);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), AI_SERVICE_URL: "http://127.0.0.1:9" },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
child.stdout.on("data", (b) => serverLog.push(String(b)));
child.stderr.on("data", (b) => serverLog.push(String(b)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = async (body) => {
  const res = await fetch(`${URL}/api/presence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function main() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${URL}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }

  // --- the doors a plate actually is ----------------------------------------
  for (const source of ["nfc-plate", "qr-plate"]) {
    const r = await post({ tenant: "t_doors", guest_ref: "g1", zone: "Floor", source });
    check(`${source} is a public door`, r.status !== 400,
      `${r.status} ${JSON.stringify(r.body)}`);
  }

  // --- the doors it is not ---------------------------------------------------
  //
  // Each of these exists in the registry and each carries a consent class a
  // browser has no standing to assert. `app-beacon` is the one that matters:
  // it is the only silent door in the system, and it is silent precisely
  // because a standing opt-in stands behind it.
  for (const [source, why] of [
    ["app-beacon", "device consent, asserted by a stranger"],
    ["wallet-pass", "same"],
    ["bopis", "a commitment we would be inventing"],
    ["appointment", "same"],
    ["pos-lookup", "the till is not a browser"],
    ["associate-assisted", "nobody asked anybody"],
    ["demo", "demo traffic must not arrive from the internet"],
  ]) {
    const r = await post({ tenant: "t_doors", guest_ref: "g2", source });
    check(`${source} is refused (${why})`, r.status === 400,
      `${r.status} ${JSON.stringify(r.body)}`);
  }

  // A source nobody has ever heard of must be refused here, not passed
  // through for the AI service to reject — the browser should not be able to
  // probe the registry.
  const unknown = await post({ tenant: "t_doors", guest_ref: "g3", source: "nfc_plate" });
  check("a typo is refused at the edge", unknown.status === 400,
    `${unknown.status} ${JSON.stringify(unknown.body)}`);

  // --- and the ordinary guard ------------------------------------------------
  const noRef = await post({ tenant: "t_doors", zone: "Floor", source: "qr-plate" });
  check("a check-in with nobody in it is refused", noRef.status === 400,
    JSON.stringify(noRef.body));

  // --- the way out ----------------------------------------------------------
  //
  // Open, like the check-in it undoes, and it must not require the caller to
  // name a door: a guest tapping Stop is ending their visit, not describing
  // how it began.
  const revoke = await (await fetch(`${URL}/api/presence/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant: "t_doors", guest_ref: "g1" }),
  })).json().catch(() => ({}));
  check("revoke is reachable without a service key",
    !("error" in revoke) || revoke.error === "Could not revoke",
    JSON.stringify(revoke));

  const revokeNobody = await fetch(`${URL}/api/presence/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant: "t_doors" }),
  });
  check("revoking nobody is refused", revokeNobody.status === 400);

  // The rejection must not leak the rest of the registry to a caller probing
  // it — it names what they sent, and nothing else.
  const leak = await post({ tenant: "t_doors", guest_ref: "g4", source: "app-beacon" });
  check("the refusal names no other door",
    !JSON.stringify(leak.body).includes("wallet-pass"),
    JSON.stringify(leak.body));
}

try {
  await main();
} catch (e) {
  check("suite ran", false, String(e.message || e));
  console.error(serverLog.join(""));
} finally {
  child.kill("SIGTERM");
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
