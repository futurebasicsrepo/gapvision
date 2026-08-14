/**
 * Gesture decoder tests.
 *
 * The decoder is written from the SDK's protobuf enums, not from observed
 * hardware, so the risk it carries is a payload shape we didn't anticipate.
 * These cases cover every variant the host is documented to send: PB ordinals,
 * full enum names, shorthand, lowercase, protoName keys, and camelCase — plus
 * the things that must NOT decode as gestures (audio, IMU, junk).
 *
 *   node packages/glasses-plugin/test/gestures.test.mjs
 */
import { build } from "esbuild";
import { writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";

const OUT = new URL("./.gestures.bundle.mjs", import.meta.url).pathname;
await build({
  entryPoints: [new URL("../src/gestures.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: OUT,
  logLevel: "error",
});
const { decodeGesture, decodeAction, decodeSource, describeGesture } = await import(
  pathToFileURL(OUT).href
);

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}\n        expected ${e}\n        actual   ${a}`);
  }
}

const g = (event) => {
  const d = decodeGesture(event);
  return d ? { action: d.action, source: d.source, kind: d.kind } : undefined;
};

// --- the mapping that matters on the floor --------------------------------
check("ring click", g({ sysEvent: { eventType: 0, eventSource: 2 } }),
  { action: "click", source: "ring", kind: "sys" });
check("ring double-click (the voice trigger)",
  g({ sysEvent: { eventType: 3, eventSource: 2 } }),
  { action: "double-click", source: "ring", kind: "sys" });
check("ring scroll up", g({ sysEvent: { eventType: 1, eventSource: 2 } }),
  { action: "scroll-up", source: "ring", kind: "sys" });
check("ring scroll down", g({ sysEvent: { eventType: 2, eventSource: 2 } }),
  { action: "scroll-down", source: "ring", kind: "sys" });
check("right temple click", g({ sysEvent: { eventType: 0, eventSource: 1 } }),
  { action: "click", source: "glasses-right", kind: "sys" });
check("left temple double", g({ sysEvent: { eventType: 3, eventSource: 3 } }),
  { action: "double-click", source: "glasses-left", kind: "sys" });

// --- every spelling the Flutter host might use -----------------------------
check("full enum name", g({ sysEvent: { eventType: "DOUBLE_CLICK_EVENT", eventSource: "TOUCH_EVENT_FROM_RING" } }),
  { action: "double-click", source: "ring", kind: "sys" });
check("shorthand", g({ sysEvent: { eventType: "DOUBLE_CLICK", eventSource: "RING" } }),
  { action: "double-click", source: "ring", kind: "sys" });
check("lowercase", g({ sysEvent: { eventType: "scroll_bottom", eventSource: "ring" } }),
  { action: "scroll-down", source: "ring", kind: "sys" });
check("protoName keys", g({ sysEvent: { Event_Type: 0, EventSource: 2 } }),
  { action: "click", source: "ring", kind: "sys" });
check("numeric strings", g({ sysEvent: { eventType: "3", eventSource: "2" } }),
  { action: "double-click", source: "ring", kind: "sys" });

// --- container events (no EventSource field) -------------------------------
check("text container tap",
  g({ textEvent: { Container_ID: 1, Container_Name: "line-1", Event_Type: "CLICK_EVENT" } }),
  { action: "click", source: "unknown", kind: "text" });
check("list container double",
  g({ listEvent: { containerID: 2, eventType: 3 } }),
  { action: "double-click", source: "unknown", kind: "list" });

const listDetail = decodeGesture({
  listEvent: { Container_ID: 2, Container_Name: "recs", CurrentSelect_ItemIndex: 4, Event_Type: 0 },
});
check("list detail carried through",
  { id: listDetail.containerId, name: listDetail.containerName, idx: listDetail.itemIndex },
  { id: 2, name: "recs", idx: 4 });

// --- things that must NOT decode as gestures -------------------------------
check("audio chunk", g({ audioEvent: { audioPcm: new Uint8Array(4) } }), undefined);
check("IMU report is not a gesture",
  g({ sysEvent: { eventType: 8, eventSource: 1, imuData: { x: 1, y: 2, z: 3 } } }), undefined);
check("unknown event type", g({ sysEvent: { eventType: "SOMETHING_NEW", eventSource: 2 } }), undefined);
check("empty envelope", g({}), undefined);
check("null", g(null), undefined);
check("garbage", g({ sysEvent: { nope: true } }), undefined);

// --- lifecycle events ------------------------------------------------------
check("foreground exit", g({ sysEvent: { eventType: 5, eventSource: 0 } }),
  { action: "foreground-exit", source: "unknown", kind: "sys" });
check("system exit", g({ sysEvent: { eventType: 7 } }),
  { action: "exit", source: "unknown", kind: "sys" });

// --- helpers ---------------------------------------------------------------
check("decodeAction direct", decodeAction({ eventType: 1 }), "scroll-up");
check("decodeSource direct", decodeSource({ eventSource: 2 }), "ring");
check("decodeSource missing", decodeSource({}), "unknown");
check("describeGesture",
  describeGesture(decodeGesture({ sysEvent: { eventType: 3, eventSource: 2 } })),
  "double-click (ring)");

// --- mock path still works -------------------------------------------------
check("mock gesture passthrough", g({ mockGesture: "click", mockSource: "ring" }),
  { action: "click", source: "ring", kind: "mock" });

unlinkSync(OUT);
console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length) {
  console.log("failed: " + failures.join(", "));
  process.exit(1);
}
