import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 5174 is Cue Studio's preview port; the console sits next to it on 5176 so
// both can run at once when you're checking that a change to one didn't leak
// into the other.
export default defineConfig({
  plugins: [react()],
  server: { port: 5176 },
  preview: { port: 5176 },
});
