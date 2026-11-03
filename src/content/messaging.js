// Content-script side of talking to the background worker.
export const DEFAULT_SETTINGS = { idleSeconds: 120, threshold: 0.3, macApps: ["Orca"] };

let contextGone = false;

// Resolves true when the background worker stored the message, false otherwise.
export async function send(message) {
  if (contextGone) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await chrome.runtime.sendMessage(message);
      if (reply?.ok) return true;
    } catch (e) {
      // The extension was reloaded or removed. The background worker injects a fresh copy of
      // this script into open tabs on update, so this copy just stops.
      if (!chrome.runtime?.id) { contextGone = true; return false; }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export function reportProblem(source, message) {
  send({ type: "problem", source, message, url: location.href });
}

export async function loadSettings(onChange) {
  const { settings } = await chrome.storage.local.get("settings");
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings) onChange?.({ ...DEFAULT_SETTINGS, ...changes.settings.newValue });
  });
  return { ...DEFAULT_SETTINGS, ...settings };
}

// Each injected copy of a content script stops older copies in the same page, so a tab never
// counts twice after the extension updates.
export function claimPage(name) {
  const token = Math.random().toString(36).slice(2);
  document.documentElement.dataset[name] = token;
  return () => document.documentElement.dataset[name] === token && !contextGone;
}
