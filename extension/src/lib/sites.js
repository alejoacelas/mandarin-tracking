// The pages the reading content script tracks: LLM chats and Readwise Reader documents.
//
// For each site:
//   conversation(url) -> the conversation or document id in the URL, or null
//   isNewChat(url)    -> a chat page that will get an id once the first message is sent
//   title(doc)        -> the conversation or document title
//   content           -> CSS selectors for the conversation's messages (or the document's text),
//                        so the sidebar, history list and menus aren't measured. Checked live where
//                        noted; the others follow each site's current markup as far as known and
//                        report a problem when they find nothing.
const stripSuffix = (re) => (doc) => doc.title.replace(re, "").trim() || null;

export const SITES = {
  // Checked live 2026-11-10. ChatGPT dropped data-message-author-role from some layouts in 2026.
  "chatgpt.com": {
    source: "llm",
    conversation: (u) => u.pathname.match(/^\/(?:g\/[\w-]+\/)?c\/([\w-]{8,})/)?.[1] ?? null,
    isNewChat: (u) => u.pathname === "/" || /^\/g\/[\w-]+\/?$/.test(u.pathname) || /^\/g\/[\w-]+\/project\/?$/.test(u.pathname),
    title: stripSuffix(/\s*[-|]\s*ChatGPT$/),
    content: ["[data-message-author-role]", "[data-user-message-bubble]", "[data-dil-response]", "[data-markdown-copy]"],
  },
  // Checked live 2026-11-10.
  "claude.ai": {
    source: "llm",
    conversation: (u) => u.pathname.match(/^\/chat\/([0-9a-f-]{36})/)?.[1] ?? null,
    isNewChat: (u) => u.pathname === "/new" || /^\/project\/[\w-]+\/?$/.test(u.pathname),
    title: stripSuffix(/\s*-\s*Claude$/),
    content: ['[data-testid="user-message"]', "[data-is-streaming]", ".font-claude-response"],
  },
  // Checked live 2026-11-10 (signed in).
  "gemini.google.com": {
    source: "llm",
    conversation: (u) => u.pathname.match(/^(?:\/u\/\d+)?\/(?:app|gem\/[\w-]+)\/([0-9a-f]{8,})/)?.[1] ?? null,
    isNewChat: (u) => /^(?:\/u\/\d+)?\/(?:app|gem\/[\w-]+)\/?$/.test(u.pathname),
    title: stripSuffix(/\s*-\s*(?:Google )?Gemini$/),
    content: ["user-query", "model-response"],
  },
  // Not checked live (no signed-in account): sign-in page only.
  "chat.deepseek.com": {
    source: "llm",
    conversation: (u) => u.pathname.match(/^\/a\/chat\/s\/([\w-]{8,})/)?.[1] ?? null,
    isNewChat: (u) => u.pathname === "/" || u.pathname === "/a/chat" || u.pathname === "/a/chat/",
    title: stripSuffix(/\s*-\s*(?:DeepSeek|DSeek).*$/),
    content: [".ds-message", ".ds-markdown"],
  },
  "www.doubao.com": {
    source: "llm",
    conversation: (u) => u.pathname.match(/^\/chat\/(\d{6,})/)?.[1] ?? null,
    isNewChat: (u) => u.pathname === "/chat" || u.pathname === "/chat/",
    title: stripSuffix(/\s*-\s*豆包.*$/),
    content: ['[data-testid="message_text_content"]', '[data-testid="send_message"]', '[data-testid="receive_message"]'],
  },
  "www.kimi.com": {
    source: "llm",
    conversation: (u) => u.pathname.match(/^\/chat\/([\w-]{8,})/)?.[1] ?? null,
    isNewChat: (u) => u.pathname === "/" || u.pathname === "/chat" || u.pathname === "/chat/",
    title: stripSuffix(/\s*-\s*Kimi.*$/),
    content: [".chat-content-item", ".segment-content"],
  },
  "grok.com": {
    source: "llm",
    conversation: (u) => u.pathname.match(/^\/(?:project\/[\w-]+\/)?c\/([\w-]{8,})/)?.[1] ?? null,
    isNewChat: (u) => u.pathname === "/" || u.pathname === "/chat",
    title: stripSuffix(/\s*-\s*Grok$/),
    content: [".message-bubble", "[id^='response-']"],
  },
  "www.perplexity.ai": {
    source: "llm",
    conversation: (u) => u.pathname.match(/^\/search\/([\w.-]{8,})/)?.[1] ?? null,
    isNewChat: (u) => u.pathname === "/",
    title: stripSuffix(/\s*[|-]\s*Perplexity$/),
    content: ["[id^='markdown-content']", ".prose", "h1.group\\/query", "[class*='group/query']"],
  },
  // Checked live 2026-11-10 (signed in, test account).
  "read.readwise.io": {
    source: "reader",
    conversation: (u) => u.pathname.match(/\/read\/([0-9a-z]{8,})/i)?.[1] ?? null,
    isNewChat: () => false,
    title: stripSuffix(/\s*[|–-]\s*Readwise.*$/i),
    content: ["#document-text-content"],
  },
};
// Kimi also serves from kimi.com without www.
SITES["kimi.com"] = SITES["www.kimi.com"];
SITES["perplexity.ai"] = SITES["www.perplexity.ai"];

// Host patterns for the manifest and for injecting into open tabs.
export const READING_MATCHES = Object.keys(SITES).map((h) => `https://${h}/*`);

// Elements matching any selector, keeping only the outermost when they nest.
export function contentElements(doc, selectors) {
  const found = new Set();
  for (const sel of selectors) {
    let list;
    try { list = doc.querySelectorAll(sel); } catch { continue; }
    for (const el of list) found.add(el);
  }
  return [...found].filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (found.has(p)) return false;
    return true;
  });
}
