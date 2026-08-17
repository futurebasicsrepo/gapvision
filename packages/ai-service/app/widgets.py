"""The deck, as configuration: whose order it is, and what fills a data widget.

Two halves of one idea — what an associate sees on the right-hand side of the
glass should be configuration rather than a build.

── Whose order it is ────────────────────────────────────────────────────────

The widget list lived in the phone's localStorage since it shipped. That is
wrong in the exact case auto-pairing already assumes will happen: somebody
picks up a different pair of glasses and inherits a stranger's layout. Prefs
belong to the person, and the phone's copy becomes an offline fallback rather
than the truth.

── What can plug in without a rebuild, and what cannot ──────────────────────

Kyle, 17 Aug 2026: not every associate needs every widget, and new widgets
should plug in rather than force a rebuild each time.

That is achievable for *some* widgets and it is worth being exact about which,
because the difference decides whether the claim is true or marketing:

  **A widget that renders a titled list of short lines** — promotions, store
  announcements, shift notes, the "other useful information" slot — is data.
  Adding one is a row in `tenant_feeds` with a new `widget` value, plus a
  catalogue entry. **No new package, no Even Hub upload, no version bump for
  every pair in the field.**

  **A widget that writes, or reads a privileged source** — to-do completion,
  clock in/out behind `shift_telemetry` — needs code in the package. Adding
  one is a release.

`FEED_WIDGETS` below is the first list; `promos` is its first member rather
than a special case, which is what makes the plug-and-play property real.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from . import db

#: Widgets whose entire content is rows in `tenant_feeds`. Adding an id here
#: and a renderer entry in the lens catalogue is the whole of a new read-only
#: widget — deliberately, see the module docstring.
FEED_WIDGETS = ("promos",)

#: Widgets the package renders from live engagement data or its own state.
#: Listed so the prefs validator can accept them; they are not feed-backed.
CODE_WIDGETS = ("customer", "inventory", "messaging")

KNOWN_WIDGETS = CODE_WIDGETS + FEED_WIDGETS

#: A promotion is three lines on 576px of monochrome. More than a handful of
#: live ones is a deck nobody scrolls to the end of, and the cap is here rather
#: than in the UI so it holds however the rows arrived.
MAX_LIVE = 8
MAX_LINES = 4
MAX_LINE_CHARS = 60


# --- per-person order ---------------------------------------------------------

def prefs_for(user_id) -> dict:
    """This person's deck, or an empty document meaning "the default"."""
    row = db.query_one("SELECT widget_prefs FROM users WHERE id = %s", (user_id,))
    if not row:
        return {}
    raw = row["widget_prefs"]
    return raw if isinstance(raw, dict) else json.loads(raw or "{}")


def save_prefs(user_id, prefs: dict) -> dict:
    """Store the associate's order, having thrown away everything else.

    The document is `{"order": [...]}` and nothing more — deliberately the same
    shape the package already reads (`widgets.ts` `WidgetPrefs`). **A widget
    being on is encoded as its presence in the order**, so an `enabled` map
    beside it would be a second source of truth for one fact, and the two would
    disagree the first time a client wrote one and not the other.

    Validated rather than trusted: this arrives from a phone and is read by a
    renderer, so an id the lens cannot resolve is a hole in somebody's deck.
    Unknown ids are dropped rather than the document rejected — a package a
    version behind will send one, and refusing everything would lose the
    associate's real preferences over a name we simply do not have yet.

    An empty order is a real answer, not a missing one: it means the associate
    turned every widget off, which the design says leaves the cue — a complete
    product.
    """
    raw = prefs.get("order")
    order = [w for w in raw if w in KNOWN_WIDGETS] if isinstance(raw, list) else []

    # Deduplicate keeping first position: a repeated id renders one widget twice.
    seen, clean = set(), []
    for w in order:
        if w not in seen:
            seen.add(w)
            clean.append(w)

    doc = {"order": clean}
    db.execute("UPDATE users SET widget_prefs = %s WHERE id = %s",
               (json.dumps(doc), user_id))
    return doc


# --- feed-backed widgets ------------------------------------------------------

def _clean_lines(lines) -> list[str]:
    out = []
    for line in (lines or [])[:MAX_LINES]:
        text = str(line).strip()
        if text:
            out.append(text[:MAX_LINE_CHARS])
    return out


def live(tenant_id, widget: str, now: datetime | None = None) -> list[dict]:
    """What this store's widget should show right now.

    The window is applied in SQL rather than in Python because "right now" is
    the server's business and a client that computed it would drift with the
    phone's clock — which on a shop floor is a device somebody set the time on
    by hand.

    A NULL start means "already running" and a NULL end means "until we say
    otherwise". Both are real states; an end date invented to satisfy a NOT
    NULL is a promotion that vanishes on a day nobody chose.
    """
    rows = db.query(
        """
        SELECT id, widget, title, lines, starts_at, ends_at, source, position
          FROM tenant_feeds
         WHERE tenant_id = %s
           AND widget = %s
           AND (starts_at IS NULL OR starts_at <= %s)
           AND (ends_at   IS NULL OR ends_at   >  %s)
      ORDER BY position, created_at
         LIMIT %s
        """,
        (tenant_id, widget, now or datetime.now(timezone.utc),
         now or datetime.now(timezone.utc), MAX_LIVE),
    ) or []
    return [_public(r) for r in rows]


def all_for(tenant_id, widget: str) -> list[dict]:
    """Every row, live or not — the authoring view.

    Separate from `live()` on purpose. An admin editing promotions needs to see
    the one that ended yesterday; a lens must never receive it.
    """
    rows = db.query(
        "SELECT id, widget, title, lines, starts_at, ends_at, source, position "
        "FROM tenant_feeds WHERE tenant_id = %s AND widget = %s "
        "ORDER BY position, created_at",
        (tenant_id, widget),
    ) or []
    return [_public(r) for r in rows]


def _public(row: dict) -> dict:
    lines = row["lines"]
    return {
        "id": str(row["id"]),
        "widget": row["widget"],
        "title": row["title"],
        "lines": lines if isinstance(lines, list) else json.loads(lines or "[]"),
        "starts_at": row.get("starts_at"),
        "ends_at": row.get("ends_at"),
        "source": row.get("source"),
        "position": row.get("position", 0),
    }


def create(tenant_id, *, widget: str, title: str, lines,
           starts_at=None, ends_at=None, source: str = "manual",
           source_ref: str | None = None, position: int = 0) -> dict:
    row = db.query_one(
        """
        INSERT INTO tenant_feeds
            (tenant_id, widget, title, lines, starts_at, ends_at, source,
             source_ref, position)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id, widget, title, lines, starts_at, ends_at, source, position
        """,
        (tenant_id, widget, title.strip()[:120], json.dumps(_clean_lines(lines)),
         starts_at, ends_at, source, source_ref, position),
    )
    return _public(row)


def delete(tenant_id, feed_id) -> bool:
    """Scoped by tenant as well as id.

    An id alone would be enough for the query and not enough for the rule: a
    delete that only matches on a uuid is a delete that reaches another
    retailer's row if one is ever guessed or leaked into the wrong request.
    """
    row = db.query_one(
        "DELETE FROM tenant_feeds WHERE id = %s AND tenant_id = %s RETURNING id",
        (feed_id, tenant_id),
    )
    return row is not None
