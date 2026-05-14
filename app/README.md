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
| `preview` | release `.apk` (Android) or signed `.ipa` (iOS), internal distribution | Smoke test before release; sideload on a device. |
| `production` | release build with auto-incremented version, ready to submit | App Store / Play Store submission. |

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
