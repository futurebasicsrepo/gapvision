/**
 * @cue/lens-core — the parts of a lens that are not a screen.
 *
 * Three surfaces render a cue now: the Even G2 plugin, the Meta Ray-Ban
 * Display web app, and the phone in an associate's pocket. They share almost
 * nothing physically — 576×288 monochrome over BLE, 600×600 colour on-glass,
 * and whatever an iPhone 13 is — and they must share everything semantically.
 *
 * That is the whole reason this package exists. If the card deck forks, an
 * associate who moves from the handheld to the glasses relearns the product,
 * and worse, the two surfaces start answering the same question differently.
 * The grammar (`toDisplayText`, `money`, `joinMeta`), the deal (`cardsFor`)
 * and the navigation (`move`, `select`, `back`) are decided once, here.
 *
 * Everything in here is pure: no DOM, no socket, no storage, no platform.
 * That is enforced by the fact that `npm test` runs it under plain node.
 * Anything that needs a browser belongs in the surface package, not here.
 */
export * from "./types.js";
export * from "./grammar.js";
export * from "./deck.js";
