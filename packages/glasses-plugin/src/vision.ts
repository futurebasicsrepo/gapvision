/**
 * CueSea vision — photograph a thing with the phone, read the answer in-lens.
 *
 * ## The boundary, in plain words
 *
 * **The camera photographs things. It never photographs people.**
 *
 * It is for a SKU tag an associate cannot read, a washed-out care label, a
 * broken buckle they need the part number for. It is not for faces. There is
 * no face detection here, no person matching, no identification of anybody
 * from an image, and none of that is a setting somebody can turn on: the
 * plugin sends one photo to CueSea's own service and asks it what the object
 * is. If a person is in the frame by accident, nothing in this system looks
 * for them. That sentence is repeated in the `camera` permission description
 * in `app.json`, where the associate and the store can read it, and it should
 * be repeated anywhere this feature grows.
 *
 * The G2 has no camera and that stays true. This is the phone in the
 * associate's pocket. The glasses' only role is to show that something is
 * happening and then to show the answer.
 *
 * ## Which surface starts it
 *
 * The phone page, not the glasses. Aiming a camera is the most hands-and-eyes
 * task in the product — you are holding the phone and looking at it to frame a
 * swing tag whatever we do — so a glasses affordance only adds a step to
 * something that cannot be finished without the phone. The glasses' grammar is
 * no buttons and no chrome; their four input events are all spoken for.
 *
 * Eyes down to shoot, eyes up to read the answer while you are still talking
 * to the customer. The readout stays in the lens: a phone showing a result the
 * glasses do not is the failure this product exists to avoid.
 *
 * ## Why it looks the way it does
 *
 * A photo and a network round trip is slower than voice, and voice at ~3s is
 * already at the edge of what someone will hold still for. So the glass shows
 * its stage and the seconds elapsed, in exactly the shape `voice.ts` uses for
 * listening — one pattern for "the machine is working", not two.
 *
 * And every failure says *which* failure. "Something went wrong" sends an
 * associate to a manager for a thing they could have fixed themselves, and
 * only one of the failures below is actually a manager's problem.
 *
 * Nothing here stores the image, and nothing logs the base64. The bytes exist
 * for one POST and are dropped.
 */
import type { CaptureResult, GlassesBridge } from "./bridge";

/**
 * What this store has turned on.
 *
 * Fetched from the realtime server at boot — the plugin is a static bundle and
 * cannot hold a service key, so every capability question is proxied like
 * everything else.
 */
export interface Capabilities {
  /** Whether the server found a tenant with this slug at all. Not a switch —
   *  the switches already fail closed. This is so the page can say *which*
   *  nothing it is looking at, instead of rendering a typo as a real store
   *  with the camera switched off. */
  known: boolean;
  camera_capture: boolean;
  voice: boolean;
  floor_comms: boolean;
}

/**
 * Everything off.
 *
 * The default is closed, and the camera is why: an affordance that appears
 * because a fetch timed out is a camera control on the face of an associate
 * whose store declined the camera. Failing the other way costs a feature for
 * as long as the network is down, which is recoverable and visible.
 */
export const NO_CAPABILITIES: Capabilities = { known: false,
  camera_capture: false,
  voice: false,
  floor_comms: false,
};

/** Don't hold the HUD hostage to a slow store network. */
const CAPABILITIES_TIMEOUT_MS = 2_500;

/**
 * Ask the server what this tenant may do. **Never rejects, never throws** —
 * every failure resolves to `NO_CAPABILITIES`, because a caller that has to
 * remember to catch is a caller that will one day forget and fail open.
 *
 * A malformed or partial body is a failure too: a flag that isn't a boolean
 * has not said yes, and `Boolean(undefined)` quietly reading as "off" is only
 * safe by accident. It is asserted rather than relied on.
 */
