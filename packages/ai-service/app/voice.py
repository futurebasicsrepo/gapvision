"""Voice query engine — "the associate asks, the lens answers".

Input: a transcript plus the context the associate is already looking at
(tenant, the guest they're engaged with, the product currently on the lens).
Output: a short answer plus display-ready `glasses_lines`, same contract the
beacon path uses, so the plugin renders both through one code path.

Why rules first, LLM second
---------------------------
The questions that matter on a sales floor are lookups: is it in stock, in
this size, where is it, what does it cost, what did she buy last time. Those
have *correct* answers sitting in the CRM, and a model asked to paraphrase
them can only add latency and a chance of inventing a size we don't carry.
So intents resolve deterministically against inventory, and the LLM provider
is the fallback for the open-ended remainder ("what should I show her next")
where judgement, not lookup, is the job.

Every answer is grounded in a record we actually hold. If nothing matches, we
say so — a wrong size quoted out loud costs a sale and the guest's trust.
"""
from __future__ import annotations

import re

from . import cue as cue_format
from .llm import get_provider
from .personas import match_products

#: A 576x288 monochrome lens fits roughly this many characters per row.
LINE_CHARS = 40

_STOPWORDS = {
    "the", "a", "an", "do", "does", "we", "have", "any", "in", "is", "it",
    "are", "there", "this", "that", "these", "those", "of", "for", "got",
    "some", "left", "more", "on", "at", "what", "whats", "how", "much",
    "where", "can", "i", "you", "get", "find", "me", "my", "her", "his",
    "them", "they", "one", "and", "or", "to", "with", "s",
}

_SIZE_WORDS = {
    "xs": "XS", "extra small": "XS",
    "s": "S", "small": "S",
    "m": "M", "medium": "M", "mediums": "M",
    "l": "L", "large": "L", "larges": "L",
    "xl": "XL", "extra large": "XL",
    "xxl": "XXL", "2xl": "XXL",
}

# "these" / "that one" / "it" — the guest is holding it, or it's on the lens.
_DEICTIC = re.compile(r"\b(these|this|that|those|it|them|the one)\b")


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9x\s]", " ", text.lower()).strip()


def _tokens(text: str) -> list[str]:
    return [t for t in _norm(text).split() if t and t not in _STOPWORDS]


def extract_size(transcript: str) -> str | None:
    """Pull a size out of a spoken question. Waist x inseam wins over a bare
    number, and a bare number is only a size if it's in a plausible range."""
    t = _norm(transcript)
    m = re.search(r"\b(\d{2})\s*(?:x|by)\s*(\d{2})\b", t)
    if m:
        return f"{m.group(1)}x{m.group(2)}"
    for phrase in ("extra small", "extra large"):
        if phrase in t:
            return _SIZE_WORDS[phrase]
    words = t.split()
    for w in words:
        if w in _SIZE_WORDS and (len(w) > 1 or f" {w} " in f" {t} "):
            # Single letters are only sizes when the sentence is about sizing.
            if len(w) == 1 and not re.search(r"\bsize\b|\bin a\b|\bin an\b", t):
                continue
            return _SIZE_WORDS[w]
    m = re.search(r"\b(\d{1,2})\b", t)
    if m:
        n = int(m.group(1))
        if 0 <= n <= 44:  # 00-44 covers US womens/mens waist+numeric sizing
            return m.group(1)
    return None


# --- intent detection --------------------------------------------------------

_INTENT_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("stock", re.compile(r"\b(in stock|do we have|have any|got any|any left|"
                         r"how many|availab|carry|restock|back room|stockroom)\b")),
    ("location", re.compile(r"\b(where|which (wall|table|zone|rack|section)|find it|"
                            r"located|aisle)\b")),
    ("price", re.compile(r"\b(price|how much|cost|on sale|discount|markdown|"
                         r"what.s it go for)\b")),
    ("history", re.compile(r"\b(last (time|visit)|before|previously|already (own|bought|has)|"
                           r"purchase|bought|her size|his size|their size|what size (is|does)|"
                           r"cart|points|tier|loyalty)\b")),
    ("recommend", re.compile(r"\b(recommend|suggest|what should|what else|show her|show him|"
                             r"pair|goes with|match|next)\b")),
]


#: Guest-record questions that would otherwise be captured by a stock phrasing
#: — "how many points does she have" is history, not inventory.
_GUEST_RECORD = re.compile(
    r"\b(points|loyalty|tier|cart|bought|purchase[ds]?|last (time|visit)|previously)\b"
)


