// Renders the dashboard with sample data, as the toolbar popup and as a tab, in light and dark,
// and saves screenshots to /tmp/dashboard-*.png. For visual checks; opens a browser window.
// Usage: node test/e2e/dashboard-screenshot.mjs
import { Browser, sleep } from "./harness.js";
import { writeFileSync } from "node:fs";

const b = await Browser.launch();
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() - offset); return d.toLocaleDateString("sv"); };
const log = {
  [day(0)]: {
    youtube: {
      "https://www.youtube.com/@laogao": { seconds: 1720, title: "老高與小茉 Mr & Mrs Gao", url: "https://www.youtube.com/@laogao" },
      "https://www.youtube.com/@xiao_lin_shuo": { seconds: 640, title: "小Lin说", url: "https://www.youtube.com/@xiao_lin_shuo" },
      "https://www.youtube.com/@YoyoChinese": { seconds: 410, title: "Yoyo Chinese", url: "https://www.youtube.com/@YoyoChinese" },
      "https://www.youtube.com/@serpentza": { seconds: 300, title: "serpentza", url: "https://www.youtube.com/@serpentza" },
      "https://www.youtube.com/@newchannel": { seconds: 95, title: "某个新频道", url: "https://www.youtube.com/@newchannel" },
    },
    claude: {
      "a1": { seconds: 840, title: "练习点外卖的对话", share: 0.82, url: "https://claude.ai/chat/a1" },
      "a2": { seconds: 300, title: "Project timeline", share: 0.01, url: "https://claude.ai/chat/a2" },
    },
    chatgpt: { "c1": { seconds: 420, title: "解释成语", share: 0.55, url: "https://chatgpt.com/c/c1" } },
    reader: { "r1": { seconds: 380, apiSeconds: 900, title: "测试", share: 1 } },
  },
  [day(1)]: { youtube: { "https://www.youtube.com/@laogao": { seconds: 2400 } }, claude: { a3: { seconds: 600, share: 0.7 } } },
  [day(2)]: { youtube: { "https://www.youtube.com/@xiao_lin_shuo": { seconds: 1500 } } },
  [day(4)]: { chatgpt: { c2: { seconds: 900, share: 0.6 } } },
};
const channels = {
  "https://www.youtube.com/@laogao": { name: "老高與小茉 Mr & Mrs Gao", status: "done", label: "mandarin", reason: "Mr. Gao tells mystery and science stories in Mandarin." },
  "https://www.youtube.com/@xiao_lin_shuo": { name: "小Lin说", status: "done", label: "mandarin", reason: "Finance explainers narrated in Mandarin." },
  "https://www.youtube.com/@YoyoChinese": { name: "Yoyo Chinese", status: "done", label: "mixed", reason: "Mandarin lessons taught largely in English." },
  "https://www.youtube.com/@serpentza": { name: "serpentza", status: "done", label: "other", reason: "English-language vlogs about China." },
  "https://www.youtube.com/@newchannel": { name: "某个新频道", status: "pending", since: Date.now() },
};
await b.worker.eval(`chrome.storage.local.clear().then(() => chrome.storage.local.set(${JSON.stringify({ log, channels, settings: { threshold: 0.3, idleSeconds: 120 } })})).then(() => true)`);
const page = b.worker;
for (const [mode, width, query] of [["popup", 420, "?popup"], ["tab", 900, ""]]) {
  for (const scheme of ["light", "dark"]) {
    await b.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, page.sessionId);
    await page.eval(`location.href = "dashboard.html${query}"`).catch(() => {});
    await sleep(1500);
    await b.cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 2, mobile: false }, page.sessionId);
    await sleep(300);
    const h = await page.eval(`document.documentElement.scrollHeight`);
    await b.cdp.send("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: 2, mobile: false }, page.sessionId);
    const shot = await b.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, page.sessionId);
    writeFileSync(`/tmp/dashboard-${mode}-${scheme}.png`, Buffer.from(shot.data, "base64"));
  }
}
await b.close();
console.log("saved /tmp/dashboard-*.png");
