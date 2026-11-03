// Bundles the extension into extension/build/. Reads ANTHROPIC_API_KEY from the environment
// (run with `node --env-file=.env`) and writes it into extension/build/config.js, which is
// gitignored. Fails if the key is missing, since channel classification can't work without it.
// READWISE_TOKEN, when set, goes in too: the extension uses it for the Reader API until a token
// is entered in its settings, so a build can track phone reading with no setup.
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.error("ANTHROPIC_API_KEY is not set; run `npm run build` (it loads .env)."); process.exit(1); }
await mkdir("extension/build", { recursive: true });
// The background worker compares the build ID compiled into it with build/build-id.txt and reloads
// the extension when they differ, so a rebuild takes effect without pressing reload.
const buildId = String(Date.now());
await writeFile("extension/build/build-id.txt", buildId);
await writeFile("extension/build/config.js", `export const ANTHROPIC_API_KEY = ${JSON.stringify(key)};\nexport const READWISE_TOKEN = ${JSON.stringify(process.env.READWISE_TOKEN ?? "")};\n`);
await build({
  entryPoints: { background: "src/background.js", dashboard: "src/dashboard.js" },
  bundle: true, outdir: "extension/build", format: "esm", target: "chrome120", logLevel: "warning",
  define: { __BUILD_ID__: JSON.stringify(buildId) },
});
// Content scripts can't be ES modules; rebuild them as plain scripts.
await build({
  entryPoints: { youtube: "src/content/youtube.js", "youtube-main": "src/content/youtube-main.js", reading: "src/content/reading.js" },
  bundle: true, outdir: "extension/build", format: "iife", target: "chrome120", logLevel: "warning",
});
console.log("built extension/build/");
