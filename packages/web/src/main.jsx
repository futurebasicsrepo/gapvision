import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import CheckIn from "./CheckIn.jsx";
import "./index.css";

/**
 * Two surfaces, one bundle, no router.
 *
 * `/here` is the guest page a plate points at — public, paper-toned, and the
 * only route in this app that must never sit behind a sign-in. Everything
 * else is Cue Studio. A path check is enough for two routes and cheaper than
 * a dependency; if a third public route ever appears, that is the moment to
 * add one.
 *
 * `vercel.json` rewrites `/here` to this bundle. It is listed explicitly
 * rather than as a catch-all so `/privacy.html` keeps being served as itself —
 * and the note lives here rather than in that file because Vercel validates
 * `vercel.json` against a schema that rejects unknown keys, including a
 * comment. It rejected one, and the deploy failed with the page written and
 * pushed.
 */
const guest = location.pathname.replace(/\/+$/, "") === "/here";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {guest ? <CheckIn /> : <App />}
  </React.StrictMode>
);
