/**
 * Work done on a dead network.
 *
 * Retail wifi is not down — it is intermittent behind concrete and steel
 * fixtures, in the exact spot where the denim is. An associate who claims a
 * request in that spot has done the thing; whether the socket happened to be
 * up is not their problem and must not become the guest's.
 *
 * So outbound actions queue, survive a restart, and replay in order.
 *
 * ── Two rules that are not obvious ───────────────────────────────────────
 *
 * **1. The queue is visible.** `pending()` drives a line in the UI reading
 * "not connected · 2 waiting". An action that silently did not happen is worse
 * than one that visibly has not happened *yet*: the second is a person waiting,
 * the first is a person who thinks they are finished.
 *
 * **2. A queued action carries ids and verbs, never a guest.** This is the one
 * thing in the app that is written to disk and derived from an engagement, so
 * it is the one place a customer could leak into storage. Each action type
 * declares its payload keys and everything else is dropped at enqueue time —
 * see `SHAPES`. "Claim request 41f3" is safe to persist; "Claim Sarah Chen at
 * the denim wall" is not, and nothing here can accidentally become the second.
 */

export type ActionType = "claim" | "release" | "end" | "floor:message" | "mark";

/**
 * The declared payload of each action, key by key.
 *
 * A whitelist rather than a type assertion, because TypeScript is not present
 * at runtime and the risk here is a runtime one: an object spread that picks
 * up `guest.name` because it happened to be on the source object.
 */
const SHAPES: Record<ActionType, readonly string[]> = {
  claim: ["requestId"],
  release: ["requestId"],
  end: ["engagementId"],
  // `text` is typed by the associate, so it is theirs, bounded, and the one
  // free-text field allowed through. `to` is a socket id, not a person.
  "floor:message": ["text", "to"],
  mark: ["sku", "kind"],
};

/** Text an associate typed. Bounded so a stuck key cannot fill a phone. */
export const MAX_TEXT = 500;
/** Beyond this, the oldest actions are dropped and the drop is reported. */
export const MAX_QUEUE = 50;

export interface QueuedAction {
  id: string;
  type: ActionType;
  payload: Record<string, string>;
  at: string;
  attempts: number;
}

/** Strip a payload to its declared keys, stringified and bounded. */
export function shape(type: ActionType, payload: Record<string, unknown>): Record<string, string> {
  const allowed = SHAPES[type] || [];
  const out: Record<string, string> = {};
  for (const k of allowed) {
    const v = payload?.[k];
    if (v === undefined || v === null) continue;
    out[k] = String(v).slice(0, MAX_TEXT);
  }
  return out;
}

export interface QueueIO {
  read(): string | null;
  write(value: string): void;
}

/**
 * A durable FIFO of outbound actions.
 *
 * Constructed with its own storage rather than reaching for `localStorage`, so
 * the whole thing runs under `node --test` — the ordering and the overflow
 * behaviour are exactly the parts that are miserable to debug from a shop
 * floor and trivial to pin down here.
 */
export class ActionQueue {
  private items: QueuedAction[] = [];
  private dropped = 0;

  constructor(private io: QueueIO, private now: () => string = () => new Date().toISOString()) {
    this.load();
  }

  private load(): void {
    try {
      const raw = this.io.read();
      const parsed = raw ? JSON.parse(raw) : [];
      // A corrupt queue is dropped rather than crashing the app. Losing unsent
      // work is bad; a phone that will not boot on a shop floor is worse, and
      // the corrupt case means we could not read the work anyway.
      this.items = Array.isArray(parsed) ? parsed.filter(isAction) : [];
    } catch {
      this.items = [];
    }
  }

  private save(): void {
    try { this.io.write(JSON.stringify(this.items)); } catch { /* full disk, nothing to do */ }
  }

  /** Add an action. Returns it, shaped — the caller shows what was queued. */
  push(type: ActionType, payload: Record<string, unknown> = {}, id?: string): QueuedAction {
    const action: QueuedAction = {
      id: id || `${type}-${this.items.length}-${this.now()}`,
      type,
      payload: shape(type, payload),
      at: this.now(),
      attempts: 0,
    };
    this.items.push(action);
    while (this.items.length > MAX_QUEUE) {
      this.items.shift();
      this.dropped++;
    }
    this.save();
    return action;
  }

  /** What is waiting, oldest first. A copy — callers must not mutate it. */
  pending(): QueuedAction[] {
    return this.items.map((a) => ({ ...a, payload: { ...a.payload } }));
  }

  get length(): number { return this.items.length; }

  /**
   * How many actions were dropped for overflow.
   *
   * Surfaced rather than swallowed: fifty unsent actions means something is
   * badly wrong, and an app that silently forgot the first ten is an app that
   * lied about the second rule at the top of this file.
   */
  get droppedCount(): number { return this.dropped; }

  /**
   * Send everything, in order, stopping at the first failure.
   *
   * In order and stop-on-failure, both deliberately. These actions are about
   * the same few engagements — claim then end, in that order — and replaying
   * out of order or skipping past a failure produces a state on the floor that
   * nobody can reason about afterwards.
   */
  async flush(send: (a: QueuedAction) => Promise<boolean>): Promise<{ sent: number; left: number }> {
    let sent = 0;
    while (this.items.length) {
      const head = this.items[0];
      head.attempts++;
      let ok = false;
      try { ok = await send(head); } catch { ok = false; }
      if (!ok) { this.save(); break; }
      this.items.shift();
      sent++;
      this.save();
    }
    return { sent, left: this.items.length };
  }

  clear(): void {
    this.items = [];
    this.dropped = 0;
    this.save();
  }
}

function isAction(v: unknown): v is QueuedAction {
  const a = v as QueuedAction;
  return !!a && typeof a.id === "string" && typeof a.type === "string"
    && a.type in SHAPES && typeof a.payload === "object" && a.payload !== null;
}
