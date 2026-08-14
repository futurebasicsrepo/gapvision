import { useState } from "react";
import { api, session } from "../api.js";
import { Wordmark } from "./Mark.jsx";

/**
 * Sign in.
 *
 * Says nothing about what this console is or who it's for until you're
 * through. An unauthenticated visitor should not be able to read the names of
 * our internal panels off a login screen.
 */
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
      // The API returns the same 401 for a wrong password and an account that
      // doesn't exist. Keep it that way here — don't narrate a difference the
      // backend deliberately refuses to make.
      setError(err.status === 401 ? "That email and password don't match." : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin-wrap">
      <form className="signin" onSubmit={submit}>
        <Wordmark size={22} />
        <h2>Sign in</h2>
        <p className="signin-sub">Cue Console</p>

        {error && <div className="notice error">{error}</div>}

        <label className="field">
          <span>Email</span>
          <input type="email" value={email} autoComplete="username" required
                 onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" value={password} autoComplete="current-password" required
                 onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn primary" type="submit" disabled={busy || !email || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
