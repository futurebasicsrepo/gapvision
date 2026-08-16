/**
 * Bridge acquisition with graceful fallback.
 *
 * Inside the Even App WebView, `waitForEvenAppBridge()` resolves to the real
 * native bridge. In a plain browser (dev, CI, the official simulator's web
 * harness) there is no `flutter_inappwebview` handler, so we fall back to a
 * MockBridge that renders containers into the on-page "virtual lens" —
 * pixel-mapped to the G2's 576x288 monochrome display.
 *
 * The rest of the plugin only ever talks to this module's `GlassesBridge`
 * surface, so swapping mock -> real requires zero code changes.
 */
import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";

export interface TextContainer {
  xPosition: number;
  yPosition: number;
  width: number;
  /** Also the type size: the host scales glyphs to the box. There is no font
   *  field anywhere in the SDK — this is the only control there is. */
  height: number;
  borderWidth?: number;
  borderColor?: number;
  borderRadius?: number;
  paddingLength?: number;
  containerID: number;
  containerName: string;
  zOrderIndex?: number;
  content: string;
  isEventCapture: 0 | 1;
}

/** A selectable list, the shape Even's own dashboard uses. `itemName` is the
 *  rows; `currentSelectItemIndex` comes back on a listEvent. */
export interface ListContainer {
  xPosition: number;
  yPosition: number;
  width: number;
  /** Also the type size: the host scales glyphs to the box. There is no font
   *  field anywhere in the SDK — this is the only control there is. */
  height: number;
  borderWidth?: number;
  borderColor?: number;
  borderRadius?: number;
  paddingLength?: number;
  containerID: number;
  containerName: string;
  zOrderIndex?: number;
  isEventCapture: 0 | 1;
  itemContainer: {
    itemCount: number;
    itemWidth: number;
    itemName: string[];
    isItemSelectBorderEn?: 0 | 1;
  };
}

/**
 * An image container. Note what it does *not* have: no border, no padding, no
 * `isEventCapture`. The host's `ImageContainerProperty` is position, size, id,
 * name and z-order and nothing else — so a page whose only gesture receiver
 * was the header cannot simply swap that header for a mark. The capture has to
 * move somewhere else first.
 *
 * The pixels do not travel with the page. The container is declared here and
 * then filled by a separate `updateImageRawData` call, so a page can be built
 * and drawn with an empty box in it.
 */
export interface ImageContainer {
  xPosition: number;
  yPosition: number;
  /** Host range 20–288. */
  width: number;
  /** Host range 20–144. */
  height: number;
  containerID: number;
  containerName: string;
  zOrderIndex?: number;
}

export interface PageSpec {
  containerTotalNum: number;
  textObject: TextContainer[];
  listObject?: ListContainer[];
  imageObject?: ImageContainer[];
}

/**
 * A photo the *phone* took. Mirrors the SDK's `AppImageAsset` field for field
 * (path, name, mimeType, size, base64) rather than importing it, the same way
 * the container shapes above are declared here rather than pulled from the SDK
 * — this module is the one place that knows what the host's types look like.
 *
 * The G2 has no camera and that does not change. `path` is a phone-side file
 * reference; nothing in this plugin opens it, stores it or passes it on.
 */
export interface AppImageAsset {
  path: string;
  name: string;
  mimeType: string;
  /** Bytes of the encoded image, before base64. */
  size: number;
  base64: string;
}

/**
 * What a capture attempt came back as.
 *
 * `captureImageFromCamera()` answers `AppImageAsset | null` and null means two
 * completely different things: the associate backed out of the camera, or the
 * Even App on this phone has no camera method at all. Those want different
 * sentences on the glass — "no photo taken" is nothing to do about, "update
 * the Even App" is. The bridge is where that distinction still exists, so it
 * is drawn here rather than guessed at a layer that can no longer tell.
 */
export type CaptureResult =
  | { ok: true; asset: AppImageAsset }
  | { ok: false; reason: "cancelled" | "unsupported" | "failed"; detail?: string };

