// Checks the Mac app time path end to end: the extension copies totals from the apptime helper
// (apptime/install.sh must have run on this Mac) and the dashboard shows the chosen apps. Saves
// /tmp/dashboard-apps.png. Usage: node test/e2e/live-apptime.mjs  (opens a browser window)
import { Browser, sleep } from "./harness.js";
import { writeFileSync } from "node:fs";

const helper = await (await fetch("http://127.0.0.1:47321/")).json();
const today = new Date().toLocaleDateString("sv");
const apps = Object.values(helper.days[today] ?? {}).sort((a, b) => b.seconds - a.seconds);
const names = ["Orca", ...apps.slice(0, 1).map((a) => a.name)];
const b = await Browser.launch();
try {
  await b.worker.eval(`chrome.storage.local.set({ settings: { threshold: 0.3, idleSeconds: 120, macApps: ${JSON.stringify(names)} } }).then(() => true)`);
  let appTime;
  for (let i = 0; i < 80; i++) { appTime = (await b.storage(["appTime"])).appTime; if (appTime?.at) break; await sleep(1000); }
  if (!appTime?.at) throw new Error(`no app time copied: ${JSON.stringify(appTime)}`);
  await b.worker.eval(`location.href = "dashboard.html"`).catch(() => {});
  await sleep(1500);
  const card = await b.worker.eval(`[...document.querySelectorAll(".card")].find((c) => c.textContent.startsWith("Mac apps"))?.innerText ?? null`);
  const shot = await b.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, b.worker.sessionId);
  writeFileSync("/tmp/dashboard-apps.png", Buffer.from(shot.data, "base64"));
  console.log(JSON.stringify({ helperToday: apps.slice(0, 3), shown: names, card }, null, 2));
  if (!card || !names.every((n) => card.includes(n)) || /isn't answering|Waiting/.test(card)) process.exitCode = 1;
} finally {
  await b.close();
}
