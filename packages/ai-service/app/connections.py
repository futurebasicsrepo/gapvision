"""Everything a store is plugged into, in one answer.

Two halves, because a retailer's IT director asks two questions and they are
not the same question:

  **Systems** — where the answers come from. Shopify today; a flat-file feed,
  Lightspeed, Square, Salesforce and the enterprise stacks are the roadmap.
  This half decides whether the product can say anything true at all.

  **Peripherals** — where the answers show up. Two kinds of glasses, a phone,
  and a browser tab. This half decides who sees it.

── The rule this module keeps ────────────────────────────────────────────────

**A connector that is not built says so, in the same list, in the same words.**

The ordinary version of an integrations page is a wall of logos with Connect
buttons, most of which open a form that files a feature request. That page is a
lie told at the exact moment a buyer is deciding whether to trust the product,
and it is the most expensive possible moment to be caught.

So every entry carries a `state` from a fixed vocabulary, and the states that
mean something other than "on" are distinct because they send a merchant to
different next actions:

    connected   this tenant is on it now, with a live credential
    available   built and working; connect it from this screen today
    external    built, but connecting it happens somewhere else — the POS tile
                is deployed to a merchant's own till with the Shopify CLI, so
                there is no button here and there should not be one
    planned     we know exactly what it takes and it is not built. The entry
                says what it would give you and what it would cost us.
    exploring   researched, no decision. Named so it is not mistaken for the
                one above.

`available` may only be claimed by something in `crm_credentials.PROVIDERS` —
that is, by an adapter that actually exists. The registry below cannot lie
about that, because `_state_of` reads the tuple rather than the entry.
"""
from __future__ import annotations

from . import crm_credentials, db, devices

#: What a system gives us, and what it costs, said once.
#:
#: `gives` is deliberately in a merchant's words rather than ours: "who is at
#: the till" is a thing a store manager wants; "a subscribable Cart API hook"
#: is a thing we implement. The second belongs in the design docs.
SYSTEMS = (
    {
        "id": "shopify",
        "name": "Shopify",
        "kind": "commerce",
        "gives": ["Guest records and loyalty", "Order history", "Live stock by location",
                  "Barcode and SKU lookup"],
        "note": "The full adapter: guests, orders, inventory and code lookup.",
    },
    {
        "id": "shopify-pos",
        "name": "Shopify POS — Cue tile",
        "kind": "commerce",
        "gives": ["The guest attached to the till's cart in one tap",
                  "Their cart lines, loaded",
                  "The associate and engagement stamped onto the sale"],
        # Built — `packages/pos-app`. It reached what
        # claude/shopify-pos-what-it-gives-us.md argued was the strongest
        # reason: attribution stops being inferred from timing and becomes a
        # property written onto the cart.
        #
        # `external` rather than `available` because connecting it is not an
        # act available on this screen: the merchant links and deploys the
        # extension against their own custom app with the Shopify CLI. Calling
        # it "ready to connect" here would send an admin looking for a button
        # that is not and should not be on this page.
        "note": "Built. The merchant deploys the tile to their own POS with "
                "the Shopify CLI — see packages/pos-app. It verifies each till "
                "against the client secret stored with this store's Shopify "
                "connection, so it needs a client ID + secret connection "
                "rather than an admin token.",
        "state": "external",
    },
    {
        "id": "feed",
        "name": "Your own feed (CSV or SFTP)",
        "kind": "feed",
        "gives": ["Inventory from a nightly export", "Guest records, if you export them"],
        "note": "The widest item on the roadmap and the cheapest: any retailer "
                "who can export inventory becomes a candidate without waiting "
                "on their IT roadmap. Needs a mapping screen and a staleness "
                "indicator — a nightly file must never be shown as live.",
        "state": "planned",
    },
    {
        "id": "salesforce",
        "name": "Salesforce",
        "kind": "crm",
        "gives": ["Guest records and history from Service or Commerce Cloud"],
        "note": "Same three-method adapter as Shopify. The work is the auth "
                "(connected app, refresh tokens) and the object mapping, which "
                "differs per org — so this is a build against a signed "
                "customer's instance rather than a generic connector.",
        "state": "exploring",
    },
    {
        "id": "lightspeed",
        "name": "Lightspeed Retail",
        "kind": "commerce",
        "gives": ["Guest records", "Order history", "Stock counts"],
        "note": "Documented API, SMB-heavy, the same shape as Shopify.",
        "state": "planned",
    },
    {
        "id": "square",
        "name": "Square",
        "kind": "commerce",
        "gives": ["Guest records", "Order history", "Stock counts"],
        "note": "As Lightspeed: documented, similar effort.",
        "state": "planned",
    },
    {
        "id": "custom",
        "name": "Something else",
        "kind": "custom",
        "gives": ["Whatever the adapter returns"],
        "note": "The adapter contract is three methods — all_guests, get_guest, "
                "floor_inventory — and nothing above that seam knows which "
                "backend a store is on. If you have an endpoint, this is days "
                "rather than a quarter.",
        "state": "exploring",
    },
)

#: Where an answer shows up. Mirrors `devices.SURFACES` plus what each one is,
#: in the words a retailer would use.
PERIPHERALS = (
    {
        "id": "even-g2",
        "name": "Even G2 glasses",
        "kind": "glasses",
        "note": "Sideloaded plugin, paired by QR. Monochrome, in the line of sight.",
    },
    {
        "id": "mrbd",
        "name": "Meta Ray-Ban Display",
        "kind": "glasses",
        "note": "A web app on the glasses themselves. Colour, driven by the "
                "Neural Band. No microphone available to us on this hardware.",
    },
    {
        "id": "phone",
        "name": "Store phone or handheld",
        "kind": "mobile",
        "note": "A device the store owns, paired by QR. An associate's own "
                "phone is not one of these — they sign in with their own "
                "account, and disabling them in People ends it everywhere.",
    },
    {
        "id": "sim",
        "name": "Browser tab",
        "kind": "simulator",
        "note": "For training and demos. Badged, and excluded from analytics.",
    },
)

