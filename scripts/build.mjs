// Bundles the extension into extension/build/. Reads ANTHROPIC_API_KEY from the environment
// (run with `node --env-file=.env`) and writes it into extension/build/config.js, which is
// gitignored. Fails if the key is missing, since channel classification can't work without it.
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.error("ANTHROPIC_API_KEY is not set; run `npm run build` (it loads .env)."); process.exit(1); }
await mkdir("extension/build", { recursive: true });
await writeFile("extension/build/config.js", `export const ANTHROPIC_API_KEY = ${JSON.stringify(key)};\n`);
await build({
  entryPoints: { background: "src/background.js", popup: "src/popup.js" },
  bundle: true, outdir: "extension/build", format: "esm", target: "chrome120", logLevel: "warning",
});
// Content scripts can't be ES modules; rebuild them as plain scripts.
await build({
  entryPoints: { youtube: "src/content/youtube.js", "youtube-main": "src/content/youtube-main.js", reading: "src/content/reading.js" },
  bundle: true, outdir: "extension/build", format: "iife", target: "chrome120", logLevel: "warning",
});
console.log("built extension/build/");
