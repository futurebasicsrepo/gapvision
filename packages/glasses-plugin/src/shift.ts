/**
 * Shift boundaries, glasses health, and the events the wifi ate.
 *
 * ## What this is for
 *
 * Everything the dashboards show is a raw count. A raw count has no
 * denominator, so it punishes the person who works Tuesday mornings and
 * rewards whoever left the app running over lunch. `register` fired when the
 * app opened and nothing ever closed it, so "cues per hour worked" had no
 * bottom half at all.
 *
 * Three jobs, and all of them are plumbing:
 *
 *   1. **Say when a shift starts and ends.** Including when the app is torn
 *      down, which on this host happens every time the phone goes in a pocket.
 *   2. **Report what the glasses say about themselves.** `DeviceStatus` has
 *      been in the SDK the whole time and nothing read it. A pair that dies at
 *      3pm every day reads on a leaderboard as somebody who stops working
 *      after lunch.
 *   3. **Survive the wifi.** Shop networks drop. Events used to be fired into
 *      a closed socket and lost, after which a dashboard reported something
 *      that did not happen.
 *
 * ## The rule about time
 *
 * **Every buffered event carries the moment it occurred, not the moment it was
 * delivered.** That is the entire point of the buffer: a shift that ended at
 * 17:58 and reached the server at 09:04 the next morning is a shift that ended
 * at 17:58, and reporting the delivery time would be worse than losing the
 * event, because a wrong number looks like a real one.
 *
 * The server side treats that timestamp as a *claim*, not a fact — it decides
 * ordering and identity within one phone's own history, and never a duration,
 * a bill or a retention window. See `app/shifts.py`. This module's job is to
 * stamp it honestly at the moment the thing happened and then never touch it
 * again.
 *
 * ## The one thing that is never buffered
 *
 * A heartbeat. Its entire content is "I am here now", and a stale one replayed
 * an hour later is a lie about the only thing it claims. If the socket is
 * down, the heartbeat is simply not sent — and the gap that leaves is the
 * signal the server uses to close the shift at the right moment.
 *
 * ## Gating
 *
 * Nothing here runs unless the tenant's `shift_telemetry` capability is true.
 * That flag is the store's decision about measuring its own staff; the copy
 * this module holds decides what is *sent*, and the service re-reads the real
 * one before anything is *recorded*. A `stop` from the server (a 403 — the
 * store has it off after all) disables the controller for the session rather
 * than re-queueing forever.
 */

/** One buffered event, as it sits on the phone. */
export interface QueuedEvent {
  event: string;
  payload: Record<string, unknown>;
  /** ISO 8601, stamped when the thing happened. Never rewritten on replay. */
  occurredAt: string;
}

/** The two things this module persists, namespaced away from `cue.pref.`. */
export const SHIFT_KEY = "cue.shift.id";
export const QUEUE_KEY = "cue.shift.queue";

/**
 * How many events the phone will hold.
 *
 * Bounded because the store is a string in a key-value slot with no quota
 * anyone can query, and an unbounded queue is a plugin that eventually cannot
 * save a preference. Sixty is a long outage's worth of the events that are
 * actually buffered — shifts and battery samples, not heartbeats.
 *
 * When it is full the **oldest** goes. The end of a shift is worth more than
 * the battery reading from four hours ago, and the newest events are the ones
 * a dashboard is about to be asked about.
 */
export const MAX_QUEUED = 60;

/** What may be buffered at all. An allowlist, so a future caller cannot
 *  accidentally give a floor message or a request claim a timestamp of its
 *  own choosing and a delivery an hour late. */
export const BUFFERABLE = new Set(["shift:start", "shift:end", "device:health"]);

export interface ShiftStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<boolean>;
}

export interface ShiftDeps {
  emit(event: string, payload: Record<string, unknown>): void;
  /** Whether the socket is up *right now*. Called at emit time, never cached:
   *  the whole failure being fixed here is a send into a connection that was
   *  open when we last looked. */
  connected(): boolean;
  store: ShiftStore;
  serial?: string | null;
  model?: string | null;
  /** Read at send time, not captured at construction: an associate changes
   *  their zone mid-shift and the record should say where they actually were
   *  when the shift opened, not where they were when the page booted. */
  zone?: () => string | null;
  log?: (message: string) => void;
  /** Injected so tests can move time without sleeping. */
  now?: () => number;
  /** Injected so tests do not have to run real timers. */
  setInterval?: (fn: () => void, ms: number) => any;
  clearInterval?: (handle: any) => void;
}

/**
 * How much a battery has to move before it is worth a row.
 *
 * The host pushes a status on every change it notices, including wear and
 * case changes that leave the level identical. Sending all of them would fill
 * a table with the same number. One point of battery is the finest resolution
 * the SDK reports, so any change at all is meaningful — what is filtered is
 * the *unchanged* status, plus a floor on how often an unchanged one may
 * repeat so a pair sitting at 61% still proves it is alive.
 */
