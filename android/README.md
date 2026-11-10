# Android app

Counts time in YouTube, Pleco, Readwise Reader and AI chat apps on the phone and sends it to the Mac hub (see `docs/protocol.md`). After setup it runs on its own.

- Unit tests: `./gradlew :app:testDebugUnitTest`
- Emulator tests (AOSP image without real YouTube, e.g. AVD `mt-aosp35`): `e2e/run.sh -s emulator-5554`
- Signed release APK: `./gradlew :app:assembleRelease` → `app/build/outputs/apk/release/app-release.apk`. Needs `keystore/release.jks` and `keystore/release.properties` (not in git).
