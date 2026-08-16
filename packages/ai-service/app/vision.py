"""Photograph a thing, get a cue back.

    from app import vision
    vision.analyze(tenant="gap", kind="sku", image_base64=..., mime="image/jpeg",
                   note=None, crm=crm)   # -> {"lines": [...], "meta": [...]}

The G2 has no camera and that is a standing decision. The *phone* running the
plugin does, and the Even SDK hands it to us (`captureImageFromCamera` /
`pickImageFromAlbum`), so an associate can point it at a SKU tag or a broken
part and read the answer in the glass.

**Objects. Never people.**
--------------------------
This capture path is for a swing tag, a barcode, a serial plate, a snapped
bracket. It is not for a face, and there is nothing here that could become
one: no face detection, no person matching, no "who is this customer" — not
now and not as a follow-up. The provider prompt refuses a photograph whose
subject is a person and this module turns that refusal into a cue that says so.
The boundary is written here, in the Console copy and in the plugin's camera
permission description, because the standing camera-free, opt-in-only,
never-passive-matching decision is what gets this product into stores, and a
rule that lives in one person's memory is a rule that quietly moves.

**The image is never stored.**
------------------------------
Not to disk, not to the database, not in a log line, not in an analytics row.
It arrives as base64 in a request body, is passed once to the vision provider,
and goes out of scope with the request. Nothing in this module opens a file or
takes a database connection, and nothing prints the payload. This is the most
sensitive thing the service touches and the defence is that there is nothing
to find: an image that is never written cannot leak.

**A SKU answer comes from records, not from the model.**
--------------------------------------------------------
The model reads characters off a tag. That is all it is trusted to do. The
code it read is looked up in the floor inventory we actually hold, and the
price, location and count on the glass come from that record. If the code
matches nothing, the answer is that it matches nothing — which is a real
answer an associate can act on, and is the only honest one. The standing rule
is that answers are grounded in records we hold and never a model's guess
about stock; a vision path that prints a price the model thought it saw breaks
the most important promise in the product.

And "we hold no inventory records" is kept distinct from "we don't carry it".
`crm.floor_inventory()` is called bare elsewhere in this service, so an empty
feed and a floor that carries nothing are indistinguishable there — a live
store whose product query failed would tell an associate, confidently, that a
jean in their hand is not carried. This module refuses to make that mistake:
no records means we say we cannot confirm.
"""
from __future__ import annotations

import base64
import binascii
import re

from . import barcode as barcode_reader
from . import cue as cue_format
from .llm import VisionUnsupported, get_provider

#: What a capture can be about. `sku` resolves against inventory; `part` is a
#: field-service identification, which nothing on the floor can confirm.
KINDS = ("sku", "part")

#: Formats a phone actually produces and a vision model actually reads. HEIC is
#: absent on purpose: iOS converts on export through the SDK, and accepting a
#: container we cannot decode means a failure the associate can do nothing about.
ALLOWED_MIME = ("image/jpeg", "image/png", "image/webp")

#: 3 MB of image, decoded.
#:
#: A swing tag or a serial plate is legible at 1600px on the long edge, which
#: is a 200–600 KB JPEG; 3 MB leaves room for a 4000px capture of a part in bad
#: light. What it does not leave room for is the 12 MP original a phone hands
#: you if nobody downscales it, and that is the point — the client is expected
#: to resize before upload, and a limit that quietly accepts the unresized
#: version is a limit that trains nobody. Uploading four megabytes over shop
#: wifi also costs the associate the seconds this feature exists to save.
MAX_IMAGE_BYTES = 3 * 1024 * 1024

#: Base64 inflates by 4/3. Checked against the string *before* decoding, so a
#: caller who posts a 40 MB payload is refused without materialising it.
MAX_BASE64_CHARS = (MAX_IMAGE_BYTES + 2) // 3 * 4


class VisionRefused(Exception):
    """A capture this endpoint will not process, and why.

    Carries the HTTP status the route should return. Deliberately not an
    `HTTPException`: everything below is testable without a web framework, and
    the translation happens in exactly one place in `main.py`.
    """

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


