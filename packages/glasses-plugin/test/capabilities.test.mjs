/**
 * The capability gate, and the sentences behind it.
 *
 *   node packages/glasses-plugin/test/capabilities.test.mjs
 *
 * One rule this file exists to hold down: **the camera affordance must not
 * exist when the store has not turned the camera on.** Not greyed out, not
 * refused on press — absent. An associate who can see a control their store
 * declined will press it, and then either it works (wrong) or it doesn't
 * (a support call about a feature they were never sold).
 *
 * The failure that makes this worth a test is the quiet one: a capabilities
 * fetch that 404s, times out, or answers with something that isn't JSON. If
 * any of those read as "on", every tenant who never configured the flag gets a
 * camera control. So the fetch is asserted to fail *closed* for each of them
 * separately, rather than trusting one happy-path check.
 *
 * The affordance moved from the floor menu to the phone page — the trigger is
 * a card on the page, the readout is still the glass. So this file covers the
 * gate *as data*, in all three states, and `vision-browser.mjs` covers the
 * same three states as rendered DOM. "Not in the list" and "not on the page"
 * are different claims and only the second is what an associate sees; neither
 * test is allowed to be the only one.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const visionOut = join(here, "..", "dist-test", "vision.mjs");
const layoutOut = join(here, "..", "dist-test", "layout.mjs");
await build({
  entryPoints: [join(here, "..", "src", "vision.ts")],
  bundle: true, format: "esm", platform: "neutral", outfile: visionOut, logLevel: "error",
});
await build({
  entryPoints: [join(here, "..", "src", "layout.ts")],
  bundle: true, format: "esm", external: ["./bridge"], outfile: layoutOut, logLevel: "error",
});
const V = await import(`file://${visionOut}`);
// `layout.mjs` is built here rather than only used here: `page-shape.test.mjs`
// imports it from `dist-test`, so dropping this build would break that suite
// from a change that looks unrelated.
const { RAIL_LINE_CHARS } = await import(`file://${layoutOut}`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** A fetch that answers exactly once, however we need it to. */
const fetchOf = (impl) => async (url) => impl(url);
const jsonOk = (body) => fetchOf(async () => ({
  ok: true, status: 200, json: async () => body,
}));

// --- the fetch itself ------------------------------------------------------

{
  const caps = await V.fetchCapabilities("http://x", "gap",
    jsonOk({ camera_capture: true, voice: true, floor_comms: true }));
  check("a tenant with the camera on reads as on", caps.camera_capture === true,
    JSON.stringify(caps));
}

{
  const caps = await V.fetchCapabilities("http://x", "gap",
    jsonOk({ camera_capture: false, voice: true, floor_comms: true }));
  check("a tenant with the camera off reads as off", caps.camera_capture === false,
    JSON.stringify(caps));
}

// Every way this can go wrong must land on the same answer: everything off.
const closed = {
  "the fetch rejects (no server, no wifi)":
    fetchOf(async () => { throw new Error("ECONNREFUSED"); }),
  "the endpoint is not there yet (404)":
    fetchOf(async () => ({ ok: false, status: 404, json: async () => ({}) })),
  "the server errors (500)":
    fetchOf(async () => ({ ok: false, status: 500, json: async () => ({}) })),
  "the body is not JSON":
    fetchOf(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })),
  "the body is null":
    jsonOk(null),
  "the flag is missing":
    jsonOk({ voice: true }),
  // The one a permissive parser gets wrong: a string is not a yes.
  "the flag is the string 'false'":
    jsonOk({ camera_capture: "false" }),
  "the flag is the string 'true'":
    jsonOk({ camera_capture: "true" }),
};
for (const [name, impl] of Object.entries(closed)) {
  const caps = await V.fetchCapabilities("http://x", "gap", impl);
  check(`fails closed when ${name}`, caps.camera_capture === false, JSON.stringify(caps));
}

{
  const caps = await V.fetchCapabilities("http://x", "gap",
    jsonOk({ camera_capture: true }));
  check("an absent voice flag does not read as on", caps.voice === false, JSON.stringify(caps));
}