STATES = ("connected", "available", "external", "planned", "exploring")

#: The only states a registry entry is allowed to ask for.
#:
#: `connected` and `available` are *earned* — from a credential row and from
#: the adapter tuple respectively. A literal in the registry cannot claim
#: either, which is the whole mechanism: somebody adding a hopeful
#: `"state": "available"` to the Salesforce entry — an easy edit that reads as
#: documentation — must not thereby ship a Connect button for a backend with
#: no adapter behind it.
#:
#: `external` is declarable because it makes no claim this screen could be
#: wrong about: it says the thing is built and that connecting it happens
#: somewhere else. The POS tile is the case — the merchant links and deploys
#: it against their own custom app with the Shopify CLI, so calling it "ready
#: to connect" would send an admin hunting for a button that is not and should
#: not be here.
DECLARABLE = ("external", "planned", "exploring")


def _state_of(entry: dict, connected_ids: set[str]) -> str:
    """The one place a state is decided.

    Read from the code rather than from the registry. `connected` comes from a
    credential row; `available` requires an adapter in
    `crm_credentials.PROVIDERS`. Everything else falls back to what the
    registry declared, and the registry may only declare a flavour of "not
    yet".
    """
    if entry["id"] in connected_ids:
        return "connected"
    if entry["id"] in crm_credentials.PROVIDERS:
        return "available"
    declared = entry.get("state", "planned")
    return declared if declared in DECLARABLE else "planned"


def systems_for(tenant_id) -> list[dict]:
    """Every system, with this tenant's live state on the ones it is using."""
    row = crm_credentials.get_row(tenant_id)
    described = crm_credentials.describe(row)
    connected_ids = {described["provider"]} if described.get("connected") else set()

    out = []
    for entry in SYSTEMS:
        state = _state_of(entry, connected_ids)
        item = {**entry, "state": state}
        if entry["id"] == "shopify-pos":
            # A live, per-tenant fact rather than a general note, and the most
            # useful thing this row can say.
            #
            # The POS tile verifies each till by checking a Shopify session
            # token against the client secret stored with *this* store's
            # connection (`app/pos.py`). A store connected with a legacy admin
            # token has no secret on file, so the tile is refused — and the
            # place that is discoverable today is a 503 at the till, during a
            # sale, in front of a customer. Said here instead.
            kind = described.get("auth_kind") if described.get("connected") else None
            item["ready"] = kind == "client_credentials"
            item["blocked_by"] = (
                None if item["ready"]
                else "This store has no Shopify connection yet."
                if kind is None
                else "This store is connected with an admin token, which carries no "
                     "client secret. Reconnect with a client ID and secret before "
                     "deploying the tile, or every till will be refused."
            )

        if state == "connected":
            # Only the connected one carries live detail, and only the shape
            # `describe()` allows out — no secret has ever crossed this
            # boundary and this is not the place to start.
            item["detail"] = described.get("store_domain")
            item["last_tested_at"] = described.get("last_tested_at")
            item["last_test_ok"] = described.get("last_test_ok")
            item["last_test_detail"] = described.get("last_test_detail")
            item["missing_required_scopes"] = described.get("missing_required_scopes") or []
            item["degraded_without"] = described.get("degraded_without") or {}
        out.append(item)
    return out


def peripherals_for(tenant_id) -> list[dict]:
    """Every surface, with how many of them this tenant actually has.

    Counted from `devices`, not from a config flag, because the question a
    manager is really asking is "is anything of this kind answering" — and a
    surface that is configured and silent is the failure worth seeing.
    """
    rows = db.query(
        """
        SELECT surface,
               count(*)                                              AS total,
               count(*) FILTER (WHERE revoked_at IS NOT NULL)        AS revoked,
               count(*) FILTER (WHERE revoked_at IS NULL
                                  AND last_seen_at > now() - interval '10 minutes')
                                                                     AS active,
               max(last_seen_at)                                     AS last_seen
          FROM devices
         WHERE tenant_id = %s
      GROUP BY surface
        """,
        (tenant_id,),
    ) or []
    by_surface = {r["surface"]: r for r in rows}

    out = []
    for entry in PERIPHERALS:
        r = by_surface.get(entry["id"])
        total = int(r["total"]) if r else 0
        revoked = int(r["revoked"]) if r else 0
        out.append({
            **entry,
            "devices": total - revoked,
            "revoked": revoked,
            "active": int(r["active"]) if r else 0,
            "last_seen": r["last_seen"] if r else None,
            # "none set up" and "set up and silent" are different sentences and
            # only one of them is a fault. Same rule as empty-versus-unreachable
            # in the answer engine.
            "state": "connected" if total - revoked > 0 else "available",
        })
    return out


def summary(systems: list[dict], peripherals: list[dict]) -> dict:
    """The one line at the top of the panel.

    `answering` is the number that matters: a store with a connected system and
    nothing on the floor is a store where nobody is being helped, and that is
    invisible if the panel only counts connections.
    """
    return {
        "systems_connected": sum(1 for s in systems if s["state"] == "connected"),
        "systems_available": sum(1 for s in systems if s["state"] == "available"),
        "devices": sum(p["devices"] for p in peripherals),
        "answering": sum(p["active"] for p in peripherals),
    }
