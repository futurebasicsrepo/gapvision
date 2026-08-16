/**
 * Associate preferences — defaults, decoding, and the line between a store's
 * permission and a person's choice.
 *
 *   node packages/glasses-plugin/test/prefs.test.mjs
 *
 * This file covers the preferences *as data*; `prefs-browser.mjs` covers the
 * same four as rendered controls on the phone page. "Hidden in the list" and
 * "not on the page" are different claims and neither test is allowed to be the
 * only one — the same split the capability gate already has.
 *
 * The rule with the sharpest edge, and the reason for most of what is below:
 * **a preference is not a capability.** `capabilities` says what the store
 * permits; a preference says what this associate wants inside that. A
 * preference whose capability is false is not shown and does not take effect —
 * but it resolves to its *default*, not to off, because `voice` and
 * `floor_comms` are deliberately unenforced (see `main.ts`) and resolving them
 * to off would switch two shipped features off for every tenant alive to
 * honour a flag none of them have set.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "dist-test", "prefs.mjs");
await build({
  entryPoints: [join(here, "..", "src", "prefs.ts")],
  bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "error",
});
const P = await import(`file://${out}`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const ALL_ON = { camera_capture: true, voice: true, floor_comms: true };
const ALL_OFF = { camera_capture: false, voice: false, floor_comms: false };

// --- defaults ---------------------------------------------------------------

{
  const gap = P.defaultPrefs("gap");
  const shopify = P.defaultPrefs("shopify");
  check("the defaults are today's behaviour",
    gap.floorComms === "everything" && gap.voice === true && gap.railPoints === true,
    JSON.stringify(gap));
  check("the zone defaults to the tenant's own, and is no longer a constant",
    gap.zone === "Denim Wall" && shopify.zone === "Front Table",
    `${gap.zone} / ${shopify.zone}`);
}

// --- an empty store ---------------------------------------------------------
// The state every associate is in the first time they open this page.

{
  const empty = { getLocalStorage: async () => null, setLocalStorage: async () => true };
  const loaded = await P.loadPrefs(empty, "gap");
  check("an empty store loads the defaults",
    JSON.stringify(loaded) === JSON.stringify(P.defaultPrefs("gap")),
    JSON.stringify(loaded));
}

{
  // A host that throws rather than answering is the same as an empty one: an
  // associate on defaults, which is the page they had before any of this.
  const broken = {
    getLocalStorage: async () => { throw new Error("no storage"); },
    setLocalStorage: async () => false,
  };
  const loaded = await P.loadPrefs(broken, "shopify");
  check("a store that throws loads the defaults rather than failing the page",
    JSON.stringify(loaded) === JSON.stringify(P.defaultPrefs("shopify")),
    JSON.stringify(loaded));
}

// --- round trip -------------------------------------------------------------

{
  const store = new Map();
  const bridge = {
    getLocalStorage: async (k) => (store.has(k) ? store.get(k) : null),
    setLocalStorage: async (k, v) => { store.set(k, v); return true; },
  };
  await P.savePref(bridge, "zone", "Fitting Rooms");
  await P.savePref(bridge, "floorComms", "urgent");
  await P.savePref(bridge, "voice", false);
  await P.savePref(bridge, "railPoints", false);
  const loaded = await P.loadPrefs(bridge, "gap");
  check("what was written is what comes back",
    loaded.zone === "Fitting Rooms" && loaded.floorComms === "urgent" &&
    loaded.voice === false && loaded.railPoints === false,
    JSON.stringify(loaded));

  check("each preference is its own key, so one failed write cannot take another",
    new Set(store.keys()).size === 4 &&
    [...store.keys()].every((k) => k.startsWith(P.STORAGE_PREFIX)),
    [...store.keys()].join(", "));

  // The session-resume key lives in sessionStorage and is not a preference;
  // a prefix collision would have one clearing the other.
  check("preference keys cannot collide with the session key",
    ![...store.keys()].includes("cue.session"), [...store.keys()].join(", "));
}

{
  const bridge = { getLocalStorage: async () => null, setLocalStorage: async () => false };
  check("a refused write is reported as refused, not swallowed",
    (await P.savePref(bridge, "voice", false)) === false);
  const throws = {
    getLocalStorage: async () => null,
    setLocalStorage: async () => { throw new Error("host gone"); },
  };
  check("a write that throws is reported as a failure too",
    (await P.savePref(throws, "voice", false)) === false);
}

// --- decoding what a store hands back ---------------------------------------
// Anything unrecognised is not a decision anybody made, so it falls back to the
// default rather than to off.

for (const [raw, expected] of [
  ["on", true], ["off", false], ["true", true], ["1", true], ["", true],
  [null, true], ["ON", true], ["nonsense", true],
]) {
  const got = P.decodePref("voice", raw, "gap");
  // "true"/"1"/"ON"/"nonsense" are all unrecognised, and the default is on, so
  // they all read as on — the assertion is that nothing garbled reads as off.
  check(`voice stored as ${JSON.stringify(raw)} decodes to ${expected}`,
    got === expected, String(got));
}

check("only the three written floor-comms values survive a round trip",
  P.decodePref("floorComms", "urgent", "gap") === "urgent" &&
  P.decodePref("floorComms", "off", "gap") === "off" &&
  P.decodePref("floorComms", "everything", "gap") === "everything" &&
  P.decodePref("floorComms", "URGENT", "gap") === "everything" &&
  P.decodePref("floorComms", "sometimes", "gap") === "everything");

check("an empty zone is the tenant default, never an empty string",
  P.decodePref("zone", "   ", "gap") === "Denim Wall" &&
  P.normaliseZone("", "shopify") === "Front Table" &&
  P.normaliseZone("  Fitting   Rooms  ", "gap") === "Fitting Rooms");

check("a zone is capped rather than stored unbounded",
  P.normaliseZone("x".repeat(400), "gap").length === P.MAX_ZONE_CHARS);

// --- capability is not preference -------------------------------------------

check("a preference whose capability is false is not shown at all",
  !P.visiblePrefs({ ...ALL_ON, floor_comms: false }).includes("floorComms") &&
  !P.visiblePrefs({ ...ALL_ON, voice: false }).includes("voice"),
  JSON.stringify(P.visiblePrefs({ ...ALL_ON, floor_comms: false })));

check("the preferences with no capability behind them are always shown",
  P.visiblePrefs(ALL_OFF).join(",") === "zone,railPoints",
  P.visiblePrefs(ALL_OFF).join(","));

check("unknown is not a yes: no capabilities means no gated control",
  P.visiblePrefs(null).join(",") === "zone,railPoints" &&
  P.visiblePrefs(undefined).join(",") === "zone,railPoints",
  P.visiblePrefs(null).join(","));

check("the enforced capability has no preference to argue with it",
  !P.PREF_KEYS.some((k) => P.PREF_CAPABILITY[k] === "camera_capture"),
  JSON.stringify(P.PREF_CAPABILITY));

{
  const stored = { zone: "Fitting Rooms", floorComms: "off", voice: false, railPoints: false };
  const withCaps = P.effectivePrefs(stored, ALL_ON, "gap");
  check("with the capability on, the associate's choice is what takes effect",
    withCaps.voice === false && withCaps.floorComms === "off",
    JSON.stringify(withCaps));

  const denied = P.effectivePrefs(stored, ALL_OFF, "gap");
  // The point of this one: NOT off. `voice` and `floor_comms` are unenforced by
  // standing decision, every tenant reads false today, and resolving a hidden
  // preference to off would take voice away from all of them.
  check("a hidden preference falls back to its default, not to off",
    denied.voice === true && denied.floorComms === "everything",
    JSON.stringify(denied));

  check("a hidden preference cannot be turned on by the associate either — it is not on the page",
    P.visiblePrefs(ALL_OFF).includes("voice") === false);

  check("the ungated preferences are untouched by any capability",
    denied.zone === "Fitting Rooms" && denied.railPoints === false,
    JSON.stringify(denied));

  check("before the capabilities land, the stored values are in force",
    P.effectivePrefs(stored, null, "gap").voice === false,
    JSON.stringify(P.effectivePrefs(stored, null, "gap")));

  check("what is stored is never rewritten by a capability — only what is in force",
    stored.voice === false && stored.floorComms === "off");
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
