/**
 * Drawing Pocket.
 *
 * Plain DOM, no framework, for the same reason the sales site has no build
 * step: the surface this runs on is a mid-range Android on shop wifi, and
 * every kilobyte of framework is time an associate spends looking at nothing
 * while a guest waits. The whole app is a handful of screens and a card deck;
 * a virtual DOM would be more code than the thing it renders.
 *
 * `@cue/lens-core` decides *what* is on the card. This file decides how big it
 * is and where the thumb goes, and nothing else.
 */
import { contentOf, titleOf, VISIBLE_ROWS, type DeckState } from "@cue/lens-core";
import type { Capabilities } from "./platform.js";
import { gaps } from "./platform.js";
import { holdsSummary, type PocketMode } from "./identity.js";

export interface Chrome {
  connected: boolean;
  pending: number;
  zone: string;
  tenantLabel: string;
}

const el = (tag: string, cls?: string, text?: string) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** The status strip. Present on every screen, so state is never a surprise. */
export function strip(c: Chrome): HTMLElement {
  const s = el("div", "strip");
  s.append(el("span", "wordmark", "CUE"));
  const dot = el("span", `dot ${c.connected ? "live" : c.pending ? "queued" : ""}`);
  s.append(dot);
  // The sentence, not the icon. "Not connected · 2 waiting" tells an associate
  // that their work is held and will go; a grey dot tells them nothing, and a
  // silent failure tells them something false.
  s.append(el("span", "", c.connected ? "on the floor" : "not connected"));
  if (c.pending > 0) {
    s.append(el("span", "pending", `· ${c.pending} waiting`));
  }
  s.append(el("span", "spacer"));
  s.append(el("span", "", c.zone));
  return s;
}

export function notice(text: string, opts: { calm?: boolean; onDismiss?: () => void } = {}): HTMLElement {
  const n = el("div", `notice${opts.calm ? " calm" : ""}`);
  n.append(el("span", "", text));
  if (opts.onDismiss) {
    const x = el("span", "x", "×");
    x.setAttribute("role", "button");
    x.setAttribute("aria-label", "Dismiss");
    x.addEventListener("click", opts.onDismiss);
    n.append(x);
  }
  return n;
}

/**
 * The engagement: one card, filling the screen.
 *
 * On glass a card is three lines because three lines is what fits. Here it is
 * three lines because that is the grammar every surface shares — the phone has
 * the room for more and deliberately does not take it, so an associate who
 * switches to glasses next week sees the same card, not a smaller one.
 */
export function deckScreen(deck: DeckState, chrome: Chrome, actions: {
  onSelect: () => void; onBack: () => void; onEnd: () => void;
}, ask?: HTMLElement | null): HTMLElement {
  const root = el("div", "stage");
  const card = el("div", `card${deck.clickedIn ? " clicked-in" : ""}`);
  const current = deck.cards[deck.index];

  card.append(el("div", "kicker", titleOf(deck)));

  const rows = el("div", "rows");
  const all = contentOf(current);
  const visible = deck.clickedIn ? all.slice(deck.offset, deck.offset + VISIBLE_ROWS) : current.lines;
  visible.forEach((line, i) => {
    rows.append(el("div", `row${i === 0 && !deck.clickedIn ? " lead" : ""}`, line));
  });
  card.append(rows);

  if (current.meta?.length) card.append(el("div", "meta", current.meta.join(" · ")));
  root.append(card);

  const pips = el("div", "pips");
  deck.cards.forEach((_, i) => pips.append(el("span", `pip${i === deck.index ? " on" : ""}`)));
  root.append(pips);

  // Three buttons, thumb-height, in the bottom third. The swipe gestures do
  // the same work; the buttons exist because a phone held in a gloved hand, or
  // by somebody who has used the app for one shift, needs a target it can see.
  const bar = el("div", "actions");
  const back = el("button", "btn quiet", deck.clickedIn ? "Back" : "End");
  back.addEventListener("click", () => (deck.clickedIn ? actions.onBack() : actions.onEnd()));
  const open = el("button", "btn primary", deck.clickedIn ? "Close" : "Open");
  open.addEventListener("click", actions.onSelect);
  bar.append(back, open);
  root.append(bar);

  // Standing with a guest is exactly when a question gets asked — "do you have
  // this in a 32" is a sentence said *at* somebody, not away from them. The
  // control is below the deck actions so a thumb reaching for Open never
  // opens a microphone by accident.
  if (ask) root.append(ask);

  return root;
}

