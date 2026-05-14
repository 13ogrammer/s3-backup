# Backlog

Improvements deferred during the initial build. Each item carries the key
implementation note so it can be picked up later without re-deriving context.

Tick items off as they land.

---

## Thumbnails & previews

- [ ] **Video thumbnails on upload**
  For each video picked, extract a frame at ~1 s via `expo-video-thumbnails`
  and upload as `<key>.thumb.jpg` alongside the original. Backend already
  returns it as `previewUrl` when the sidecar exists (no backend change
  needed). Replace the ▶ tile in Browse with the actual thumb.

- [x] **Backfill thumbnails for existing bucket content** — `backend/scripts/backfill-thumbnails.ts` walks the bucket, generates missing thumbs at `.thumbnails/<key>.thumb.jpg` using sharp. Idempotent. `npm run backfill:thumbs`.

- [ ] **Pan when zoomed in image preview**
  `ZoomableImage` currently supports pinch + double-tap-to-reset but no
  pan (deliberate, to leave room for horizontal swipe). Add pan when
  `scale > 1`; snap back when zoom resets. Use gesture-handler's
  `activeOffset` / `failOffset` patterns to avoid clashing with any
  swipe gesture added later.

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

- [ ] **Filter by media type**
  Toolbar chip(s) to filter the current folder to images only / videos
  only / all. Client-side filter over the loaded rows; folders always
  remain visible.

- [ ] **Search by name**
  Collapsible search input above the list. Substring match on basename.
  Decide whether search triggers a deeper scan or only filters loaded
  items (depends on whether infinite scroll lands first).

- [x] **Infinite scroll for large folders** — `/list` now takes `continuationToken`, returns `nextToken`, page size 500. Browse paginates via `onEndReached`; stale responses are dropped if path changes mid-fetch.

---

## Upload reliability

- [ ] **Parallelism + retries with backoff**
  Uploads currently run strictly sequentially. Run N (e.g. 3) in
  parallel via a semaphore, and wrap each upload in
  retry-with-exponential-backoff (max 3 attempts) for transient HTTP
  5xx / network errors. Report aggregate progress instead of one file
  at a time.

- [ ] **Resumable uploads for large videos (S3 multipart)**
  Files above a threshold (e.g. 50 MB) should use S3 multipart upload
  so a flaky cellular drop doesn't restart from zero. Needs backend
  endpoints to create/complete/abort multipart, and client logic to
  split the file into parts and PUT each to its own signed URL.

- [ ] **Skip-if-exists upload dedup**
  Before uploading, HEAD the destination key (or include the check in
  a `/preflight` endpoint). If the object exists, prompt the user:
  skip / rename with suffix / overwrite. Default to skip. Saves
  bandwidth on accidental re-uploads.

---

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

- [ ] **Remember last-picked folder + retain selection**
  Two small wins:
  - Persist the most recently picked destination folder (secure-store
    or `AsyncStorage`) and pre-fill it next time the FolderPicker opens.
  - Tapping "Add more" currently appends but doesn't dedupe by URI
    explicitly; verify selection state stays clean across multiple
    picker invocations.

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
