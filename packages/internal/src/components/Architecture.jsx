import { Fragment } from "react";
import SystemMap from "./SystemMap.jsx";

/**
 * Architecture — the reference a new cuesea employee reads on day one.
 *
 * Deliberately explains *why* alongside *what*. Most of what's surprising
 * about this system is a decision, not an accident, and someone who doesn't
 * know which is which will "fix" the decisions.
 */

const PIPELINE = [
  {
    name: "Guest signal",
    sub: "opt-in only",
    note: "A QR check-in or beacon. No camera, no face. Nobody is identified who didn't ask to be.",
  },
  {
    name: "Cue Lens",
    sub: "Even Realities G2",
    note: "The plugin, sideloaded. 576×288 monochrome. Three lines and up to three supporting facts — never more.",
  },
  {
    name: "Even App",
    sub: "associate's phone",
    note: "Hosts the plugin in a WebView and relays display over BLE. There is no supported path around it.",
  },
  {
    name: "Realtime",
    sub: "Node · Socket.io",
    note: "Sessions, roster, voice audio. Holds the service key so no browser ever does. Writes events fire-and-forget.",
  },
  {
    name: "Depth",
    sub: "FastAPI · the AI service",
    note: "Grounded answers, recommendations, the cue grammar. Deepgram and Grok in production, both swappable by env var.",
  },
  {
    name: "Postgres",
    sub: "the control plane",
    note: "Tenants, people, devices, engagements, voice queries, usage rollups. Guests are referenced, never copied — an engagement holds the CRM's id, the cue we showed and the products we offered, and no customer record.",
  },
];

const SERVICES = [
  ["Cue Lens", "packages/glasses-plugin", "Vercel", "cuesea-lens.vercel.app", "Sideloaded by QR. Not in any store."],
  ["Cue Studio", "packages/web", "Vercel", "app.cuesea.ai", "Retailer back office."],
  ["Cue Console", "packages/internal", "Vercel", "internal.cuesea.ai", "This. Staff only, separate build on purpose."],
  ["Realtime", "packages/server", "Railway", "realtime-production-80f4", "Socket.io + the AI proxy."],
  ["Depth", "packages/ai-service", "Railway", "ai-service-production-a3af", "FastAPI. Owns the database."],
  ["Postgres", "—", "Railway", "DATABASE_URL reference", "Referenced, not pasted — survives a password rotation."],
];

const ROLES = [
  ["associate", "Own activity only. Cannot open a dashboard at all — their surface is the lens."],
  ["manager", "One store: roster, leaderboard, analytics. Read-only on people."],
  ["client_admin", "Manager rights plus people, devices, tenant config, privacy posture, their own usage."],
  ["cue_admin", "Every tenant. Provisioning and billing. Structurally cannot belong to a tenant — there's a database CHECK on it."],
];

function Flow() {
  return (
    <div className="flow">
      {PIPELINE.map((n, i) => (
        <Fragment key={n.name}>
          <div className="flow-node">
            <div className="n-name">{n.name}</div>
            <div className="n-sub">{n.sub}</div>
            <div className="n-note">{n.note}</div>
          </div>
          {i < PIPELINE.length - 1 && <span className="flow-arrow">→</span>}
        </Fragment>
      ))}
    </div>
  );
}