/**
 * Ask, as a thumb holds it.
 *
 * Press and hold to talk, release to send — the idiom every messaging app on
 * this phone already taught the associate, and the reason Pocket needs none of
 * the glasses' endpointing: the finger *is* the endpoint.
 *
 * The meter is not decoration. A microphone that is open and hearing nothing
 * looks exactly like a microphone that is open and working, and the difference
 * is a question the associate has to ask twice in front of a guest.
 *
 * `pointer` events rather than touch/mouse pairs: one code path for a gloved
 * thumb, a stylus and a desktop test, and `setPointerCapture` keeps the
 * release ours even when the finger slides off the button mid-sentence — which
 * is otherwise a mic left open until the twelve-second cap.
 */
export function askButton(opts: {
  state: "idle" | "listening" | "thinking" | "denied" | "unsupported";
  level: number;
  onStart: () => void;
  onStop: () => void;
}): HTMLElement {
  const wrap = el("div", `ask ${opts.state}`);

  if (opts.state === "unsupported") {
    wrap.append(el("div", "ask-note", "This phone has no microphone Cue can use."));
    return wrap;
  }
  if (opts.state === "denied") {
    // The browser will not ask twice. Saying which switch to flip is the only
    // useful thing left, and it is not obvious on either platform.
    wrap.append(el("div", "ask-note",
      "Microphone blocked. Turn it on for this site in your browser settings, then try again."));
    return wrap;
  }

  const btn = el("button", "ask-btn",
    opts.state === "listening" ? "Listening — release to ask"
      : opts.state === "thinking" ? "Thinking…"
      : "Hold to ask") as HTMLButtonElement;
  btn.type = "button";
  btn.disabled = opts.state === "thinking";

  // The release is listened for on the *window*, not on the button.
  //
  // Pointer capture is the textbook answer and it is not enough on its own:
  // a thumb that slides off mid-sentence, a gesture the browser steals, a
  // capture that silently fails to bind — each leaves the button waiting for a
  // `pointerup` that lands somewhere else, and the mic stays open until the
  // twelve-second cap. That is the worst failure this control has: the
  // associate believes they asked, the light stays on, and the answer arrives
  // long after they stopped caring.
  //
  // So the button starts the utterance and the window ends it, whatever the
  // finger did in between. `onStop` is idempotent — it returns early unless
  // the mic is actually listening — so the duplicate that pointer capture
  // still delivers costs nothing.
  let release: ((e: PointerEvent) => void) | null = null;

  const down = (e: PointerEvent) => {
    e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch { /* not captureable */ }
    release = (ev: PointerEvent) => {
      window.removeEventListener("pointerup", release!);
      window.removeEventListener("pointercancel", release!);
      release = null;
      try { btn.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }
      opts.onStop();
    };
    window.addEventListener("pointerup", release);
    // A cancelled pointer — a call arrives, the gesture is stolen — must close
    // the mic on exactly the same path.
    window.addEventListener("pointercancel", release);
    opts.onStart();
  };
  btn.addEventListener("pointerdown", down);
  wrap.append(btn);

  const meter = el("div", "ask-meter");
  const fill = el("div", "ask-fill");
  // Mean amplitude is small even when someone is talking clearly; scaled so
  // the bar reads as a voice rather than as a flicker.
  fill.style.width = `${Math.min(100, Math.round(opts.level * 400))}%`;
  meter.append(fill);
  if (opts.state === "listening") wrap.append(meter);

  return wrap;
}

