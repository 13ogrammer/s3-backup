# Backlog

Improvements deferred during the initial build. Each item carries the key
implementation note so it can be picked up later without re-deriving context.

Tick items off as they land.

---

## Thumbnails & previews

- [x] **Video thumbnails on upload** — videos go through `expo-video-thumbnails` (frame at ~1 s) → `expo-image-manipulator` to resize to the same 320 px JPEG → upload to `.thumbnails/<key>.thumb.jpg`. Backend `list` / `del` / `move` now also handle the video kind. Backfill script doesn't generate video thumbs (needs ffmpeg, not in scope); pre-existing videos still show the ▶ placeholder tile.

- [x] **Backfill thumbnails for existing bucket content** — `backend/scripts/backfill-thumbnails.ts` walks the bucket, generates missing thumbs at `.thumbnails/<key>.thumb.jpg` using sharp. Idempotent. `npm run backfill:thumbs`.

- [x] **Pan when zoomed in image preview** — `ZoomableImage` now has a Pan gesture that's only enabled while `scale > 1.01`. Crossing the threshold fires `onZoomChange` up to `PreviewModal`, which flips the horizontal FlatList's `scrollEnabled` to false so pan inside the image and pager swipe between files don't fight. Double-tap or pinch-out snaps translation back to (0,0).

- [x] **Horizontal swipe between files in preview** — preview is now a paged horizontal FlatList of `PreviewSlide`s, each owning its own video player. URLs hoisted to parent, signs current + neighbours. Known follow-up tracked in "Pan when zoomed": pager still captures pan when an image is pinched.

- [ ] **Video scrubbing reliability on poor networks**
  `expo-video` streams from the signed URL; large videos on flaky
  cellular can stall mid-playback. Options:
  - Investigate `bufferOptions` on the player for larger ahead-of-play
    buffer.
  - Preload a small range (HTTP range request) before showing the
    player.
  - Above a size threshold, fall back to "download then play" via the
    existing Download flow.

---

## Browse

- [x] **Filter by media type** — toolbar gains a third chip that cycles All → Images → Videos. Client-side filter over loaded rows; folders always remain visible regardless. Active filter (not "All") is tinted with `accentSoft` so it stands out.

- [x] **Search by name** — always-visible search bar above the sort toolbar (only when there's content). Client-side case-insensitive substring match on file/folder basename. Composes with the media-type filter. Empty-list state copy distinguishes "no matches" from "folder is empty".

- [x] **Infinite scroll for large folders** — `/list` now takes `continuationToken`, returns `nextToken`, page size 500. Browse paginates via `onEndReached`; stale responses are dropped if path changes mid-fetch.

---

## Upload reliability

- [x] **Parallelism + retries with backoff** — uploads run 3 in parallel via a small worker pool (`runWithConcurrency`); each upload is wrapped in `withRetry` (max 3 attempts, exp backoff + jitter, retries 408/429/5xx/network). Failed items stay selected for one-tap retry.
- [x] **Resumable uploads for large videos (S3 multipart)** — files > 50 MB go through 8 MB-part multipart upload via new `/multipart/create|sign-part|complete|abort` endpoints. Each part is retried independently, abort fires on permanent failure so we don't leak in-flight uploads.
- [x] **Skip-if-exists upload dedup** — before upload, `/exists` returns the subset of destination keys already present; user is prompted to skip / overwrite / cancel.

---

## Background uploads

Currently uploads pause when the app is backgrounded — both upload paths
(`expo-file-system` `createUploadTask` and the multipart `fetch()` chunks)
run on the JS thread, which iOS / Android suspend within seconds of
backgrounding. Three escalating mitigations:

- [x] **Keep-awake + warning** — `expo-keep-awake` activates while an upload is in flight (tagged `s3backup.upload`), plus a one-line "Keep the app open — uploads pause if you switch away" note in the overlay. Doesn't solve real backgrounding; just keeps "leave the screen open" working.

- [ ] **Resume after foreground** (~half day)
  Persist in-flight multipart state (`uploadId` + completed parts +
  remote key) to `secure-store`. On next foreground, offer "resume"
  instead of restart. Single-PUT files just retry the whole. Buys real
  reliability without a custom dev build.

- [ ] **Real native background uploads** (multi-day)
  Wire iOS `URLSession.background` + Android WorkManager / foreground
  service so uploads keep going when the app is backgrounded or the
  screen is off. Requires a custom dev client (which #27 also needs).
  Options: `react-native-background-upload` or a small expo native
  module. End-state.

## Manage / Auth

- [ ] **Undo for last destructive operation**
  After a delete or move, show a snackbar / toast with "Undo" for ~5 s.
  - Move undo: reverse the move call.
  - Delete undo: rely on S3 object versioning (the SAM stack enables it
    on created buckets); restore the previous version. For BYO buckets
    without versioning, the Undo button is disabled.

- [ ] **Rotatable / per-device auth tokens**
  Replace the single bootstrap token with a per-device token model.
  Backend stores hashed tokens in a small DynamoDB table, supports
  issuing new tokens via an admin endpoint, supports revoking. Keep
  bootstrap-token mode as a fallback for the simplest single-user
  install. Prep work for any multi-tenant / shared-bucket future.

---

## Gallery polish

- [x] **Remember last-picked folder + retain selection** — `lib/config.ts` adds `getLastFolder` / `setLastFolder` backed by secure-store; FolderPicker takes an `initialPath` prop and starts there. Selection retention was already correct (Add-more dedupes by URI when merging picks).

- [ ] **Switch Gallery back to the inline grid (post dev-build)**
  Once a custom Android dev build is set up (via EAS Build or
  `expo run:android`), the `expo-media-library` permission issue stops
  blocking and the scrollable in-app gallery grid can be restored.
  The source is preserved in `app/legacy/gallery-media-library.tsx` —
  copy its contents over `app/app/(tabs)/index.tsx`.

---

## Distribution

- [x] **EAS Build configs + open-source README** — `app/eas.json` with development / preview / production profiles. Root README walks through the full install (deploy backend → patch `app.json` IDs → EAS build → paste API URL + token in Settings → optional thumb backfill).
- [x] **Launch Stack button + publish pipeline** — `backend/scripts/bootstrap-dist-bucket.sh` + `publish-template.sh` (exposed as `npm run bootstrap:dist-bucket` and `npm run publish:template`) handle the one-time public-read S3 bucket setup and the per-release `sam build && sam package && aws s3 cp` chain. Root README has the Launch Stack button with a `REPLACE-WITH-YOUR-DIST-BUCKET` placeholder for maintainers to fill in after the first publish.
