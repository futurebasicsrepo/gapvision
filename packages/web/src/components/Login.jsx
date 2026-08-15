import { useState } from "react";
import { api, session } from "../api.js";
import { Wordmark } from "./Mark.jsx";

export default function Login({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await api.login(email.trim(), password);
      session.save(token, user);
      onSignedIn(user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="signin-wrap">
      <form className="signin card" onSubmit={submit}>
        <Wordmark size={22} />
        <h2>Sign in</h2>
        <p className="signin-sub">Studio — floor performance and administration</p>

        <label>
          <span>Email</span>
          <input
            type="email" value={email} autoComplete="username" required autoFocus
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label>
          <span>Password</span>
          <input
            type="password" value={password} autoComplete="current-password" required
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {/* One message for every failure, matching the API — it does not
            distinguish a wrong password from an account that doesn't exist. */}
        {error && <div className="signin-error" role="alert">{error}</div>}

        <button type="submit" className="primary" disabled={busy || !email || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
