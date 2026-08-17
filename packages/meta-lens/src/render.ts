/**
 * DOM renderer for the 600×600 additive display. One frame per screen (the
 * card), a header cluster, a hero row when the guest's sizes are known, a
 * footer strip. No scrolling of the page itself — the deck model decides
 * which rows exist; this module only paints them.
 */
import type { DisplayPayload } from "./types.js";
import { type DeckState, contentOf, titleOf, VISIBLE_ROWS } from "./deck.js";
import { joinMeta } from "./grammar.js";

const app = () => document.getElementById("app")!;

function el(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function header(cluster: string): HTMLDivElement {
  const h = el("hdr");
  h.appendChild(el("word", "CUE"));
  h.appendChild(el("cluster", cluster));
  return h;
}

export function renderIdle(clock: string, tenantLabel: string, connected: boolean) {
  const root = app();
  root.innerHTML = "";
  root.appendChild(header(connected ? clock : "OFFLINE"));
  const card = el("card");
  card.appendChild(el("idle-clock", clock));
  card.appendChild(el("idle-sub", "AWAITING GUEST SIGNAL"));
  root.appendChild(card);
  root.appendChild(el("foot", tenantLabel));
}

export function renderDeck(s: DeckState, payload: DisplayPayload, clock: string) {
  const root = app();
  root.innerHTML = "";
  root.appendChild(header(clock));

  const g = payload.guest || {};
  if (g.name) {
    const name = el("line peak", g.name.toUpperCase());
    name.style.margin = "14px 0 0";
    root.appendChild(name);
  }

  // The hero — the G2 earned big type by drawing pixels; here it is just type.
  if (g.sizes?.tops || g.sizes?.bottoms) {
    const hero = el("hero");
    if (g.sizes.tops) {
      hero.appendChild(el("slot", "TOP"));
      hero.appendChild(el("size", g.sizes.tops.toUpperCase()));
    }
    if (g.sizes.bottoms) {
      hero.appendChild(el("slot", "BTM"));
      hero.appendChild(el("size", g.sizes.bottoms.toUpperCase()));
    }
    root.appendChild(hero);
  }

  const card = el("card" + (s.clickedIn ? " clicked-in" : ""));
  card.tabIndex = 0;
  card.appendChild(el("title", titleOf(s)));
  const body = el("body");
  const rows = contentOf(s.cards[s.index]);
  const shown = s.clickedIn ? rows.slice(s.offset, s.offset + VISIBLE_ROWS) : rows.slice(0, VISIBLE_ROWS);
  shown.forEach((r, i) => body.appendChild(el("line" + (s.index === 0 && i === 0 ? " peak" : ""), r)));
  card.appendChild(body);
  const meta = s.cards[s.index].meta;
  if (meta?.length) card.appendChild(el("meta", joinMeta(meta)));
  root.appendChild(card);
  card.focus();

  const hint = s.clickedIn ? "SELECT BACK" : s.index === 0 ? "SELECT DONE" : "SELECT OPEN";
  root.appendChild(
    el("foot", joinMeta([payload.zone, payload.latency_s !== undefined ? `${payload.latency_s}S` : ""]) || " ")
  ).appendChild(el("hint", hint));
}
