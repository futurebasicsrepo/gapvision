/**
 * A markdown viewer, for the reference docs that live in the repo.
 *
 * Deliberately not a markdown library. The only documents this ever renders
 * are ones we wrote and that are checked into the repo beside the code, so the
 * usual reasons to reach for a parser — arbitrary input, HTML passthrough,
 * sanitising somebody else's content — do not apply. What a dependency would
 * add here is bundle weight and an HTML injection surface, in exchange for
 * syntax we do not use.
 *
 * So this handles the subset our docs are written in: headings, paragraphs,
 * lists, tables, blockquotes, fenced code, horizontal rules, and inline bold,
 * code and links. Anything else renders as plain text rather than as broken
 * markup — a doc that reads slightly flat is better than one that swallows a
 * paragraph because it met a syntax nobody implemented.
 */

/** Inline: **bold**, `code`, [text](url). Split rather than replace, so
 *  nothing is ever inserted as raw HTML. */
function inline(text, keyPrefix = "i") {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0, m, n = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${n++}`;
    if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("*")) out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    else if (tok.startsWith("`")) out.push(<code className="ident" key={key}>{tok.slice(1, -1)}</code>);
    else {
      const label = tok.slice(1, tok.indexOf("]"));
      const href = tok.slice(tok.indexOf("(") + 1, -1);
      const external = /^https?:/.test(href);
      out.push(
        <a key={key} href={href}
           target={external ? "_blank" : undefined}
           rel={external ? "noreferrer" : undefined}>{label}</a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableRow = (l) => l.trim().startsWith("|") && l.trim().endsWith("|");
const cells = (l) => l.trim().slice(1, -1).split("|").map((c) => c.trim());
/** The |---|---| separator, which is a table's second line and never content. */
const isTableRule = (l) => /^\|[\s:|-]+\|$/.test((l || "").trim());

export default function Doc({ source }) {
  const lines = String(source || "").split("\n");
  const blocks = [];
  let i = 0, k = 0;
  // The page chrome already prints the document's title, so rendering the
  // leading H1 as well shows it twice — which reads as a mistake rather than
  // as emphasis. Everything below the first heading renders normally.
  let droppedTitle = false;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // The docs:sync banner. It is a note to whoever opens the file in an
    // editor, not to whoever reads it in the console.
    if (line.trim().startsWith("<!--")) {
      while (i < lines.length && !lines[i].includes("-->")) i++;
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(<pre className="doc-pre" key={k++}><code>{body.join("\n")}</code></pre>);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      blocks.push(<hr className="doc-rule" key={k++} />);
      i++;
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h && h[1].length === 1 && !droppedTitle) {
      droppedTitle = true;
      i++;
      continue;
    }
    if (h) {
      const Tag = `h${Math.min(h[1].length + 1, 5)}`;
      blocks.push(<Tag className={`doc-h doc-h${h[1].length}`} key={k++}>{inline(h[2], `h${k}`)}</Tag>);
      i++;
      continue;
    }

    if (line.trim().startsWith(">")) {
      const body = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        body.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(<blockquote className="doc-quote" key={k++}>{inline(body.join(" "), `q${k}`)}</blockquote>);
      continue;
    }

    if (isTableRow(line) && isTableRule(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div className="table-wrap" key={k++}>
          <table className="table">
            <thead><tr>{head.map((c, n) => <th key={n}>{inline(c, `th${n}`)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, rn) => (
                <tr key={rn}>{r.map((c, cn) => <td key={cn}>{inline(c, `td${rn}-${cn}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
        // Continuation lines belong to the item above them.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) &&
               !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          items[items.length - 1] += " " + lines[i].trim();
          i++;
        }
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List className="doc-list" key={k++}>
          {items.map((it, n) => <li key={n}>{inline(it, `li${n}`)}</li>)}
        </List>,
      );
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() &&
           !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s|---+$)/.test(lines[i]) &&
           !isTableRow(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) blocks.push(<p key={k++}>{inline(para.join(" "), `p${k}`)}</p>);
  }

  return <div className="doc doc-md">{blocks}</div>;
}
