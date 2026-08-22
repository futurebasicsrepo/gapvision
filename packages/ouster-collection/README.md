# ouster-collection — the blue-star selection, as a storefront collection page

A static, dependency-free page that renders a Shopify-collection-shaped grid from
a JSON file. Built to show a client the Ouster-branded products marked with a blue
star in the [Ouster Brand Playground][fig] Figma file.

## Run it

```
npm run dev:ouster          # http://localhost:8903
```

Any static server works — it is four files and no build step. It must be served
over HTTP, though: the page `fetch()`es its data, and `file://` blocks that.

| URL | Shows |
|---|---|
| `http://localhost:8903/` | The real collection, from `data/collection.json` |
| `http://localhost:8903/?preview=1` | Layout preview, from `data/layout-preview.json` |

## Why `products` is empty

`data/collection.json` ships with an empty `products` array. That is deliberate,
and it is the one part of this deliverable that is not finished.

The blue-star marking exists **only inside the Figma file**, and that file cannot
be read from here. Every call — `get_metadata`, `get_screenshot` — comes back:

> Looks like you don't have edit access to this file. The file owner can share it
> with you and make you an editor.

The account is right (`kyle@thefuturebasics.com`, Full seat) and the URL is
well-formed. What is missing is plan membership: that account belongs to one plan,
**Future Basics**, and Figma only serves files belonging to a plan you are in.
The playground file almost certainly sits in Ouster's own Figma org.

Two other sources were checked and neither substitutes:

- **This repository** — no occurrence of "ouster" in any file.
- **The connected Shopify store** — 32 products, every one vendor `Future Basics`.
  A search for `ouster` returns nothing.

So the selection was left blank rather than guessed. This page is going in front of
a client; invented product names and prices would be worse than an empty grid, and
harder to spot.

## Filling it in

Once the file opens, or once someone hands over the starred products:

1. Put one object per starred product into `products` in `data/collection.json`.
2. Set `starred: true` on the ones carrying the blue star.
3. Reload. Nothing else changes.

```json
{
  "id": "…",
  "title": "…",
  "handle": "…",
  "vendor": "Ouster",
  "price": 0,
  "currency": "USD",
  "image": "…",
  "variantCount": 1,
  "inventory": 0,
  "status": "ACTIVE",
  "starred": true
}
```

`image` takes any URL the browser can reach. If the artwork only exists in Figma,
`download_assets` on the starred node exports it once the access above is granted.

Set `collection.source.importedAt` and `importedBy` when you populate it, so the
next person can tell real data from the placeholder.

## The layout preview

`?preview=1` loads `data/layout-preview.json` — the seven **ACTIVE** products
really present in the Future Basics Shopify store, pulled 2026-08-22. They are
there so the grid, cards, star badge, starred-only filter and sorting can be seen
working before the real data lands.

Three of them carry `starred: true`. That is a demonstration of the badge and
nothing more — it is not a claim about any Figma marker. The page shows a banner
whenever this file is in use, so the stand-in cannot be mistaken for the real
collection on a shared screen.

## Brand

The palette is neutral on purpose. Ouster's real values live in the playground
file, which has not been readable, so nothing here claims to be Ouster's brand.
Four variables at the top of `assets/collection.css` carry every brand decision —
`--brand-star` is the blue of the star badge. Swap those four and the page is
Ouster's; nothing else needs to change.

## Files

| File | Role |
|---|---|
| `index.html` | Markup, including the empty state that explains the blocker |
| `assets/collection.css` | All styling. Brand variables at the top. |
| `assets/collection.js` | Fetch, filter, sort, render. No dependencies. |
| `data/collection.json` | **The real slot.** Empty until Figma opens. |
| `data/layout-preview.json` | Stand-in data, `?preview=1` only |

[fig]: https://www.figma.com/design/8EPHS3N2yuXjEa9YAC2y84/Ouster-Brand-Playground?node-id=3765-3103
