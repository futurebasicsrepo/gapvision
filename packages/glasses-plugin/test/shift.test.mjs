/**
 * The offline buffer, and the timestamp that makes it worth having.
 *
 *   node packages/glasses-plugin/test/shift.test.mjs
 *
 * Shop wifi drops. Before this, socket events were fired into a closed
 * connection and lost — and a dashboard then reported something that did not
 * happen. The buffer fixes that, and it can only fix it if every buffered
 * event carries **the time it occurred**, not the time it was finally
 * delivered. A shift that ended at 17:58 and reached the server at 09:04 the
 * next morning is a shift that ended at 17:58; reporting the delivery time
 * would make the buffer worse than losing the event, because a wrong number
 * looks like a real one.
 *
 * The three things here that will rot silently if nobody holds them down:
 *
 *   1. A replayed event keeps its original stamp. This is the whole feature,
 *      and it is one line of code away from being wrong in a way nothing
 *      visibly breaks.
 *   2. A heartbeat is never buffered. Its entire content is "I am here now",
 *      and a stale one delivered an hour later is a lie about the only thing
 *      it claims — and the lie would keep a dead phone's shift open, which is
 *      the exact failure the heartbeat exists to prevent.
 *   3. The buffer survives the app being torn down. On this host the WebView
 *      is destroyed every time the phone goes in a pocket, so the end of a
 *      shift is *usually* an event that has to outlive the page that fired it.
 *
 * No DOM, no bridge, no socket: the controller takes its emit, its clock and
 * its storage as dependencies, so all of this runs in node.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "dist-test", "shift.mjs");
await build({
  entryPoints: [join(here, "..", "src", "shift.ts")],
  bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "error",
});
const S = await import(`file://${out}`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/**
 * A phone: a key-value store that survives a "reload", a socket that can be
 * unplugged, and a clock the test moves by hand.
 */
function phone({ connected = true, refuseWrites = false, store = new Map() } = {}) {
  const p = {
    sent: [],
    connected,
    clock: Date.parse("2026-08-16T09:00:00.000Z"),
    store,
    timers: [],
  };
  p.deps = {
    emit: (event, payload) => p.sent.push({ event, payload }),
    connected: () => p.connected,
    store: {
      get: async (k) => (p.store.has(k) ? p.store.get(k) : null),
      set: async (k, v) => {
        if (refuseWrites) return false;
        p.store.set(k, v);
        return true;
      },
    },
    serial: "G2-TEST-0001",
    model: "g2",
    zone: () => "Denim Wall",
    now: () => p.clock,
    setInterval: (fn, ms) => { p.timers.push({ fn, ms }); return p.timers.length - 1; },
    clearInterval: (h) => { if (p.timers[h]) p.timers[h] = null; },
  };
  p.tick = (ms) => { p.clock += ms; };
  p.beat = () => p.timers.filter(Boolean).forEach((t) => t.fn());
  p.controller = () => new S.ShiftController(p.deps);
  return p;
}

const STATE_OPEN = {
  open: true, shift_id: "shift-abc", started_at: "2026-08-16T09:00:00.000Z",
  heartbeat_seconds: 60,
};

// --- a live shift ------------------------------------------------------------

{
  const p = phone();
  const c = p.controller();
  await c.open();
  const start = p.sent.find((s) => s.event === "shift:start");
  check("opening a shift sends a start with the time it happened",
    !!start && start.payload.occurredAt === "2026-08-16T09:00:00.000Z",
    JSON.stringify(start));
  check("the start carries the zone read at send time, not at construction",
    start?.payload.zone === "Denim Wall", JSON.stringify(start?.payload));
  check("nothing is buffered while the socket is up", c.pending.length === 0);

  await c.onState(STATE_OPEN);
  check("the shift id is remembered so a teardown does not become nine shifts",
    c.current === "shift-abc" && p.store.get(S.SHIFT_KEY) === "shift-abc",
    `${c.current} / ${p.store.get(S.SHIFT_KEY)}`);
}

// --- the heartbeat -----------------------------------------------------------

{
  const p = phone();
  const c = p.controller();
  await c.open();
  await c.onState(STATE_OPEN);
  p.sent.length = 0;

  p.beat();
  check("a heartbeat is sent while the socket is up",
    p.sent.filter((s) => s.event === "shift:heartbeat").length === 1,
    JSON.stringify(p.sent));

  // The wifi goes. This is the case that matters: a heartbeat buffered now and
  // replayed in an hour would keep a dead phone's shift open, which is the
  // exact thing the heartbeat exists to prevent.
  p.connected = false;
  p.sent.length = 0;
  p.beat();
  p.beat();
  check("a heartbeat is never sent while offline", p.sent.length === 0,
    JSON.stringify(p.sent));
  check("and a heartbeat is never buffered either", c.pending.length === 0,
    JSON.stringify(c.pending));
  check("the buffer allowlist does not include heartbeats",
    !S.BUFFERABLE.has("shift:heartbeat"), [...S.BUFFERABLE].join(","));
}