/** What the host reports back from `updateImageRawData`. `success` is the only
 *  one that means a pixel reached the glass. */
export type ImageResult =
  | "success" | "imageException" | "imageSizeInvalid" | "imageToGray4Failed" | string;

export interface GlassesBridge {
  readonly kind: "even-app" | "mock";
  createStartUpPageContainer(page: PageSpec): Promise<unknown>;
  rebuildPageContainer(page: PageSpec): Promise<unknown>;
  textContainerUpgrade(update: { containerID: number; containerName: string; content: string }): Promise<unknown>;
  /**
   * Fill a declared image container with encoded image bytes.
   *
   * The SDK also exposes `ImageRawDataUpdateFields`, the fragmented form with
   * session ids and packet indices, and its own source marks it "暂时用不到" —
   * not used for now. The host does the fragmenting; this call takes the whole
   * image. Returns the host's verdict, which is the only signal that the mark
   * actually landed: an image container the host rejected stays an empty box
   * and reports nothing further.
   */
  updateImageRawData(update: {
    containerID: number;
    containerName: string;
    imageData: Uint8Array;
  }): Promise<ImageResult>;
  /** 1 = system exit-confirmation dialog, required on the root page.
   *  0 = immediate exit, permitted only on internal pages. Defaulting to 1
   *  because the failure mode of getting it wrong is a rejected submission,
   *  and an extra confirmation is a far cheaper mistake than a silent exit. */
  shutDownPageContainer(exitMode?: number): Promise<unknown>;
  audioControl(isOpen: boolean, source?: unknown): Promise<boolean>;
  /**
   * Open the **phone's** camera and hand back the photo.
   *
   * The glasses have no camera. This is the phone in the associate's pocket,
   * pointed at a product tag or a broken part, so the answer can land in the
   * glass. It photographs things, never people — see `vision.ts` for the whole
   * statement of that boundary.
   *
   * Never rejects: every host outcome comes back as a `CaptureResult` so the
   * caller can say which failure happened rather than "something went wrong".
   */
  captureImage(): Promise<CaptureResult>;
  /**
   * Persist one string on the phone, through the host.
   *
   * This is the only durable store the SDK offers a plugin, and it is what
   * makes an associate's preferences a real thing rather than a thing that
   * lasts until the WebView is torn down — which, on this host, is every time
   * the phone goes in a pocket.
   *
   * **The boolean is the whole contract and it must be honoured.** A host that
   * refuses the write answers `false` and says nothing else; a caller that
   * ignores it shows a setting as saved that will be gone on the next
   * foreground transition, which is worse than a setting that refused to
   * change, because nobody looks twice at a control that appeared to work.
   */
  setLocalStorage(key: string, value: string): Promise<boolean>;
  /** What was stored, or null for "nothing here". The SDK types the host's
   *  answer as `string`; an absent key comes back empty, and empty is not a
   *  value anyone stored on purpose, so both collapse to null. */
  getLocalStorage(key: string): Promise<string | null>;
  onEvenHubEvent(cb: (event: any) => void): () => void;
  getUserInfo(): Promise<{ name?: string } | null>;
  /** Model and serial of the connected glasses.
   *
   *  This is how the floor knows who did what. The SDK's UserInfo has no
   *  email — uid, display name, avatar, country and nothing else — so a
   *  serial the device knows about itself is the only identity available
   *  here that a dashboard can resolve to a person. */
  getDeviceInfo(): Promise<{ model?: string; sn?: string } | null>;
}

export async function getBridge(): Promise<GlassesBridge> {
  // The SDK's waitForEvenAppBridge() resolves even outside the Even App
  // WebView (its calls then no-op with "Flutter handler not available").
  // Detect the actual native handler to decide real vs mock.
  const hasNative =
    typeof (window as any).flutter_inappwebview?.callHandler === "function";
  if (!hasNative) return new MockBridge();
  try {
    return wrapReal(await waitForEvenAppBridge());
  } catch {
    return new MockBridge();
  }
}

