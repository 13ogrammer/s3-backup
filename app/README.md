# s3-backup app

Expo (React Native) app for iOS + Android. Connects to the backend in
`../backend/` to back up phone photos and videos to your own S3 bucket.

## Dev

```bash
npm install
npm start         # press 'i' for iOS sim, 'a' for Android, or scan with Expo Go
```

Then open the **Settings** tab and paste your backend API URL + bootstrap
token (from the SAM stack outputs). Tap **Test** to verify connectivity.

Note: `expo-media-library` doesn't run in Expo Go on Android (Google's
granular media permissions). Gallery uses `expo-image-picker`'s system
picker instead, which does work in Expo Go on both platforms. To use the
inline scrollable gallery grid, you need a custom dev build (see
"EAS Build" below) and to restore
`app/legacy/gallery-media-library.tsx` over `app/app/(tabs)/index.tsx`.

## EAS Build (installable .apk / .ipa)

Production-style installs use EAS Build. One-time setup:

```bash
npm install -g eas-cli
eas login                # free Expo account at https://expo.dev
eas project:init         # links this directory to a project in your account
```

Then update `app/app.json`:

- `ios.bundleIdentifier` — change from `com.example.s3backup` to a
  reverse-DNS string you own (e.g. `com.yourname.s3backup`).
- `android.package` — same string.

Profiles in `eas.json`:

| Profile | What | When |
|---|---|---|
| `development` | dev client `.apk` / `.ipa` | Daily dev — install once, then `npm start` connects to it. |
| `preview` | release `.apk` (Android) or signed `.ipa` (iOS), internal distribution; versionCode auto-incremented per build | Smoke test before release; sideload on a device. |
| `production` | release build with auto-incremented version, ready to submit | App Store / Play Store submission. |

### Sentry (error reporting)

`EXPO_PUBLIC_SENTRY_DSN` is required for error reporting in `preview` and
`production` builds. The DSN is inlined at bundle time — if the variable is
absent from the EAS environment, `initSentry()` short-circuits silently:
`failureCount` still increments, but no events reach Sentry at all.

Add it as an EAS secret (never commit the real value):

```bash
eas secret:create --scope project --name EXPO_PUBLIC_SENTRY_DSN --value <your-dsn>
```

The `eas.json` `preview` and `production` profiles already include an empty
`EXPO_PUBLIC_SENTRY_DSN: ""` placeholder so EAS reads the variable from
secrets; the real value must come from the EAS dashboard or the command above.

For the Sentry auth token needed for source-map uploads, see the note in
`CLAUDE.md` — same pattern, separate secret.

Build commands:

```bash
eas build --profile development --platform android   # ~10 min, gives a .apk URL
eas build --profile preview --platform android       # release .apk
eas build --profile production --platform ios        # signed .ipa for App Store

# or both at once
eas build --profile preview --platform all
```

For iOS distribution outside the App Store you'll need TestFlight (free
for up to 10K testers) — `eas submit -p ios --profile production` after
a production build.

For Android sideload, just download the `.apk` from the EAS build
output and install on a device with "Install unknown apps" enabled for
your file manager / browser.

## Releasing

> **Rule:** `version` in `app/app.json` tracks the **native binary**, not the
> JS bundle. Never bump it for a JS-only change. The `runtimeVersion` policy
> is `appVersion`, so bumping `version` produces a new runtime version and
> OTA bundles published against it cannot reach existing installs.

Bump `version` (manually — EAS autoIncrement only handles the native
versionCode/build-number counter) when the **native** side changes:

- **Patch** (`1.0.x`): native bug fix or small native dep bump.
- **Minor** (`1.x.0`): new native dependency or notable native behaviour change.
- **Major** (`x.0.0`): breaking native change (new permission, removed
  permission, change in minimum OS target).

For JS-only changes (UI tweaks, bug fixes, new screens, new JS-only
components), leave `version` alone and ship via OTA.

Release flows:

| Change type | Command | `version` bump? | How users get it |
|---|---|---|---|
| JS-only fix / feature | `eas update --branch preview --message "..."` | No | OTA — auto-applied on next app launch |
| Native change (new dep, SDK bump, native fix) | `eas build --profile preview --platform android` | Yes | In-app update banner → user taps Download → sideload new APK |

### Update banner

The "Download" banner is opt-in. Set `EXPO_PUBLIC_VERSION_MANIFEST_URL`
to point at a JSON manifest hosted in the public release bucket (see
`docs/DEPLOYMENT.md` for the bucket + manifest setup). Local dev reads
it from `app/.env` (copy `.env.example`). EAS builds read it from the
build profile's environment variables in the EAS dashboard. Leave it
unset and the banner is inert — no banner, no network call.

## Structure

```
app/
├── app/
│   ├── _layout.tsx          Root stack + theme provider
│   └── (tabs)/
│       ├── _layout.tsx      Bottom tabs (Gallery / Browse / Settings)
│       ├── index.tsx        Gallery (system picker)
│       ├── browse.tsx       S3 browser with thumbnails + grid/list + sort + select
│       └── settings.tsx     Backend URL + bootstrap token form
├── lib/
│   ├── api.ts               HTTP client for the backend
│   ├── config.ts            expo-secure-store wrappers
│   ├── upload.ts            Pre-signed PUT + thumb generation
│   └── format.ts            Byte / path / media-type helpers
├── components/              Themed primitives, modals, preview, picker
├── constants/theme.ts       Colors / Radius / Spacing / Shadow / Type tokens
├── legacy/                  Preserved inline-grid Gallery (post dev-build path)
└── eas.json                 EAS Build profiles
```
