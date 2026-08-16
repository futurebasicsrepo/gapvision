import { useEffect, useRef } from "react";

/**
 * Text that resolves out of noise.
 *
 * The site's decode, quoted into the product: each character scrambles through
 * a glyph set and settles to its real value, left to right, with a brief lit
 * flash as it lands. It is not ornament — it is what a cue does in the glass,
 * said in a place a manager can see it.
 *
 * DUPLICATED ON PURPOSE. Console and Studio are separate Vercel roots and
 * cannot import across the package boundary, so this file exists twice and the
 * behaviour must stay identical. Change both or neither.
 *
 * Two things worth keeping:
 *
 *   · Characters are grouped into per-word spans carrying `white-space:
 *     nowrap`. A bare per-character `inline-block` gives the browser a break
 *     opportunity between every letter, so a heading wraps as `tuesd/ay`.
 *   · `prefers-reduced-motion` resolves instantly to the final string. Not a
 *     shorter animation — no animation, final value, immediately.
 *
 * Studio uses this sparingly and only on first paint: a number that
 * re-scrambles on every socket refresh is unreadable on a back-office monitor
 * somebody leaves open all day. `replay` exists for surfaces that enter and
 * leave; nothing in Studio sets it.
 */

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/<>*#=+";

const DELAY = 430;   // before the first character settles
const STAGGER = 26;  // per character, left to right
const TICK = 44;     // one scramble step
const LIT = 320;     // how long a landed character stays lit

const glyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];

function prefersReduced() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Split once. Words are spans so a wrap lands between words; characters are
 * spans inside them so they can be addressed individually. The real string is
 * carried by a visually hidden copy, because a screen reader reading live
 * scramble is noise with no meaning in it.
 */
function build(host, text) {
  host.textContent = "";

  const sr = document.createElement("span");
  sr.className = "dc-sr";
  sr.textContent = text;
  host.appendChild(sr);

  const view = document.createElement("span");
  view.className = "dc-v";
  view.setAttribute("aria-hidden", "true");

  const chars = [];
  for (const part of text.split(/(\s+)/)) {
    if (part === "") continue;
    if (/^\s+$/.test(part)) {
      view.appendChild(document.createTextNode(part));
      continue;
    }
    const word = document.createElement("span");
    word.className = "dc-w";
    for (const ch of part) {
      const cell = document.createElement("span");
      cell.className = "dc-c";
      cell.textContent = ch;
      word.appendChild(cell);
      chars.push({ el: cell, ch });
    }
    view.appendChild(word);
  }

  host.appendChild(view);
  return { text, chars };
}

function settle(parts) {
  for (const c of parts.chars) {
    if (c.el.textContent !== c.ch) c.el.textContent = c.ch;
    if (c.el.className !== "dc-c") c.el.className = "dc-c";
  }
}

export default function Decode({ text, replay = false, delay = DELAY, className }) {
  const host = useRef(null);
  const cache = useRef(null);
  const run = useRef({ startedFor: null, done: false });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const str = String(text ?? "");

    // Re-running on the same element is cheap: the spans are built once and
    // kept, and a replay only swaps their text content.
    if (!cache.current || cache.current.text !== str) cache.current = build(el, str);
    const parts = cache.current;

    if (parts.chars.length === 0) return;

    // Decode the first string this element is given, and after that only on
    // an explicit replay. A value that arrives while the first decode is
    // still running lands instantly rather than restarting it — otherwise a
    // panel refreshing faster than the animation never stops scrambling.
    // (The same-string case is left animatable so a dev-mode remount, which
    // mounts, unmounts and mounts again, still shows the effect.)
    const st = run.current;
    const animate = replay || (!st.done && (st.startedFor === null || st.startedFor === str));

    if (!animate || prefersReduced()) {
      settle(parts);
      st.done = true;
      return;
    }
    st.startedFor = str;

    // When each character stops scrambling: staggered left to right, three to
    // five iterations each. The whole string is noise from the first frame, so
    // nothing reflows when a character lands — only the delay is staggered.
    const settledAt = parts.chars.map((_, i) => delay + i * STAGGER + (3 + (i % 3)) * TICK);
    const finish = settledAt[settledAt.length - 1] + LIT + 40;

    for (const c of parts.chars) {
      c.el.className = "dc-c dc-noise";
      c.el.textContent = glyph();
    }

    const t0 = performance.now();
    let raf = 0;
    let lastStep = -1;

    const frame = (now) => {
      const t = now - t0;
      const step = Math.floor(t / TICK);
      const scrambling = step !== lastStep;
      lastStep = step;

      for (let i = 0; i < parts.chars.length; i++) {
        const c = parts.chars[i];
        const at = settledAt[i];
        if (t >= at) {
          if (c.el.textContent !== c.ch) c.el.textContent = c.ch;
          const want = t < at + LIT ? "dc-c dc-lit" : "dc-c";
          if (c.el.className !== want) c.el.className = want;
        } else if (scrambling) {
          c.el.textContent = glyph();
        }
      }

      if (t < finish) raf = requestAnimationFrame(frame);
      else {
        settle(parts);
        st.done = true;
      }
    };
    raf = requestAnimationFrame(frame);

    // A backstop, because rAF does not run in a hidden tab. Without it, a
    // dashboard opened in a background tab sits on noise until it is focused.
    const guard = setTimeout(() => {
      cancelAnimationFrame(raf);
      settle(parts);
      st.done = true;
    }, finish + 600);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(guard);
    };
  }, [text, replay, delay]);

  return <span ref={host} className={className ? `dc ${className}` : "dc"} />;
}
