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

- [ ] **Backfill thumbnails for existing bucket content**
  One-time admin path that walks the bucket, finds images without a
  `.thumb.jpg` sidecar, generates one, and uploads it. Two ways:
  - A small Lambda using `sharp` deployed alongside the SAM stack, triggered
    by an admin endpoint or run manually.
  - A CLI script in `backend/scripts/` that runs locally against either
    real S3 or MinIO.
  Worth doing once you connect to a bucket with thousands of pre-existing
  photos.

- [ ] **Pan when zoomed in image preview**
  `ZoomableImage` currently supports pinch + double-tap-to-reset but no
  pan (deliberate, to leave room for horizontal swipe). Add pan when
  `scale > 1`; snap back when zoom resets. Use gesture-handler's
  `activeOffset` / `failOffset` patterns to avoid clashing with any
  swipe gesture added later.

- [ ] **Horizontal swipe between files in preview**
  Replace (or complement) Prev / Next buttons with a paged horizontal
  FlatList. Tricky bits:
  - Gesture conflict with pinch/pan inside `ZoomableImage` — disable
    horizontal pager pan when image is zoomed > 1×.
  - Coordinate with the existing prefetch effect that signs N-1/N+1
    URLs so pages render instantly.

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

- [ ] **Infinite scroll for large folders**
  Backend `/list` currently exhausts the S3 `continuationToken` before
  returning. Switch to paged response (return up to N=200 per call and
  pass the token back to the client). Browse `FlatList` calls
  `onEndReached` to fetch the next page.

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

## Distribution (Phase 6, predates this list)

- [ ] **Launch Stack button + EAS Build configs + open-source README**
  Finalise SAM template parameters, publish the template to a public
  S3 location, add a `[![Launch Stack](...)]` button to the README,
  set up `eas.json` for iOS + Android Build profiles, write the
  README that walks a new user through:
  1. Click Launch Stack to deploy the backend to their AWS account.
  2. Generate a bootstrap token, paste it in.
  3. Install the app via TestFlight / Play internal track / sideload.
  4. Paste API URL + token into Settings.
  Then make the repo public.
