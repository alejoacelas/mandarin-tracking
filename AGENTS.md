# mandarin-tracking

Scope: track time spent on Mandarin input across YouTube, Readwise Reader, Pleco and LLM chats. See README.md.

- Visibility: public
- Still running or billing: the Chrome extension bills the `personal-apps-2026-10` Anthropic key, once per new YouTube channel.

## Credentials

Rebuild `.env` with `~/best/stash/dotfiles/bin/op-agent inject -i .env.tpl -o .env -f`.

| Variable | 1Password item | Field |
|---|---|---|
| `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY — personal-apps-2026-10` (`mj6dyf42xml2ughfxqzpxey3zi`, vault `mac-agents`) | `credential` |

`npm run build` copies the key into `extension/build/config.js` (gitignored), because the
extension calls the Anthropic API directly to classify YouTube channels.
