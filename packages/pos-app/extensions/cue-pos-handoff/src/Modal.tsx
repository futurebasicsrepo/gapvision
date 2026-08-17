/**
 * The Cue modal — the floor's live engagements, one tap from the till.
 *
 * Path A of `claude/lens-payments.md`. The associate has been serving a guest
 * through the Lens; when the moment to pay arrives at the POS, this modal
 * shows who is on the floor right now and one tap does three things to the
 * till's cart: attaches the customer, loads the cart lines, and stamps the
 * engagement onto the order as cart properties. The POS is reduced to its
 * last irreplaceable act — Charge.
 *
 * Trust boundary, spelled out: this code never chooses its tenant. It asks
 * Shopify for a session token (signed by the merchant's own app secret) and
 * sends it to Cue, where the signature is checked against the secret that
 * same merchant stored in Console. Which floor appears in this list is
 * decided by that cryptography, not by anything in this bundle.
 *
 * Attribution is the quiet payload: `cue:engagement` on the cart is what
 * lets the sale that closes here be tied back to the engagement the Lens
 * opened — a recorded fact, where before it was an inference from timing.
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { shopify, type HandoffSession } from "./shopify";

/**
 * The Cue realtime server. Per-deployment, like the plugin's — the pilot's
 * Railway URL here; a self-hosted merchant edits one line.
 */
const CUE_SERVER = "https://realtime-production-80f4.up.railway.app";

export default async () => {
  render(<Modal />, document.body);
};

type Phase = "loading" | "error" | "ready";

function Modal() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [detail, setDetail] = useState("");
  const [sessions, setSessions] = useState<HandoffSession[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setPhase("loading");
    try {
      const token = await shopify.session.getSessionToken();
      if (!token) {
        setDetail("POS did not issue a session token — check the app is installed on this store.");
        setPhase("error");
        return;
      }
      const res = await fetch(`${CUE_SERVER}/pos/handoff`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // Cue wrote the sentence (unknown store, legacy credential, expired
        // token); show it verbatim — each names a different fix.
        setDetail(String(body?.detail || `Cue refused (${res.status}).`));
        setPhase("error");
        return;
      }
      setSessions(body?.sessions || []);
      setPhase("ready");
    } catch {
      setDetail("Could not reach Cue. The till still works without it.");
      setPhase("error");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const pull = async (s: HandoffSession) => {
    const key = s.engagement_id || s.at;
    setBusy(key);
    try {
      if (s.customer_id) {
        await shopify.cart.setCustomer({ id: s.customer_id });
      }
      let added = 0;
      let failed = 0;
      for (const line of s.lines || []) {
        try {
          if (line.variantId) {
            await shopify.cart.addLineItem(line.variantId, line.qty || 1);
          } else if (line.title) {
            await shopify.cart.addCustomSale({
              title: line.title,
              price: String(line.price ?? 0),
              quantity: line.qty || 1,
              taxable: true,
            });
          }
          added += 1;
        } catch {
          // An out-of-stock variant refuses here (oversell protection).
          // Count it and say so — a cart quietly short one line is the
          // failure mode this product exists to prevent.
          failed += 1;
        }
      }
      await shopify.cart.addCartProperties({
        "cue:engagement": String(s.engagement_id ?? ""),
        "cue:associate": String(s.associate ?? ""),
        "cue:zone": String(s.zone ?? ""),
      });
      shopify.toast.show(
        failed
          ? `${s.guest}: ${added} line(s) added, ${failed} refused (stock). Review before charging.`
          : `${s.guest} is in the cart — charge when ready.`,
      );
    } catch {
      shopify.toast.show("Could not load the cart — build it by hand this once.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <s-page heading="Cue — on the floor now">
      {phase === "loading" && (
        <s-section>
          <s-stack direction="inline" gap="small">
            <s-spinner />
            <s-text>Asking the floor…</s-text>
          </s-stack>
        </s-section>
      )}

      {phase === "error" && (
        <s-section>
          <s-banner tone="warning" heading="Cue is not answering">
            <s-text>{detail}</s-text>
          </s-banner>
          <s-button onClick={() => void load()}>Try again</s-button>
        </s-section>
      )}

      {phase === "ready" && sessions.length === 0 && (
        <s-section>
          <s-text>
            No live engagements. When an associate is with a guest on the
            Lens, they appear here — one tap loads the till.
          </s-text>
          <s-button onClick={() => void load()}>Refresh</s-button>
        </s-section>
      )}

      {phase === "ready" &&
        sessions.map((s) => {
          const key = s.engagement_id || s.at;
          const lineCount = (s.lines || []).length;
          return (
            <s-section key={key} heading={`${s.guest} · ${s.tier}`}>
              <s-text>
                {s.zone}
                {s.associate ? ` · with ${s.associate}` : ""}
                {lineCount
                  ? ` · ${lineCount} item${lineCount === 1 ? "" : "s"} in their cart`
                  : " · no cart lines yet"}
              </s-text>
              <s-button
                variant="primary"
                disabled={busy !== null}
                onClick={() => void pull(s)}
              >
                {busy === key ? "Loading the cart…" : "Pull into this cart"}
              </s-button>
            </s-section>
          );
        })}
    </s-page>
  );
}
