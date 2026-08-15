import { useState } from "react";
import { Wordmark } from "./Mark.jsx";
import { api } from "../api.js";

/**
 * Redeem an invite or reset link.
 *
 * This screen did not exist, and the link in every invitation pointed at it.
 * `mailer.link_for()` has always built `{app}/set-password?token=…`, the API
 * has always been able to redeem one at `POST /auth/reset`, and the test
 * asserted the string appeared in the email body — which it did. Nobody
 * checked that the URL resolved. The first person we ever invited followed a
 * live link to a 404.
 *
 * No session is issued on success, deliberately: the API sets the password and
 * stops there, so a leaked link cannot both set a password and hand back a
 * signed-in session in one request. That costs one screen and is worth it, so
 * this hands off to sign-in rather than pretending to be further along.
 */
export default function SetPassword({ token, onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  // Checked here so the message arrives while they are still typing, rather
  // than after a round trip. The API enforces the same floor — this is
  // courtesy, not the control.
  const tooShort = password.length > 0 && password.length < 10;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= 10 && confirm === password && !busy;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.setPassword(token, password);
      setDone(res.email || true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="signin-wrap">
        <div className="signin">
          <Wordmark size={22} />
          <h2>Something is missing</h2>
          <p className="signin-sub">
            This page needs the link from your invitation email. Open that link
            directly rather than typing the address — the token is the part
            that identifies you.
          </p>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="signin-wrap">
        <div className="signin">
          <Wordmark size={22} />
          <h2>Password set</h2>
          <p className="signin-sub">
            {typeof done === "string"
              ? `You can sign in as ${done} now.`
              : "You can sign in now."}
          </p>
          <button className="btn primary" onClick={onDone}>Sign in</button>
        </div>
      </div>
    );
  }

  return (
    <div className="signin-wrap">
      <form className="signin" onSubmit={submit}>
        <Wordmark size={22} />
        <h2>Set your password</h2>
        <p className="signin-sub">
          Pick something only you know. The link you followed works once.
        </p>

        {/* The API distinguishes expired, already used, and never valid. Show
            whichever it said — they mean different things about what to do
            next, and flattening them to "invalid link" would waste that. */}
        {error && <div className="notice error">{error}</div>}

        <label className="field">
          <span>New password</span>
          <input type="password" value={password} autoComplete="new-password" required
                 onChange={(e) => setPassword(e.target.value)} />
        </label>
        {tooShort && <p className="card-note">At least 10 characters.</p>}

        <label className="field">
          <span>Again</span>
          <input type="password" value={confirm} autoComplete="new-password" required
                 onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {mismatch && <p className="card-note error">These don't match.</p>}

        <button className="btn primary" type="submit" disabled={!ready}>
          {busy ? "Setting…" : "Set password"}
        </button>
      </form>
    </div>
  );
}
