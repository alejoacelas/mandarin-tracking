// Bundles the extension into dist/. The background worker and popup are ES modules; content
// scripts can't be, so they're bundled as plain scripts.
//   node scripts/build.mjs                    builds this folder's dist/
//   buildExtension(dir, { hubUrl })           builds a copy into `dir` (used by the e2e tests)
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildExtension(outRoot = root, { hubUrl } = {}) {
  const common = {
    bundle: true, outdir: path.join(outRoot, "dist"), target: "chrome120", logLevel: "warning", absWorkingDir: root,
    define: hubUrl ? { __MT_HUB_URL__: JSON.stringify(hubUrl) } : {},
  };
  await build({ ...common, format: "esm", entryPoints: { background: "src/background/background.js", popup: "src/popup/popup.js" } });
  await build({ ...common, format: "iife", entryPoints: { youtube: "src/content/youtube.js", "youtube-main": "src/content/youtube-main.js", reading: "src/content/reading.js" } });
  if (outRoot !== root) {
    mkdirSync(outRoot, { recursive: true });
    for (const f of ["manifest.json", "popup.html"]) copyFileSync(path.join(root, f), path.join(outRoot, f));
  }
  return outRoot;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildExtension();
  console.log("built dist/");
}
