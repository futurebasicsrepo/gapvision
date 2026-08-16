import { useLayoutEffect, useRef } from "react";

/**
 * Decode — text that resolves out of noise.
 *
 * The site does this because it is the product's behaviour quoted back: a cue
 * arrives in the glass by resolving, so a label arrives on a screen the same
 * way. It is not ornament and it is not applied everywhere — panel titles and
 * rail labels on arrival, and nothing that changes on a poll. A dashboard that
 * re-scrambles every sixty seconds is unreadable.
 *
 * Two things the site got wrong first, fixed here from the start:
 *
 *  · Words are wrapped, not just characters. Per-character inline-block spans
 *    give the line a soft-wrap opportunity between every letter, so a title
 *    breaks mid-word (`tuesd/ay`) the moment the column narrows. Characters
 *    are grouped inside a per-word span that carries `white-space: nowrap`,
 *    and the spaces between words stay plain text nodes so the line still
 *    wraps where a line is supposed to wrap.
 *
 *  · `prefers-reduced-motion` resolves instantly. Not a shorter animation —
 *    no animation at all, final string, first paint. The rAF loop is never
 *    started.
 *
 * Replay is cheap on purpose: the element is split into spans once per string
 * and the spans are cached, so entering a panel a second time swaps text
 * content on nodes that already exist rather than rebuilding the DOM.
 */

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/<>*#=+";

const DELAY = 430;      // ms before the first character starts resolving
const STAGGER = 26;     // ms between one character landing and the next
const TICK = 44;        // ms per scramble frame
const MIN_ITER = 3;     // scramble frames a character does before it lands
const MAX_ITER = 5;
const LIT = 140;        // ms the landing flash stays on

const TAIL = MAX_ITER * TICK;

/** Deterministic per index, so the churn varies down the line but the landing
 *  order never does — the resolve has to read left to right. */
const iterations = (i) => MIN_ITER + (i % (MAX_ITER - MIN_ITER + 1));

const glyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];

export function prefersReducedMotion() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Split `el` into per-word spans of per-character spans. Returns the flat list
 * of character spans in reading order, paired with the value each must settle
 * to. Spaces are emitted as text nodes between words — they are the only wrap
 * opportunities the line gets.
 */
function split(el, text) {
  const chars = [];
  const values = [];
  const frag = document.createDocumentFragment();
  let word = null;

  for (const ch of Array.from(text)) {
    if (ch === " ") {
      word = null;
      frag.appendChild(document.createTextNode(" "));
      continue;
    }
    if (!word) {
      word = document.createElement("span");
      word.className = "decode-word";
      frag.appendChild(word);
    }
    const span = document.createElement("span");
    span.className = "decode-char";
    span.textContent = ch;
    word.appendChild(span);
    chars.push(span);
    values.push(ch);
  }

  el.textContent = "";
  el.appendChild(frag);
  return { chars, values };
}

export default function Decode({ text, as: Tag = "span", replay, className, ...rest }) {
  const host = useRef(null);
  const cache = useRef({ text: null, chars: [], values: [] });
  const raf = useRef(0);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    const value = String(text ?? "");

    // Split once per string. Re-entering a panel reuses the spans. The
    // `firstChild` half of the test is the case where React handed us a fresh
    // element for the same string — the cache would otherwise be pointing at
    // spans that are no longer in the document, and nothing would render.
    if (cache.current.text !== value || !el.firstChild) {
      cache.current = { text: value, ...split(el, value) };
    }
    const { chars, values } = cache.current;

    const settle = () => {
      for (let i = 0; i < chars.length; i++) {
        chars[i].textContent = values[i];
        chars[i].classList.remove("lit");
      }
    };

    if (prefersReducedMotion() || !chars.length) {
      settle();
      return undefined;
    }

    // Landing times are a constant tail past the stagger, so a character that
    // churns for five frames still lands after the one before it.
    const landAt = (i) => DELAY + i * STAGGER + TAIL;
    const startAt = (i) => landAt(i) - iterations(i) * TICK;
    const done = landAt(chars.length - 1) + LIT;

    // A held glyph before a character starts churning: the whole line is noise
    // from the first frame and clears left to right, rather than growing.
    const held = chars.map(() => glyph());
    for (let i = 0; i < chars.length; i++) {
      chars[i].textContent = held[i];
      chars[i].classList.remove("lit");
    }

    const t0 = performance.now();
    const landed = chars.map(() => false);
    let frame = -1;

    const step = (now) => {
      const t = now - t0;
      const f = Math.floor(t / TICK);
      const churned = f !== frame;
      frame = f;

      for (let i = 0; i < chars.length; i++) {
        const span = chars[i];
        const land = landAt(i);
        if (t >= land) {
          if (!landed[i]) {
            landed[i] = true;
            span.textContent = values[i];
            span.classList.add("lit");
          } else if (t >= land + LIT) {
            span.classList.remove("lit");
          }
        } else if (churned && t >= startAt(i)) {
          span.textContent = glyph();
        }
      }

      if (t < done) {
        raf.current = requestAnimationFrame(step);
      } else {
        settle();
        raf.current = 0;
      }
    };

    raf.current = requestAnimationFrame(step);

    // A backstop, because rAF does not run in a hidden tab. Without it a
    // console opened in a background tab and left there would sit on a title
    // made of noise until somebody looked at it. Timers are throttled in the
    // background but they still fire, so the worst case is a title that is
    // simply correct rather than one that is garbage.
    const guard = setTimeout(settle, done + 400);

    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
      clearTimeout(guard);
      // Whatever interrupted this, the string it was resolving to is the one
      // that must be on screen.
      settle();
    };
  }, [text, replay]);

  return <Tag ref={host} className={className ? `decode ${className}` : "decode"} {...rest} />;
}
