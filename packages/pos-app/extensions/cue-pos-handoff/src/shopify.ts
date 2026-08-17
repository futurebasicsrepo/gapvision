/**
 * The POS host global, typed loosely on purpose.
 *
 * `@shopify/ui-extensions` ships full types per target, but they move with
 * every quarterly API version and this extension touches a handful of calls
 * (session token, cart writes, toast, modal). A loose binding keeps the
 * source compiling across versions; the real contract is exercised on a dev
 * store via `shopify app dev`, which is the only place POS code can run
 * anyway. Tighten to the generated types once the extension stops moving.
 */
export const shopify: any = (globalThis as any).shopify;

/** One line of a Cue handoff, as the realtime server sends it. */
export interface HandoffLine {
  title: string;
  price: number | null;
  variantId: number | null;
  qty: number;
}

/** One live engagement, as `/pos/handoff` answers. */
export interface HandoffSession {
  guest: string;
  tier: string;
  zone: string;
  at: string;
  associate: string | null;
  engagement_id: string | null;
  customer_id: number | null;
  lines: HandoffLine[];
}