export async function fetchCapabilities(
  baseUrl: string,
  tenant: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Capabilities> {
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), CAPABILITIES_TIMEOUT_MS),
  );
  try {
    const res = await Promise.race([
      fetchImpl(`${baseUrl}/api/tenant/capabilities?tenant=${encodeURIComponent(tenant)}`),
      timeout,
    ]);
    if (!res || !res.ok) return { ...NO_CAPABILITIES };
    const body = await res.json();
    if (!body || typeof body !== "object") return { ...NO_CAPABILITIES };
    return {
      // An older service that predates this field answers `undefined`, which
      // reads as unknown — wrong, and it would paint every existing tenant as
      // a typo. Absent means "this service cannot tell me", and a service that
      // cannot tell us is not evidence the tenant is missing.
      known: body.known === undefined ? true : body.known === true,
      camera_capture: body.camera_capture === true,
      voice: body.voice === true,
      floor_comms: body.floor_comms === true,
    };
  } catch {
    return { ...NO_CAPABILITIES };
  }
}

/** What the service is being asked to recognise. */
export type VisionKind = "sku" | "part";

export interface CaptureControl {
  label: string;
  kind: VisionKind;
}

/**
 * The camera affordance on the phone page — **or nothing at all.**
 *
 * When the store has not turned the camera on these controls do not exist. Not
 * greyed out, not erroring when pressed, not present-but-refused: an associate
 * should never see a control their store declined, because a control that
 * exists and does not work is a support call, and a control that exists and
 * *shouldn't* is a conversation with a customer about why the phone is taking
 * pictures on the shop floor.
 *
 * The gate is a list rather than a flag on purpose. The page builds its card
 * from whatever this returns, so an empty array is an absent card by
 * construction — there is no branch where a control gets built and then hidden.
 *
 * Two controls rather than one because the service wants to know whether it is
 * reading a tag or identifying a part, and asking on the phone — where the
 * associate is already looking — is free. The alternative is guessing.
 *
 * Sentence case, in the page's sans face: this is a control a person presses,
 * not a line the machine says in the glass.
 */
export function captureControls(caps: Capabilities): CaptureControl[] {
  if (!caps?.camera_capture) return [];
  return [
    { label: "Scan a tag", kind: "sku" },
    { label: "Scan a part", kind: "part" },
  ];
}

/**
 * The cap on what we will put on the wire.
 *
 * A modern phone camera will hand back 3-8 MB, and base64 adds a third on top
 * of that; a store's wifi will sit on it for half a minute and the associate
 * is standing in front of somebody. Refusing early with a sentence they can
 * act on beats a timeout they cannot read.
 *
 * 3 MiB is the service's own ceiling on the decoded image, so this is the same
 * number rather than a looser one: a photo that is going to be refused should
 * be refused here, in the moment, instead of after an upload over shop wifi
 * that was never going to be accepted. A 413 is still handled — the two limits
 * living in two repositories is exactly how they drift apart — but it should
 * not be the way an associate finds out.
 */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export type VisionState = "idle" | "capturing" | "analysing" | "answering";

/**
 * Every way this can end badly, each with its own sentence.
 *
 * The list is the point. "Something went wrong" would cover all seven, and an
 * associate reading it has no idea whether to retake the photo, walk to a
 * manager, or wait for the wifi.
 */
export type VisionFailure =
  | "cancelled"      // they backed out of the camera
  | "unsupported"    // this Even App has no camera API
  | "capture-failed" // the host tried and couldn't
  | "forbidden"      // 403: the tenant's camera is off
  | "too-large"      // the photo is bigger than we will send
  | "unrecognised"   // 200, but the service saw nothing it knows
  | "unreachable"    // the request never landed
  | "service-error"; // it landed and came back wrong

/**
 * Written to 21 characters, which is what a line holds beside the fact rail —
 * the tightest place any of these can land, and where they will land, because
 * an associate scanning a tag is usually mid-engagement with the rail up.
 */
