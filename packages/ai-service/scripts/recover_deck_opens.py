#!/usr/bin/env python3
"""Replay gated deck opens that reached the log and nowhere else.

    CUE_DATABASE_URL=postgres://… python -m scripts.recover_deck_opens opens.json
    CUE_DATABASE_URL=postgres://… python -m scripts.recover_deck_opens opens.json --commit

Why this exists
---------------
`sales-site/api/lead.js` answers 204 to the reader whatever happens behind it —
the deck must open even when our plumbing does not. That is the right trade for
the person reading, and it means a misconfigured deployment loses leads while
looking healthy. On 18 Aug four real gated opens were logged by that function
and forwarded nowhere, because `CUE_API_KEY` did not match the control plane.

The lead is recoverable from the Vercel runtime log — for as long as Vercel
keeps it. This replays those rows into the pipeline through exactly the path a
live open would have taken, so a recovered lead is indistinguishable from one
that worked the first time.

**No lead data lives in this file, and none should ever be committed.** This
repository is public. The records are passed in as a JSON file that stays out
of git — pull them from the log, run this, delete the file.

Input format
------------
A JSON array of the objects `lead.js` logs verbatim, so you can copy them
straight out of the log line after `[cuesea-lead] `:

    [
      {"deck": "floor", "name": "…", "email": "…", "firm": "…",
       "preparedFor": "…", "token": "…", "at": "2026-08-18T02:14:19.609Z"}
    ]

Safety
------
Dry run by default: it prints what it would write and touches nothing. Pass
`--commit` to write. Re-running is safe — `record_deck_open` upserts on email
and never moves a stage, so a lead recovered twice is still one lead. It does
add a second "opened the deck" touch, which is true: they did open it twice if
the log says so, and this script is not the right place to decide otherwise.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db, decks, growth  # noqa: E402


def _host_of(url: str) -> str:
    """Just enough of the URL to recognise which database this is.

    Never the credentials: this line exists to stop somebody writing to
    production believing it was local, and a password printed to a terminal
    would trade one hazard for a worse one.
    """
    try:
        rest = url.split("://", 1)[1]
    except IndexError:
        return "(unparseable)"
    netloc = rest.split("@")[-1].split("/")[0]
    if not netloc or netloc.startswith("?"):
        # Unix-socket form: postgresql://user@/db?host=/tmp&port=5434
        for part in rest.split("?")[-1].split("&"):
            if part.startswith("host="):
                return f"{part[5:]} (local socket)"
        return "(local socket)"
    return netloc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("records", help="JSON array of logged lead objects")
    ap.add_argument("--commit", action="store_true",
                    help="actually write; without it this is a dry run")
    args = ap.parse_args()

    if not db.configured():
        print("Set CUE_DATABASE_URL to the database you mean to write to.",
              file=sys.stderr)
        return 2

    rows = json.loads(Path(args.records).read_text())
    if not isinstance(rows, list):
        print("Expected a JSON array.", file=sys.stderr)
        return 2

    # Said out loud, because the whole point of this script is writing to a
    # database that is usually production and the flag is easy to forget.
    where = os.environ.get("CUE_DATABASE_URL") or os.environ.get("DATABASE_URL") or ""
    host = _host_of(where)
    print(f"{'WRITING TO' if args.commit else 'dry run against'} {host}\n")

    written = 0
    for row in rows:
        email = (row.get("email") or "").strip()
        if not email or "@" not in email:
            print(f"  skip — no usable email: {row!r}")
            continue

        deck = row.get("deck") or "floor"
        prepared = row.get("preparedFor") or row.get("to") or ""
        print(f"  {email:40s} {deck:10s} {prepared or '—'}")

        if not args.commit:
            continue

        # The same two calls a live open makes, in the same order: the raw
        # evidence first, then the pipeline mirror. Going through
        # `decks.record_lead` rather than writing rows by hand is deliberate —
        # a recovered lead should be shaped by the same code as a live one, or
        # it is a second implementation nobody tests.
        decks.record_lead(row)
        written += 1

    if not args.commit:
        print(f"\n{len(rows)} record(s) would be replayed. Re-run with --commit.")
    else:
        print(f"\n{written} replayed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
