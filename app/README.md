# s3-backup app

Expo (React Native) app for iOS + Android. Connects to the backend in
`../backend/` to back up phone photos/videos to your own S3 bucket.

## Dev

```bash
npm install
npm start         # then press 'i' for iOS, 'a' for Android, or scan QR with Expo Go
```

Open the **Settings** tab and paste your backend API URL + bootstrap token
(from the SAM stack outputs). Tap **Test** to verify connectivity.

## Building installable binaries

EAS Build configuration lands in the distribution phase. Until then:

```bash
npx expo prebuild
npx expo run:ios      # requires Xcode
npx expo run:android  # requires Android Studio
```

## Structure

```
app/
├── app/
│   ├── _layout.tsx          Root stack
│   └── (tabs)/
│       ├── _layout.tsx      Bottom tabs (Gallery / Browse / Settings)
│       ├── index.tsx        Gallery (phone photos/videos) — Phase 3
│       ├── browse.tsx       S3 browser — Phase 4
│       └── settings.tsx     Backend URL + bootstrap token form
├── lib/
│   ├── api.ts               HTTP client for the backend
│   └── config.ts            expo-secure-store wrappers
├── components/              Themed UI primitives (kept from Expo template)
└── constants/, hooks/       Theming
```