export function failureCue(reason: VisionFailure, detail = ""): string[] {
  switch (reason) {
    case "cancelled":
      return ["NO PHOTO TAKEN", "SCAN AGAIN ON PHONE"];
    case "unsupported":
      return ["CAMERA UNAVAILABLE", "UPDATE THE EVEN APP"];
    case "capture-failed":
      return ["CAMERA DIDNT OPEN", "TRY THE PHONE CAMERA"];
    case "forbidden":
      // The one failure that really is a manager's problem, said plainly so
      // the walk is worth it.
      return ["CAMERA OFF IN STORE", "A MANAGER CAN ENABLE"];
    case "too-large":
      return ["PHOTO TOO LARGE", detail, "TRY A SMALLER PHOTO"].filter(Boolean);
    case "unrecognised":
      return ["NOTHING RECOGNISED", "TRY A CLOSER PHOTO"];
    case "unreachable":
      return ["CANT REACH CUESEA", "CHECK THE CONNECTION"];
    case "service-error":
      return ["LOOKUP FAILED", detail, "TRY AGAIN"].filter(Boolean);
  }
}

/** What `/api/vision/analyze` answers with — the shape `renderCue` takes. */
export interface VisionResult {
  lines?: string[];
  meta?: string[];
}

export interface VisionDeps {
  bridge: GlassesBridge;
  /** Where the realtime server lives. Vision is proxied through it like
   *  everything else; the plugin cannot hold the service key. */
  serverUrl: string;
  tenant: string;
  /** Same signature `voice.ts` uses — main.ts owns the page lifecycle, and a
   *  vision answer is a cue like any other. */
  render(lines: string[], meta: string[]): Promise<void>;
  log(message: string): void;
  onState?(state: VisionState): void;
  /** The answer's dwell expired, or it was dismissed. */
  onDone?(): void;
  fetchImpl?: typeof fetch;
}

/** How long an answer stays up. Matches voice's dwell — it is the same kind of
 *  answer and there is no reason for two numbers. */
export const ANSWER_DWELL_MS = 12_000;
/**
 * How often the working screen repaints its elapsed count.
 *
 * `voice.ts` repaints at 400ms because it is animating a level meter off live
 * audio. There is nothing live to show inside a fetch, so this counts whole
 * seconds and repaints twice a second — enough that the number is never more
 * than half a second stale, and half the traffic to the host.
 */
const TICK_MS = 500;

export class VisionController {
  private state: VisionState = "idle";
  private startedAt = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private dwellTimer: ReturnType<typeof setTimeout> | null = null;
  private stageLines: string[] = [];

  constructor(private deps: VisionDeps) {}

  get current(): VisionState {
    return this.state;
  }

  private setState(next: VisionState) {
    this.state = next;
    this.deps.onState?.(next);
  }

