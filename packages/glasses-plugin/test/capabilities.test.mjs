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
import { getTextWidth } from "@evenrealities/pretext";
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
const { RAIL_LINE_PX, GLASS_CHARS } = await import(`file://${layoutOut}`);

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

// --- shift telemetry -------------------------------------------------------
//
// The same gate as the camera, guarding a different kind of data: this one is
// about the *associate*, not the guest. A store that has not switched it on
// must not have its staff measured because a fetch timed out, and the sentence
// the associate reads on their own phone page is built from this flag — so a
// wrong answer here is either surveillance nobody agreed to or a notice that
// claims something untrue about the person reading it.
for (const [name, impl] of Object.entries(closed)) {
  const caps = await V.fetchCapabilities("http://x", "gap", impl);
  check(`shift telemetry fails closed when ${name}`,
    caps.shift_telemetry === false, JSON.stringify(caps));
}

{
  const caps = await V.fetchCapabilities("http://x", "gap",
    jsonOk({ camera_capture: true, voice: true, floor_comms: true }));
  check("a service that reports every other flag but not this one reads as off",
    caps.shift_telemetry === false, JSON.stringify(caps));
}

{
  const caps = await V.fetchCapabilities("http://x", "gap",
    jsonOk({ shift_telemetry: "true" }));
  check("a string is not a yes for shift telemetry either",
    caps.shift_telemetry === false, JSON.stringify(caps));
}

{
  const caps = await V.fetchCapabilities("http://x", "gap",
    jsonOk({ shift_telemetry: true, camera_capture: false, voice: true, floor_comms: true }));
  check("the two privacy switches are independent — measuring staff is not opening a camera",
    caps.shift_telemetry === true && caps.camera_capture === false,
    JSON.stringify(caps));
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

const ON = { camera_capture: true, shift_telemetry: true, voice: true, floor_comms: true };
const OFF = { camera_capture: false, shift_telemetry: false, voice: true, floor_comms: true };

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
  V.captureControls(ON).every((c) => /^Scan a (tag or barcode|part)$/.test(c.label)),
  JSON.stringify(V.captureControls(ON).map((c) => c.label)));

// --- which failure, not "something went wrong" ------------------------------

const reasons = ["cancelled", "unsupported", "capture-failed", "forbidden",
                 "too-large", "unrecognised", "unreachable", "service-error"];
const sentences = reasons.map((r) => V.failureCue(r, "9 MB").join(" | "));
check("every failure has its own sentence",
  new Set(sentences).size === reasons.length,
  `${new Set(sentences).size}/${reasons.length} distinct`);

// `RAIL_LINE_PX` is the module column beside the fact rail, which is where a
// scan's answer lands during an engagement. A sentence that overruns it is
// clipped by the glass and reads as broken hardware. Measured against the
// font's own metrics, and taken from the geometry rather than written down —
// it used to be a character count, and a character count cannot describe a
// proportional font.
const tooLong = reasons.flatMap((r) =>
  V.failureCue(r, "9 MB")
    .filter((l) => getTextWidth(l) > RAIL_LINE_PX)
    .map((l) => `${r}: ${l} (${getTextWidth(l)}px)`));
check("every failure sentence fits beside the rail", tooLong.length === 0,
  tooLong.join(", ") || `all within ${RAIL_LINE_PX}px`);

// Anything outside the charset is stripped on the way out, so a sentence
// written with an apostrophe arrives with a hole in it. The charset is derived
// from the font's own tables now, so this asks the real set rather than a
// literal copied into a third file.
const offCharset = reasons.flatMap((r) =>
  V.failureCue(r, "9 MB").filter((l) => [...l].some((c) => !GLASS_CHARS.includes(c))));
check("every failure sentence is in the glass charset", offCharset.length === 0,
  offCharset.join(", ") || "clean");

check("only the tenant-permission failure sends anyone to a manager",
  V.failureCue("forbidden").join(" ").includes("MANAGER") &&
  reasons.filter((r) => V.failureCue(r, "x").join(" ").includes("MANAGER")).length === 1);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