{
  // The tenant reaches the server as a query parameter, and a slug with a
  // space or a slash in it must not become a different URL.
  let seen = "";
  await V.fetchCapabilities("http://x", "gap demo/1",
    fetchOf(async (url) => { seen = url; return { ok: true, status: 200, json: async () => ({}) }; }));
  check("the tenant is encoded into the query",
    seen === "http://x/api/tenant/capabilities?tenant=gap%20demo%2F1", seen);
}

// --- the affordance --------------------------------------------------------

const ON = { camera_capture: true, voice: true, floor_comms: true };
const OFF = { camera_capture: false, voice: true, floor_comms: true };

check("the affordance is present when the flag is true",
  V.captureControls(ON).length === 2 &&
  V.captureControls(ON).every((i) => i.label && (i.kind === "sku" || i.kind === "part")),
  JSON.stringify(V.captureControls(ON)));

check("the affordance offers a tag and a part, which the service needs told apart",
  V.captureControls(ON).map((c) => c.kind).join(",") === "sku,part",
  JSON.stringify(V.captureControls(ON).map((c) => c.kind)));

check("the affordance is absent when the flag is false",
  V.captureControls(OFF).length === 0,
  JSON.stringify(V.captureControls(OFF)));

check("the affordance is absent when the fetch failed",
  V.captureControls(V.NO_CAPABILITIES).length === 0 &&
  V.captureControls(await V.fetchCapabilities("http://x", "gap",
    fetchOf(async () => { throw new Error("down"); }))).length === 0);

check("the affordance is absent when capabilities never arrived at all",
  V.captureControls(undefined).length === 0 &&
  V.captureControls(null).length === 0 &&
  V.captureControls({}).length === 0);

// --- written for the page it now lives on ----------------------------------
// The trigger used to be two rows in the floor menu, written in glass grammar:
// uppercase, no punctuation, twenty-one characters. It is a button on the
// phone now, and a button a person presses is sentence case in the sans face.
// A label that drifts back to SHOUTING is the visible sign the control has
// drifted back toward a surface that has no buttons.
check("the control labels are written for a page, not for the glass",
  V.captureControls(ON).every((c) => /^Scan a (tag|part)$/.test(c.label)),
  JSON.stringify(V.captureControls(ON).map((c) => c.label)));

// --- which failure, not "something went wrong" ------------------------------

const reasons = ["cancelled", "unsupported", "capture-failed", "forbidden",
                 "too-large", "unrecognised", "unreachable", "service-error"];
const sentences = reasons.map((r) => V.failureCue(r, "9 MB").join(" | "));
check("every failure has its own sentence",
  new Set(sentences).size === reasons.length,
  `${new Set(sentences).size}/${reasons.length} distinct`);

// `RAIL_LINE_CHARS` is what a line holds beside the fact rail, which is where
// a scan's answer lands during an engagement. A sentence that clips there
// reads as broken hardware. Taken from the geometry rather than written down
// as a number, so it moves when `CHAR_ASPECT` or `ROW_H` does.
const tooLong = reasons.flatMap((r) =>
  V.failureCue(r, "9 MB").filter((l) => l.length > RAIL_LINE_CHARS).map((l) => `${r}: ${l}`));
check("every failure sentence fits beside the rail", tooLong.length === 0,
  tooLong.join(", ") || `all within ${RAIL_LINE_CHARS}`);

// The glass charset is [A-Z0-9 ·%$£€/+-]; anything else is stripped on the way
// out, so a sentence written with an apostrophe arrives with a hole in it.
const offCharset = reasons.flatMap((r) =>
  V.failureCue(r, "9 MB").filter((l) => /[^A-Z0-9 ·%$£€/+-]/.test(l)));
check("every failure sentence is in the glass charset", offCharset.length === 0,
  offCharset.join(", ") || "clean");

check("only the tenant-permission failure sends anyone to a manager",
  V.failureCue("forbidden").join(" ").includes("MANAGER") &&
  reasons.filter((r) => V.failureCue(r, "x").join(" ").includes("MANAGER")).length === 1);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