  /**
   * Capture → show that something is happening → POST → render the answer.
   *
   * Re-entrant by refusal: a second scan while one is in flight is ignored
   * rather than queued. Two photos racing to the same three lines is worse
   * than a press that did nothing.
   */
  async scan(kind: VisionKind): Promise<void> {
    if (this.state !== "idle" && this.state !== "answering") return;
    this.clearDwell();
    this.startedAt = Date.now();

    const thing = kind === "part" ? "PART" : "TAG";
    // Said before the camera opens, because the phone is about to take the
    // associate's attention and the glass is what they look back at.
    this.setState("capturing");
    this.stageLines = ["CAMERA OPEN ON PHONE", `PHOTOGRAPH THE ${thing}`];
    await this.paint();
    this.startTicking();

    const shot = await this.deps.bridge.captureImage();
    if (!shot.ok) {
      // Cancelling is not a failure worth four seconds of screen: it was a
      // deliberate act and the associate already knows what they did. It still
      // gets its own sentence, briefly, so the glass never just snaps back.
      if (shot.reason === "failed") this.deps.log(`vision: capture failed — ${shot.detail}`);
      return this.fail(
        shot.reason === "cancelled" ? "cancelled"
          : shot.reason === "unsupported" ? "unsupported"
            : "capture-failed",
        shot.reason === "cancelled" ? 2_500 : 5_000,
      );
    }

    const { asset } = shot;
    // `size` is the host's byte count for the encoded image. Guard on the
    // base64 length as well: it is what actually goes on the wire, and a host
    // that reports size as 0 (some do) would otherwise walk straight past this.
    const bytes = Math.max(asset.size || 0, Math.floor((asset.base64.length * 3) / 4));
    if (bytes > MAX_IMAGE_BYTES) {
      // Whole megabytes: the glass charset is [A-Z0-9 ·%$£€/+-] and has no
      // decimal point, so "5.2 MB" would arrive as "5 2 MB" — a number that
      // reads as two numbers.
      return this.fail("too-large", 5_000, `${Math.round(bytes / 1_000_000)} MB`);
    }
    // The size and the kind, never the bytes. There is no path from this
    // module to storage and none to the log.
    this.deps.log(`vision: ${kind} photo, ${Math.round(bytes / 1024)} KB — sending`);

    this.setState("analysing");
    this.stageLines = [kind === "part" ? "READING THE PART" : "READING THE TAG"];
    await this.paint();

    let res: Response | null = null;
    try {
      res = await (this.deps.fetchImpl ?? fetch)(`${this.deps.serverUrl}/api/vision/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenant: this.deps.tenant,
          kind,
          image_base64: asset.base64,
          mime: asset.mimeType || "image/jpeg",
        }),
      });
    } catch (e) {
      // A thrown fetch is a request that never landed — no server, no wifi, no
      // DNS. Distinct from one that landed and answered badly, and distinct in
      // what the associate should do about it.
      this.deps.log(`vision: unreachable — ${String(e)}`);
      return this.fail("unreachable", 5_000);
    }

    if (res.status === 403) return this.fail("forbidden", 6_000);
    // The service's own size ceiling. The check above should have caught this
    // before the upload; if it did not, the two limits have drifted and the
    // associate still gets the sentence that tells them what to do about it,
    // rather than a number.
    if (res.status === 413) return this.fail("too-large", 5_000);
    if (!res.ok) return this.fail("service-error", 5_000, `ERROR ${res.status}`);

    let body: VisionResult | null = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const lines = (body?.lines || []).filter(Boolean);
    if (!lines.length) return this.fail("unrecognised", 5_000);

    this.stopTicking();
    this.setState("answering");
    await this.deps.render(lines, body?.meta ?? []);
    this.deps.log(`vision: ${kind} answered in ${Date.now() - this.startedAt}ms`);
    this.scheduleDwell(ANSWER_DWELL_MS);
  }

  /** A press while a scan is up: clear it and go back to what was underneath.
   *  Returns whether it had anything to clear, so `main.ts` can fall through
   *  to the next meaning of a press when it didn't. */
  dismiss(): boolean {
    if (this.state === "idle") return false;
    // A capture in flight cannot be recalled — the phone owns the camera UI
    // and will answer eventually. Dropping our state means its answer lands on
    // an idle controller and is discarded, which is the right outcome.
    this.stopTicking();
    this.clearDwell();
    this.setState("idle");
    this.deps.onDone?.();
    return true;
  }

  private async fail(reason: VisionFailure, dwellMs: number, detail = "") {
    this.stopTicking();
    this.deps.log(`vision: ${reason}${detail ? ` (${detail})` : ""}`);
    this.setState("answering");
    await this.deps.render(failureCue(reason, detail), []);
    this.scheduleDwell(dwellMs);
  }

  /**
   * The working screen: the stage, and how long it has been going.
   *
   * The seconds are the honest half. A photo round trip is slower than voice
   * and there is no progress to report from inside a fetch — a counter at
   * least distinguishes "working" from "frozen on the last frame", which is
   * the thing the glass must never do.
   */
  private async paint() {
    // Whole seconds, floored. Not `toFixed(1)`: the glass charset is
    // [A-Z0-9 ·%$£€/+-] and has no full stop, so "3.4S" arrives as "3 4S" —
    // one number that reads as two. At the length of a photo round trip the
    // tenths were never worth reading anyway.
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
    await this.deps.render(this.stageLines, [`${seconds}S`]);
  }

  private startTicking() {
    this.stopTicking();
    this.tickTimer = setInterval(() => void this.paint(), TICK_MS);
  }

  private stopTicking() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private scheduleDwell(ms: number) {
    this.clearDwell();
    this.dwellTimer = setTimeout(() => {
      this.dwellTimer = null;
      this.setState("idle");
      this.deps.onDone?.();
    }, ms);
  }

  private clearDwell() {
    if (this.dwellTimer) clearTimeout(this.dwellTimer);
    this.dwellTimer = null;
  }
}
