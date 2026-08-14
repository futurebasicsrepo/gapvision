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
  height: number;
  containerID: number;
  containerName: string;
  zOrderIndex?: number;
  content: string;
  isEventCapture: 0 | 1;
}

export interface PageSpec {
  containerTotalNum: number;
  textObject: TextContainer[];
}

export interface GlassesBridge {
  readonly kind: "even-app" | "mock";
  createStartUpPageContainer(page: PageSpec): Promise<unknown>;
  rebuildPageContainer(page: PageSpec): Promise<unknown>;
  textContainerUpgrade(update: { containerID: number; containerName: string; content: string }): Promise<unknown>;
  shutDownPageContainer(exitMode?: number): Promise<unknown>;
  audioControl(isOpen: boolean, source?: unknown): Promise<boolean>;
  onEvenHubEvent(cb: (event: any) => void): () => void;
  getUserInfo(): Promise<{ name?: string } | null>;
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
    shutDownPageContainer: (m = 0) => real.shutDownPageContainer(m),
    audioControl: (o, s) => real.audioControl(o, s),
    onEvenHubEvent: (cb) => real.onEvenHubEvent(cb),
    getUserInfo: () => real.getUserInfo().catch(() => null),
  };
}

/** Renders container specs into #virtual-lens, scaled from 576x288. */
class MockBridge implements GlassesBridge {
  readonly kind = "mock" as const;
  private listeners = new Set<(event: any) => void>();
  private containers = new Map<number, TextContainer>();
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
  }

  async createStartUpPageContainer(page: PageSpec) {
    this.containers.clear();
    page.textObject.forEach((c) => this.containers.set(c.containerID, { ...c }));
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
  async shutDownPageContainer() {
    this.containers.clear(); this.paint(); return true;
  }

  /**
   * Opening the mock mic streams synthetic 16 kHz PCM: ~2.2 s of
   * speech-shaped noise, then silence. That exercises the real thing —
   * chunking, the level meter, silence endpointing — in a plain browser, so
   * the voice path is testable and demo-able with no glasses in the room.
   */
  async audioControl(isOpen: boolean, _source?: unknown) {
    console.log(`[mock] audioControl(${isOpen})`);
    if (this.audioTimer) { clearInterval(this.audioTimer); this.audioTimer = null; }
    if (!isOpen) return true;

    const FRAME_MS = 100;
    const SAMPLES = (16000 * FRAME_MS) / 1000;
    let elapsed = 0;
    this.audioTimer = setInterval(() => {
      const speaking = elapsed < 2200;
      const bytes = new Uint8Array(SAMPLES * 2);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < SAMPLES; i++) {
        // Rough vowel-ish tone + noise while "speaking"; near-zero after.
        const t = (elapsed / 1000) + i / 16000;
        const amp = speaking ? 6000 + 3000 * Math.sin(t * 3) : 20;
        const sample = speaking
          ? amp * Math.sin(2 * Math.PI * 180 * t) + (Math.random() - 0.5) * amp * 0.6
          : (Math.random() - 0.5) * amp;
        view.setInt16(i * 2, Math.max(-32768, Math.min(32767, sample)), true);
      }
      this.listeners.forEach((cb) => cb({ audioEvent: { audioPcm: bytes, source: "glasses" } }));
      elapsed += FRAME_MS;
    }, FRAME_MS);
    return true;
  }
  onEvenHubEvent(cb: (event: any) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  async getUserInfo() { return { name: "Dev Associate" }; }
}
