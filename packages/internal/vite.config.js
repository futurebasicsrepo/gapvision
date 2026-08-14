import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * PREVIEW=1 swaps the API client for a fixture-backed stand-in and inlines
 * every asset into one HTML file, so the console can be shown to someone
 * without an account or a live backend.
 *
 * The alias is the whole mechanism: no `if (preview)` branches leak into the
 * application code, and a normal build cannot accidentally ship fixtures
 * because it never resolves that module.
 */
const preview = process.env.PREVIEW === "1";

/** Inline the built CSS and JS into index.html — a preview has to survive
 *  being opened as a single file, with no server to fetch siblings from. */
function singleFile() {
  return {
    name: "cue-single-file",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find((f) => f.fileName.endsWith(".html"));
      if (!html) return;
      let source = html.source;

      // Replacements are passed as functions, never strings. Minified React
      // is full of `$&`, `$'` and `$1`, which String.replace would treat as
      // capture-group references and silently corrupt the bundle.
      for (const [name, file] of Object.entries(bundle)) {
        if (name.endsWith(".css")) {
          source = source.replace(
            new RegExp(`<link[^>]*href="[^"]*${escapeRe(name)}"[^>]*>`),
            () => `<style>\n${file.source}\n</style>`,
          );
          delete bundle[name];
        } else if (name.endsWith(".js")) {
          // `</script>` inside a string literal would close the tag early.
          const code = file.code.replace(/<\/script>/g, "<\\/script>");
          source = source.replace(
            new RegExp(`<script[^>]*src="[^"]*${escapeRe(name)}"[^>]*></script>`),
            () => `<script type="module">\n${code}\n</script>`,
          );
          delete bundle[name];
        }
      }
      // Label it, unmistakably and permanently. A screenshot of this file
      // will outlive the conversation it was sent in, and fixture numbers
      // that look like production numbers are how invented figures end up in
      // a deck.
      source = source
        .replace("<title>Cue Console — cuesea</title>",
                 "<title>Cue Console — preview (sample data)</title>")
        .replace("<body>", `<body>
    <div id="preview-banner">
      Preview build · sample data · nothing here reads or writes a real tenant
    </div>
    <style>
      #preview-banner {
        position: sticky; top: 0; z-index: 20;
        background: #8C2D06; color: #FBF9F5;
        font: 500 11.5px/1 "IBM Plex Mono", ui-monospace, monospace;
        letter-spacing: 0.1em; text-transform: uppercase;
        padding: 9px 24px; text-align: center;
      }
      body::before { display: none; }
    </style>`);

      html.source = source;
    },
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default defineConfig({
  plugins: [react(), ...(preview ? [singleFile()] : [])],
  resolve: {
    alias: preview
      ? [{
          find: /^(?:\.\.?\/)+api\.js$/,
          replacement: fileURLToPath(new URL("./src/api.preview.js", import.meta.url)),
        }]
      : [],
  },
  build: preview ? { outDir: "dist-preview", assetsInlineLimit: 1e9 } : {},
  // 5174 is Cue Studio's preview port; the console sits next to it on 5176 so
  // both can run at once when you're checking that a change to one didn't leak
  // into the other.
  server: { port: 5176 },
  preview: { port: 5176 },
});
