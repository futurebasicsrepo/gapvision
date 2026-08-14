import { useEffect, useState } from "react";
import { api, session, isCueStaff } from "./api.js";
import { Wordmark } from "./components/Mark.jsx";
import Login from "./components/Login.jsx";
import Health from "./components/Health.jsx";
import Tenants from "./components/Tenants.jsx";
import Architecture from "./components/Architecture.jsx";
import Brand from "./components/Brand.jsx";

const VIEWS = [
  ["health", "Health"],
  ["tenants", "Tenants"],
  ["architecture", "Architecture"],
  ["brand", "Brand"],
];

export default function App() {
  const [user, setUser] = useState(session.user);
  const [checking, setChecking] = useState(Boolean(session.token));
  const [view, setView] = useState("health");

  // A stored token may have been revoked since the tab was opened. Confirm it
  // before rendering panels that would 401 one at a time and look broken.
  useEffect(() => {
    if (!session.token) return;
    api.me()
      .then(({ user: fresh }) => { setUser(fresh); session.save(session.token, fresh); })
      .catch(() => { session.clear(); setUser(null); })
      .finally(() => setChecking(false));
  }, []);

  async function signOut() {
    await api.logout();
    session.clear();
    setUser(null);
  }

  if (checking) {
    return <div className="console"><div className="empty">Checking your session…</div></div>;
  }
  if (!user) return <Login onSignedIn={setUser} />;

  // Belt and braces. The API refuses these accounts on every route anyway;
  // this exists so a retailer's admin who lands here reads a sentence instead
  // of a shell that fails one panel at a time.
  if (!isCueStaff(user)) {
    return (
      <div className="signin-wrap">
        <div className="signin">
          <Wordmark size={22} />
          <div className="notice error">
            This console is for cuesea staff. Your account is a{" "}
            <strong>{user.role.replace("_", " ")}</strong>
            {user.tenant_slug ? <> at <span className="ident">{user.tenant_slug}</span></> : null}
            {" "}— everything you need is in Cue Studio.
          </div>
          <div className="btn-row">
            <a className="btn primary" href="https://app.cuesea.ai">Open Cue Studio</a>
            <button className="btn ghost" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="console">
      <header className="topbar">
        <div className="brand">
          <Wordmark size={21} />
          <span className="brand-sub">Cue Console · staff</span>
        </div>
        <div className="topbar-right">
          <span className="whoami">{user.email}</span>
          <button className="linkish" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <nav className="view-switch" style={{ marginBottom: 18, width: "fit-content" }}>
        {VIEWS.map(([key, label]) => (
          <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
      </nav>

      {view === "health" && <Health />}
      {view === "tenants" && <Tenants />}
      {view === "architecture" && <Architecture />}
      {view === "brand" && <Brand />}
    </div>
  );
}
