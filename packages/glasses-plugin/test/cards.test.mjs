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
import { getTextWidth } from "@evenrealities/pretext";
import { buildCue, RAIL_LINE_PX } from "../dist-test/layout.js";
import { cardsFor } from "../dist-test/cards.js";

/** Does this line fit the box a card is drawn in? Asked of the font's own
 *  metrics, because the G2's font is proportional and a character count
 *  describes neither `IIIIIIIIIII` (56px) nor `WWWWWWWWWWW` (176px). */
const fits = (line) => getTextWidth(String(line)) <= RAIL_LINE_PX;
const px = (line) => `${getTextWidth(String(line))}px`;

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
// A card sits beside the fact rail, so it gets the module column — 346px — and
// three lines. A card that overflows is not a smaller card: the glass clips
// it, which reads as broken hardware.
{
  const tooWide = [];
  for (const c of cards) {
    check(`${c.kind} is at most three lines`, c.lines.length <= 3,
      `${c.lines.length} lines`);
    for (const l of c.lines) {
      if (!fits(l)) tooWide.push(`${c.kind}: "${l}" (${px(l)})`);
    }
  }
  // Reported rather than asserted away: buildCue truncates with a "+" so
  // nothing clips, but a card that is *always* truncated is a card whose
  // content was chosen wrong, and that is worth seeing in the output.
  console.log(tooWide.length
    ? `NOTE  ${tooWide.length} line(s) will truncate in the ${RAIL_LINE_PX}px column:\n      ${tooWide.join("\n      ")}`
    : `NOTE  every card line fits the ${RAIL_LINE_PX}px column`);
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
    const over = (card?.lines || []).filter((l) => !fits(l));
    check(`${kind} never truncates`, over.length === 0,
      over.length ? JSON.stringify(over) : JSON.stringify(card.lines));
  }

  // The long-address path. The street may truncate — a clipped street is
  // still recognisable — but the state and postcode must arrive whole,
  // because that is the line somebody reads back to confirm a delivery.
  //
  // Measured, `Rancho Santa Margarita CA 92688` is 299px and fits the 346px
  // column, so it now arrives on one line and the apartment is *kept*. That is
  // the point rather than a weakening of it: the split exists to protect the
  // postcode, and a split that fires on a line that fits spends the
  // apartment's row for nothing. The property to hold is the postcode, not the
  // number of lines.
  const long = cardsFor({
    lines: ["A"],
    guest: { address: { line1: "1 Very Long Street Name", line2: "Suite 1200",
                        line3: "Rancho Santa Margarita CA 92688", country: "US" } },
  }).find((c) => c.kind === "SHIP");
  const tail = long.lines[long.lines.length - 1];
  check("a long address keeps the state and postcode whole",
    tail.endsWith("CA 92688") && long.lines.every(fits),
    JSON.stringify(long.lines));

  // And the case that does not fit: the same shape of address in the
  // uppercase the glass draws it in is 355px, over the column, so the region
  // splits and the apartment gives way. A character count put both of these
  // on the same side of the line at 31 characters.
  const wideAddr = cardsFor({
    lines: ["A"],
    guest: { address: { line1: "1 LONG STREET", line2: "SUITE 1200",
                        line3: "WOLLONGONG WAGGA WAGGA NSW 2650", country: "AU" } },
  }).find((c) => c.kind === "SHIP");
  const wideTail = wideAddr.lines[wideAddr.lines.length - 1];
  check("an address too wide for the column splits and keeps the postcode",
    wideTail === "NSW 2650" && wideAddr.lines.every(fits)
    && !wideAddr.lines.includes("SUITE 1200"),
    `${JSON.stringify(wideAddr.lines)} — ${px("WOLLONGONG WAGGA WAGGA NSW 2650")} in ${RAIL_LINE_PX}px`);

  // Losslessness is the property, not the line count: whatever it renders,
  // reading the lines back in order must reconstruct the address exactly.
  const EMAIL = "somebody.verylong@averylongdomain.example.com";
  const longEmail = cardsFor({
    lines: ["A"], guest: { contact: { email: EMAIL } },
  }).find((c) => c.kind === "CONTACT");
  check("a long email is wrapped, not clipped",
    longEmail.lines.join("") === EMAIL
    && longEmail.lines.every(fits),
    JSON.stringify(longEmail.lines));

  // Wrapping by measurement rather than by character count is not a tidy-up:
  // a lowercase email is mostly narrow glyphs, so a count wrapped it far
  // earlier than it had to and spent lines it did not need — and the card only
  // has three. Same address, wider glyphs, and the break points differ.
  const WIDE_EMAIL = "WWWWWWWWWWWWWWWWWWWWWWWWW@WWWWWWWWWWWWWWWWWWWW.COM";
  const wideEmail = cardsFor({
    lines: ["A"], guest: { contact: { email: WIDE_EMAIL } },
  }).find((c) => c.kind === "CONTACT");
  check("a wide email wraps where the box runs out, not where a count would",
    wideEmail.lines.every(fits)
    && wideEmail.lines.length > longEmail.lines.length
    && WIDE_EMAIL.length > EMAIL.length,
    `${wideEmail.lines.length} lines for ${WIDE_EMAIL.length} chars vs ` +
    `${longEmail.lines.length} for ${EMAIL.length}`);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