function wrapReal(real: any): GlassesBridge {
  return {
    kind: "even-app",
    createStartUpPageContainer: (p) => real.createStartUpPageContainer(p),
    rebuildPageContainer: (p) => real.rebuildPageContainer(p),
    textContainerUpgrade: (u) => real.textContainerUpgrade(u),
    // Optional-chained and never throwing: an Even App build without image
    // support should cost us the mark, not the HUD. `main.ts` reads the
    // non-success verdict and rebuilds with the wordmark instead.
    updateImageRawData: (u) =>
      real.updateImageRawData?.(u).then((r: any) => String(r ?? "success"))
        .catch((e: any) => `imageException: ${e}`) ?? Promise.resolve("unsupported"),
    shutDownPageContainer: (m = 1) => real.shutDownPageContainer(m),
    audioControl: (o, s) => real.audioControl(o, s),
    // Optional-chained like `getDeviceInfo`, and for a sharper reason: the
    // camera API arrived in a later Even App than the one some phones on a
    // shop floor are running, and `captureImageFromCamera` is simply absent
    // there. Absent is "unsupported"; a null return from a method that does
    // exist is the associate backing out. Only the host can tell them apart,
    // so the distinction is made here and never again.
    captureImage: () => {
      const call = real.captureImageFromCamera?.();
      if (!call) return Promise.resolve<CaptureResult>({ ok: false, reason: "unsupported" });
      return call
        .then((asset: AppImageAsset | null) =>
          asset?.base64
            ? ({ ok: true, asset } as CaptureResult)
            : ({ ok: false, reason: "cancelled" } as CaptureResult))
        .catch((e: any) =>
          ({ ok: false, reason: "failed", detail: String(e) }) as CaptureResult);
    },
    // Optional-chained like `captureImage`, and read the same way: a host
    // without the method has not stored anything, so it answers false rather
    // than throwing. False is a sentence the page can show; a rejected promise
    // is a preference that looks saved and isn't.
    setLocalStorage: (key, value) => {
      const call = real.setLocalStorage?.(key, value);
      if (!call) return Promise.resolve(false);
      return call.then((ok: any) => ok === true).catch(() => false);
    },
    getLocalStorage: (key) => {
      const call = real.getLocalStorage?.(key);
      if (!call) return Promise.resolve(null);
      return call
        .then((v: any) => (typeof v === "string" && v !== "" ? v : null))
        .catch(() => null);
    },
    onEvenHubEvent: (cb) => real.onEvenHubEvent(cb),
    getUserInfo: () => real.getUserInfo().catch(() => null),
    // Optional-chained: an older Even App build may not implement it, and
    // losing attribution is not a reason to fail startup.
    getDeviceInfo: () =>
      real.getDeviceInfo?.().catch(() => null) ?? Promise.resolve(null),
  };
}

