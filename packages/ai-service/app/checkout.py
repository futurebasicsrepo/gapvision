"""Floor checkout — a Shopify-hosted payment link, minted from the lens.

The Path B of `claude/lens-payments.md`: the associate closes the sale where
the conversation is happening, and the *guest's own phone* is the terminal.
No POS app, no card reader, no Cue surface anywhere in the payment path — we
mint a draft order through the store's own credentials and hand back its
`invoiceUrl`, which is Shopify's secure checkout for exactly those lines
(Shop Pay included, the guest's details pre-filled when the draft names them).

What this module deliberately is NOT:

* **Not a payment processor.** No card number, no token, no amount is ever
  charged by Cue. The one write is `draftOrderCreate` — an invoice waiting to
  be paid, the mildest write Shopify has. Payment, receipt, refund and fraud
  all remain the store's checkout's problem, which is the entire point.
* **Not a cart of record.** The lines exist on the draft order in the
  merchant's own store the moment they exist at all. Nothing here is stored
  by Cue beyond the analytics event the caller may choose to write.

Failure posture: a link that could not be minted is an outcome, not a crash —
the associate is mid-conversation, so refusals come back as sentences the
phone page can show. Only a malformed request raises.
"""
from __future__ import annotations

from . import capabilities

#: Bound the request rather than trust it. A floor basket is a handful of
#: items; forty lines is a data-entry error or someone probing the endpoint.
MAX_LINES = 20


class CheckoutRefused(Exception):
    """A refusal with a sentence attached. `status` maps onto HTTP."""

    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail
        super().__init__(detail)


def qr_matrix(url: str) -> list[str] | None:
    """The link as rows of '1'/'0' — the same inert shape Console's device
    QRs use (see `devices.py`): data the page draws rectangles from, never a
    document fragment that arrived over the network. None if segno is
    missing; the URL itself is already in the response and a QR is a
    convenience on top of it.
    """
    try:
        import segno
    except ImportError:  # pragma: no cover - depends on the deployment
        print("[cue] segno is not installed; checkout link without a QR", flush=True)
        return None
    # Error correction 'm', matching the plates and the device QRs — one
    # answer to "how dense is a Cue QR". The phone screen showing this one
    # picks up no scuffs, but consistency costs nothing.
    return ["".join("1" if m else "0" for m in row)
            for row in segno.make(url, error="m").matrix]


def build_link(crm, tenant: str, items: list[dict], *, guest_id: str | None = None,
               note: str | None = None, associate: str | None = None) -> dict:
    """Resolve the floor's lines against the store, mint the link, attach a QR.

    `items` entries, in the caller's vocabulary:
        {"code": "..."}                      — a SKU/barcode; resolved against
                                               the live store via lookup_code
        {"variant_id": "gid://..."}          — already resolved
        {"title": "...", "price": 12.0}      — custom line, the last resort
    each optionally with "qty".

    Lines that cannot be resolved are *reported*, never silently dropped: a
    guest paying for three things because the fourth quietly vanished is a
    worse failure than no link at all — so if nothing resolves, that is a
    refusal, and if some resolve, the skipped ones are named in the response
    and it is the associate's call to proceed.
    """
    slug = (tenant or "gap").lower()
    if not capabilities.checkout_links(slug):
        raise CheckoutRefused(
            403,
            f"Checkout links are switched off for tenant '{slug}' "
            f"(config.checkout_links). A tenant admin turns them back on in "
            f"Console → Tenants.")

    if not isinstance(items, list) or not items:
        raise CheckoutRefused(400, "A checkout needs at least one item.")
    if len(items) > MAX_LINES:
        raise CheckoutRefused(
            400, f"Too many lines for one checkout ({len(items)} > {MAX_LINES}).")

    mint = getattr(crm, "create_checkout_link", None)
    if not callable(mint):
        raise CheckoutRefused(
            501,
            "This tenant's CRM adapter cannot mint checkout links. The "
            "Shopify adapter can; others need a create_checkout_link of "
            "their own.")

    lines: list[dict] = []
    skipped: list[dict] = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        qty = raw.get("qty") or 1
        code = str(raw.get("code") or "").strip()
        if code:
            try:
                hit = crm.lookup_code(code)
            except Exception:
                # "Could not answer" must never read as "not carried" — and
                # here it must never quietly become a line the guest pays a
                # guessed price for.
                hit = None
            if hit and (hit.get("variant_id") or hit.get("price") is not None):
                lines.append({
                    "variant_id": hit.get("variant_id"),
                    "title": hit.get("name") or code,
                    "price": hit.get("price"),
                    "qty": qty,
                })
            else:
                skipped.append({"code": code, "reason": "not found in the store"})
            continue
        if raw.get("variant_id") or (raw.get("title") or raw.get("name")):
            lines.append({
                "variant_id": raw.get("variant_id"),
                "title": raw.get("title") or raw.get("name"),
                "price": raw.get("price"),
                "qty": qty,
            })

    if not lines:
        raise CheckoutRefused(
            422, "None of the items could be resolved against the store — "
                 "no link was created.")

    who = (associate or "").strip()[:80]
    full_note = note or (
        f"Cue floor checkout{' — ' + who if who else ''}")

    try:
        minted = mint(lines, guest_id=guest_id, note=full_note)
    except ValueError as e:
        raise CheckoutRefused(400, str(e))
    except Exception as e:
        # The store said no — scope missing, rate limit, API drift. The
        # sentence goes to the phone page; the associate falls back to the
        # till, which still exists precisely for this.
        raise CheckoutRefused(502, f"The store refused the checkout: {e}")

    return {
        "ok": True,
        "url": minted["url"],
        "qr": qr_matrix(minted["url"]),
        "draft_id": minted.get("draft_id") or "",
        "total": minted.get("total"),
        "currency": minted.get("currency") or "",
        "lines": [
            {"title": l.get("title"), "qty": int(l.get("qty") or 1),
             "resolved": bool(l.get("variant_id"))}
            for l in lines
        ],
        "skipped": skipped,
    }