#: Asked of the model, per kind. Short, because the system prompt in `llm.py`
#: carries the rules (objects only, no invented facts, NONE when unreadable).
QUESTIONS = {
    "sku": ("Read the product identifier on this tag or label — the SKU, style "
            "number or barcode digits. Reply with that code alone."),
    "part": ("Name the object or part in this photograph in one short phrase, "
             "plus any model or serial number printed on it."),
}

#: The model's two reserved replies.
NO_READING = "NONE"
NOT_AN_OBJECT = "NO_SUBJECT"


def analyze(*, tenant: str, kind: str, image_base64: str, mime: str,
            note: str | None, crm, zone: str | None = None) -> dict:
    """One photograph in, one cue out.

    Returns exactly what `cue.build` produces — `{"lines": [...], "meta": [...]}`
    — plus a few scalars the lens ignores, so this renders through the existing
    lens path with no new card type.

    `zone` is where the associate is standing (their own preference, sent by
    the plugin). It is used for one thing: the direction line — `KNITWEAR →
    DENIM WALL` beats `DENIM WALL` when you are not already there. Optional,
    never stored, never matched against anything.
    """
    kind = (kind or "").strip().lower()
    if kind not in KINDS:
        raise VisionRefused(400, f"kind must be one of: {', '.join(KINDS)}")

    mime = (mime or "").strip().lower()
    if mime not in ALLOWED_MIME:
        raise VisionRefused(
            415, f"'{mime or 'unset'}' is not a supported image type. Send one "
                 f"of: {', '.join(ALLOWED_MIME)}.")

    payload, raw = _checked_payload(image_base64)
    provider = get_provider()

    # A barcode in frame settles the SKU question without a model: the
    # decoder is exact, local, free and cannot hallucinate. The model is the
    # fallback for tags a decoder cannot read — washed-out print, a
    # handwritten style number, a care label. The raw bytes go out of scope
    # right after this; they are never written anywhere.
    if kind == "sku":
        codes = barcode_reader.decode(raw)
        del raw
        if codes:
            return _sku_answer(tenant, "zxing", codes[0], crm,
                               source="BARCODE", zone=zone)
    else:
        del raw

    question = QUESTIONS[kind]
    if note:
        # Spoken context, clipped. It reaches the model as part of the question
        # and is not retained here any more than the image is.
        question = f"{question} The person taking it said: {str(note)[:200]}"

    try:
        reading = (provider.read_image(payload, mime, question) or "").strip()
    except VisionUnsupported as e:
        # An operator problem, not an associate problem: name the env var.
        raise VisionRefused(503, str(e))
    except Exception as e:
        # A model outage must not read as broken hardware. The associate
        # pressed a button and is looking at the glass, so the glass says what
        # happened — same posture as the voice path.
        return _out(kind, tenant, provider.name, grounded=False, sku=None,
                    lines=["COULD NOT READ IT", "TRY AGAIN IN A MOMENT"],
                    meta=[_short_reason(e)])

    if reading.upper().startswith(NOT_AN_OBJECT):
        # The boundary, as behaviour rather than as a comment.
        return _out(kind, tenant, provider.name, grounded=False, sku=None,
                    lines=["PHOTOGRAPH THE ITEM", "NOT PEOPLE"],
                    meta=["OBJECTS"])

    if kind == "sku":
        return _sku_answer(tenant, provider.name, reading, crm,
                           source="TAG READ", zone=zone)
    return _part_answer(tenant, provider.name, reading, crm)


# --- the payload -------------------------------------------------------------