/** Renders container specs into #virtual-lens, scaled from 576x288. */
class MockBridge implements GlassesBridge {
  readonly kind = "mock" as const;
  private listeners = new Set<(event: any) => void>();
  private containers = new Map<number, TextContainer>();
  private lists = new Map<number, ListContainer>();
  private images = new Map<number, ImageContainer & { src?: string }>();
  private audioTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // The simulator buttons emit the *same protobuf shapes the host sends* —
    // PB ordinals for sys events, protoName keys for container events — so
    // dev exercises the real decoder rather than a shortcut around it.
    document.querySelectorAll<HTMLButtonElement>("[data-event]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const payload = MockBridge.eventFor(btn.dataset.event!, btn.dataset.source);
        this.listeners.forEach((cb) => cb(payload));
      });
    });
  }

  /** Build a host-shaped EvenHubEvent for a simulator button. */
  static eventFor(action: string, source?: string): any {
    const SOURCE: Record<string, number> = {
      ring: 2, "glasses-right": 1, "glasses-left": 3,
    };
    const TYPE: Record<string, number> = {
      click: 0, "scroll-up": 1, "scroll-down": 2, "double-click": 3,
    };

    // A container tap arrives as a textEvent with protoName keys and a string
    // event type, and carries no EventSource — the awkward shape, on purpose.
    if (source === "container") {
      return {
        textEvent: {
          Container_ID: 1,
          Container_Name: "line-1",
          Event_Type: action === "double-click" ? "DOUBLE_CLICK_EVENT" : "CLICK_EVENT",
        },
      };
    }

    return {
      sysEvent: {
        eventType: TYPE[action] ?? 0,
        eventSource: SOURCE[source ?? "ring"] ?? 2,
      },
    };
  }

  private paint() {
    const lens = document.getElementById("virtual-lens");
    if (!lens) return;
    lens.innerHTML = "";
    const sx = lens.clientWidth / 576;
    const sy = lens.clientHeight / 288;
    [...this.containers.values()]
      .sort((a, b) => (a.zOrderIndex ?? 0) - (b.zOrderIndex ?? 0))
      .forEach((c) => {
        const el = document.createElement("div");
        // hud-500 is peak brightness and belongs to the three lines alone;
        // the label, latency and meta strip sit at hud-300.
        const dim = /^(cue-label|cue-latency|cue-meta|status)$/.test(c.containerName);
        el.className = dim ? "lens-text meta" : "lens-text";
        el.style.left = `${c.xPosition * sx}px`;
        el.style.top = `${c.yPosition * sy}px`;
        el.style.width = `${c.width * sx}px`;
        el.style.height = `${c.height * sy}px`;
        el.textContent = c.content;
        lens.appendChild(el);
      });
    // List containers — the fact rail and the floor menu.
    //
    // These used to be dropped on the floor here, which meant the browser demo
    // silently showed neither: the rail was invisible and the floor menu was a
    // title and a footer with nothing between them. That is exactly the class
    // of "renders nothing and says nothing" the glass itself is prone to, and
    // having the mock share the fault removes the only place it could have
    // been caught without hardware. Rows are laid out from the container's own
    // `height`, the same way the host divides a list.
    this.lists.forEach((c) => {
      const rows = c.itemContainer.itemName;
      const rowH = rows.length ? c.height / rows.length : c.height;
      rows.forEach((label, i) => {
        const el = document.createElement("div");
        el.className = "lens-item";
        el.style.left = `${c.xPosition * sx}px`;
        el.style.top = `${(c.yPosition + i * rowH) * sy}px`;
        el.style.width = `${c.width * sx}px`;
        el.style.height = `${rowH * sy}px`;
        el.textContent = label;
        lens.appendChild(el);
      });
    });
    // Images last: an image container the host never received pixels for is
    // an empty box on the glass, and the browser should show the same empty
    // box rather than quietly drawing nothing.
    this.images.forEach((c) => {
      const el = document.createElement(c.src ? "img" : "div");
      el.className = "lens-image";
      el.style.position = "absolute";
      el.style.left = `${c.xPosition * sx}px`;
      el.style.top = `${c.yPosition * sy}px`;
      el.style.width = `${c.width * sx}px`;
      el.style.height = `${c.height * sy}px`;
      if (c.src) (el as HTMLImageElement).src = c.src;
      else el.style.outline = "1px dashed rgba(255,255,255,.35)";
      lens.appendChild(el);
    });
  }

  async createStartUpPageContainer(page: PageSpec) {
    this.containers.clear();
    this.lists.clear();
    this.images.clear();
    page.textObject.forEach((c) => this.containers.set(c.containerID, { ...c }));
    (page.listObject || []).forEach((c) => this.lists.set(c.containerID, { ...c }));
    (page.imageObject || []).forEach((c) => this.images.set(c.containerID, { ...c }));
    this.paint();
    return "success";
  }

  async updateImageRawData(u: { containerID: number; containerName: string; imageData: Uint8Array }) {
    const c = this.images.get(u.containerID);
    // Same verdict the host gives: a container that was never declared cannot
    // be filled, and saying so here is how the browser test catches an id that
    // drifted out of sync with the layout.
    if (!c) return "imageException";
    let bin = "";
    u.imageData.forEach((b) => { bin += String.fromCharCode(b); });
    c.src = `data:image/png;base64,${btoa(bin)}`;
    this.paint();
    return "success";
  }
  async rebuildPageContainer(page: PageSpec) {
    return this.createStartUpPageContainer(page).then(() => true);
  }
  async textContainerUpgrade(u: { containerID: number; containerName: string; content: string }) {
    const c = this.containers.get(u.containerID);
    if (c) { c.content = u.content; this.paint(); }
    return true;
  }
  async shutDownPageContainer(exitMode = 1) {
    // Record it rather than just clearing: the exit mode is the thing Even's
    // reviewers check, so the browser test needs to be able to read it back.
    (window as any).__cueExitMode = exitMode;
    this.containers.clear();
    this.lists.clear();
    this.images.clear();
    this.paint();
    const lens = document.getElementById("virtual-lens");
    if (lens) {
      lens.innerHTML =
        `<div class="lens-text">SYSTEM EXIT DIALOG</div>` +
        `<div class="lens-text meta">shutDownPageContainer(${exitMode})</div>`;
    }
    return true;
  }

  /**
   * Opening the mock mic streams 16 kHz PCM of an actual spoken question,
   * then silence, so chunking, the level meter and silence endpointing all
   * exercise the real path in a plain browser.
   *
   * It used to stream a 180 Hz sine plus noise. That was fine while STT was
   * `mock` — the mock returns a scripted transcript regardless of the audio,
   * so the demo looked like it worked. The moment Deepgram went live the
   * browser demo started answering "didn't catch that" every time, because a
   * sine wave is not speech. A recorded utterance is the only version of this
   * that stays honest as the backend gets more real.
   *
   * The asset is fetched lazily from the app origin rather than bundled: it
   * costs nothing in the JS the G2 loads, and if it is missing the tone still
   * drives endpointing and the meter.
   */
  private static utterance: Promise<Int16Array | null> | null = null;

  private static loadUtterance(): Promise<Int16Array | null> {
    if (!MockBridge.utterance) {
      MockBridge.utterance = fetch("dev-utterance.pcm")
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((buf) => new Int16Array(buf))
        .catch(() => {
          console.log("[mock] no dev-utterance.pcm — falling back to a tone");
          return null;
        });
    }
    return MockBridge.utterance;
  }

  async audioControl(isOpen: boolean, _source?: unknown) {
    console.log(`[mock] audioControl(${isOpen})`);
    if (this.audioTimer) { clearInterval(this.audioTimer); this.audioTimer = null; }
    if (!isOpen) return true;

    const FRAME_MS = 100;
    const SAMPLES = (16000 * FRAME_MS) / 1000;
    const speech = await MockBridge.loadUtterance();
    // The mic may have closed while we were fetching.
    if (!isOpen) return true;

    let elapsed = 0;
    let offset = 0;
    this.audioTimer = setInterval(() => {
      const bytes = new Uint8Array(SAMPLES * 2);
      const view = new DataView(bytes.buffer);

      if (speech && offset < speech.length) {
        // Real speech, 100 ms at a time, then let it fall silent so the
        // plugin's own endpointing decides when the question ended.
        for (let i = 0; i < SAMPLES; i++) {
          view.setInt16(i * 2, offset + i < speech.length ? speech[offset + i] : 0, true);
        }
        offset += SAMPLES;
      } else {
        const speaking = !speech && elapsed < 2200;
        for (let i = 0; i < SAMPLES; i++) {
          const t = elapsed / 1000 + i / 16000;
          const amp = speaking ? 6000 + 3000 * Math.sin(t * 3) : 20;
          const sample = speaking
            ? amp * Math.sin(2 * Math.PI * 180 * t) + (Math.random() - 0.5) * amp * 0.6
            : (Math.random() - 0.5) * amp;
          view.setInt16(i * 2, Math.max(-32768, Math.min(32767, sample)), true);
        }
      }

      this.listeners.forEach((cb) => cb({ audioEvent: { audioPcm: bytes, source: "glasses" } }));
      elapsed += FRAME_MS;
    }, FRAME_MS);
    return true;
  }
  /**
   * A canned photograph, so the capture flow runs end to end with no phone.
   *
   * The MockBridge is the reason this plugin is demoable at all, and the
   * camera path would otherwise be the one flow you could not reach without
   * hardware — which is how a flow stops being exercised and starts rotting.
   * A 16x16 checker is enough: nothing on this side looks at the pixels, the
   * service does, and a real backend answering "nothing recognised" for a
   * checkerboard is the honest answer rather than a broken demo.
   *
   * `window.__cueMockCapture` forces the failure branches ("cancel" for the
   * associate backing out, "unsupported" for an Even App without the camera
   * API), because each of those has its own sentence on the glass and a
   * sentence nobody can reach is a sentence nobody has read.
   */
  private static readonly CANNED_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAAAAAA6mKC9AAAAG0lEQVR42mP4DwQKQACj" +
    "GcgQQOaAaHIEBok7AEGEj4Gjm0KtAAAAAElFTkSuQmCC";

  async captureImage(): Promise<CaptureResult> {
    const forced = (window as any).__cueMockCapture;
    if (forced === "cancel") return { ok: false, reason: "cancelled" };
    if (forced === "unsupported") return { ok: false, reason: "unsupported" };
    if (forced === "failed") return { ok: false, reason: "failed", detail: "mock" };
    const base64 = MockBridge.CANNED_PNG_B64;
    console.log("[mock] captureImageFromCamera → canned 16x16 png");
    return {
      ok: true,
      asset: {
        // Deliberately not a real path: nothing may read it, and a path that
        // resolves invites something to try.
        path: "mock://camera/tag.png",
        name: "tag.png",
        mimeType: "image/png",
        // Bytes of the decoded PNG, which is what the host reports — not the
        // length of the base64, which is a third larger and would make the
        // oversize check disagree with the phone.
        size: Math.floor((base64.length * 3) / 4),
        base64,
      },
    };
  }

  /**
   * The host's key-value store, standing in as the browser's own.
   *
   * `window.localStorage` is the right stand-in and not a shortcut: it has the
   * same shape (strings in, strings out), the same lifetime (survives a reload,
   * survives the page being backgrounded) and the same failure — Safari private
   * mode throws on `setItem` exactly where a host refuses a write. So the
   * preferences flow, including the branch where saving fails, is reachable in
   * a plain browser with no phone and no glasses. That is the whole reason this
   * mock exists, and a preference that could only be tested on hardware is a
   * preference nobody would test.
   *
   * `window.__cueMockStorage = "fail"` forces the refusal, the same way
   * `__cueMockCapture` forces a camera that says no.
   */
  async setLocalStorage(key: string, value: string): Promise<boolean> {
    if ((window as any).__cueMockStorage === "fail") {
      console.log(`[mock] setLocalStorage(${key}) refused`);
      return false;
    }
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      console.log(`[mock] setLocalStorage(${key}) threw — ${String(e)}`);
      return false;
    }
  }

  async getLocalStorage(key: string): Promise<string | null> {
    if ((window as any).__cueMockStorage === "fail") return null;
    try {
      const v = window.localStorage.getItem(key);
      return v === "" ? null : v;
    } catch {
      return null;
    }
  }

  onEvenHubEvent(cb: (event: any) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  async getUserInfo() { return { name: "Dev Associate" }; }
  /** Stable, and obviously fake. The browser tests bind this serial to a
   *  person so they exercise the real attribution path rather than a
   *  shortcut around it. */
  async getDeviceInfo() { return { model: "g2", sn: "MOCK-G2-0001" }; }
}
