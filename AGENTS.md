# mandarin-tracking

## Credentials

Rebuild `.env` with `~/best/areas/dotfiles/bin/op-agent inject -i .env.tpl -o .env -f`.

| Variable | 1Password item | Field |
|---|---|---|
| `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY — personal-apps-2026-10` (`mj6dyf42xml2ughfxqzpxey3zi`, vault `mac-agents`) | `credential` |
| `READWISE_TOKEN` | `READWISE_TOKEN — mandarin-tracking` (`xzfcafysy35nkwq2grutb6lzx4`, vault `mac-agents`), a test Reader account with seeded Mandarin articles | `credential` |

The Android release keystore goes in `android/keystore/` (gitignored): `release.jks` is the 1Password document `Android release keystore file — mandarin-tracking` (`4godxrihbgboqcidugigfeiomi`, vault `mac-agents`). `release.properties` needs `storeFile=release.jks`, `keyAlias`, `storePassword` and `keyPassword` from the item `Android release keystore — mandarin-tracking` (`55t76ah4zfki7q3qszq6rbvxnm`, fields `key_alias`, `store_password`, `key_password`). Losing it means the friend must uninstall the app to update it.