export const STATUS_REPEAT_MS = 5 * 60_000;

export class ShiftController {
  private deps: ShiftDeps;
  private queue: QueuedEvent[] = [];
  private shiftId: string | null = null;
  private timer: any = null;
  private heartbeatMs = 60_000;
  private lastStatus: string | null = null;
  private lastStatusAt = 0;
  private stopped = false;
  private loaded = false;
  /** True between asking for a shift and hearing back, so a reconnect storm
   *  cannot open three. */
  private opening = false;

  constructor(deps: ShiftDeps) {
    this.deps = deps;
  }

  get current(): string | null { return this.shiftId; }
  get pending(): QueuedEvent[] { return [...this.queue]; }
  get disabled(): boolean { return this.stopped; }

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private stamp(): string { return new Date(this.now()).toISOString(); }
  private log(msg: string) { this.deps.log?.(msg); }

  /**
   * Read what the last run of this app left behind.
   *
   * Both halves matter and they matter for different reasons. The shift id is
   * how a WebView teardown stops being nine shifts. The queue is how an event
   * that happened while the phone was offline — including the end of a shift,
   * fired as the app was being taken away — reaches the server at all.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.shiftId = await this.deps.store.get(SHIFT_KEY);
    } catch { this.shiftId = null; }
    try {
      const raw = await this.deps.store.get(QUEUE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      // A store that came back garbled costs the buffer, not the shift. An
      // unreadable queue is dropped rather than guessed at: a half-parsed
      // event with an invented timestamp is exactly the fiction this file
      // exists to prevent.
      this.queue = Array.isArray(parsed)
        ? parsed.filter((e: any) =>
            e && typeof e.event === "string" && typeof e.occurredAt === "string"
            && BUFFERABLE.has(e.event))
        : [];
    } catch { this.queue = []; }
    if (this.queue.length) this.log(`telemetry: ${this.queue.length} buffered event(s)`);
  }

  /**
   * Write the buffer to the phone, and say so if the phone would not take it.
   *
   * `setLocalStorage` answers a boolean and **the boolean is the contract** —
   * the same rule `prefs.ts` follows. A refusal here is not fatal, because the
   * queue still lives in memory and an associate mid-shift must not lose the
   * product because a diagnostic could not be filed. It is the difference
   * between "we will deliver this later" and "we will deliver this if the page
   * survives", and only one of those is worth believing.
   */
  private async persistQueue(): Promise<void> {
    let stored = false;
    try {
      stored = await this.deps.store.set(QUEUE_KEY, JSON.stringify(this.queue));
    } catch { stored = false; }
    if (!stored) this.log("telemetry: the phone refused to store the buffer");
  }

  private async persistShift(): Promise<void> {
    try {
      await this.deps.store.set(SHIFT_KEY, this.shiftId ?? "");
    } catch { /* the next launch starts a new shift, which is honest */ }
  }

  /**
   * Send it, or keep it until we can.
   *
   * The timestamp is taken here — at the moment the caller says the thing
   * happened — and travels with the event whichever path it takes. A live
   * send and a replayed one therefore carry the same value, which is the
   * property the whole design rests on.
   */
  private async dispatch(event: string, payload: Record<string, unknown>): Promise<void> {
    if (this.stopped) return;
    const occurredAt = this.stamp();
    if (this.deps.connected()) {
      this.deps.emit(event, { ...payload, occurredAt });
      return;
    }
    if (!BUFFERABLE.has(event)) return;
    this.queue.push({ event, payload, occurredAt });
    while (this.queue.length > MAX_QUEUED) this.queue.shift();
    await this.persistQueue();
    this.log(`telemetry: buffered ${event} (${this.queue.length} waiting)`);
  }

  /**
   * The wifi came back.
   *
   * Buffered events first, then the shift. Order matters: a start that was
   * buffered yesterday has to reach the server before today's live one, or the
   * live shift gets superseded by a replay of an older one and the timeline
   * reads backwards.
   *
   * The queue is cleared on acknowledgement, not on send — a flush that went
   * into a socket which then dropped has not been delivered. Replaying twice
   * is safe: every buffered event carries the phone's own timestamp, and the
   * service treats that as the event's identity.
   */
  async onConnect(): Promise<void> {
    if (this.stopped) return;
    await this.load();
    if (this.queue.length) {
      this.deps.emit("telemetry:replay", { events: this.pending });
      this.log(`telemetry: replaying ${this.queue.length} event(s)`);
    }
    await this.open();
  }

  /** The server took the buffer. Only now is it safe to forget. */
  async onReplayed(accepted: number): Promise<void> {
    if (!this.queue.length) return;
    this.log(`telemetry: server accepted ${accepted} replayed event(s)`);
    this.queue = [];
    await this.persistQueue();
  }

