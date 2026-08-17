import { useRef, useState } from "react";

/**
 * The Lens Sim — the Meta lens, hardware-free, inside Console.
 *
 * Worth being precise about what this is, because "simulator" undersells it:
 * the Meta Ray-Ban Display lens is a Web App, so **the thing in the iframe is
 * not a replica — it is the identical bundle the glasses run**, drawn at
 * 600×600. What `sim.html` adds around it is a device frame and a driver
 * panel: guest signals, the Neural Band as a button pad, classic↔meta at idle.
 *
 * Two constraints shape this component, and both are load-bearing:
 *
 *  · **Same origin, always.** The sim drives the lens over postMessage and the
 *    bridge answers its own origin only — a page that could iframe the lens
 *    cross-origin could drive somebody's glasses. So the build is copied under
 *    Console's own origin (`scripts/sync-lens-sim.mjs`) rather than pointed at
 *    over the network, and this iframe carries no `sandbox` attribute, which
 *    would put it in an opaque origin and silently break the bridge it exists
 *    to use.
 *  · **No account, no hardware, no backend.** What ships today is the demo
 *    drive: everything in the frame runs from the driver panel. Live drive —
 *    the same lens carrying a minted `sim` token and connecting to the realtime
 *    server — is the pre-hardware acceptance test for the whole Meta path, and
 *    it needs a device from the Devices card rather than anything new here.
 */
export default function LensSim() {
  const frame = useRef(null);
  const [reloads, setReloads] = useState(0);

  return (
    <div className="card span-12">
      <div className="card-head">
        {/* "Demo drive" rather than repeating the page title: the spec names
            two modes here, and the second one — the same lens carrying a
            minted `sim` token against the realtime server — is a sibling card,
            not a replacement. Naming this one now means that card has a name
            to arrive under. */}
        <h3>Demo drive</h3>
        <div className="btn-row">
          {/* The lens holds engagement state in the page. Reloading is how you
              get back to idle without hunting for the gesture that does it. */}
          <button className="btn small ghost" onClick={() => setReloads((n) => n + 1)}>
            Reset lens
          </button>
          <a className="btn small ghost" href="/lens-sim/sim.html"
             target="_blank" rel="noreferrer">Open full screen</a>
        </div>
      </div>
      <p className="card-note">
        Not a mock — this is the same bundle the Meta Ray-Ban Display runs,
        drawn at 600×600 with a driver panel around it. Fire a guest signal,
        work the deck with the band buttons, switch classic↔meta at idle.
        Nothing here touches a tenant: it is the demo drive, and it needs no
        account, no hardware and no services.
      </p>
      <div className="lens-sim-wrap">
        <iframe
          ref={frame}
          key={reloads}
          className="lens-sim"
          src="/lens-sim/sim.html"
          title="Cue Lens Sim"
        />
      </div>
      <p className="meta" style={{ marginTop: 12, lineHeight: 1.5 }}>
        To drive it against real data instead, mint a <strong>Lens Sim</strong>
        {" "}device on a tenant (Tenants → the tenant → Devices) and open its
        launch URL. That lens registers like any other, and the same payload
        reaches it and Studio at once.
      </p>
    </div>
  );
}
