// Checks the Reader API path end to end in the browser with the seeded test account: the
// extension polls with a real token, and document updates spaced like reading-progress saves
// become reading time in the log. Updates a test document's title (and restores it) to move its
// updated_at, since the API can't set reading progress.
// Usage: READWISE_TOKEN=... node test/e2e/live-reader.mjs  (opens a browser window)
import { Browser, sleep } from "./harness.js";

const token = process.env.READWISE_TOKEN;
const api = (path, init = {}) => fetch(`https://readwise.io/api/v3/${path}`, { ...init, headers: { Authorization: `Token ${token}`, "Content-Type": "application/json", ...init.headers } });
const SAVES = 4, GAP_S = 20;

const b = await Browser.launch();
let doc, originalTitle;
try {
  await b.worker.eval(`chrome.storage.local.clear().then(() => chrome.storage.local.set({ settings: { readwiseToken: ${JSON.stringify(token)} } })).then(() => true)`);
  let state;
  // The first poll fetches every document's text, which can hit the 20-requests-a-minute limit.
  for (let i = 0; i < 150; i++) { state = (await b.storage(["readerApi"])).readerApi; if (state?.lastPollAt) break; await sleep(1000); }
  if (!state?.lastPollAt) throw new Error(`no successful poll: ${JSON.stringify((await b.storage(["problems"])).problems)}`);
  const docs = Object.entries(state.state.docs).filter(([, d]) => d.share >= 0.3);
  [doc, { title: originalTitle }] = docs[0];
  console.log(`baseline poll: ${Object.keys(state.state.docs).length} documents, ${docs.length} Mandarin; reading ${doc}`);

  for (let i = 0; i < SAVES; i++) {
    const r = await api(`update/${doc}/`, { method: "PATCH", body: JSON.stringify({ title: `${originalTitle} (${i + 1})` }) });
    if (!r.ok) throw new Error(`update returned ${r.status}`);
    await sleep(2000);
    await b.worker.eval(`chrome.runtime.sendMessage({ type: "pollReader" }).then(() => true)`);
    if (i < SAVES - 1) await sleep((GAP_S - 2) * 1000);
  }
  const { log = {}, problems = [] } = await b.storage(["log", "problems"]);
  const item = Object.values(log)[0]?.reader?.[doc];
  const expected = (SAVES - 1) * GAP_S + 45; // gaps between saves plus the tail after the last
  console.log(JSON.stringify({ item, expectedApiSeconds: expected, problems }, null, 2));
  if (!item || Math.abs(item.apiSeconds - expected) > 10 || problems.length) process.exitCode = 1;
} finally {
  if (doc) await api(`update/${doc}/`, { method: "PATCH", body: JSON.stringify({ title: originalTitle }) });
  await b.close();
}
