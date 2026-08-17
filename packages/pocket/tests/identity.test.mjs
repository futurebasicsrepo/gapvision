/**
 * The boot decision — the one that keeps the store off somebody's own phone.
 *
 * This suite is the reason `decideBoot` is a pure function. Every case below
 * is a thing that will actually happen on a shop floor, and none of them is
 * pleasant to reproduce by hand in a browser:
 *
 *   · an admin scans a QR into a new handheld
 *   · an associate opens the app on their own phone and signs in
 *   · somebody forwards the provisioning link to an associate in a text
 *   · a handheld gets a reissued token after a revoke
 *
 * The third is the attack. It is one tap, it looks exactly like the first, and
 * the only thing standing between it and a store credential on a personal
 * handset is the sticky-mode rule tested here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideBoot, mayHoldStoreToken, wipePlan, holdsSummary } from "../.test-dist/identity.js";

const claim = (o = {}) => ({ storedMode: null, urlToken: null, urlTenant: null, ...o });

test("first boot with a provision token becomes a store handheld", () => {
  const d = decideBoot(claim({ urlToken: "abc123", urlTenant: "GAP" }));
  assert.equal(d.mode, "managed");
  assert.equal(d.storeToken, "abc123");
  assert.equal(d.reason, "provisioned");
  assert.equal(d.tenantHint, "gap", "tenant hint is normalised, since the URL is typed by people");
});

test("first boot with no token is somebody's own phone", () => {
  const d = decideBoot(claim());
  assert.equal(d.mode, "personal");
  assert.equal(d.storeToken, null);
  assert.equal(d.reason, "no-token");
});

test("a provisioning link sent to a personal phone is REFUSED, not honoured", () => {
  // The attack, in full: an associate has been using their own phone for a
  // week, somebody texts them a provisioning URL, they tap it. If this returns
  // managed, that handset now authenticates as the shop and will keep doing so
  // after they leave.
  const d = decideBoot(claim({ storedMode: "personal", urlToken: "stolen-or-forwarded" }));
  assert.equal(d.mode, "personal");
  assert.equal(d.storeToken, null);
  assert.equal(d.reason, "refused-token-on-personal",
    "the refusal must be named, so the UI can explain rather than appear to ignore the link");
});

test("a personal phone with no token just stays personal, without a refusal notice", () => {
  const d = decideBoot(claim({ storedMode: "personal" }));
  assert.equal(d.reason, "no-token");
});

test("a store handheld restarting stays managed without needing the token again", () => {
  const d = decideBoot(claim({ storedMode: "managed" }));
  assert.equal(d.mode, "managed");
  assert.equal(d.storeToken, null, "nothing new to store — the stored one still stands");
  assert.equal(d.reason, "already-managed");
});

test("a reissued token on an existing handheld replaces the old one", () => {
  // Revoke-and-reissue is the normal recovery when a handheld goes missing and
  // turns up again. It must work, or the recovery path is a factory reset.
  const d = decideBoot(claim({ storedMode: "managed", urlToken: "reissued" }));
  assert.equal(d.mode, "managed");
  assert.equal(d.storeToken, "reissued");
});

test("whitespace and empty strings are not tokens", () => {
  assert.equal(decideBoot(claim({ urlToken: "   " })).mode, "personal");
  assert.equal(decideBoot(claim({ urlToken: "" })).mode, "personal");
});

test("only a managed device may hold a store token", () => {
  assert.equal(mayHoldStoreToken("managed"), true);
  assert.equal(mayHoldStoreToken("personal"), false);
});

test("signing out of a personal phone destroys everything; a handheld keeps being a handheld", () => {
  const personal = wipePlan("personal");
  assert.equal(personal.session, true);
  assert.equal(personal.caches, true);
  assert.equal(personal.queue, true);

  const managed = wipePlan("managed");
  assert.equal(managed.session, true, "the person still signs out");
  assert.equal(managed.storeToken, false,
    "a handheld that forgot it was provisioned needs an admin to mint a new QR mid-shift");
  assert.equal(managed.queue, false,
    "unsent work belongs to the store on a store device, and survives a shift change");
});

test("a push subscription never outlives a session, on either kind of device", () => {
  // A subscription that survives sign-out means the shop can buzz a phone that
  // has signed out of the shop. On a personal handset that is the whole
  // objection, restated as a notification.
  assert.equal(wipePlan("personal").push, true);
  assert.equal(wipePlan("managed").push, true);
});

test("the app can say, in plain words, what it is holding", () => {
  assert.match(holdsSummary("personal"), /nothing belonging to the store/i);
  assert.match(holdsSummary("managed"), /store device/i);
});
