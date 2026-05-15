# Working on this repo with Claude

Read this first if you're picking up development on the s3-backup app.
It captures **conventions you must follow** and **gotchas that will
cost you time** otherwise. Detailed material lives in `docs/`.

## What this is

A cross-platform mobile app that backs up phone photos and videos to a
private S3 bucket. Open-source, BYO-AWS. See [`README.md`](./README.md)
for the user-facing pitch.

## Where to find things

| Need | Look at |
|---|---|
| System design, tech stack, sidecar contract | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) |
| Cost model, business decisions, hosted-tier plan | [`docs/MONETIZATION.md`](./docs/MONETIZATION.md) |
| Deferred improvements (pick the next task here) | Linear team `S3Backup` ([open issues](https://linear.app/s3backup/team/S3B/active)) |
| Local dev runbook (MinIO + dev server) | [`backend/README.md`](./backend/README.md) |
| App dev / build instructions | [`app/README.md`](./app/README.md) |

## Repo layout

```
s3-backup/
├── app/        Expo (React Native, TypeScript). iOS + Android.
├── backend/    AWS Lambda + API Gateway via SAM.
├── docs/       Architecture, monetisation, backlog.
└── CLAUDE.md   This file (must stay at root).
```

App-side highlights:
- `app/app/(tabs)/` — three tabs: Gallery / Browse / Settings.
- `app/components/` — themed primitives, modals (preview, folder picker, rename), `ZoomableImage`.
- `app/lib/` — `api.ts`, `config.ts`, `upload.ts`, `format.ts`.
- `app/constants/theme.ts` — `Colors` / `Radius` / `Spacing` / `Shadow` / `Type`. Use these, not raw hex.

Backend-side highlights:
- `backend/src/index.ts` — single Lambda router for all routes.
- `backend/src/handlers/` — `list`, `signUpload`, `signDownload`, `del`, `move`.
- `backend/src/dev-server.ts` — thin Node `http` wrapper for local dev.

## Conventions (apply on every change)

- **Commits** — Conventional Commits prefix (`feat:`, `fix:`, `chore:`,
  `perf:`, `docs:`, `polish:`). When Claude wrote the change, the
  commit message ends with:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Theme tokens** — never hardcode colours / spacing / radii in
  components. Pull from `app/constants/theme.ts`. Light + dark
  variants live there.
- **No UI libraries** — design language is the custom tokens. Adding
  Tamagui / NativeWind / Paper is a deliberate refactor, not a "small
  change."
- **Validate boundary input** — sanitise keys/prefixes via
  `sanitizeKey` / `sanitizePrefix` in `backend/src/s3.ts`. Reject `..`,
  absolute paths, null bytes, over-long paths.
- **Typecheck before commit** — `npm run typecheck` (backend) and
  `npx tsc --noEmit` (app).
- **No git config changes** — author identity comes from the user's
  global git config. Don't touch it.
- **Don't commit secrets** — `.env`, real AWS keys, real bootstrap
  tokens. `.gitignore` covers `.env`; eyeball your stage list.

## Gotchas (the stuff that costs time to rediscover)

### Expo Go on Android can't run `expo-media-library`
Google's granular media permissions need declarations Expo Go doesn't
ship. The Gallery tab uses `expo-media-library` to render an inline
grid of phone media, so a **custom dev build** is required on Android
(`npm run android` in `app/`). Expo Go will fail at the permission
prompt.

### LocalStack is paid as of v2026.03
Both `localstack/localstack:latest` and `:s3-latest` exit with code 55
("License activation failed"). We use **MinIO** instead. Don't switch
back to LocalStack on this project.

### Pre-signed URL host = `S3_ENDPOINT_URL`
Signed URLs inherit whatever endpoint the S3 client was configured
with. In local dev, that needs to be the **LAN IP** of your Mac
(`http://192.168.x.y:9000`), not `localhost`, or the phone gets
ECONNREFUSED. The `.env.example` flags this.

### Thumbnail tree at `.thumbnails/`
Thumbs live in a parallel tree (`.thumbnails/<original_key>.jpg`) that
mirrors the bucket's folder structure, not as `<key>.thumb.jpg`
sidecars next to originals. Any new backend handler that creates,
moves, or deletes image keys must update the parallel thumb path in
the same operation. See
[`docs/ARCHITECTURE.md#thumbnail-tree`](./docs/ARCHITECTURE.md#thumbnail-tree).

### `expo-file-system` v19 split the API
Use the legacy import path:
```ts
import { ... } from 'expo-file-system/legacy';
```
The new `File`/`Directory` classes don't (yet) support
upload-with-progress, which we need for `createUploadTask`.

### Modal safe-areas
`PreviewModal` uses `statusBarTranslucent` + `navigationBarTranslucent`
and pulls top/bottom padding from `useSafeAreaInsets()`. If you add
other full-screen modals, do the same — otherwise there's a visible
empty band above the close button on Android.

### `.vscode/` is gitignored
A global gitignore is in play. If you want workspace settings tracked,
`git add -f`.

## Working on a new task

1. Pick an issue from the Linear `S3Backup` team (Todo column). The
   description carries the implementation note migrated from the old
   `docs/BACKLOG.md`. Historical completed items live in S3B-14
   ("Backlog history (completed pre-Linear)") for reference.
2. If it spans both packages, plan the contract first — types live in
   `backend/src/types.ts` and are mirrored in `app/lib/api.ts`.
3. Implement, typecheck both packages, manually verify on device.
4. Commit with a Conventional Commits subject and a body that
   explains *why* (the *what* is in the diff). Reference the Linear
   ID (e.g. `S3B-9`) in the commit body so Linear auto-links it.
5. Move the Linear issue to Done.

For new work that isn't pre-planned, do a small design pass first —
architecture-level, not file-by-file. Read the relevant existing code,
write a short plan, then build. Avoid speculative abstractions: three
similar lines beats a premature factoring.

## What NOT to do

- Don't update git config (org rule).
- Don't recommend LocalStack — dead end for free use.
- Don't add UI libraries — design language is the custom tokens.
- Don't ship a `.git` inside `app/` — single repo at the root. If
  `create-expo-app` adds one again, remove it.
- Don't commit secrets.
- Don't skip pre-commit hooks (`--no-verify`).
- Don't auto-amend published commits — always a new commit unless
  explicitly asked.
- Don't add features that route user bytes through Lambda
  (see [`docs/MONETIZATION.md`](./docs/MONETIZATION.md) for why).
