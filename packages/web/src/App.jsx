import { useEffect, useState } from "react";
import { socket } from "./socket.js";
import { api, session } from "./api.js";
import { Wordmark } from "./components/Mark.jsx";
import Login from "./components/Login.jsx";
import SetPassword from "./components/SetPassword.jsx";
import ManagerDashboard from "./components/ManagerDashboard.jsx";
import Dashboard from "./components/Dashboard.jsx";
import Settings from "./components/Settings.jsx";
import Devices from "./components/Devices.jsx";
import AssociateView from "./components/AssociateView.jsx";

/** Which views a role may open. An associate has no business in here at all —
 *  their surface is the lens. */
const VIEWS = {
  manager: ["floor"],
  // Settings is the retailer's own admin, and only theirs. A manager runs the
  // floor; deciding what the glasses offer the whole floor is a rank up. CueSea
  // staff are deliberately absent: they have Console, and a second door into a
  // retailer's configuration — from a surface where the store came out of a
  // switcher — is how the wrong shop gets changed.
  //
  // Glasses sits beside Settings and under the same rule: handing out an
  // identity that registers as this store is the same class of act as changing
  // what the floor can do, and the API agrees — minting is `client_admin`.
  client_admin: ["floor", "glasses", "settings"],
  cue_admin: ["floor"],
};
const LABELS = {
  floor: "Floor", glasses: "Glasses", settings: "Settings", simulator: "Simulator",
};

/** The one path this app answers on other than `/`. Read once, before React
 *  renders anything, because the answer cannot change without a navigation. */
function invitedToken() {
  if (typeof window === "undefined") return null;
  if (!window.location.pathname.startsWith("/set-password")) return null;
  return new URLSearchParams(window.location.search).get("token") || "";
}

export default function App() {
  const [user, setUser] = useState(session.user);
  const [checking, setChecking] = useState(Boolean(session.token));
  const [invite, setInvite] = useState(invitedToken);
  const [view, setView] = useState("floor");
  const [connected, setConnected] = useState(socket.connected);
  // The bar boots before it becomes glass: one scan sweep, then the blur and
  // the lift fade in. Reduced motion skips straight to the settled state.
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let reduce = false;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* no matchMedia */ }
    if (reduce) { setBooting(false); return; }
    const t = setTimeout(() => setBooting(false), 1150);
    return () => clearTimeout(t);
  }, []);

  // A stored token may have been revoked or expired since the tab was open;
  // confirm it before rendering a dashboard that would 401 on every panel.
  useEffect(() => {
    if (!session.token) return;
    api.me()
      .then(({ user: fresh }) => { setUser(fresh); session.save(session.token, fresh); })
      .catch(() => { session.clear(); setUser(null); })
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    setConnected(socket.connected); // catch a connect that beat the listener
    socket.on("connect", on);
    socket.on("disconnect", off);
    return () => {
      socket.off("connect", on);
      socket.off("disconnect", off);
    };
  }, []);

  async function signOut() {
    await api.logout();
    session.clear();
    setUser(null);
  }

  // Before the session check, not after. Somebody redeeming an invitation has
  // no session by definition, and a stale token in this tab must not send them
  // to a spinner or a sign-in form instead of the link they clicked.
  if (invite !== null) {
    return (
      <SetPassword
        token={invite}
        onDone={() => {
          // The token is spent. Leaving it in the address bar and in history
          // is a credential lying around for no reason.
          window.history.replaceState({}, "", "/");
          setInvite(null);
        }}
      />
    );
  }

  if (checking) return <div className="app-shell"><div className="empty">Checking your session…</div></div>;
  if (!user) return <Login onSignedIn={setUser} />;

  const allowed = VIEWS[user.role] || [];
  if (allowed.length === 0) {
    return (
      <div className="app-shell">
        <div className="card signin-error" style={{ marginTop: 40 }}>
          Associates don't have a dashboard — your surface is Lens, in the glass.
          <button className="linkish" onClick={signOut}>Sign out</button>
        </div>
      </div>
    );
  }

  // The simulator stays available for demos, but behind the real thing.
  const views = [...allowed, "simulator"];

  return (
    <div className="app-shell">
      <div className={booting ? "topbar booting" : "topbar"}>
        <div className="brand">
          <Wordmark size={20} />
          <span className="brand-sub">
            Studio · {user.tenant_slug
              ? `${user.tenant_slug} · ${user.role.replace("_", " ")}`
              : "all tenants"}
          </span>
        </div>
        <div className="view-switch">
          {views.map((v) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
              {LABELS[v]}
            </button>
          ))}
        </div>
        <div className="topbar-right">
          <span className={`conn-dot ${connected ? "" : "offline"}`}>
            {connected ? "Realtime linked" : "Server offline"}
          </span>
          <button className="linkish" onClick={signOut}>Sign out</button>
        </div>
      </div>

      {view === "floor" && <ManagerDashboard user={user} />}
      {view === "glasses" && <Devices user={user} />}
      {view === "settings" && <Settings user={user} />}
      {view === "simulator" && (
        <>
          <p className="card-note" style={{ marginBottom: 12 }}>
            Demo harness — drives the same backend as Lens. Anything you do
            here is recorded against the {user.tenant_slug || "demo"} tenant.
          </p>
          <AssociateView />
          <Dashboard />
        </>
      )}
    </div>
  );
}