// --- offline, and the timestamp ----------------------------------------------

{
  const p = phone();
  const c = p.controller();
  await c.open();
  await c.onState(STATE_OPEN);

  // 17:58. The wifi has been gone for a while and the app is being torn down.
  p.connected = false;
  p.clock = Date.parse("2026-08-16T17:58:00.000Z");
  p.sent.length = 0;
  await c.close("app_closed");

  check("an end fired offline is buffered rather than lost",
    p.sent.length === 0 && c.pending.length === 1,
    JSON.stringify({ sent: p.sent, pending: c.pending }));
  check("the buffered end carries the moment it happened",
    c.pending[0].occurredAt === "2026-08-16T17:58:00.000Z",
    JSON.stringify(c.pending[0]));
  check("the buffer is written to the phone, not just held in the page",
    JSON.parse(p.store.get(S.QUEUE_KEY))[0].occurredAt === "2026-08-16T17:58:00.000Z",
    p.store.get(S.QUEUE_KEY));

  // The app is destroyed and reopened the next morning on the store's wifi.
  // A *new* controller reads the same phone.
  const morning = phone({ store: p.store });
  morning.clock = Date.parse("2026-08-17T09:04:00.000Z");
  const c2 = morning.controller();
  await c2.onConnect();

  const replay = morning.sent.find((s) => s.event === "telemetry:replay");
  check("the buffer survives the app being torn down and is replayed",
    !!replay && replay.payload.events.length === 1, JSON.stringify(replay));
  check("THE REPLAYED EVENT KEEPS ITS ORIGINAL TIMESTAMP",
    replay?.payload.events[0].occurredAt === "2026-08-16T17:58:00.000Z",
    `got ${replay?.payload.events[0].occurredAt}, delivered at 2026-08-17T09:04:00.000Z`);
  check("the replayed end still says it was an end",
    replay?.payload.events[0].event === "shift:end",
    JSON.stringify(replay?.payload.events[0]));

  // The live start that follows it is stamped now, not backdated. Both stamps
  // in one flush is the case that catches a shared "occurredAt" variable.
  const start = morning.sent.find((s) => s.event === "shift:start");
  check("the live start alongside a replay is stamped now, not backdated",
    start?.payload.occurredAt === "2026-08-17T09:04:00.000Z",
    JSON.stringify(start?.payload));
}

// --- the queue is only cleared on acknowledgement ----------------------------

{
  const p = phone({ connected: false });
  const c = p.controller();
  await c.close("app_closed");          // nothing open yet — no event
  await c.onState(STATE_OPEN);
  p.connected = false;
  await c.onStatus({ serial: "G2-TEST-0001", connection: "connected", batteryPercent: 44 });
  check("a status fired offline is buffered", c.pending.length === 1,
    JSON.stringify(c.pending));

  p.connected = true;
  await c.onConnect();
  check("a flush does not clear the buffer on its own", c.pending.length === 1,
    "a send into a socket that then drops has not been delivered");

  await c.onReplayed(1);
  check("the buffer is cleared once the server says it took it",
    c.pending.length === 0 && JSON.parse(p.store.get(S.QUEUE_KEY)).length === 0,
    p.store.get(S.QUEUE_KEY));
}

// --- the buffer is bounded ---------------------------------------------------

{
  const p = phone({ connected: false });
  const c = p.controller();
  await c.onState(STATE_OPEN);
  p.connected = false;
  for (let i = 0; i < S.MAX_QUEUED + 15; i++) {
    p.tick(60_000);
    await c.onStatus({
      serial: "G2-TEST-0001", connection: "connected", batteryPercent: 100 - i,
    });
  }
  check("the buffer is capped", c.pending.length === S.MAX_QUEUED,
    `${c.pending.length} / ${S.MAX_QUEUED}`);
  check("and it drops the oldest, so the end of a shift outlives a stale battery reading",
    c.pending[c.pending.length - 1].payload.batteryPercent === 100 - (S.MAX_QUEUED + 14),
    JSON.stringify(c.pending[c.pending.length - 1].payload));
}

// --- device status filtering -------------------------------------------------

