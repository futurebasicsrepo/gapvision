/**
 * The durable whitelist — what a phone is allowed to write down.
 *
 * The bug this suite exists to catch has a shape: six months from now, a
 * reconnect feels slow, somebody caches the guest card "just until the socket
 * comes back", and a year of customers is on a handset that ends up on eBay.
 * It will not look like a mistake in review. It will look like a performance
 * fix.
 *
 * Runs in node against a localStorage double, because a policy that can only
 * be checked by driving a browser is a policy that gets checked once.
 */
import test from "node:test";
import assert from "node:assert/strict";

/** Enough of the Storage interface for store.ts, including key()/length. */
class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  key(i) { return [...this.map.keys()][i] ?? null; }
  get length() { return this.map.size; }
}

globalThis.localStorage = new FakeStorage();

const { durable, ephemeral, isDurable, DURABLE_KEYS, refusedWrites, wipeEverything } =
  await import("../.test-dist/store.js");

test("the declared keys are the ones the app actually needs", () => {
  for (const k of ["mode", "store_token", "session", "tenant", "queue"]) {
    assert.ok(isDurable(k), `${k} must be writable or the app cannot work`);
  }
});

test("nothing guest-shaped is on the whitelist", () => {
  // Not a lookup — an assertion about the whole list, so a key added later
  // with a guest-shaped name trips this without anybody remembering to.
  for (const k of Object.keys(DURABLE_KEYS)) {
    assert.doesNotMatch(k, /guest|customer|cue|card|cart|payload|name(?!s$)/i,
      `"${k}" looks like it is about a person; guests live in memory`);
  }
});

test("an undeclared key is refused, and the refusal is recorded", () => {
  const before = refusedWrites().length;
  assert.equal(durable.set("guest_card", JSON.stringify({ name: "Sarah Chen" })), false);
  assert.equal(localStorage.getItem("cue.pocket.guest_card"), null);
  assert.equal(refusedWrites().length, before + 1);
});

test("a refused write does not throw, because a caching mistake must not end an engagement", () => {
  assert.doesNotThrow(() => durable.set("anything_at_all", "x"));
});

test("a declared key round-trips", () => {
  durable.set("mode", "personal");
  assert.equal(durable.get("mode"), "personal");
});

test("clearAll removes every key, not every other one", () => {
  // Removing while enumerating reindexes Storage and silently leaves half
  // behind — which is a wipe that reports success and is not one.
  durable.set("mode", "personal");
  durable.set("session", "s");
  durable.set("tenant", "gap");
  durable.set("queue", "[]");
  durable.set("who", "Sam");
  localStorage.setItem("unrelated.app.key", "keep me");

  durable.clearAll();

  for (const k of ["mode", "session", "tenant", "queue", "who"]) {
    assert.equal(durable.get(k), null, `${k} survived the wipe`);
  }
  assert.equal(localStorage.getItem("unrelated.app.key"), "keep me",
    "and another app's storage on the same origin is not ours to delete");
});

test("guests live in memory and die with it", () => {
  ephemeral.set("payload", { guest: { name: "Sarah Chen" } });
  assert.equal(ephemeral.get("payload").guest.name, "Sarah Chen");
  ephemeral.clear();
  assert.equal(ephemeral.get("payload"), undefined);
});

test("wipeEverything clears storage and memory even with no Cache Storage present", async () => {
  durable.set("session", "s");
  ephemeral.set("payload", { guest: { name: "Dana" } });
  // `caches` is undefined in node, which is also true of a browser without a
  // secure context — the wipe must complete rather than throw past the rest.
  await wipeEverything();
  assert.equal(durable.get("session"), null);
  assert.equal(ephemeral.size, 0);
});