export default function Architecture() {
  return (
    <div className="grid grid-12">
      <div className="card span-12">
        <h3>The system</h3>
        <p className="card-note">
          One picture, and the thing it exists to say: the service key never
          leaves the boxed region, and the customer record never enters it.
        </p>
        <SystemMap />
      </div>

      <div className="card span-12">
        <h3>The path a cue takes</h3>
        <p className="card-note">
          The same thing in words, with the reasoning. An associate never
          touches anything but the first two boxes.
        </p>
        <Flow />
      </div>

      <div className="card span-12">
        <h3>Where everything runs</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Service</th><th>Package</th><th>Host</th><th>Address</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {SERVICES.map(([name, pkg, host, addr, note]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td className="ident">{pkg}</td>
                  <td><span className="pill muted">{host}</span></td>
                  <td className="ident">{addr}</td>
                  <td className="meta">{note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="meta" style={{ marginTop: 12 }}>
          Railway auto-deploys from <code className="ident">main</code>. That's
          why environment variables have to exist before a push that needs them
          — the deploy won't wait for you.
        </p>
      </div>

      <div className="card span-6">
        <h3>Roles and isolation</h3>
        <div className="doc">
          <p>
            Scoping runs through one function, <code>identity.scope_tenant()</code>,
            so there is exactly one place to audit. A manager who asks for
            another retailer's tenant gets <strong>their own data back, not a
            403</strong> — there's no legitimate reason to ask, and an error
            would confirm that the other tenant exists.
          </p>
          <ul>
            {ROLES.map(([role, what]) => (
              <li key={role}><code>{role}</code> — {what}</li>
            ))}
          </ul>
          <p>
            A client admin can set their own privacy posture but not their
            billing plan or status. Nobody can create an account above their own
            role.
          </p>
        </div>
      </div>

      <div className="card span-6">
        <h3>How attribution works</h3>
        <div className="doc">
          <p>
            The Even SDK cannot tell us who is wearing a pair of glasses. Its{" "}
            <code>UserInfo</code> carries a uid, a display name, an avatar and a
            country — no email. So attribution runs on the <strong>serial the
            device knows about itself</strong>.
          </p>
          <ul>
            <li>The plugin reads the serial and sends it on <code>register</code>.</li>
            <li>Realtime attaches it to every event it reports.</li>
            <li>
              Depth resolves serial → person through <code>devices</code>. An
              unknown serial <strong>self-registers unassigned</strong> rather
              than being thrown away, so the Console can ask "these have been on
              the floor, who is wearing them?" instead of asking someone to read
              a serial number off a pair of glasses.
            </li>
            <li>A human assigns the owner here, in Tenants.</li>
          </ul>
          <p>
            Activity from an unassigned device is still recorded against the
            tenant — it just has no name on it, which is why Cue Studio says{" "}
            <em>unassigned device</em> rather than <em>unattributed</em>. One
            says what to do about it.
          </p>
        </div>
      </div>

      <div className="card span-6">
        <h3>What we deliberately don't store</h3>
        <div className="doc">
          <p>
            <strong>Guest profiles.</strong> Engagements carry the CRM's id and
            nothing else. Cue is not a second home for a retailer's customer
            database, and an opt-in product should not accumulate profiles as a
            side effect of running. There is no screen to browse guests because
            there is no data to browse.
          </p>
          <p>
            <strong>Transcripts, and the answers beside them.</strong> Off by
            default, per tenant, and both halves ride the same flag. The
            operational analytics need intent, outcome and latency — not the
            words an associate said near a customer. An answer quotes the
            guest's record back at them, so it is no less sensitive than the
            question; and a question stored without its answer cannot be
            judged anyway. When they're withheld the API says so explicitly,
            so it doesn't read as a bug.
          </p>
          <p>
            <strong>What we do keep per engagement:</strong> the cue we showed
            and the products we offered. Stored as sent rather than re-derived
            later, because stock moves — "what did we suggest at 2pm" and "what
            would we suggest now" are different questions and only the first is
            reviewable.
          </p>
          <p>
            <strong>Faces.</strong> No camera on the glasses, by standing
            decision. Everything a camera adds is incremental; what it risks is
            the privacy position that gets a pilot approved in weeks instead of
            quarters.
          </p>
        </div>
      </div>

      <div className="card span-6">
        <h3>Two defaults worth defending</h3>
        <div className="doc">
          <p>
            <strong>Leaderboards weight assists.</strong> 25 points each by
            default, tunable per tenant, alongside sales and engagements — and
            every component is returned so a ranking can be explained to the
            person it ranks. Ranking retail staff on sales alone reliably
            produces cherry-picking: staff compete for the promising customer
            and stop covering for each other.
          </p>
          <p>
            <strong>Reporting is fire-and-forget.</strong> The realtime server
            writes events without waiting. An associate mid-conversation must
            not feel a reporting outage. A dropped socket closes its engagement
            as <code>abandoned</code> rather than leaving an open row that
            quietly corrupts average-engagement-length.
          </p>
        </div>
      </div>

      <div className="card span-6">
        <h3>Known gaps</h3>
        <div className="doc">
          <p>Say these out loud before a customer finds them.</p>
          <ul>
            <li>
              <strong>Retention isn't enforced.</strong>{" "}
              <code>privacy.retention_days</code> is stored and nothing deletes
              on it yet. A promise the code doesn't keep is worse than no
              promise.
            </li>
            <li>
              <strong>No invites or password reset.</strong> Admins can create
              an account but the person can't set their own password.
            </li>
            <li>
              <strong>Login isn't rate-limited.</strong> The service-key limiter
              doesn't cover <code>/auth</code>.
            </li>
            <li>
              <strong>Nothing enforces a retention window on floor
              messages either.</strong> Whatever floor comms ends up storing
              inherits the same gap as transcripts.
            </li>
            <li>
              <strong>Infrastructure still says gapvision.</strong> Repo,
              Railway project, and every <code>GAPVISION_*</code> variable.
              Cosmetic, but it confuses anyone new.
            </li>
          </ul>
        </div>
      </div>

      <div className="card span-12">
        <h3>The lesson we paid for</h3>
        <div className="doc">
          <p>
            The first production deploy reported{" "}
            <code>{`{"configured": true, "reachable": true, "migrations": 0}`}</code>{" "}
            — which reads as healthy and means the schema does not exist. The
            Dockerfile copied <code>app</code> and <code>tests</code> but not{" "}
            <code>migrations</code>, so the migrator globbed an empty directory
            and announced success.
          </p>
          <p>
            <strong>"Reachable" is not "working."</strong> Every check on the
            Health panel asserts on something a feature actually needs, and
            anything that can't be proven renders as unknown rather than as a
            pass.
          </p>
        </div>
      </div>
    </div>
  );
}
