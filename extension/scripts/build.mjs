// Bundles the extension into dist/. The background worker and popup are ES modules; content
// scripts can't be, so they're bundled as plain scripts.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const common = { bundle: true, outdir: path.join(root, "dist"), target: "chrome120", logLevel: "warning", absWorkingDir: root };
await build({ ...common, format: "esm", entryPoints: { background: "src/background/background.js", popup: "src/popup/popup.js" } });
await build({ ...common, format: "iife", entryPoints: { youtube: "src/content/youtube.js", "youtube-main": "src/content/youtube-main.js", reading: "src/content/reading.js" } });
console.log("built dist/");
