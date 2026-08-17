/**
 * DOM renderer for the 600×600 additive display, in two voices.
 *
 * classic — the G2 grammar 1:1: hud green, type only, one framed card.
 * meta    — icons and logos by default: the Cue Bracket mark, the two-tone
 *           wordmark, garment glyphs on the hero, card icons in the title
 *           row, product thumbnails, and the brand's color rule — green is
 *           the product's own voice, sea is everything measured, flame is
 *           one per display, the thing that wants attention.
 *
 * Both voices share the deck model; this module only decides paint.
 */
import type { DisplayPayload, LensMode } from "@cue/lens-core";
import { type DeckState, contentOf, titleOf, VISIBLE_ROWS, joinMeta } from "@cue/lens-core";
import { CARD_ICON, MARK, SHIRT, STAR, TROUSERS } from "./icons.js";

const app = () => document.getElementById("app")!;

function el(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function icon(cls: string, svg: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.innerHTML = svg;
  return s;
}

function header(mode: LensMode, cluster: string): HTMLDivElement {
  const h = el("hdr");
  if (mode === "meta") {
    const brand = el("brand");
    brand.appendChild(icon("mark", MARK));
    const word = el("word2");
    const cue = document.createElement("span");
    cue.className = "cue";
    cue.textContent = "cue";
    const sea = document.createElement("span");
    sea.className = "sea";
    sea.textContent = "sea";
    word.append(cue, sea);
    brand.appendChild(word);
    h.appendChild(brand);
  } else {
    h.appendChild(el("word", "CUE"));
  }
  h.appendChild(el("cluster", cluster));
  return h;
}

export function renderIdle(mode: LensMode, clock: string, tenantLabel: string,
                           connected: boolean, refused = false) {
  const root = app();
  root.className = `mode-${mode}`;
  root.innerHTML = "";
  root.appendChild(header(mode, connected ? clock : "OFFLINE"));
  const card = el("card");
  card.appendChild(el("idle-clock", clock));
  // A lens whose token the control plane refused will never receive a guest,
  // and "AWAITING GUEST SIGNAL" on a quiet afternoon looks exactly like a lens
  // that is working. Say which one it is, in the words the person wearing it
  // can act on.
  card.appendChild(refused
    ? el("idle-sub", "NOT PROVISIONED · SEE YOUR MANAGER")
    : el("idle-sub", "AWAITING GUEST SIGNAL"));
  root.appendChild(card);
  const foot = el("foot");
  foot.appendChild(el("", tenantLabel));
  foot.appendChild(el("hint", `${mode.toUpperCase()} · UP/DOWN SWITCH`));
  root.appendChild(foot);
}

function heroRow(mode: LensMode, g: NonNullable<DisplayPayload["guest"]>): HTMLDivElement | null {
  if (!g.sizes?.tops && !g.sizes?.bottoms) return null;
  const hero = el("hero");
  if (g.sizes.tops) {
    hero.appendChild(
      mode === "meta" ? icon("hero-icon", SHIRT) : el("slot", "TOP")
    );
    hero.appendChild(el("size", g.sizes.tops.toUpperCase()));
  }
  if (g.sizes.bottoms) {
    hero.appendChild(
      mode === "meta" ? icon("hero-icon", TROUSERS) : el("slot", "BTM")
    );
    hero.appendChild(el("size", g.sizes.bottoms.toUpperCase()));
  }
  return hero;
}

function thumb(src: string | undefined, big = false): HTMLElement | null {
  if (!src) return null;
  const img = document.createElement("img");
  img.className = big ? "show-hero" : "thumb";
  img.src = src;
  img.alt = "";
  // A refused/failed image must never leave a hole — same latch philosophy
  // as the G2 hero rail: drop to text, silently.
  img.addEventListener("error", () => img.remove());
  return img;
}

export function renderDeck(mode: LensMode, s: DeckState, payload: DisplayPayload, clock: string) {
  const root = app();
  root.className = `mode-${mode}`;
  root.innerHTML = "";
  root.appendChild(header(mode, clock));

  const g = payload.guest || {};
  if (g.name) {
    const row = el("name-row");
    row.appendChild(el("line peak", g.name.toUpperCase()));
    if (mode === "meta" && g.tier) {
      const chip = el("chip");
      chip.appendChild(icon("chip-icon", STAR));
      chip.appendChild(el("", g.tier.toUpperCase()));
      row.appendChild(chip);
    }
    root.appendChild(row);
  }

  const hero = heroRow(mode, g);
  if (hero) root.appendChild(hero);

  const card = s.cards[s.index];
  const frame = el(
    "card" + (s.clickedIn ? " clicked-in" : "") + (card.kind === "SHOW" ? " attention" : "")
  );
  frame.tabIndex = 0;

  const title = el("title");
  if (mode === "meta" && CARD_ICON[card.kind]) title.appendChild(icon("title-icon", CARD_ICON[card.kind]));
  title.appendChild(el("", titleOf(s)));
  frame.appendChild(title);

  const body = el("body" + (mode === "meta" && card.kind === "SHOW" && !s.clickedIn ? " split" : ""));
  if (mode === "meta" && card.kind === "SHOW" && !s.clickedIn) {
    const t = thumb(card.heroImage, true);
    if (t) body.appendChild(t);
  }
  // Browse shows the card's three lines; clicked-in scrolls its whole
  // content. Row thumbnails only where rows and images are the same list —
  // SHOW's browse lines are name+facts of one item, so its thumbs wait for
  // the clicked-in list (the hero already carries the image up front).
  const rows = s.clickedIn ? contentOf(card) : card.lines;
  const lo = s.clickedIn ? s.offset : 0;
  const shown = rows.slice(lo, lo + VISIBLE_ROWS);
  const rowImages =
    mode === "meta" && card.images && !(card.kind === "SHOW" && !s.clickedIn)
      ? card.images
      : undefined;
  const lines = el("lines");
  shown.forEach((r, i) => {
    const row = el("row");
    if (rowImages) {
      const t = thumb(rowImages[lo + i]);
      if (t) row.appendChild(t);
    }
    row.appendChild(el("line" + (card.kind === "CUE" && lo + i === 0 ? " peak" : ""), r));
    lines.appendChild(row);
  });
  body.appendChild(lines);
  frame.appendChild(body);

  if (card.meta?.length) frame.appendChild(el("meta", joinMeta(card.meta)));
  root.appendChild(frame);
  frame.focus();

  const hint = s.clickedIn ? "SELECT BACK" : card.kind === "CUE" ? "SELECT DONE" : "SELECT OPEN";
  const foot = el("foot");
  foot.appendChild(
    el("", joinMeta([payload.zone, payload.latency_s !== undefined ? `${payload.latency_s}S` : ""]) || " ")
  );
  foot.appendChild(el("hint", hint));
  root.appendChild(foot);
}
