/**
 * The POS Polaris web components (`<s-tile>`, `<s-page>`, …) as JSX
 * intrinsics, typed loosely for the same reason `shopify.ts` types the host
 * loosely: the full generated types move with every quarterly API version.
 * The dev-store run (`shopify app dev`) is the real check — nothing here can
 * execute anywhere else.
 */
import "preact";

declare module "preact" {
  namespace JSX {
    interface IntrinsicElements {
      [tagName: `s-${string}`]: any;
    }
  }
}