def detect_intent(transcript: str, size: str | None) -> str:
    t = _norm(transcript)
    if _GUEST_RECORD.search(t):
        return "history"
    for name, pattern in _INTENT_PATTERNS:
        if pattern.search(t):
            # "do we have these in a 32" is stock, but so is a bare
            # "any of these in a medium" — size alone implies availability.
            return name
    if size:
        return "stock"
    return "open"


# --- product resolution ------------------------------------------------------

def size_scheme(size: str | None) -> str | None:
    """Which sizing system a size belongs to: waist ('32x30'), numeric ('32'),
    or letter ('M'). Comparing across schemes is meaningless — a tee has no
    32x30 — so this is what stops "these" from binding to the wrong garment."""
    if not size:
        return None
    s = str(size).strip().lower()
    if re.fullmatch(r"\d{2}x\d{2}", s):
        return "waist"
    if re.fullmatch(r"\d{1,2}", s):
        return "numeric"
    if s.upper() in {"XS", "S", "M", "L", "XL", "XXL"}:
        return "letter"
    return None


def item_scheme(item: dict) -> str | None:
    """The scheme an item's variants are sized in, if it exposes variants."""
    sizes = item.get("sizes")
    if not isinstance(sizes, dict) or not sizes:
        return None
    schemes = [size_scheme(k) for k in sizes]
    schemes = [s for s in schemes if s]
    return max(set(schemes), key=schemes.count) if schemes else None


def _scheme_compatible(item: dict, size: str | None) -> bool:
    """Unknown scheme on either side is compatible — we only rule out
    contradictions we can actually prove."""
    want, have = size_scheme(size), item_scheme(item)
    return not want or not have or want == have or {want, have} == {"numeric", "waist"}


def resolve_product(
    transcript: str,
    inventory: list[dict],
    focus: dict | None = None,
    size: str | None = None,
) -> tuple[dict | None, str]:
    """Find which product the associate means.

    Returns (item, how) where `how` is 'named' (they said its name), 'focus'
    (deictic — they mean what's on the lens), 'size-scheme' (only one thing on
    the floor is sized the way they asked), or 'none'/'ambiguous'.
    """
    toks = set(_tokens(transcript))
    best, best_score = None, 0
    for item in inventory:
        name_toks = set(_tokens(item["name"]))
        tag_toks = {t for tag in item.get("tags", []) for t in _tokens(tag)}
        score = len(toks & name_toks) * 2 + len(toks & tag_toks)
        if score > best_score:
            best, best_score = item, score
    if best is not None and best_score >= 2:
        return best, "named"

    if focus and _DEICTIC.search(_norm(transcript)):
        if _scheme_compatible(focus, size):
            return focus, "focus"
        # They said "these" while a differently-sized garment is on the lens —
        # they're holding something else. If exactly one floor item is sized
        # the way they asked, that's the only thing they can mean.
        candidates = [
            i for i in inventory
            if item_scheme(i) and _scheme_compatible(i, size)
        ]
        if len(candidates) == 1:
            return candidates[0], "size-scheme"
        return None, "ambiguous"

    if best is not None and best_score >= 1:
        return best, "named"
    if focus and _scheme_compatible(focus, size):
        return focus, "focus"
    return None, "none"


def size_availability(item: dict, size: str | None) -> tuple[str, int | None]:
    """('yes' | 'no' | 'unknown', units) for a size in a floor item.

    `sizes` is optional on inventory records: CRMs that expose variant-level
    counts (the Gap demo dataset; Shopify once variants land) fill it in, and
    the ones that don't get an honest 'unknown' rather than a guess.
    """
    if not size:
        return ("yes" if item.get("stock", 0) > 0 else "no", item.get("stock", 0))
    sizes = item.get("sizes")
    if not isinstance(sizes, dict):
        return ("unknown", None)
    for key, units in sizes.items():
        if str(key).lower() == size.lower():
            return ("yes" if units > 0 else "no", int(units))
    return ("no", 0)


def nearest_sizes(item: dict, size: str | None, limit: int = 2) -> list[str]:
    """In-stock sizes to offer when the one they asked for is gone.

    Same sizing scheme only — offering "S (8)" to someone asking for a 32x30
    is worse than offering nothing.
    """
    sizes = item.get("sizes")
    if not isinstance(sizes, dict):
        return []
    want = size_scheme(size)
    have = [
        f"{k} ({v})" for k, v in sizes.items()
        if v > 0
        and str(k).lower() != str(size).lower()
        and (not want or size_scheme(k) == want)
    ]
    return have[:limit]