  /** Clock in, or resume the shift this phone still believes in. */
  async open(): Promise<void> {
    if (this.stopped || this.opening) return;
    await this.load();
    this.opening = true;
    await this.dispatch("shift:start", {
      resumeShiftId: this.shiftId || null,
      zone: this.deps.zone?.() || null,
    });
  }

  /**
   * The server's answer: which shift we are on, or why we are on none.
   *
   * A `stop` is a 403 — the retailer has shift telemetry switched off, and
   * this client's copy of the capability was wrong or stale. It disables the
   * controller for the session rather than retrying, because retrying would
   * mean hammering a store's own network to deliver records that store has
   * explicitly declined.
   */
  async onState(state: any): Promise<void> {
    this.opening = false;
    if (state?.stop) {
      this.stopped = true;
      this.stopHeartbeat();
      this.shiftId = null;
      this.queue = [];
      await this.persistQueue();
      await this.persistShift();
      this.log(`telemetry: stopped — ${state.reason || "the store has this off"}`);
      return;
    }
    if (state?.open && state.shift_id) {
      this.shiftId = String(state.shift_id);
      await this.persistShift();
      const seconds = Number(state.heartbeat_seconds);
      if (Number.isFinite(seconds) && seconds > 0) this.heartbeatMs = seconds * 1000;
      this.startHeartbeat();
      this.log(`shift ${state.resumed ? "resumed" : "started"} ${this.shiftId}`);
      return;
    }
    // Closed, or never opened. Either way this phone is not on a shift, and
    // the id it was holding is no longer one the server will accept.
    this.shiftId = null;
    await this.persistShift();
    this.stopHeartbeat();
    if (state?.reason) this.log(`shift closed (${state.reason})`);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const every = this.deps.setInterval ?? setInterval;
    this.timer = every(() => {
      // Never buffered. Its whole content is "now", and a stale "now"
      // delivered an hour late is a lie about the only thing it says. The gap
      // it leaves is the signal — the server closes the shift at the last
      // heartbeat it actually received.
      if (this.shiftId && this.deps.connected()) {
        this.deps.emit("shift:heartbeat", {});
      }
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.timer === null) return;
    (this.deps.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
  }

  /**
   * Clock out.
   *
   * `app_closed` is the one that arrives as the WebView is being taken away,
   * which is also the one most likely to be buffered rather than sent: the
   * page is dying and the socket may already be gone. That is precisely why it
   * carries its own timestamp — it will be delivered on the next launch, and
   * without the stamp the shift would appear to have ended whenever the
   * associate next opened the app.
   */
  async close(reason: "signed_out" | "app_closed" = "app_closed"): Promise<void> {
    if (this.stopped) return;
    if (!this.shiftId) return;
    const shiftId = this.shiftId;
    this.shiftId = null;
    this.stopHeartbeat();
    await this.persistShift();
    await this.dispatch("shift:end", { reason, shiftId });
  }

  /**
   * One `DeviceStatus` from the glasses.
   *
   * Filtered, not throttled by count: an unchanged status is dropped, and an
   * unchanged status repeats at most every `STATUS_REPEAT_MS` so a pair that
   * has been sitting at 61% all afternoon still proves it is on the floor. A
   * changed one always goes — a drop from 21% to 19% is the whole point.
   */
  async onStatus(status: {
    serial: string; connection: string; batteryPercent?: number;
    charging?: boolean; wearing?: boolean; inCase?: boolean;
  }): Promise<void> {
    if (this.stopped || !status?.serial) return;
    const key = [status.serial, status.connection, status.batteryPercent,
                 status.charging, status.inCase].join("|");
    const at = this.now();
    if (key === this.lastStatus && at - this.lastStatusAt < STATUS_REPEAT_MS) return;
    this.lastStatus = key;
    this.lastStatusAt = at;
    await this.dispatch("device:health", {
      serial: status.serial,
      model: this.deps.model || null,
      batteryPercent: status.batteryPercent ?? null,
      charging: status.charging ?? null,
      wearing: status.wearing ?? null,
      inCase: status.inCase ?? null,
      connection: status.connection,
    });
  }

  /** Stop everything. Used when the page is going away for good. */
  dispose(): void { this.stopHeartbeat(); }
}

/**
 * What the associate's own phone page says when this is switched on.
 *
 * Not buried in a diagnostics drawer and not phrased as a feature. Somebody
 * being measured should not have to read a schema to find out — it goes on the
 * identity line, beside their name and their serial, in the same mono face the
 * rest of the machine's answers use.
 *
 * Exported so the sentence has one source and a test can hold it to saying the
 * three things it has to say: that it is on, that it is the store's setting,
 * and what is actually recorded.
 */
export const TELEMETRY_NOTICE =
  "SHIFT TIMING ON · THIS STORE RECORDS WHEN YOU START AND STOP, AND YOUR GLASSES BATTERY";
