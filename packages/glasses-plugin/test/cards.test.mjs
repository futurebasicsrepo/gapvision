/**
 * The card stack — what an associate finds when they scroll.
 *
 *   node packages/glasses-plugin/test/cards.test.mjs
 *
 * The right-hand region has always been a stack; it only ever held products.
 * Now it holds the guest too, and everything shipping next will land here as
 * well, so the ordering and the widths are decisions rather than accidents.
 *
 * `cardsFor` is pure and lives in main.ts beside the socket wiring, so this
 * file re-implements nothing: it imports the compiled module and drives the
 * real function. The alternative — a copy of the ordering in the test — would
 * pass forever while the glass showed something else.
 */
import { buildCue, fitChars, RAIL_LINE_CHARS } from "../dist-test/layout.js";
import { cardsFor } from "../dist-test/cards.js";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const PAYLOAD = {
  lines: ["IN CART CASHSOFT CREW", "BOUGHT BARREL JEANS", "OFFER IT IN SIZE M"],
  guest: {
    guest_id: "guest-001", name: "Sarah Chen", tier: "Icon", points: 4200,
    sizes: { tops: "M", bottoms: "28x30", outerwear: "M" },
    contact: { email: "sarah.chen@example.com", phone: "+1 415 555 0142" },
    address: { line1: "412 Valencia St", line2: "Apt 3",
               line3: "San Francisco CA 94103", country: "US" },
    orders: { count: 11, last_at: "2026-05-18", last_ref: "#1042" },
    purchase_history: [
      { sku: "A", name: "Mid Rise Vintage Slim Jeans", price: 79.95 },
      { sku: "B", name: "Organic Cotton Vintage Tee", price: 24.95 },
      { sku: "C", name: "Icon Denim Jacket", price: 98 },
    ],
    open_cart_online: [{ sku: "D", name: "CashSoft Crew Sweater", price: 69.95 }],
  },
  recommendations: [
    { sku: "P1", name: "High Rise Barrel Jean", price: 89.95, location: "Denim Wall", stock: 9 },
    { sku: "P2", name: "Cropped Cardigan", price: 69.95, location: "Front Table", stock: 3 },
  ],
};

const cards = cardsFor(PAYLOAD);
const kinds = cards.map((c) => c.kind);

// Kyle's call: the cue, then the guest, then the picks. You are already
// talking to the person; their details are what you reach for mid-sentence.
check("the cue is always card one", kinds[0] === "CUE", kinds.join(" · "));
check("guest cards come before picks",
  kinds.lastIndexOf("SHIP") < kinds.indexOf("PICK")
  && kinds.lastIndexOf("CONTACT") < kinds.indexOf("PICK"),
  kinds.join(" · "));
check("every recommendation gets a card",
  kinds.filter((k) => k === "PICK").length === PAYLOAD.recommendations.length);

// The ask that started this: shipping address, on the glass.
{
  const ship = cards.find((c) => c.kind === "SHIP");
  check("the address is on a card",
    ship && ship.lines[0] === "412 Valencia St", JSON.stringify(ship?.lines));
}

// --- the constraint every card has to survive --------------------------------
// A card sits beside the fact rail, so it gets RAIL_LINE_CHARS per line and
// three lines. A card that overflows is not a smaller card — the glass clips
// it, which reads as broken hardware.
{
  const tooWide = [];
  for (const c of cards) {
    check(`${c.kind} is at most three lines`, c.lines.length <= 3,
      `${c.lines.length} lines`);
    for (const l of c.lines) {
      if (String(l).length > RAIL_LINE_CHARS) tooWide.push(`${c.kind}: "${l}"`);
    }
  }
  // Reported rather than asserted away: buildCue truncates with a "+" so
  // nothing clips, but a card that is *always* truncated is a card whose
  // content was chosen wrong, and that is worth seeing in the output.
  console.log(tooWide.length
    ? `NOTE  ${tooWide.length} line(s) will truncate at ${RAIL_LINE_CHARS}:\n      ${tooWide.join("\n      ")}`
    : `NOTE  every card line fits ${RAIL_LINE_CHARS} chars`);
}

