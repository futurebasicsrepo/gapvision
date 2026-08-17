# sales-site — the two decks, as things you send

Plain HTML against one stylesheet and one script. No framework, no bundler,
nothing to rot between now and the raise — which is the point: a deck that
needs a build step is a deck that eventually cannot be opened.

```
/                           redirects to /customers
/customers                  for the floor — merchants and operators (11 sections)
/fundraise                  pre-seed — investors                    (13 sections)
/assets/deck.css            tokens, lens, motion, print
/assets/deck.js             decode, reveals, counters, share, gate, PDF
/cuesea-for-the-floor.pdf   printed from /customers
/api/lead                   gated-open capture
```

## Running it

Anything that serves static files. There is no build:

```bash
npx serve packages/sales-site -l 8902     # → http://localhost:8902/customers
```

`/api/lead` only exists on Vercel; locally the gate still opens the deck,
because the client treats that call as best-effort on purpose.

## Deploying

**Its own Vercel project, deliberately not part of Console.** These are
customer- and investor-facing documents, and Console is the staff origin —
that boundary is the whole reason `packages/internal` is a separate build.

```bash
cd packages/sales-site
vercel deploy --prod          # project: cuesea-sales
# then add sales.cuesea.ai in Vercel, and a CNAME: sales → cname.vercel-dns.com
```

Two environment variables, both optional and both worth setting:

| Where | Variable | Effect |
|---|---|---|
| this project | `LEAD_WEBHOOK_URL` | gated opens are forwarded there; without it they land in the runtime log |
| the Console project | `VITE_SALES_URL` | the origin the Sales panel builds every link from |

Console defaults to `https://sales.cuesea.ai`, so if the domain above is what
you use, `VITE_SALES_URL` is belt and braces rather than required.

## The one sentence that must not get softened

**The gate is a lead gate, not authentication.** Anyone can delete `gate=1`
from the URL and read the deck. The Console panel says so, `deck.js` says so,
`claude/sales-deck.md` says so, and this says so. The moment it reads as
protection, somebody sends a deck they believed was safe into a room it should
not have reached.

## Regenerating the PDF

The leave-behind is printed from the page so the two cannot drift:

```bash
node tools/print-deck.js http://localhost:8902/customers cuesea-for-the-floor.pdf
```

That tool is not in this repo yet. Until it is, the browser's own print-to-PDF
from `/customers` produces the same thing — `deck.css` carries the print rules,
one section per page.
