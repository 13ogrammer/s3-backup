# Architecture

How the s3-backup app is put together and why.

## One-screen overview

```
┌─────────────┐  HTTPS, bearer token,    ┌───────────────────┐
│  Mobile app │◄────signed-URL minting──►│  Lambda (backend) │
└──────┬──────┘                          └─────────┬─────────┘
       │                                           │
       │ PUT/GET/DELETE direct to S3 via pre-      │ ListObjectsV2,
       │ signed URL (bytes never traverse Lambda)  │ CopyObject, etc.
       ▼                                           ▼
        ┌──────────────────────────────────────────────┐
        │           Your private S3 bucket             │
        └──────────────────────────────────────────────┘
```

Key implication: photo and video bytes flow **directly between the
phone and the user's S3 bucket** via pre-signed URLs. The backend
never sees the bytes. This keeps backend egress near zero and means
infra cost scales with **user count**, not with **data volume**. See
[`MONETIZATION.md`](./MONETIZATION.md) for the cost model that follows
from this.

Long-running server-side operations (currently: folder moves > ~600
files) escape the 29 s API Gateway timeout by going async — see
"Async folder-move jobs" for the producer / SQS / worker / DLQ flow.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Mobile framework | **Expo (managed)** with `expo-router` | EAS Build covers iOS + Android. |
| Mobile language | TypeScript | strict, `noUncheckedIndexedAccess`. |
| Backend runtime | Node.js 20, ARM64 Lambda | Bundled with esbuild via SAM `BuildMethod: makefile` (needed to ship sharp's native binary). 1024 MB / 29 s. |
| API surface | HTTP API Gateway, single Lambda router | All routes go through `backend/src/index.ts`. |
| Async jobs | **SQS-backed worker Lambdas** (`MoveWorker` + `TranscodeWorker`) | Folder moves >29 s and video preview generation run as jobs; producer returns 202/pending, workers drain their respective queues. See "Async folder-move jobs" and "Async video preview transcoding" below. |
| Auth (v1) | Single bootstrap token, `timingSafeEqual` compare | Linear S3B-8 ("Rotatable / per-device auth tokens") tracks the replacement plan. |
| Local S3 emulator | **MinIO** via docker-compose | LocalStack went paid in v2026.03 — don't reach for it. |
| Local SQS emulator | **ElasticMQ** via docker-compose | SQS-compatible, Apache 2.0, sibling container to MinIO. Dev-server auto-creates both queue pairs on startup. |
| Local backend dev | Node `http` wrapper around the Lambda handler, `tsx watch` | `backend/src/dev-server.ts`. |
| Upload UX | `expo-image-picker` (system picker) | Inline gallery grid is blocked in Expo Go on Android — see [`CLAUDE.md`](../CLAUDE.md#gotchas). |
| Image thumbnails | On-demand via Lambda (`/get-derived-url`), cached in `.thumbnails/` | Backend list returns the thumb URL when present; Browse lazy-fetches via `/get-derived-url` on first view. |
| Image previews | On-demand via Lambda (`/get-derived-url`), cached in `.previews/` | PreviewModal fetches a 1920px JPEG for full-screen display; Download always uses the original signed URL. |
| Video thumbnails | Client-side at upload time via `expo-video-thumbnails`, cached in `.thumbnails/` | Frame extracted at 1 s, resized to 320 px; Lambda never sees the video bytes. Pre-existing videos can be back-filled via `backend/scripts/backfill-video-thumbs.ts`. |
| Video previews | Async on first open via `TranscodeWorker` Lambda + SQS, cached in `.previews/` | 720p H.264/AAC MP4 at ~1 Mbps. `/get-derived-url` returns `{ status:'pending' }` on first request; PreviewModal plays original while waiting, then hot-swaps. |
| Preview | `expo-image` + `expo-video` + custom `ZoomableImage` for pinch | Adjacent files prefetched on index change. |

## Endpoints

All POST routes require `Authorization: Bearer <BOOTSTRAP_TOKEN>` except `GET /health`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check |
| POST | `/list` | Folders + files at a prefix; paginated via `continuationToken` |
| POST | `/sign-upload` | Pre-signed PUT for a key + content-type (single-shot upload) |
| POST | `/sign-download` | Pre-signed GET for a key |
| POST | `/delete` | Batch delete by keys, prefixes, or both |
| POST | `/exists` | Returns the subset of supplied keys that exist (HeadObject) |
| POST | `/move` | File rename (sync, 200) or folder move (**async, 202 `{ jobId }`** — see "Async folder-move jobs"). Folder-keys variant carries `keys[]` for retry-failed flows. |
| POST | `/move-job` | Return the current `JobRecord` for a `jobId`. 404 if unknown. |
| POST | `/move-job-cancel` | Set `cancelRequested: true` on a job record; the worker stops at the next batch boundary. |
| POST | `/multipart/create` | Initiate multipart upload, returns `uploadId` |
| POST | `/multipart/sign-part` | Pre-signed PUT URL for one part of an in-flight upload |
| POST | `/multipart/complete` | Finalise the multipart upload with the part list + ETags |
| POST | `/multipart/abort` | Cancel an in-flight multipart upload |
| POST | `/get-derived-url` | Generate (on first call) and return a signed GET URL for a derived asset. Request: `{ key, tier: 'thumbnail' \| 'preview' }`. Response: `{ url, tier, generated, expiresIn }` or `{ url: null, error: 'unsupported_format' }`. |
| POST | `/stats` | Full bucket walk (skipping `.thumbnails/`, `.previews/`, `.cache/`): total size/count, `byType` breakdown, large-file callouts, top folders, 30-day CloudWatch growth series, estimated monthly cost. Results are cached for 1 hour in `.cache/stats.json`; pass `{ refresh: true }` to bypass. |

## Derived asset trees

Four derived/cache trees live alongside originals in the bucket:

| Tree | Prefix | Size | Purpose |
|---|---|---|---|
| Thumbnails | `.thumbnails/` | ~30–50 KB | Browse grid and list row icons |
| Image previews | `.previews/<key>.preview.jpg` | ~50–300 KB | Full-screen in-app view (PreviewModal) for images |
| Video previews | `.previews/<key>.preview.mp4` | ~5–80 MB | Low-bitrate 720p preview for PreviewModal video slides |
| Stats cache | `.cache/` | ~10–50 KB | Cached `/stats` response (TTL 1 hour, `stats.json`) |

Both image and video previews live in the `.previews/` tree but use different
extensions, keeping them addressable by the same prefix operations (del/move).

### Path convention

The original extension is stripped before appending the derived suffix,
so the filename reads cleanly:

```
photos/2025/IMG_001.heic  →  .thumbnails/photos/2025/IMG_001.thumb.jpg
                          →  .previews/photos/2025/IMG_001.preview.jpg
IMG_002.jpg               →  .thumbnails/IMG_002.thumb.jpg
                          →  .previews/IMG_002.preview.jpg
videos/2025/clip.mov      →  .thumbnails/videos/2025/clip.thumb.jpg  (client-side at upload)
                          →  .previews/videos/2025/clip.preview.mp4  (async on first open)
```

Trade-off: if `IMG_001.jpg` and `IMG_001.heic` coexist in the same
folder, they share one derived path; the last-written wins. Rare in
practice.

Why separate trees instead of `<key>.thumb.jpg` sidecars: blast-radius.
Either tree can be nuked with one `aws s3 rm` to regenerate from scratch,
and listing real folders doesn't have to filter sidecars out.

### On-demand generation for images (S3B-25)

Derived assets for **images** are generated lazily on first request via
`/get-derived-url` rather than eagerly at upload time. Flow:

1. Browse calls `/get-derived-url { key, tier: 'thumbnail' }` for image rows
   returned by `/list` without a `previewUrl`.
2. Lambda HEADs the derived key. If present → return signed URL (cache hit).
3. On miss: GetObject original, sharp resize + JPEG encode, PutObject derived,
   return signed URL (`generated: true`).
4. Subsequent calls to the same key are cache hits — Lambda only touches the
   original once per asset.

Sharp specs:
- `thumbnail`: 320 px wide, q=70, `.rotate()` for EXIF orientation.
- `preview`: 1920 px wide, q=82, `withoutEnlargement: true`, `.rotate()`.

HEIC without libheif will return `{ url: null, error: 'unsupported_format' }`;
the app degrades gracefully (placeholder icon / no resize attempt for unsupported
formats).

### Client-side generation for video thumbnails (S3B-30)

Video thumbnails are generated **client-side at upload time** rather than
via Lambda. This keeps video bytes off the backend entirely, consistent with
the zero-egress monetisation principle (see [`MONETIZATION.md`](./MONETIZATION.md)).

Flow at upload:
1. `uploadAsset` in `app/lib/upload.ts` calls `generateAndUploadThumb` after
   uploading the video.
2. `expo-video-thumbnails` extracts a still frame at 1 000 ms (falls back
   gracefully for clips shorter than 1 s).
3. `expo-image-manipulator` resizes to 320 px wide, q=0.7 JPEG.
4. The resulting JPEG is uploaded directly to `.thumbnails/<stripped-key>.thumb.jpg`
   via a pre-signed PUT. Failure is best-effort and does not block the upload.

Browse behaviour for videos:
- If a `.thumbnails/` sidecar exists, `/list` returns `previewUrl` and the
  Browse grid shows it.
- If no sidecar exists, the video row renders a `▶` placeholder. Browse's
  lazy-fetch guard (`mediaKind === 'image'`) ensures no spurious
  `/get-derived-url` calls are made for video rows.

Pre-existing videos (uploaded before S3B-30) have no sidecar. Use the
operator backfill script to generate them (see below).

### Async on-demand generation for video previews (S3B-33)

Video preview MP4s are generated lazily on first open via an async Lambda
(`TranscodeWorker`) rather than synchronously. See "Async video preview
transcoding" below for the full producer/worker/polling flow.

### Helpers

- `backend/src/thumbs.ts` — `THUMB_PREFIX`, `thumbKey()`, `thumbPrefix()`
- `backend/src/previews.ts` — `PREVIEW_PREFIX`, `previewKey()`, `previewPrefix()`

### Handler responsibilities

Backend handlers that touch image objects must maintain both trees:

- `handlers/list.ts` — lists `.thumbnails/<prefix>` in parallel and returns
  `previewUrl` only when the thumb exists. Filters both derived-tree prefixes
  from the root folder listing so the user doesn't see them. If no thumb exists,
  `previewUrl` is omitted — Browse lazy-fetches via `/get-derived-url`.
- `handlers/del.ts` — single-key image deletes schedule `thumbKey(k)` and
  `previewKey(k)`. Folder-prefix deletes expand to include `thumbPrefix(p)`
  and `previewPrefix(p)`.
- `handlers/move.ts` — single-file renames move the thumb and preview (when
  they exist) alongside. Folder moves enqueue a job; the `MoveWorker` Lambda
  reuses the same per-item move logic (`handlers/__shared/moveOps.ts`)
  so the derived-tree contract is identical for sync and async paths.

When extending the backend, any new operation that creates or moves image keys
must update both parallel derived paths similarly.

Two optional operator scripts handle pre-existing assets:

- `backend/scripts/backfill-thumbnails.ts` — generates thumbnails for existing
  **images**; no longer required for correctness since `/get-derived-url` handles
  first-view generation on-demand.
- `backend/scripts/backfill-video-thumbs.ts` — generates thumbnails for existing
  **videos** using local ffmpeg (prerequisite: `brew install ffmpeg` / `apt-get
  install ffmpeg`). Safe to re-run; keys with existing sidecars are skipped.
  Run via `cd backend && npm run backfill:video-thumbs`.

## Async folder-move jobs (S3B-52)

Synchronous folder rename used to walk the prefix and do per-item copy
+ delete inside the `/move` Lambda invocation. Past ~600 files that
exceeded the 29 s API Gateway timeout — the Lambda was killed mid-walk,
leaving the destination with the partial copy and the source with the
remainder. Folder moves are now jobs: API returns 202 immediately and a
worker Lambda with a 15-minute budget drains the queue.

### Components

```
┌───────────┐  1. POST /move (folder)              ┌──────────────────┐
│  Mobile   │ ───────────────────────────────────► │  ApiFn Lambda    │
│   app     │                                      │  (producer)      │
│           │ ◄────  2. 202 { jobId }  ─────────── │                  │
└─────┬─────┘                                      └────────┬─────────┘
      │                                                     │
      │                                            3a. write JobRecord
      │                                            3b. enqueue SQS msg
      │                                                     │
      │ 4. POST /move-job (poll, 2 s)                       ▼
      │ ◄──── { status, moved, total, … } ──────  ┌──────────────────┐
      │                                            │ FolderMoveQueue  │
      │ 5. POST /move-job-cancel (optional)        │ (visibility 950s,│
      │                                            │  redrive to DLQ) │
      │                                            └────────┬─────────┘
      ▼                                                     │
┌───────────┐                                      6. SQS event source
│ JobsStrip │                                               │
│  (UI)     │                                               ▼
└───────────┘                                      ┌──────────────────┐
                                                   │ MoveWorker       │
                                                   │ Lambda           │
                                                   │ (Timeout 900s,   │
                                                   │  RC 4, BS 1)     │
                                                   └────────┬─────────┘
                                                            │
                                       7. ListObjectsV2 +   │
                                          Copy/Delete       │
                                          (parallel 16)     │
                                                            ▼
                                                   ┌──────────────────┐
                                                   │  Private S3      │
                                                   │  bucket          │
                                                   │  + JobRecord at  │
                                                   │  .cache/jobs/    │
                                                   └──────────────────┘
```

Failure path: any throw from `MoveWorker` lets the SQS message become
visible again; with `maxReceiveCount: 1` it is then redriven to
`FolderMoveDLQ` (14-day retention). Per-item failures are *not*
exceptions — they accumulate in `JobRecord.failed[]` and end the job
in `completed-with-errors`. Follow-up cards S3B-56..S3B-59 wire alarms
and auto-failed-status flips off the DLQ.

### Contract

`JobRecord` lives at `.cache/jobs/<jobId>.json` in the bucket:

```ts
type JobStatus =
  | 'queued' | 'running'
  | 'completed' | 'completed-with-errors' | 'cancelled' | 'failed';

type JobRecord = {
  jobId: string;             // crypto.randomUUID()
  kind: 'folder-move';       // future-proof for bulk-delete, ai-tag, …
  fromPrefix: string;
  toPrefix: string;
  status: JobStatus;
  total: number;             // capped at 50_000 (COUNTS_SCAN_MAX)
  moved: number;
  failed: { key: string; reason: string }[];
  cancelRequested?: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;            // populated only when status === 'failed'
  retryOf?: string;          // parent jobId for retry-failed runs
};
```

### Gating: too-large folders

Producer reads counts via `getCounts` (cached at `.cache/folder-counts/`).
If `counts.truncated || counts.total > MAX_FILES_PER_JOB` (default
10 000, env var on both Lambdas), returns:

```
HTTP 422 { code: 'folder-too-large', fileCount, limit, truncated }
```

The app renders this inline in the rename modal. Chunked execution for
>10 000-file folders is a separate follow-up card.

### App side

`JobsContext` (`app/lib/jobs.tsx`) persists active job IDs in
`expo-file-system/legacy` `documentDirectory` so they survive an app
kill. Polling is on-demand:

- Polls `POST /move-job` every 2 s, **only** when `activeJobs.length > 0`.
- Pauses on `AppState === 'background'`, resumes on `active`.
- Terminal jobs (`completed`, `cancelled`, `failed`) auto-dismiss from
  the strip after 4 s. `completed-with-errors` persists until the user
  taps it → `JobDetailsModal` lists the failed keys with a "Retry
  failed" CTA that kicks a new `folder-keys` job carrying `retryOf`.

The strip lives in `app/components/jobs-strip.tsx` and renders as an
absolute overlay above the tab bar; it does not reshape `Tabs`.

### Local dev parity

Local SQS uses **ElasticMQ** via `backend/docker-compose.yml`. The
dev-server (`backend/src/dev-server.ts`) calls `ensureQueues()` on
startup to create both queues with the same `VisibilityTimeout=950`
and `maxReceiveCount=1` as production. A long-polling consumer in
`backend/src/dev-poller.ts` dispatches each received message to
`processJob` in the same Node process — same code path as the
deployed Lambda, just no cold start. The shim does *not* perfectly
mimic AWS SQS (no real per-message retry semantics outside redrive,
no separate poller process) but is faithful enough that visibility
timeouts and DLQ behaviour are exercised on every dev run.

## Async video preview transcoding (S3B-33)

First-open of a video in `PreviewModal` triggers on-demand transcoding via a
dedicated `TranscodeWorker` Lambda and its own SQS queue. Same shape as the
folder-move async pattern — producer returns a pending indicator immediately,
worker runs with a 15-minute budget.

### Components

```
Client tap (video in PreviewModal)
└─► POST /get-derived-url { key, tier:'preview' }
    └─► ApiFn:
        ├─► classifyKey === 'video' && tier === 'preview'
        ├─► HEAD .previews/<key>.preview.mp4
        │     ├─ hit  → sign URL → { url, generated:false }
        │     └─ miss
        │         ├─► read .cache/jobs/by-key/<sha256(key)>.json
        │         │     ├─ live jobId? → return { status:'pending', jobId }
        │         │     └─ none/terminal → enqueue fresh job
        │         ├─► createTranscodeJobRecord + writeJob
        │         ├─► writeActiveTranscodeJobId (dedupe pointer)
        │         └─► enqueueTranscodeJob(VideoTranscodeQueue)
        │                           ▼
        │              return { status:'pending', jobId, tier:'preview' }
        │
        │                  TranscodeWorker Lambda (SQS event source)
        │                  ├─► HEAD short-circuit (already exists → mark completed)
        │                  ├─► GetObject stream → /tmp/<jobId>/in.<ext>
        │                  ├─► spawn ffmpeg → /tmp/<jobId>/out.mp4
        │                  │     scale max 1280 wide, libx264 veryfast crf=28
        │                  │     aac 96k, -movflags +faststart
        │                  ├─► PUT .previews/<key>.preview.mp4 (video/mp4)
        │                  ├─► setTerminalStatus('completed')
        │                  ├─► clearActiveTranscodeJobId
        │                  └─► rm -rf /tmp/<jobId>/ in finally
        │
        └─► app: addJob({ kind:'video-transcode', key })
               → JobsStrip shows "Generating preview · <filename>"
               → PreviewModal plays original URL while waiting
               → on job completed: re-fetch getDerivedUrl → hot-swap to preview MP4
```

### TranscodeWorker sizing

| Setting | Value | Reason |
|---|---|---|
| `Timeout` | 900 s | 15-minute ceiling; very long videos may DLQ |
| `MemorySize` | 3008 MB | Headroom for ffmpeg 4K frame buffers |
| `EphemeralStorage` | 4096 MB | /tmp must hold original + output simultaneously |
| `ReservedConcurrentExecutions` | 2 | Cap cost and S3 PUT rates |
| `VisibilityTimeout` | 950 s | Must exceed worker timeout |

Note: videos longer than ~90 min at high bitrate may hit the 15-minute Lambda
ceiling and land in the DLQ. This is an acceptable v1 limitation. Future: split
long jobs into segments, or use AWS MediaConvert for very large files.

### ffmpeg binary

The Lambda uses a **vendored static ARM64 ffmpeg binary** (not a Lambda layer)
placed at `backend/bin/ffmpeg-arm64` and bundled into the artifact at
`bin/ffmpeg`. The binary is gitignored — run `backend/scripts/fetch-ffmpeg.sh`
once to download it before `sam build`. The binary is from johnvansickle.com
(GPL v2); acceptable for self-hosted BYO-AWS deployment.

### Failure handling

ffmpeg crash, S3 PUT failure, or missing source → `setTerminalStatus('failed')`.
The client's `JobsContext` stops polling and `PreviewModal` stays on `originalUrl`.
No toast for v1. A user can trigger a retry by closing and reopening the modal
(which calls `/get-derived-url` again and enqueues a new job).

### Local dev

The dev-server creates both `folder-move-queue` and `video-transcode-queue` in
ElasticMQ on startup and starts a long-polling consumer for each. `FFMPEG_PATH`
must be set in `backend/.env` pointing to a local ffmpeg binary (e.g. from
`brew install ffmpeg` on macOS). See `backend/README.md`.

## Observability

Every Lambda invocation emits structured JSON logs so failures can be traced end-to-end from a client error response back to the exact log lines that caused it.

**Structured logger.** `backend/src/logger.ts` exports `createLogger(base)`, which returns a logger with `debug`, `info`, `warn`, `error`, and `child` methods. Every call writes one JSON line to stdout:

```
{ "ts": "…", "level": "info", "requestId": "…", "route": "POST /list", "msg": "…", …fields }
```

`child(extra)` merges additional fields into the base context — useful inside handlers that want to attach a key or prefix to all their log calls.

**Request ID propagation.** At handler entry, `event.requestContext.requestId` is captured (fallback `'unknown'`) and threaded through `RequestContext = { requestId, route, log }` passed to every route handler. The same ID is echoed back to the caller as the `x-request-id` response header — including 4xx and 5xx error responses — so the client can surface it for support. In local dev, `backend/src/dev-server.ts` synthesises `dev-<n>` IDs so local logs have the same shape as production.

**Per-route timing.** `withTiming(ctx, fn)` wraps each route handler. On success it emits one `request complete` log line with a `durationMs` field; on failure it emits `request failed` with `durationMs` and the error message, then re-throws. One timing record per invocation.

**CloudWatch dashboard.** `backend/template.yaml` defines a `ObservabilityDashboard` resource (logical ID `ObservabilityDashboard`) named `<stack-name>-observability` via `!Sub '${AWS::StackName}-observability'`. Panels:

- Lambda: Invocations, Errors, Duration p95
- API Gateway: 4xx, 5xx
- S3: GetRequests, PutRequests

The S3 panels rely on `MetricsConfigurations` added to the `BackupBucket` resource. If you are deploying against a pre-existing bucket (not managed by this SAM stack), add a metrics configuration to it manually or the S3 panels will be empty.

**Debug recipe.** When the app surfaces an error, grab the `x-request-id` value from the failing response. In CloudWatch Logs Insights, query the Lambda log group:

```
fields @timestamp, level, route, msg, durationMs
| filter requestId = "REPLACE_ME"
| sort @timestamp asc
```

Replace `REPLACE_ME` with the captured ID to see every log line — including timing — for that exact invocation.

**App-side observability — Sentry.**

The app uses `@sentry/react-native` for crash reporting and upload-flow tracing. The DSN is read from the `EXPO_PUBLIC_SENTRY_DSN` environment variable (set in `.env`). When the variable is absent all helpers (`initSentry`, `addUploadBreadcrumb`, `captureApiError`) no-op silently, so development and CI builds work without a Sentry project.

`initSentry()` runs once at module scope in `app/app/_layout.tsx` — before `RootLayout` renders and before any navigation is mounted. Running at module scope rather than inside the component body ensures it is not repeated on remount.

The upload flow emits breadcrumbs in the `upload` category for each of: `upload start`, `sign-upload ok`, `PUT begin`, sampled progress at 25 / 50 / 75 % (simple path), `part complete` per part (multipart path), `upload complete`, `upload error`, `retry attempt`, and `upload error (giving up)`. These appear in the Sentry issue breadcrumb trail, making it easy to see exactly where a failed upload stalled.

`captureApiError` reads the `requestId` field on `ApiError` (populated in `api.ts` from the `x-request-id` response header emitted by every backend route) and attaches it as a Sentry tag `backend_request_id` via `Sentry.withScope`. This joins the app-side Sentry event to the exact backend CloudWatch log lines via the debug recipe above.

**Deployer setup.** A real Sentry project is required for production crash visibility. Steps:
1. Create a Sentry project for the app (React Native platform).
2. Replace the `<your-sentry-org>` and `<your-sentry-project>` placeholder slugs in the `@sentry/react-native/expo` plugin tuple in `app/app.json`.
3. Add `EXPO_PUBLIC_SENTRY_DSN=https://…@…sentry.io/…` to `app/.env`.
4. Create the auth-token EAS secret — do **not** commit it or put it in `eas.json`:
   ```
   eas secret:create --scope project --name SENTRY_AUTH_TOKEN --value <token>
   ```
5. Source maps are then uploaded automatically on every `eas build`. No `eas.json` changes are needed — the Sentry plugin v8+ reads `SENTRY_AUTH_TOKEN` from EAS project-scoped secrets at build time.

## Distribution model

V1 ships as **open-source bring-your-own-AWS**. Users deploy the SAM
stack into their own AWS account; their data stays in their bucket; the
app installs from the App Store / Play Store / sideload separately.
Architecture leaves the door open for a hosted multi-tenant tier later
(same backend code, cross-account IAM role to user's bucket). See
[`MONETIZATION.md`](./MONETIZATION.md) for the rollout plan.