def _checked_payload(image_base64: str) -> tuple[str, bytes]:
    """The base64 string and its decoded bytes, or a refusal.

    The bytes are returned so the barcode decoder can read them; they still
    never outlive the request — `analyze` drops them the moment the decode
    attempt is done, and nothing on any path writes or logs them.
    """
    payload = (image_base64 or "").strip()
    if not payload:
        raise VisionRefused(400, "image_base64 is required")

    if len(payload) > MAX_BASE64_CHARS:
        raise VisionRefused(413, _too_big(len(payload) * 3 // 4))

    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise VisionRefused(400, "image_base64 is not valid base64")

    if len(raw) > MAX_IMAGE_BYTES:
        raise VisionRefused(413, _too_big(len(raw)))
    if len(raw) < 1024:
        raise VisionRefused(400, "That image is too small to read anything from.")
    return payload, raw


def _too_big(size: int) -> str:
    return (f"Image is {size / 1_048_576:.1f} MB; the limit is "
            f"{MAX_IMAGE_BYTES / 1_048_576:.0f} MB. Capture or resize to about "
            f"1600px on the long edge — a SKU tag reads fine at that size and "
            f"uploads in a fraction of the time.")


def _short_reason(e: Exception) -> str:
    return cue_format.glassify(type(e).__name__, cue_format.FACT_CHARS)


# --- SKU: grounded in what the floor actually holds ---------------------------

def _sku_answer(tenant: str, provider_name: str, reading: str, crm,
                source: str = "TAG READ", zone: str | None = None) -> dict:
    """A code — decoded or read — resolved against records, with a direction.

    `source` names how the code was obtained, and it goes in the meta strip
    because it changes what a wrong answer means: `BARCODE` is exact (a miss
    means the store has no record), `TAG READ` is a model's transcription (a
    miss may mean it misread). An associate deciding whether to rescan or to
    walk to the POS needs that distinction more than any other fact here.
    """
    code = _identifier(reading) if source != "BARCODE" else (reading or "").strip().upper()

    if not code:
        return _out("sku", tenant, provider_name, grounded=False, sku=None,
                    lines=["NO CODE READ", "MOVE CLOSER AND RETRY"], meta=[])

    # Direct lookup first — exact, by SKU or barcode, against the live store.
    # `looked` distinguishes "the adapter answered nothing" from "the adapter
    # has no such method / could not answer", because those end differently:
    # a live store that answered nothing is a real miss; an adapter that
    # errored must not report the product as not carried.
    item, looked = _lookup(crm, code)

    if item is None and not looked:
        items, have_records = _floor(crm)
        if not have_records:
            # Empty and "not carried" are not the same claim, and this is the
            # one place the difference is load-bearing: an associate holding a
            # jean must not be told the store does not sell it because a
            # product query came back empty.
            return _out("sku", tenant, provider_name, grounded=False, sku=code,
                        lines=["NO FLOOR RECORDS LOADED",
                               f"CANT CONFIRM {code}",
                               "CHECK THE POS"],
                        meta=[source])
        item = _match(code, items)

    if item is None:
        # A real answer. The code was read and this floor has no record of it —
        # wrong store, an old tag, a transfer that never landed. Saying so beats
        # inventing a product, and beats a shrug.
        return _out("sku", tenant, provider_name, grounded=True, sku=code,
                    lines=["NOT IN FLOOR RECORDS", f"CODE {code}", "CHECK THE POS"],
                    meta=[source])

    stock = item.get("stock")
    location = str(item.get("location") or "FLOOR")
    lines = [
        str(item.get("name") or code),
        # The direction line. The arrow is the instruction — walk there — and
        # it is in the lens charset (20px, verified). With the associate's own
        # zone known and different, the line says the whole route.
        f"{cue_format.money(item.get('price'))} · {_direction(zone, location)}",
    ]
    if isinstance(stock, int):
        size = item.get("size")
        lines.append(f"{stock} ON HAND{f' IN {size}' if size else ''}")
    return _out("sku", tenant, provider_name, grounded=True,
                sku=item.get("sku") or code, lines=lines, meta=[source])


def _direction(zone: str | None, location: str) -> str:
    """`KNITWEAR → DENIM WALL`, or just `→ DENIM WALL` when we don't know
    where the associate is standing — or the location alone when they are
    already there, because directing somebody to where they are is noise."""
    here = str(zone or "").strip()
    there = location.strip()
    if here and here.upper() != there.upper():
        return f"{here} → {there}"
    return f"→ {there}" if not here else there


def _lookup(crm, code: str) -> tuple[dict | None, bool]:
    """(record, the-adapter-actually-answered).

    `lookup_code` is optional on a CRM adapter — the demo CRM and the Shopify
    adapter both carry it; a future adapter that doesn't simply falls back to
    the floor-inventory match. An adapter that *raises* is treated as not
    having answered, never as having answered "no".
    """
    fn = getattr(crm, "lookup_code", None)
    if not callable(fn):
        return None, False
    try:
        item = fn(code)
    except Exception:
        return None, False
    return (item, True) if item else (None, False)


def _identifier(reading: str) -> str | None:
    """The code the model read, or None if it read nothing usable.

    Kept strict on purpose: a model that returns a sentence has not read a code,
    and treating the sentence as one produces a lookup miss that reads to the
    associate as "we don't stock it".
    """
    text = (reading or "").strip().strip(".").strip()
    if not text or text.upper().startswith(NO_READING):
        return None
    # Models like to prefix an answer ("SKU: GAP-DNM-0498"), so take the last
    # token that looks like a code rather than the whole reply. A code contains
    # a digit — without that rule a model that answered in a sentence hands
    # "are" to the lookup, which misses, and a miss is printed to the associate
    # as "not in floor records". A sentence is not a failed lookup; it is a
    # failed read, and those want different words on the glass.
    candidates = [t for t in re.split(r"[\s,;:]+", text)
                  if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9\-_/.]{2,31}", t)
                  and any(c.isdigit() for c in t)]
    if not candidates:
        return None
    return candidates[-1].upper()


def _floor(crm) -> tuple[list[dict], bool]:
    """(items, we-actually-have-records).

    The second value is the whole reason this helper exists. A bare
    `crm.floor_inventory()` returns `[]` for a store with nothing on the floor,
    for a provider that failed, and for a tenant whose feed has not synced —
    three different situations that must not produce the same sentence.
    """
    try:
        items = crm.floor_inventory() or []
    except Exception:
        return [], False
    return list(items), bool(items)


def _norm_code(value) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def _match(code: str, items: list[dict]) -> dict | None:
    """Find the floor record this code refers to, or nothing.

    Exact first, then containment in either direction — a barcode carries the
    style number inside a longer string, and a shelf label often prints a
    prefix of it. Containment is only allowed above six characters, because
    below that it stops being an identifier and starts being a coincidence.
    """
    want = _norm_code(code)
    if not want:
        return None
    normalised = [(i, _norm_code(i.get("sku"))) for i in items]
    for item, sku in normalised:
        if sku and sku == want:
            return item
    if len(want) >= 6:
        for item, sku in normalised:
            if sku and len(sku) >= 6 and (sku in want or want in sku):
                return item
    return None


# --- part: a reading, labelled as a reading ----------------------------------

def _part_answer(tenant: str, provider_name: str, reading: str, crm) -> dict:
    """What the model saw, marked as what the model saw.

    Nothing on a retail floor can confirm a cracked hinge, so this branch has
    no record to be grounded in — and it says so in the meta strip rather than
    printing a model's sentence with the same authority as a stock count. If
    the reading does happen to name something the floor carries, the record's
    own facts go on the second line, and those are grounded.
    """
    if not reading or reading.upper().startswith(NO_READING):
        return _out("part", tenant, provider_name, grounded=False, sku=None,
                    lines=["COULDNT IDENTIFY IT", "TRY A CLOSER PHOTO"], meta=[])

    items, have_records = _floor(crm)
    item = _match(_identifier(reading) or "", items) if have_records else None

    lines = [reading]
    if item is not None:
        lines.append(f"{cue_format.money(item.get('price'))} · "
                     f"{item.get('location') or 'FLOOR'}")
    return _out("part", tenant, provider_name, grounded=False,
                sku=(item or {}).get("sku"), lines=lines,
                # The one fact worth spending the strip on: this sentence came
                # from a model looking at a picture, not from a record.
                meta=["MODEL READ"])


# --- shape -------------------------------------------------------------------

def _out(kind: str, tenant: str, provider_name: str, *, grounded: bool,
         sku: str | None, lines: list[str], meta: list[str]) -> dict:
    """`cue.build`'s shape, plus scalars the lens ignores.

    Full-frame width: a vision answer has no fact rail beside it, so it gets
    the 33-character budget rather than the guest card's 21.
    """
    cue = cue_format.build(lines, meta)
    return {
        **cue,
        "kind": kind,
        "tenant": (tenant or "gap").lower(),
        # True when every fact on the glass came out of a record we hold.
        "grounded": grounded,
        "sku": sku,
        "provider": provider_name,
    }