# --- answer construction -----------------------------------------------------

def _clip(text: str, width: int = LINE_CHARS) -> str:
    # Leading spaces are meaningful — continuation rows are indented under the
    # line they belong to, which is the only hierarchy a mono lens affords.
    indent = len(text) - len(text.lstrip(" "))
    body = " ".join(text.split())
    room = max(8, width - indent)
    if len(body) > room:
        body = body[: room - 1].rstrip() + "…"
    return " " * indent + body


def _money(v) -> str:
    try:
        return f"${float(v):.2f}"
    except (TypeError, ValueError):
        return "—"


def answer_query(
    transcript: str,
    inventory: list[dict],
    guest: dict | None = None,
    focus_sku: str | None = None,
) -> dict:
    """Route a transcript to a grounded answer. Pure function — easy to test."""
    transcript = (transcript or "").strip()
    if not transcript:
        # `main.py` normally intercepts this before we get here, but a route
        # that returns an answer with nothing to show is a blank lens wherever
        # it lives. Every exit from this function paints something.
        return _package(
            transcript, "empty", "Didn't catch that — press and ask again.", None,
            ["[ICON:WARN] Didn't catch that", "[ICON:CHAT] Press and ask again"],
        )

    focus = next((i for i in inventory if i.get("sku") == focus_sku), None) if focus_sku else None
    size = extract_size(transcript)
    intent = detect_intent(transcript, size)

    if intent == "history":
        return _answer_history(transcript, guest, inventory)
    if intent == "recommend":
        return _answer_recommend(transcript, guest, inventory)

    item, how = resolve_product(transcript, inventory, focus, size)
    if item is None:
        if how == "ambiguous":
            return _package(
                transcript, intent,
                f"Not sure which item — nothing on your lens is sized {size}. "
                f"Say the product name.",
                None,
                [f"[ICON:WARN] Which item? (asked for {size})",
                 "[ICON:CHAT] Say the product name"],
                how=how, size=size,
            )
        # An answer with no lines is a blank lens. The associate pressed the
        # temple, spoke, watched the meter, and got nothing back — which reads
        # as broken hardware, not as "I didn't recognise that item". Whatever
        # we say in `answer` has to also be sayable on the glass.
        return _package(
            transcript, intent,
            "No floor item matches that — say the product name and ask again.",
            None,
            ["[ICON:WARN] No match on the floor",
             "[ICON:CHAT] Say the product name"],
        )

    if intent == "location":
        return _answer_location(transcript, item, how)
    if intent == "price":
        return _answer_price(transcript, item, how)
    if intent == "stock":
        return _answer_stock(transcript, item, size, how, guest)
    return _answer_open(transcript, guest, item, inventory)


def _answer_stock(transcript, item, size, how, guest) -> dict:
    # No size in the question? Fall back to the guest's own size — the reason
    # you ask "do we have these" while standing next to a guest.
    implied = False
    if not size and guest:
        sizes = guest.get("sizes") or {}
        size = sizes.get("bottoms") if _is_bottoms(item) else sizes.get("tops")
        implied = bool(size)

    name = item["name"]
    loc = item.get("location", "Floor")

    # They named an item but asked for a size it isn't sold in. Say that,
    # rather than reporting a technically-true "no" that reads as out of stock.
    if size and not _scheme_compatible(item, size):
        carried = ", ".join(list(item.get("sizes", {}).keys())[:4])
        return _package(
            transcript, "stock",
            f"The {name} isn't sized {size} — it comes in {carried}.", item,
            [f"[ICON:WARN] {name} isn't sized {size}",
             f"[ICON:TAG] Comes in {carried}",
             f"        @ {loc}  {_money(item.get('price'))}"],
            how=how, size=size,
        )

    verdict, units = size_availability(item, size)

    if verdict == "yes":
        head = f"Yes — {units} in {size}" if size else f"Yes — {units} on the floor"
        lines = [f"[ICON:CHECK] {head}"]
        answer = f"Yes. {units} of the {name} in {size or 'stock'} at {loc}."
    elif verdict == "no":
        alts = nearest_sizes(item, size)
        head = f"No {size} left" if size else "Out of stock"
        lines = [f"[ICON:NO] {head}"]
        if alts:
            lines.append(f"[ICON:TAG] In stock: {', '.join(alts)}")
            answer = f"No {size} in the {name}. In stock: {', '.join(alts)}."
        else:
            answer = f"No {size or 'stock'} in the {name} on the floor."
    else:
        head = f"{item.get('stock', 0)} on floor · size not in feed"
        lines = [f"[ICON:WARN] {head}"]
        answer = (
            f"{item.get('stock', 0)} of the {name} on the floor; this store's feed "
            f"doesn't break out {size or 'sizes'} — check the rack or POS."
        )

    lines.append(f"[ICON:ARROW] {name}")
    lines.append(f"        @ {loc}  {_money(item.get('price'))}")
    # That we guessed the size is a supporting fact, not one of the three
    # lines — it qualifies the answer rather than being part of it.
    note = f"ASSUMED {size}" if implied else None
    return _package(transcript, "stock", answer, item, lines, how=how, size=size, note=note)


