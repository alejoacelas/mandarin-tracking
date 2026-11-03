// Content-script side of talking to the background worker.
export const DEFAULT_SETTINGS = { idleSeconds: 120, threshold: 0.3 };

let contextGone = false;

export function send(message) {
  if (contextGone) return;
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // The extension was reloaded or removed; this page's script is orphaned until reload.
    contextGone = true;
  }
}

export function reportProblem(source, message) {
  send({ type: "problem", source, message, url: location.href });
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}