/** Waiting for the floor. */
export function idleScreen(chrome: Chrome, opts: {
  greeting: string | null;
  ask?: HTMLElement | null;
}): HTMLElement {
  const root = el("div", "idle");
  root.append(el("div", "big", opts.greeting ? `Ready, ${opts.greeting}` : "Ready"));
  root.append(el("div", "sub",
    "When a guest needs you, the card arrives here. You do not have to watch this screen."));
  // Ask is the one thing on this screen the associate starts. Everything else
  // here arrives; this is the surface saying it also answers.
  if (opts.ask) root.append(opts.ask);
  root.append(el("div", "zone", `${chrome.tenantLabel} · ${chrome.zone}`));
  return root;
}

/** Sign in — personal phones, and handhelds that want a sale attributed. */
export function signInScreen(opts: {
  error: string | null; busy: boolean;
  onSubmit: (email: string, password: string) => void;
}): HTMLElement {
  const form = el("form", "form") as HTMLFormElement;
  form.append(el("h1", "", "Sign in"));
  form.append(el("p", "lede", "Your own account, on your own phone."));
  if (opts.error) form.append(el("div", "err", opts.error));

  const mk = (label: string, type: string, name: string, autocomplete: AutoFill) => {
    const f = el("div", "field");
    const id = `f-${name}`;
    const l = el("label", "", label);
    l.setAttribute("for", id);
    const i = el("input") as HTMLInputElement;
    i.type = type; i.name = name; i.id = id; i.autocomplete = autocomplete;
    i.required = true;
    if (type === "email") { i.inputMode = "email"; i.autocapitalize = "off"; i.spellcheck = false; }
    f.append(l, i);
    form.append(f);
    return i;
  };
  const email = mk("Email", "email", "email", "username");
  const password = mk("Password", "password", "password", "current-password");

  const submit = el("button", "btn primary", opts.busy ? "Signing in…" : "Sign in") as HTMLButtonElement;
  submit.type = "submit";
  submit.disabled = opts.busy;
  const bar = el("div", "actions");
  bar.append(submit);
  form.append(bar);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    opts.onSubmit(email.value.trim(), password.value);
  });
  return form;
}

/**
 * Settings — and specifically, what this phone is holding.
 *
 * The privacy claim the deck makes to a merchant's security review is repeated
 * here, to the person whose phone it actually is. A promise made to a buyer
 * and withheld from the employee is a promise worth doubting.
 */
export function settingsScreen(opts: {
  mode: PocketMode;
  caps: Capabilities;
  who: string | null;
  onSignOut: () => void;
  onClose: () => void;
}): HTMLElement {
  const root = el("div", "settings");

  root.append(el("h2", "", "This device"));
  const holds = el("div", "holds");
  holds.append(el("span", "mode", opts.mode === "managed" ? "Store device" : "Your phone"));
  holds.append(el("span", "", holdsSummary(opts.mode)));
  root.append(holds);

  if (opts.who) {
    root.append(el("h2", "", "Signed in as"));
    root.append(el("div", "holds", opts.who));
  }

  const missing = gaps(opts.caps);
  if (missing.length) {
    root.append(el("h2", "", "On this phone"));
    const ul = el("ul", "gaps");
    for (const g of missing) ul.append(el("li", "", g));
    root.append(ul);
  }

  const bar = el("div", "actions");
  const close = el("button", "btn quiet", "Back");
  close.addEventListener("click", opts.onClose);
  // Named for what it does. "Sign out" on a personal phone that left data
  // behind would be a lie by omission, and this is the screen where the
  // promise above is either kept or not.
  const out = el("button", "btn", opts.mode === "personal" ? "Sign out & erase" : "Sign out");
  out.addEventListener("click", opts.onSignOut);
  bar.append(close, out);
  root.append(bar);

  return root;
}

/** Replace the app's contents in one go. */
export function paint(root: HTMLElement, ...children: (HTMLElement | null)[]): void {
  root.replaceChildren(...children.filter((c): c is HTMLElement => !!c));
}