// --- cards must not multiply containers --------------------------------------
// Every card renders through the same buildCue as the cue itself. If one ever
// needed a different page shape, scrolling onto it would force a rebuild and,
// worse, could push the page over the host's budget — the failure that has
// eaten two features already.
{
  const shapes = new Set(cards.map((c) => {
    const p = buildCue({ lines: c.lines, meta: c.meta || [],
                         facts: ["SARAH CHEN", "ICON", "4200 PTS"],
                         moduleIndex: 0, moduleCount: cards.length, logo: true });
    return [...p.textObject.map((t) => t.containerID),
            ...(p.listObject || []).map((l) => `l${l.containerID}`),
            ...(p.imageObject || []).map((i) => `i${i.containerID}`)].join(",");
  }));
  check("every card is the same page shape — scrolling never rebuilds",
    shapes.size === 1, `${shapes.size} distinct shapes`);
}

// --- a thin guest must not produce empty cards -------------------------------
{
  const thin = cardsFor({
    lines: ["A", "B", "C"],
    guest: { guest_id: "g2", name: "Marcus Webb", tier: "Core" },
    recommendations: [],
  });
  check("a guest with no depth gets only a cue",
    thin.length === 1 && thin[0].kind === "CUE",
    thin.map((c) => c.kind).join(" · "));

  const noAddress = cardsFor({
    lines: ["A"], guest: { sizes: { tops: "M" }, address: { line1: "" } },
  });
  check("an empty address produces no SHIP card",
    !noAddress.some((c) => c.kind === "SHIP"),
    noAddress.map((c) => c.kind).join(" · "));
}

// --- what "these" refers to --------------------------------------------------
{
  const picks = cards.filter((c) => c.kind === "PICK");
  check("only picks carry a sku, so scrolling to an address cannot rebind \"these\"",
    picks.every((c) => c.sku) && cards.filter((c) => c.sku).length === picks.length);
}

// --- the fields where truncation is not a smaller answer but a wrong one -----
// A clipped product name is still recognisable. A clipped postcode or email is
// something an associate would read out, confidently, incorrectly.
{
  for (const kind of ["SHIP", "CONTACT"]) {
    const card = cards.find((c) => c.kind === kind);
    const over = (card?.lines || []).filter((l) => l.length > RAIL_LINE_CHARS);
    check(`${kind} never truncates`, over.length === 0,
      over.length ? JSON.stringify(over) : JSON.stringify(card.lines));
  }

  // The long-address path. The street may truncate — a clipped street is
  // still recognisable — but the state and postcode must arrive whole,
  // because that is the line somebody reads back to confirm a delivery.
  const long = cardsFor({
    lines: ["A"],
    guest: { address: { line1: "1 Very Long Street Name", line2: "Suite 1200",
                        line3: "Rancho Santa Margarita CA 92688", country: "US" } },
  }).find((c) => c.kind === "SHIP");
  const tail = long.lines[long.lines.length - 1];
  check("a long address keeps the state and postcode whole",
    tail === "CA 92688" && tail.length <= RAIL_LINE_CHARS,
    JSON.stringify(long.lines));

  // Losslessness is the property, not the line count: whatever it renders,
  // reading the lines back in order must reconstruct the address exactly.
  const EMAIL = "somebody.verylong@averylongdomain.example.com";
  const longEmail = cardsFor({
    lines: ["A"], guest: { contact: { email: EMAIL } },
  }).find((c) => c.kind === "CONTACT");
  check("a long email is wrapped, not clipped",
    longEmail.lines.join("") === EMAIL
    && longEmail.lines.every((l) => l.length <= RAIL_LINE_CHARS),
    JSON.stringify(longEmail.lines));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
