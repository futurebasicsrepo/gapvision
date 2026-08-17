/**
 * The Cue tile — one square on the POS smart grid.
 *
 * Its whole job is to open the modal. The label says what the tap does, not
 * what the app is called ("Pull a guest from the floor", never "Cue app") —
 * the POS best-practice docs are right about this and it matches how every
 * Cue surface writes its controls.
 */
import { render } from "preact";
import { shopify } from "./shopify";

export default async () => {
  render(<Tile />, document.body);
};

function Tile() {
  return (
    <s-tile
      heading="Cue"
      subheading="Pull a guest from the floor"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
