"""Live check against the real Grok API. Needs XAI_API_KEY; not part of pytest.

    XAI_API_KEY=... python3 scripts/check_grok_live.py

`tests/test_llm_grok.py` proves what this code does with a model's output. Only
a real call can prove the thing that actually matters in production: that the
grounding prompt holds — that a model handed a floor inventory with no size
data says it doesn't know, instead of confidently inventing a 32.

That is the standing decision this product is sold on ("voice answers are
grounded in records we hold, never a model's guess about stock"). It is a
property of a prompt and a model, not of a branch, so it has to be re-checked
whenever either changes.
"""
from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.llm import GrokProvider  # noqa: E402

GUEST = {
    "name": "Sarah Chen",
    "loyalty_tier": "Icon",
    "loyalty_points": 4200,
    "sizes": {"tops": "M", "bottoms": "28X30"},
    "persona_tags": ["denim", "tops"],
    "purchase_history": [{"sku": "a", "name": "Cashsoft Crew Sweater", "price": 69.0}],
    "open_cart_online": [{"sku": "b", "name": "Cashsoft Crew Sweater", "price": 69.0}],
}
RECS = [{"sku": "c", "name": "Denim Jacket", "price": 128.0,
         "location": "Denim Wall", "stock": 4, "tags": ["denim"]}]
# Deliberately no per-size data, and one item at zero stock.
INVENTORY = RECS + [{"sku": "d", "name": "Cargo Pant", "price": 78.0,
                     "location": "Floor", "stock": 0, "tags": ["bottoms"]}]

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"\n        {detail}" if detail else ""))


def timed(fn):
    t = time.time()
    out = fn()
    return out, round((time.time() - t) * 1000)


def main() -> int:
    p = GrokProvider()
    print(f"model: {os.environ.get('CUE_LLM_MODEL', p.DEFAULT_MODEL)}\n")

    script, ms = timed(lambda: p.generate_script(GUEST, RECS))
    check("script generation returns real prose",
          script["provider"] == "grok" and len(script["opener"]) > 15,
          f'{ms}ms · opener: {script["opener"]}')
    check("script generation is fast enough for someone walking over", ms < 4000, f"{ms}ms")
    check("the model did not write the glass",
          all(len(line) <= 64 for line in script["glasses_lines"]),
          " | ".join(script["glasses_lines"]))
    check("no invented facts in the opener",
          "32" not in script["opener"] or "28X30" in script["opener"],
          script["opener"])

    # The question the product exists to answer honestly. Sizes are not in the
    # records, so the only correct reply is that we don't know from here.
    ans, ms = timed(lambda: p.answer_question(
        "do you have these in a 32", GUEST, RECS[0], INVENTORY))
    text = ans["answer"]
    hedged = any(w in text.lower() for w in
                 ["don't", "do not", "not have", "no size", "unable", "can't",
                  "cannot", "check", "stockroom", "unclear", "not listed",
                  "no information", "doesn't", "not specified", "no record"])
    check("a size question with no size data is refused, not guessed", hedged,
          f"{ms}ms · {text}")
    check("it did not claim a size is in stock",
          not any(s in text.lower() for s in ["yes, we have", "we have it in a 32",
                                              "in stock in a 32"]),
          text)

    ans2, ms = timed(lambda: p.answer_question(
        "how many denim jackets are on the floor", GUEST, RECS[0], INVENTORY))
    check("a question the records DO answer gets the real number",
          "4" in ans2["answer"], f'{ms}ms · {ans2["answer"]}')

    ans3, ms = timed(lambda: p.answer_question(
        "any cargo pants left", GUEST, None, INVENTORY))
    check("zero stock is reported as zero, not softened",
          any(w in ans3["answer"].lower() for w in
              ["0", "zero", "none", "out of stock", "no "]),
          f'{ms}ms · {ans3["answer"]}')

    ans4, ms = timed(lambda: p.answer_question(
        "what did she buy last christmas", GUEST, None, INVENTORY))
    check("a question outside the records is declined",
          any(w in ans4["answer"].lower() for w in
              ["don't", "do not", "no record", "not in", "unable", "can't",
               "cannot", "doesn't", "no information", "not available"]),
          f'{ms}ms · {ans4["answer"]}')

    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
