/**
 * Gesture decoding — turns whatever the Even App hands us into an action.
 *
 * Until now this was a shim: every textEvent or listEvent became "press",
 * which meant double-press (and therefore voice) was unreachable on hardware
 * and the ring was invisible. It doesn't have to be. The SDK ships the actual
 * protobuf enums:
 *
 *   OsEventTypeList  CLICK / DOUBLE_CLICK / SCROLL_TOP / SCROLL_BOTTOM / …
 *   EventSourceType  GLASSES_R / GLASSES_L / RING
 *
 * So we decode properly and let the hardware confirm, rather than guessing
 * from hardware. Every raw event is still surfaced in the inspector panel —
 * if the host sends a shape we didn't anticipate, it shows up there rather
 * than being silently swallowed.
 *
 * Why the parsing is defensive: the host is Flutter, and the same field
 * arrives as a number (PB ordinal), a full string ("CLICK_EVENT"), a
 * shorthand ("CLICK"), or under a protoName key ("Event_Type"). The SDK's own
 * fromJson helpers are lenient for exactly this reason; we match that.
 */
import { EventSourceType, OsEventTypeList } from "@evenrealities/even_hub_sdk";

/** What the associate did, independent of which device they did it on. */
export type GestureAction =
  | "click"
  | "double-click"
  | "scroll-up"
  | "scroll-down"
  | "foreground-enter"
  | "foreground-exit"
  | "exit";

/** Which device produced it. "unknown" when the host omits the source —
 *  common for text/list container events, which carry no EventSource field. */
export type GestureSource = "ring" | "glasses-left" | "glasses-right" | "unknown";

export interface DecodedGesture {
  action: GestureAction;
  source: GestureSource;
  /** Which event envelope it arrived in — useful when confirming on device. */
  kind: "sys" | "text" | "list" | "mock";
  containerId?: number;
  containerName?: string;
  /** Selected item, for list containers. */
  itemIndex?: number;
  raw: unknown;
}

const ACTION_BY_EVENT_TYPE: Partial<Record<OsEventTypeList, GestureAction>> = {
  [OsEventTypeList.CLICK_EVENT]: "click",
  [OsEventTypeList.DOUBLE_CLICK_EVENT]: "double-click",
  [OsEventTypeList.SCROLL_TOP_EVENT]: "scroll-up",
  [OsEventTypeList.SCROLL_BOTTOM_EVENT]: "scroll-down",
  [OsEventTypeList.FOREGROUND_ENTER_EVENT]: "foreground-enter",
  [OsEventTypeList.FOREGROUND_EXIT_EVENT]: "foreground-exit",
  [OsEventTypeList.SYSTEM_EXIT_EVENT]: "exit",
  [OsEventTypeList.ABNORMAL_EXIT_EVENT]: "exit",
};

const SOURCE_BY_EVENT_SOURCE: Partial<Record<EventSourceType, GestureSource>> = {
  [EventSourceType.TOUCH_EVENT_FROM_RING]: "ring",
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_L]: "glasses-left",
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_R]: "glasses-right",
};

/** Read a value under any of several key spellings (camelCase | Proto_Name). */
function readAny(obj: any, ...keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  // Last resort: case/underscore-insensitive match.
  const flat = (s: string) => s.toLowerCase().replace(/[_\s-]/g, "");
  const wanted = keys.map(flat);
  for (const [k, v] of Object.entries(obj)) {
    if (wanted.includes(flat(k)) && v !== undefined && v !== null) return v;
  }
  return undefined;
}

/**
 * The SDK's fromJson takes ordinals and enum names, but not an ordinal that
 * arrived as a string — and Flutter's JSON layer does sometimes stringify
 * numbers (the SDK's own container parsers use `readNumber` for exactly this).
 * Coerce a digits-only string to a number before handing it over.
 */
function coerceEnumInput(value: any): any {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return value;
}

export function decodeAction(raw: any): GestureAction | undefined {
  const value = readAny(raw, "eventType", "Event_Type", "event_type", "type");
  if (value === undefined) return undefined;
  const normalized = OsEventTypeList.fromJson(coerceEnumInput(value));
  if (normalized !== undefined) return ACTION_BY_EVENT_TYPE[normalized];
  return undefined;
}

export function decodeSource(raw: any): GestureSource {
  const value = readAny(raw, "eventSource", "EventSource", "event_source", "source");
  if (value === undefined) return "unknown";
  const normalized = EventSourceType.fromJson(coerceEnumInput(value));
  if (normalized === undefined) return "unknown";
  return SOURCE_BY_EVENT_SOURCE[normalized] ?? "unknown";
}

/**
 * Decode a full EvenHubEvent envelope. Returns undefined for anything that
 * isn't a gesture (audio chunks, IMU reports, unrecognised shapes) so callers
 * can route those separately.
 */
export function decodeGesture(event: any): DecodedGesture | undefined {
  if (!event || typeof event !== "object") return undefined;

  // Dev/simulator path — the MockBridge speaks actions directly.
  if (event.mockGesture) {
    return {
      action: event.mockGesture as GestureAction,
      source: (event.mockSource as GestureSource) || "unknown",
      kind: "mock",
      raw: event,
    };
  }

  const candidates: Array<[DecodedGesture["kind"], any]> = [
    ["sys", event.sysEvent],
    ["text", event.textEvent],
    ["list", event.listEvent],
  ];

  for (const [kind, payload] of candidates) {
    if (!payload) continue;
    // IMU reports ride in on sysEvent; they are not gestures.
    if (kind === "sys" && readAny(payload, "imuData", "IMU_Data")) continue;

    const action = decodeAction(payload);
    if (!action) continue;

    return {
      action,
      source: decodeSource(payload),
      kind,
      containerId: numeric(readAny(payload, "containerID", "Container_ID", "containerId")),
      containerName: stringy(readAny(payload, "containerName", "Container_Name")),
      itemIndex: numeric(
        readAny(payload, "currentSelectItemIndex", "CurrentSelect_ItemIndex"),
      ),
      raw: event,
    };
  }
  return undefined;
}

function numeric(v: any): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function stringy(v: any): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Human-readable label for the event log / inspector. */
export function describeGesture(g: DecodedGesture): string {
  const where =
    g.source === "unknown" ? g.kind : `${g.source}`;
  return `${g.action} (${where})`;
}