def _is_bottoms(item: dict) -> bool:
    text = f"{item.get('name','')} {' '.join(item.get('tags', []))}".lower()
    return any(w in text for w in ("jean", "denim", "trouser", "pant", "jogger", "short", "skirt", "chino"))


def _answer_location(transcript, item, how) -> dict:
    loc = item.get("location", "Floor")
    return _package(
        transcript, "location",
        f"The {item['name']} is at {loc}.", item,
        [f"[ICON:PIN] {loc}",
         f"[ICON:ARROW] {item['name']}",
         f"        {item.get('stock', 0)} on hand  {_money(item.get('price'))}"],
        how=how,
    )


def _answer_price(transcript, item, how) -> dict:
    return _package(
        transcript, "price",
        f"The {item['name']} is {_money(item.get('price'))}.", item,
        [f"[ICON:TAG] {_money(item.get('price'))}",
         f"[ICON:ARROW] {item['name']}",
         f"        @ {item.get('location', 'Floor')}  {item.get('stock', 0)} on hand"],
        how=how,
    )


def _answer_history(transcript, guest, inventory) -> dict:
    if not guest:
        return _package(
            transcript, "history",
            "No guest is engaged — start a session first.", None,
            ["[ICON:WARN] No guest engaged"],
        )
    t = _norm(transcript)
    sizes = guest.get("sizes") or {}
    first = guest["name"].split()[0]

    if "size" in t:
        return _package(
            transcript, "history",
            f"{first} wears {sizes.get('tops','?')} tops, {sizes.get('bottoms','?')} bottoms.",
            None,
            [f"[ICON:USER] {guest['name']}",
             f"[ICON:TAG] Tops {sizes.get('tops','?')} · Bottoms {sizes.get('bottoms','?')}",
             f"[ICON:TAG] Outerwear {sizes.get('outerwear','?')}"],
        )

    if "cart" in t:
        cart = guest.get("open_cart_online") or []
        if not cart:
            return _package(transcript, "history", f"{first} has nothing in their online cart.",
                            None, [f"[ICON:CART] Cart empty"])
        lines = [f"[ICON:CART] Online cart ({len(cart)})"]
        lines += [f"        {c['name']}  {_money(c.get('price'))}" for c in cart[:3]]
        return _package(
            transcript, "history",
            f"{first} has {', '.join(c['name'] for c in cart)} in their online cart.",
            None, lines,
        )

    if "point" in t or "tier" in t or "loyalt" in t:
        return _package(
            transcript, "history",
            f"{first} is {guest['loyalty_tier']} with {guest['loyalty_points']} points.",
            None,
            [f"[ICON:STAR] {guest['loyalty_tier']} · {guest['loyalty_points']} pts",
             f"[ICON:USER] {guest['name']}"],
        )

    hist = guest.get("purchase_history") or []
    if not hist:
        return _package(transcript, "history", f"No purchase history for {first}.", None,
                        [f"[ICON:USER] {first} — first visit"])
    lines = [f"[ICON:USER] {first} bought"]
    lines += [f"        {p['name']}  {_money(p.get('price'))}" for p in hist[:3]]
    return _package(
        transcript, "history",
        f"{first} previously bought {', '.join(p['name'] for p in hist[:3])}.",
        None, lines,
    )


