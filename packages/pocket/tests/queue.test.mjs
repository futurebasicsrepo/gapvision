/**
 * The offline queue — ordering, survival, overflow, and the PII rule.
 *
 * The last one is the one worth the file. This queue is the only thing in
 * Pocket that is written to disk *and* derived from a live engagement, so it
 * is the only place a customer could end up persisted. `shape()` is what
 * stops that, and a whitelist nobody tests is a whitelist that grows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ActionQueue, shape, MAX_QUEUE, MAX_TEXT } from "../.test-dist/queue.js";

/** A storage double: the queue is constructed with its IO so this runs in node. */
function memoryIO() {
  let value = null;
  return { read: () => value, write: (v) => { value = v; }, peek: () => value };
}

let tick = 0;
const clock = () => `2026-08-17T00:00:${String(tick++).padStart(2, "0")}Z`;

test("a claim carries the request id and nothing else", () => {
  const out = shape("claim", {
    requestId: "req-41f3",
    guestName: "Sarah Chen",
    guest: { name: "Sarah Chen", email: "sarah@example.com" },
    zone: "Denim Wall",
  });
  assert.deepEqual(out, { requestId: "req-41f3" });
});

test("an undeclared key cannot reach disk however it is spelled", () => {
  // The realistic version of this bug is not malice — it is `push('claim',
  // {...request})` where `request` happens to carry the guest card.
  const out = shape("end", { engagementId: "e1", guest: { name: "Dana" }, name: "Dana", cue: {} });
  assert.deepEqual(Object.keys(out), ["engagementId"]);
});

test("a floor message keeps its text, because the associate typed it", () => {
  const out = shape("floor:message", { text: "Anyone got a 32 in the vintage slim?", to: "sock-7" });
  assert.equal(out.text, "Anyone got a 32 in the vintage slim?");
  assert.equal(out.to, "sock-7");
});

test("typed text is bounded, so a stuck key cannot fill the phone", () => {
  const out = shape("floor:message", { text: "x".repeat(5000) });
  assert.equal(out.text.length, MAX_TEXT);
});

test("actions replay in the order they were taken", async () => {
  const q = new ActionQueue(memoryIO(), clock);
  q.push("claim", { requestId: "a" });
  q.push("mark", { sku: "SKU-1", kind: "low" });
  q.push("end", { engagementId: "e1" });

  const seen = [];
  const { sent, left } = await q.flush(async (a) => { seen.push(a.type); return true; });
  assert.deepEqual(seen, ["claim", "mark", "end"],
    "claim-then-end out of order produces a floor state nobody can reason about");
  assert.equal(sent, 3);
  assert.equal(left, 0);
});

test("a failure stops the flush and keeps the rest, head included", async () => {
  const q = new ActionQueue(memoryIO(), clock);
  q.push("claim", { requestId: "a" });
  q.push("end", { engagementId: "e1" });

  const { sent, left } = await q.flush(async () => false);
  assert.equal(sent, 0);
  assert.equal(left, 2, "nothing is dropped just because the network said no");
  assert.equal(q.pending()[0].attempts, 1, "the attempt is counted, so a poison action is visible");
});

test("a send that throws is a failure, not a crash", async () => {
  const q = new ActionQueue(memoryIO(), clock);
  q.push("claim", { requestId: "a" });
  const { sent, left } = await q.flush(async () => { throw new Error("socket closed"); });
  assert.equal(sent, 0);
  assert.equal(left, 1);
});

test("the queue survives the app being swiped away", () => {
  const io = memoryIO();
  const first = new ActionQueue(io, clock);
  first.push("claim", { requestId: "a" });
  first.push("end", { engagementId: "e1" });

  // Same storage, new instance — an app relaunch.
  const second = new ActionQueue(io, clock);
  assert.equal(second.length, 2);
  assert.deepEqual(second.pending().map((a) => a.type), ["claim", "end"]);
});

test("a corrupt queue boots the app rather than bricking it", () => {
  const io = memoryIO();
  io.write("{not json at all");
  const q = new ActionQueue(io, clock);
  assert.equal(q.length, 0, "losing unsent work is bad; a phone that will not start on the floor is worse");
});

test("garbage entries inside a valid array are dropped individually", () => {
  const io = memoryIO();
  io.write(JSON.stringify([
    { id: "1", type: "claim", payload: { requestId: "a" }, at: "x", attempts: 0 },
    { id: "2", type: "not-a-real-action", payload: {}, at: "x", attempts: 0 },
    null,
  ]));
  const q = new ActionQueue(io, clock);
  assert.equal(q.length, 1);
  assert.equal(q.pending()[0].type, "claim");
});

test("overflow drops the oldest and says how many", () => {
  const q = new ActionQueue(memoryIO(), clock);
  for (let i = 0; i < MAX_QUEUE + 5; i++) q.push("claim", { requestId: `r${i}` });
  assert.equal(q.length, MAX_QUEUE);
  assert.equal(q.droppedCount, 5, "fifty unsent actions means something is badly wrong and must be sayable");
  assert.equal(q.pending()[0].payload.requestId, "r5", "the oldest went, not the newest");
});

test("pending() hands out copies, so the UI cannot mutate the queue by rendering it", () => {
  const q = new ActionQueue(memoryIO(), clock);
  q.push("claim", { requestId: "a" });
  const snapshot = q.pending();
  snapshot[0].payload.requestId = "tampered";
  assert.equal(q.pending()[0].payload.requestId, "a");
});

test("what actually lands on disk contains no guest", () => {
  // The end-to-end version of the first two tests: not "shape drops it" but
  // "the bytes written to storage do not contain it".
  const io = memoryIO();
  const q = new ActionQueue(io, clock);
  q.push("claim", { requestId: "req-1", guest: { name: "Sarah Chen", email: "sarah@example.com" } });
  q.push("end", { engagementId: "e1", guestName: "Sarah Chen" });
  const written = io.peek();
  assert.ok(!/Sarah Chen/.test(written), written);
  assert.ok(!/example\.com/.test(written), written);
  assert.ok(/req-1/.test(written), "and the part that is ours is still there");
});
