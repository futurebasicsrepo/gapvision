/**
 * Widgets whose content is data, fetched rather than built.
 *
 * `customer`, `inventory` and `messaging` are drawn from the live engagement —
 * the package knows how to build those cards because it knows what a guest is.
 * A **feed widget** is the other kind: its entire content is rows the control
 * plane holds, and the package's whole contribution is drawing a titled list.
 *
 * That distinction is why a new read-only widget does not cost a release.
 * Adding one is an id in the service's `FEED_WIDGETS`, a catalogue entry in
 * `widgets.ts`, and rows — no new `.ehpk` for every pair in the field. Kyle,
 * 17 Aug 2026, asked for widgets that plug in rather than forcing a rebuild
 * each time; this module is where that stops being a claim.
 *
 * ── Posture, copied deliberately from `fetchCapabilities` ────────────────
 *
 * Same shape and the same reasons: a bounded race against a timeout, and a
 * failure that returns *empty* rather than throwing. A shop floor's wifi must
 * never be in the path of a cue, and a promotions fetch that rejected would
 * take down a boot sequence that has real work to do.
 *
 * Empty is also the honest answer. A feed widget with nothing to show renders
 * its empty face rather than vanishing — the deck's length must not change
 * underneath somebody mid-shift — and "we could not ask" and "nothing is
 * running" look the same *to the glass* on purpose: neither is a promotion,
 * and neither is worth a line of 576px explaining itself.
 */

import type { Card } from "./cards";

/** One row: a title and the lines exactly as they should appear. */
export interface FeedItem {
  id: string;
  title: string;
  lines: string[];
}

export type Feeds = Record<string, FeedItem[]>;

const FEEDS_TIMEOUT_MS = 4_000;

/** How often to re-ask. A promotion's window opens on a boundary nobody is
 *  watching, and a shift outlasts a boot. Long enough that the floor's wifi is
 *  not carrying this, short enough that a promotion starting at noon is on the
 *  glass by ten past. */
export const FEEDS_REFRESH_MS = 10 * 60 * 1000;

export async function fetchFeeds(
  baseUrl: string,
  tenant: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Feeds> {
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), FEEDS_TIMEOUT_MS),
  );
  try {
    const res = await Promise.race([
      fetchImpl(`${baseUrl}/api/tenant/widgets?tenant=${encodeURIComponent(tenant)}`),
      timeout,
    ]);
    if (!res || !res.ok) return {};
    const body = await res.json();
    if (!body || typeof body !== "object" || typeof body.widgets !== "object") return {};
    return normaliseFeeds(body.widgets);
  } catch {
    return {};
  }
}

/**
 * Read what arrived without trusting it.
 *
 * This is a boundary in the same sense `normalisePrefs` is: rows are authored
 * by a retailer's admin and rendered onto a 576px monochrome display, so a
 * missing `lines`, a number where a string belongs, or a title somebody pasted
 * a paragraph into must resolve to something drawable rather than to a crash
 * in the middle of a shift.
 *
 * An item with no lines is dropped rather than drawn as a heading with nothing
 * under it — on the glass that reads as a fault, and there is no way for the
 * associate to tell it from one.
 */
export function normaliseFeeds(raw: unknown): Feeds {
  const out: Feeds = {};
  if (!raw || typeof raw !== "object") return out;

  for (const [widget, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const items: FeedItem[] = [];
    for (const row of value) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const lines = Array.isArray(r.lines)
        ? r.lines.filter((l): l is string => typeof l === "string" && l.trim().length > 0)
        : [];
      if (!lines.length) continue;
      items.push({
        id: typeof r.id === "string" ? r.id : `${widget}-${items.length}`,
        title: typeof r.title === "string" ? r.title : "",
        lines,
      });
    }
    out[widget] = items;
  }
  return out;
}


/**
 * Feed rows → cards the deck can carry.
 *
 * Pure, and separate from the fetch, for the reason every other decision in
 * this package is: what an associate *sees* should be testable in node, and
 * only the drawing should need a display. The G2 is one glasses platform and
 * will not be the last.
 *
 * The card grammar is the one already in use — three lines at a glance, the
 * whole content behind a click. A promotion with four lines is glanceable at
 * three and readable at four rather than truncated, because a promotion an
 * associate can only half-read is worse than one they have to click.
 *
 * Every row is its own card rather than one card per widget. Scrolling is how
 * this deck moves, and two promotions stacked into one card would need a click
 * to discover the second — whereas a second card is one scroll, which is the
 * gesture an associate is already making.
 */
export function feedCards(kind: string, items: FeedItem[]): Card[] {
  return items.map((item) => {
    const glance = item.lines.slice(0, 3);
    const card: Card = { kind, lines: glance };
    if (item.title) card.meta = [item.title.toUpperCase()];
    // `all` only when there is genuinely more than the glance shows —
    // otherwise clicking in would present the same three lines again, which
    // reads as a control that does nothing.
    if (item.lines.length > glance.length) card.all = item.lines;
    return card;
  });
}
