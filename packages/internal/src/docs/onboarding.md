<!-- GENERATED — do not edit. Source: docs/onboarding.md. Run `npm run docs:sync`. -->

# Onboarding a retailer

Everything here happens in Cue Console. No terminal, no code, no Railway. If a
step asks you to open something else, it says so.

Two paths, and the difference is one decision made once at the start: **is this
retailer on Shopify?** Steps 1 and 3 onward are identical either way; only
step 2 differs.

---

## Before you start

You need three things from the retailer:

1. **A store name and a short slug** — the slug is lowercase, no spaces, and it
   is permanent. It appears in URLs and in support conversations forever, so
   `gap` rather than `gap-inc-pilot-2026`.
2. **One person who will administer the account.** Their name and work email.
   They become the `client_admin` and can add everyone else themselves.
3. **If they are on Shopify:** an Admin API access token from a custom app in
   their own Shopify admin. What to ask for is in step 2a.

You do not need their customer data. Cue never holds a copy of it.

---

## 1. Create the tenant

**Console → Tenants → Create tenant.**

| Field | What to put |
|---|---|
| Slug | The permanent short name. Lowercase, no spaces. |
| Name | How the retailer writes their own name. |
| CRM adapter | `shopify` if they are on Shopify, `mock` if not — see step 2. |
| Billing plan | `pilot` unless someone has told you otherwise. |

The tenant appears in the table immediately. Click the row to open it — every
remaining step happens inside that panel.

> **Only Cue staff can create tenants or change billing.** A retailer's own
> admin can manage their people, devices and privacy posture, and nothing else.
> That is enforced in the API, not just hidden in the interface.

---

## 2a. Connect Shopify

**Tenant → Connect Shopify.**

Ask the retailer to create a **custom app** in their Shopify admin
(*Settings → Apps and sales channels → Develop apps*) with these Admin API
scopes:

| Scope | Why | Required |
|---|---|---|
| `read_customers` | Who the guest is, their sizes, their history | Yes |
| `read_orders` | What they bought, and when | Yes |
| `read_products` | What is on the floor, and the price | Yes |
| `read_inventory` | Units on hand per size | Recommended |

They install the app in their own store and give you the **Admin API access
token** (it starts `shpat_`). Paste it with the store domain
(`their-store.myshopify.com`) and save.

**Saving tests the connection immediately.** The panel then shows a tick or a
cross per scope, so a token that is missing `read_inventory` tells you that
here rather than three weeks later when an associate asks about a size and gets
"unknown".

Three things worth knowing:

- **The token is write-only.** After saving, nobody — no screen, no Cue
  employee — can read it back. You will see a fingerprint and the key id, which
  is enough to confirm *which* token is stored and nothing more. If a retailer
  loses their copy, they issue a new one; we cannot recover it for them.
- If the panel refuses to accept credentials at all, the encryption key is
  missing from the deployment. That is an engineering problem, not a
  configuration one. Stop and escalate.
- **Re-test after any change on their side.** The panel has a Test connection
  button. A rotated token fails silently from a retailer's point of view — the
  glasses simply stop knowing anything about customers.

## 2b. A retailer who is not on Shopify

Leave the CRM adapter as `mock`.

They will run on demo data — three fictional guests and a fixed product list —
which is enough to train staff, run a pilot on the floor, and show the whole
product working end to end. It is not connected to their real customers, and
you should say so plainly rather than let a demo be mistaken for an
integration.

Connecting them for real means building an adapter for their system. That is
engineering work, not configuration, and it is scoped per retailer. Gap is the
first of these by design. What to tell them: *"the glasses, the voice, the
floor messaging and the dashboards all work today; connecting your own customer
system is a defined piece of work we scope with your team."*

---

## 3. Add their admin

**Tenant → People → Add person.**

Name, work email, role `client_admin`. **Leave the password blank.**

Leaving it blank sends them an invitation: a link that lets them set their own
password. It works once and expires in seven days. Filling in a password
instead means somebody has to tell them what it is, over Slack or out loud,
which is exactly the habit this flow exists to end.

Once they are in, they can add the rest of their own staff — you do not need to
be involved.

Roles, briefly:

| Role | Can |
|---|---|
| `associate` | Wear the glasses. No dashboard at all — the lens is their surface. |
| `manager` | One store: roster, leaderboard, analytics. Read-only on people. |
| `client_admin` | The above, plus people, devices, privacy and their own usage. |

Nobody can create an account more powerful than their own, including you.

If an invitation expires or the address was wrong, fix the address and use
**Resend invite** — do not create a second account.

---

## 4. Hardware

**Tenant → Hardware & terms.**

Glasses register themselves. Have someone put a pair on and open Cue; the
serial appears in the device table within a few seconds. Then assign it to a
person from the dropdown.

**Assign every pair.** Activity from an unassigned pair is still recorded, but
it has no name on it — it will not appear on the leaderboard and a manager
cannot tell who helped a guest. The Health panel flags unassigned devices for
exactly this reason.

Note: **the leaderboard ranks associates only.** A manager wearing glasses
records activity that never shows up in the ranking. That surprises people, so
say it before it does.

---

## 5. Privacy posture

**Tenant → Hardware & terms → Store what was said.**

Off by default. On means the manager dashboard shows the question an associate
asked and the answer Cue gave. Both halves move together, because an answer
quotes the guest's own record back at them and a question without its answer
cannot be judged anyway.

Turn it on for a pilot, where the whole point is reading what the floor
actually asked. Have the conversation before you do — these are recordings of
staff speech, and the retailer's HR view on that matters more than our default.

**Retention** sits beside it. Aged personal data is redacted automatically on
that window: transcripts, answers, the pointer to the customer record, the cue
we showed, the products offered, assist notes. What survives is the shape of
the shift — how many guests, which zone, how long, what it earned — because
that is not personal data and losing it would cost the retailer their reporting
for no privacy gain.

---

## 6. Hand over

Send the admin:

- **Cue Studio — https://app.cuesea.ai** — their dashboard. They will already
  have set a password via the invitation.
- **The lens** — sideloaded onto the glasses via Even Hub, not from an app
  store.
- The tenant slug, if anyone technical on their side will ever ask us anything.

Then check **Health**. Their tenant should read ready, their devices assigned,
and no warnings against their name.

---

## When something is wrong

| Symptom | Look here first |
|---|---|
| "The glasses show no guests" | Is a beacon being fired? On the demo path guests come from the plugin's own roster on the phone, not from Studio. |
| "Voice says it doesn't know" | Connect Shopify → Test connection. A missing `read_inventory` scope answers size questions with "unknown", truthfully and unhelpfully. |
| "Nobody is on the leaderboard" | Devices unassigned, or the people wearing them are managers rather than associates. |
| "The dashboard says transcript not stored" | That is the privacy setting, working. Step 5. |
| "They can't sign in" | Resend the invitation. An account created with a blank password cannot be used until the link is redeemed. |
| Anything reporting a failed check on Health | Escalate. The Health panel only asserts things a feature actually needs; it does not report cosmetic problems. |

---

## What we never do

- **We never ask for a customer list.** Cue holds a pointer to a record in the
  retailer's system and nothing else. There is no screen to browse guests
  because there is no data to browse.
- **We never identify anyone who has not opted in.** No cameras, no face
  matching, at any tier. This is a standing decision and not a configuration
  option.
- **We never read a merchant's token back to them.** If they have lost it, they
  issue a new one.
