/* ouster-collection — renders a collection grid from a JSON data file.
 *
 * Default source is data/collection.json — the real blue-star selection.
 * ?preview=1 swaps in data/layout-preview.json (real Future Basics catalogue)
 * purely so the layout can be seen working, and shows a banner saying so.
 */

const STAR_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.4-5.8-3-5.8 3 1.1-6.4L2.6 9.4l6.5-.9z"/></svg>';

const qs = new URLSearchParams(location.search);
const isPreview = qs.get("preview") === "1";
const SRC = isPreview ? "data/layout-preview.json" : "data/collection.json";

const el = (id) => document.getElementById(id);
const money = (n, c) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: c || "USD" }).format(n);

let ALL = [];

function card(p) {
  const out = typeof p.inventory === "number" && p.inventory <= 0;
  const shot = p.image
    ? `<img src="${p.image}" alt="" loading="lazy">`
    : `<span class="none">no image</span>`;

  return `
    <article class="card">
      <div class="shot">
        ${p.starred ? `<span class="star">${STAR_SVG}Starred</span>` : ""}
        ${out ? `<span class="pill-out">Out of stock</span>` : ""}
        ${shot}
      </div>
      <div class="body">
        <h3>${escapeHtml(p.title)}</h3>
        <div class="handle">${escapeHtml(p.handle || "")}</div>
        <div class="foot">
          <span class="price">${money(p.price, p.currency)}</span>
          <span class="meta">${p.variantCount || 1} ${p.variantCount === 1 ? "variant" : "variants"}</span>
        </div>
      </div>
    </article>`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function render() {
  const starredOnly = el("starred-only").checked;
  const sort = el("sort").value;

  let list = ALL.slice();
  if (starredOnly) list = list.filter((p) => p.starred);

  const by = {
    featured: () => 0,
    "price-asc": (a, b) => a.price - b.price,
    "price-desc": (a, b) => b.price - a.price,
    title: (a, b) => a.title.localeCompare(b.title),
  }[sort];
  if (sort !== "featured") list.sort(by);

  el("grid").innerHTML = list.map(card).join("");

  // A broken image would otherwise leave alt text sitting under the star badge.
  for (const img of el("grid").querySelectorAll(".shot img")) {
    img.addEventListener("error", () => {
      const span = document.createElement("span");
      span.className = "none";
      span.textContent = "image unavailable";
      img.replaceWith(span);
    });
  }
  const starred = ALL.filter((p) => p.starred).length;
  el("count").textContent =
    `${list.length} of ${ALL.length} ${ALL.length === 1 ? "product" : "products"} · ${starred} starred`;
}

async function boot() {
  let data;
  try {
    const res = await fetch(SRC, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    data = await res.json();
  } catch (err) {
    el("empty").hidden = false;
    el("load-error").hidden = false;
    el("load-error").textContent = `Could not load ${SRC} — ${err.message}. Serve this folder over HTTP; opening index.html from the filesystem blocks fetch().`;
    return;
  }

  const c = data.collection || {};
  if (c.title) el("title").textContent = c.title;
  if (c.subtitle) el("eyebrow").textContent = c.subtitle;
  document.title = `${c.title || "Collection"} — collection`;

  ALL = Array.isArray(data.products) ? data.products : [];

  el("src-note").textContent = SRC;
  if (isPreview) {
    el("preview-banner").hidden = false;
    el("lede").textContent =
      "Stand-in products, shown only to demonstrate the grid, the star badge and the sorting. Not the Ouster selection.";
  }

  if (!ALL.length) {
    el("empty").hidden = false;
    el("toolbar").hidden = true;
    el("grid").hidden = true;
    return;
  }

  el("toolbar").hidden = false;
  el("starred-only").addEventListener("change", render);
  el("sort").addEventListener("change", render);
  render();
}

boot();
