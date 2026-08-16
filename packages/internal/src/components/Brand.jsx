import { useState } from "react";
import tokens from "../brand-tokens.json";
import assets from "../brand-assets.json";
import { CueBracket, Wordmark } from "./Mark.jsx";

/**
 * Brand & identity.
 *
 * Rendered from `brand-tokens.json`, which is generated from the same source
 * that builds every app's `brand.css`. That means this page cannot go stale:
 * if a swatch here is wrong, the product is wrong in exactly the same way.
 * A brand page maintained by hand alongside the code is a brand page that
 * quietly starts lying.
 */

function Swatch({ token, hex, note, onCopy }) {
  return (
    <button className="swatch" onClick={() => onCopy(hex)} title={`Copy ${hex}`}>
      <span className="swatch-chip" style={{ background: hex }} />
      <span className="swatch-body">
        <span className="swatch-hex">{hex}</span>
        <div className="swatch-token">{token}</div>
        {note && <div className="swatch-note">{note}</div>}
      </span>
    </button>
  );
}

export default function Brand() {
  const [copied, setCopied] = useState(null);

  function copy(value) {
    navigator.clipboard?.writeText(value)
      .then(() => {
        setCopied(value);
        setTimeout(() => setCopied((c) => (c === value ? null : c)), 1600);
      })
      .catch(() => { /* clipboard blocked — the value is on screen anyway */ });
  }

  return (
    <div className="grid grid-12">
      <div className="card span-12">
        <div className="card-head">
          <h3>Brand & identity · v{tokens.version}</h3>
          <span className="meta">
            {copied ? <span className="copied">copied {copied}</span> : "click any swatch to copy"}
          </span>
        </div>
        <p className="card-note">
          Generated from <code>packages/brand/tokens.json</code>, the same file
          that produces every app's stylesheet. Change a value there and run{" "}
          <code>npm run brand:sync</code> — this page and the products move
          together.
        </p>
      </div>

      {/* --- downloads ---
          The panel that stops people rebuilding the logo from a screenshot.
          Every file here is generated from tokens.json by
          packages/brand/build-assets.py, so it cannot drift from the spec on
          the rest of this page. */}
      <div className="card span-12">
        <div className="card-head">
          <h3>Download</h3>
          <a className="dl-all" href="/brand/cuesea-brand-assets.zip" download>
            Everything, one zip
          </a>
        </div>
        <p className="card-note">
          Transparent PNG, vector PDF and <code>.ai</code> for each. Generated
          from the tokens, not exported by hand — so nothing here can drift
          from the construction above. The wordmark is{" "}
          <strong>converted to outlines</strong>: the files open correctly on a
          machine that doesn't have Instrument Sans.
        </p>
        <div className="dl-grid">
          {assets.assets.map((a) => (
            <div className="dl" key={a.slug}>
              <div className={`dl-preview ${a.slug.includes("on-light") ? "on-light" : ""}`}>
                <img src={`/brand/${a.png[a.png.length - 1].file}`} alt={a.label} />
              </div>
              <div className="dl-body">
                <div className="dl-label">{a.label}</div>
                <div className="meta dl-note">{a.note}</div>
                <div className="dl-links">
                  <a href={`/brand/${a.svg}`} download>SVG</a>
                  <a href={`/brand/${a.pdf}`} download>PDF</a>
                  <a href={`/brand/${a.ai}`} download>AI</a>
                  <span className="dl-sep" />
                  {a.png.map((p) => (
                    <a key={p.size} href={`/brand/${p.file}`} download>
                      PNG {p.size}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
        <p className="meta" style={{ marginTop: 14, lineHeight: 1.5 }}>
          {assets.note}
        </p>
      </div>

      {/* --- colour --- */}
      {tokens.ramps.map((ramp) => (
        <div className="card span-12" key={ramp.key}>
          <h3>{ramp.name}</h3>
          <p className="card-note">{ramp.role}</p>
          <div className="rule-line">{ramp.rule}</div>
          <div className="ramp">
            {ramp.steps.map((s) => (
              <Swatch key={s.token} {...s} onCopy={copy} />
            ))}
          </div>
        </div>
      ))}

      {/* --- the mark --- */}
      <div className="card span-6">
        <h3>{tokens.mark.name}</h3>
        <p className="card-note">{tokens.mark.idea}</p>

        <div className="mark-row">
          {tokens.mark.compensation.map((c) => (
            <div className="mark-spec" key={c.from}>
              <CueBracket size={c.from >= 42 ? 64 : c.from} arc="var(--paper)" title="cuesea" />
              <div className="m-size">{c.label}</div>
              <div className="m-size" style={{ color: "var(--sea-200)" }}>
                stroke {c.stroke} · cue {c.cue}
              </div>
            </div>
          ))}
        </div>

        <p className="card-note" style={{ marginTop: 16 }}>
          As size falls, stroke and cue grow together so the opening never
          closes. Below the minimum it stops being an open C and reads as a
          filled ring.
        </p>

        <div className="doc">
          <ul>
            {tokens.mark.construction.map((c) => <li key={c}><code>{c}</code></li>)}
          </ul>
          <p><strong>Minimum:</strong> {tokens.mark.minimum}</p>
          <ul>{tokens.mark.rules.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      </div>

      {/* --- the wordmark --- */}
      <div className="card span-6">
        <h3>Wordmark</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 16 }}>
          <div style={{ padding: "14px 0" }}><Wordmark size={30} onDark /></div>
          <div className="mark-on-paper"><Wordmark size={30} onDark={false} /></div>
        </div>
        <div className="doc">
          <ul>{tokens.wordmark.rules.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      </div>

      {/* --- type --- */}
      <div className="card span-12">
        <h3>Type</h3>
        <div className="table-wrap" style={{ marginBottom: 18 }}>
          <table className="table">
            <thead>
              <tr><th>Face</th><th>Token</th><th>Role</th></tr>
            </thead>
            <tbody>
              {tokens.type.faces.map((f) => (
                <tr key={f.token}>
                  <td style={{ fontFamily: f.stack, fontSize: 17 }}>{f.name}</td>
                  <td className="ident">{f.token}</td>
                  <td className="meta">{f.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Step</th><th>Size / line</th><th>Face</th><th>Use</th></tr>
            </thead>
            <tbody>
              {tokens.type.scale.map((s) => (
                <tr key={s.step}>
                  <td>{s.step}</td>
                  <td className="ident">{s.size}</td>
                  <td className="meta">{s.face}</td>
                  <td className="meta">{s.use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* --- naming --- */}
      <div className="card span-6">
        <h3>Naming architecture</h3>
        <p className="card-note">
          What each thing is called, and where the code hasn't caught up yet.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>What it is</th></tr></thead>
            <tbody>
              {tokens.naming.map((n) => (
                <tr key={n.name}>
                  <td style={{ whiteSpace: "nowrap" }}>{n.name}</td>
                  <td>
                    <div>{n.what}</div>
                    {n.note && <div className="meta" style={{ marginTop: 3 }}>{n.note}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* --- voice --- */}
      <div className="card span-6">
        <h3>Voice</h3>
        <div className="doc">
          <ul>{tokens.voice.principles.map((p) => <li key={p}>{p}</li>)}</ul>
          <p style={{ marginTop: 14 }}>
            <strong>Words we don't use:</strong>{" "}
            {tokens.voice.avoid.map((w, i) => (
              <span key={w}>
                <code>{w}</code>{i < tokens.voice.avoid.length - 1 ? " " : ""}
              </span>
            ))}
          </p>
        </div>
      </div>
    </div>
  );
}
