import { useEffect, useState } from "react";
import { socket } from "./socket.js";
import Dashboard from "./components/Dashboard.jsx";
import AssociateView from "./components/AssociateView.jsx";

export default function App() {
  const [view, setView] = useState("associate");
  const [connected, setConnected] = useState(socket.connected);

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

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark">GAPVISION</span>
          <span className="brand-sub">Retail Floor Intelligence — Simulator</span>
        </div>
        <div className="view-switch">
          <button
            className={view === "associate" ? "active" : ""}
            onClick={() => setView("associate")}
          >
            Associate View
          </button>
          <button
            className={view === "dashboard" ? "active" : ""}
            onClick={() => setView("dashboard")}
          >
            Command Center
          </button>
        </div>
        <span className={`conn-dot ${connected ? "" : "offline"}`}>
          {connected ? "Realtime linked" : "Server offline"}
        </span>
      </div>

      {view === "associate" ? <AssociateView /> : <Dashboard />}
    </div>
  );
}