def _answer_recommend(transcript, guest, inventory) -> dict:
    if not guest:
        top = sorted(inventory, key=lambda i: i.get("stock", 0), reverse=True)[:3]
        lines = ["[ICON:ARROW] Deepest stock on floor"]
        lines += [f"        {i['name']}  @ {i.get('location','Floor')}" for i in top]
        return _package(transcript, "recommend",
                        "No guest engaged — showing the deepest stock on the floor.",
                        top[0] if top else None, lines)

    owned = {p["sku"] for p in guest.get("purchase_history", [])}
    recs = match_products(guest.get("persona_tags", []), owned, inventory)
    if not recs:
        return _package(transcript, "recommend", "Nothing on the floor matches their persona.",
                        None, ["[ICON:WARN] No persona match on floor"])
    first = guest["name"].split()[0]
    lines = [f"[ICON:ARROW] For {first} ({', '.join(guest.get('persona_tags', [])[:2])})"]
    lines += [f"        {i['name']}  @ {i.get('location','Floor')}" for i in recs[:3]]
    return _package(
        transcript, "recommend",
        f"Show {first} the {recs[0]['name']} at {recs[0].get('location','the floor')} "
        f"({_money(recs[0].get('price'))}).",
        recs[0], lines, matches=recs[:3],
    )


def _answer_open(transcript, guest, item, inventory) -> dict:
    """Open-ended question: hand to the LLM provider if one is wired, else
    answer with the grounded facts we do have rather than pretending."""
    provider = get_provider()
    handler = getattr(provider, "answer_question", None)
    if callable(handler):
        try:
            result = handler(transcript, guest, item, inventory)
            answer = (result or {}).get("answer") if isinstance(result, dict) else str(result)
            if answer:
                return _package(
                    transcript, "open", answer, item,
                    [f"[ICON:CHAT] {_clip(answer)}"] +
                    ([f"[ICON:ARROW] {item['name']}"] if item else []),
                    provider_name=provider.name,
                )
        except Exception as e:  # a model outage must not break the lens
            return _package(
                transcript, "open", f"Model unavailable ({e}).", item,
                ["[ICON:WARN] Model unavailable",
                 f"[ICON:ARROW] {item['name']}" if item else "[ICON:ARROW] —"],
                provider_name=provider.name,
            )
    # No provider wired, or one that answered with nothing. Fall back to the
    # facts we hold about whatever is on the lens.
    if not item:
        # Nothing on the lens and no model: there is genuinely nothing to say.
        # Say that on the glass rather than dereferencing a None and turning a
        # shrug into a 500 on the one route that promises it never 500s.
        return _package(
            transcript, "open",
            "Nothing on the lens to answer about — name the item and ask again.",
            None,
            ["[ICON:WARN] Nothing selected",
             "[ICON:CHAT] Name the item and ask again"],
        )
    return _package(
        transcript, "open",
        f"The {item['name']} is {_money(item.get('price'))} at {item.get('location','Floor')}, "
        f"{item.get('stock', 0)} on hand.",
        item,
        [f"[ICON:ARROW] {item['name']}",
         f"        @ {item.get('location','Floor')}  {_money(item.get('price'))}",
         f"        {item.get('stock', 0)} on hand"],
    )


def _package(transcript, intent, answer, item, lines, *, how="none", size=None,
             matches=None, provider_name="rules", note=None) -> dict:
    """One output shape for every intent, written for the glass.

    An answer is a cue like any other: three lines, uppercase, no punctuation
    but the interpunct. The question itself is not echoed back — the associate
    just asked it, and the glass shows nothing it doesn't have to.
    """
    body = [
        re.sub(r"\[ICON:\w+\]\s*", "", str(l)).strip()
        for l in lines
        if str(l).strip()
    ]
    # A qualifying note outranks the stock count — if we assumed the size,
    # that matters more to the associate than how many are on the floor.
    meta = ([note] if note else []) + _meta_for(item)
    cue = cue_format.build(body[:3], meta)
    return {
        "cue": cue,
        "transcript": transcript,
        "intent": intent,
        "answer": answer,
        "size": size,
        "resolved_by": how,
        "product": item,
        "matches": matches or ([item] if item else []),
        "answer_provider": provider_name,
        "glasses_lines": cue_format.flatten(cue),
    }


def _meta_for(item: dict | None) -> list[str]:
    """Three facts that support the sentence and never compete with it."""
    if not item:
        return []
    facts = [item.get("location"), cue_format.money(item.get("price"))]
    stock = item.get("stock")
    if isinstance(stock, int):
        facts.append(f"{stock} ON HAND")
    return [f for f in facts if f and f != "—"]