{
  const p = phone();
  const c = p.controller();
  await c.onState(STATE_OPEN);
  p.sent.length = 0;

  const status = { serial: "G2-TEST-0001", connection: "connected", batteryPercent: 61 };
  await c.onStatus(status);
  await c.onStatus({ ...status });
  check("an unchanged status is not sent twice",
    p.sent.filter((s) => s.event === "device:health").length === 1,
    JSON.stringify(p.sent));

  await c.onStatus({ ...status, batteryPercent: 60 });
  check("a battery that moved by one point is sent — 21 to 19 is the whole point",
    p.sent.filter((s) => s.event === "device:health").length === 2);

  await c.onStatus({ ...status, batteryPercent: 60, connection: "disconnected" });
  check("a connection change is sent even with the battery unchanged",
    p.sent.filter((s) => s.event === "device:health").length === 3);

  p.sent.length = 0;
  p.tick(S.STATUS_REPEAT_MS + 1000);
  await c.onStatus({ ...status, batteryPercent: 60, connection: "disconnected" });
  check("an unchanged status still repeats eventually, so a quiet pair proves it is alive",
    p.sent.length === 1, JSON.stringify(p.sent));

  await c.onStatus({ serial: "", connection: "connected", batteryPercent: 50 });
  check("a status with no serial is dropped — it is a status about nothing",
    p.sent.filter((s) => s.event === "device:health").length === 1);

  // Zero is the most important battery level there is, and the one every
  // optional-field guard gets wrong.
  p.sent.length = 0;
  await c.onStatus({ serial: "G2-TEST-0001", connection: "connected", batteryPercent: 0 });
  check("a battery of zero is a reading, not an absence",
    p.sent[0]?.payload.batteryPercent === 0, JSON.stringify(p.sent[0]?.payload));
}

// --- the store says no -------------------------------------------------------

{
  const p = phone();
  const c = p.controller();
  await c.open();
  await c.onState(STATE_OPEN);
  p.sent.length = 0;

  // A 403: the retailer has this off after all, and this bundle's copy of the
  // capability was stale. Retrying would mean hammering a store's own network
  // to deliver records that store has explicitly declined.
  await c.onState({ open: false, ok: false, stop: true, reason: "telemetry_off" });
  check("a stop disables the controller", c.disabled === true);

  p.connected = false;
  await c.close("app_closed");
  await c.onStatus({ serial: "G2-TEST-0001", connection: "connected", batteryPercent: 30 });
  await c.open();
  check("a stopped controller sends nothing and buffers nothing",
    p.sent.length === 0 && c.pending.length === 0,
    JSON.stringify({ sent: p.sent, pending: c.pending }));
  check("and it forgets the shift it was on",
    c.current === null && (p.store.get(S.SHIFT_KEY) || "") === "");
}

// --- a phone that refuses to store anything ----------------------------------

{
  // Private-mode-equivalent: the host takes no writes. The buffer then lives
  // only as long as this WebView, which is worth saying and is not worth
  // crashing over — an associate mid-shift must not lose the product because
  // a diagnostic could not be filed.
  const p = phone({ refuseWrites: true, connected: false });
  const c = p.controller();
  const said = [];
  p.deps.log = (m) => said.push(m);
  await c.onState(STATE_OPEN);
  await c.onStatus({ serial: "G2-TEST-0001", connection: "connected", batteryPercent: 12 });
  check("a refused write does not throw and the event is still queued in memory",
    c.pending.length === 1, JSON.stringify(c.pending));
  check("and the refusal is said out loud rather than silently swallowed",
    said.some((m) => m.includes("refused")), said.join(" | "));
}

// --- what the associate is told ----------------------------------------------

{
  const notice = S.TELEMETRY_NOTICE;
  check("the notice says this is on", /\bON\b/.test(notice), notice);
  check("the notice says whose decision it is", /STORE/.test(notice), notice);
  check("the notice names what is recorded — hours and battery",
    /START AND STOP/.test(notice) && /BATTERY/.test(notice), notice);
  check("the notice is short enough to read on a phone in one line of mono",
    notice.length <= 96, `${notice.length} chars`);
}

// --- a garbled store ---------------------------------------------------------

{
  const store = new Map([
    [S.QUEUE_KEY, "{not json at all"],
    [S.SHIFT_KEY, "shift-from-yesterday"],
  ]);
  const p = phone({ store, connected: true });
  const c = p.controller();
  await c.onConnect();
  check("an unreadable buffer costs the buffer and not the shift",
    c.pending.length === 0 &&
    p.sent.some((s) => s.event === "shift:start" &&
                       s.payload.resumeShiftId === "shift-from-yesterday"),
    JSON.stringify(p.sent));
}

{
  // An event nobody should be able to buffer. The replay path dispatches
  // through the socket's own handlers server-side, so a queue that accepted
  // `radio:send` would be a way to put a message on somebody else's glasses
  // with a timestamp of the sender's choosing.
  const store = new Map([[S.QUEUE_KEY, JSON.stringify([
    { event: "radio:send", payload: { message: "NEED BACKUP" }, occurredAt: "2026-08-16T09:00:00.000Z" },
    { event: "shift:end", payload: { reason: "app_closed" }, occurredAt: "2026-08-16T17:58:00.000Z" },
  ])]]);
  const p = phone({ store, connected: true });
  const c = p.controller();
  await c.load();
  check("a buffered event outside the allowlist is dropped on load",
    c.pending.length === 1 && c.pending[0].event === "shift:end",
    JSON.stringify(c.pending));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
