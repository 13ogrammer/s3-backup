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

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Mobile framework | **Expo (managed)** with `expo-router` | EAS Build covers iOS + Android. |
| Mobile language | TypeScript | strict, `noUncheckedIndexedAccess`. |
| Backend runtime | Node.js 20, ARM64 Lambda | Bundled with esbuild via SAM `BuildMethod: makefile` (needed to ship sharp's native binary). 1024 MB / 29 s. |
| API surface | HTTP API Gateway, single Lambda router | All routes go through `backend/src/index.ts`. |
| Auth (v1) | Single bootstrap token, `timingSafeEqual` compare | Linear S3B-8 ("Rotatable / per-device auth tokens") tracks the replacement plan. |
| Local S3 emulator | **MinIO** via docker-compose | LocalStack went paid in v2026.03 — don't reach for it. |
| Local backend dev | Node `http` wrapper around the Lambda handler, `tsx watch` | `backend/src/dev-server.ts`. |
| Upload UX | `expo-image-picker` (system picker) | Inline gallery grid is blocked in Expo Go on Android — see [`CLAUDE.md`](../CLAUDE.md#gotchas). |
| Image thumbnails | On-demand via Lambda (`/get-derived-url`), cached in `.thumbnails/` | Backend list returns the thumb URL when present; Browse lazy-fetches via `/get-derived-url` on first view. |
| Image previews | On-demand via Lambda (`/get-derived-url`), cached in `.previews/` | PreviewModal fetches a 1920px JPEG for full-screen display; Download always uses the original signed URL. |
| Video thumbnails | Client-side at upload time via `expo-video-thumbnails`, cached in `.thumbnails/` | Frame extracted at 1 s, resized to 320 px; Lambda never sees the video bytes. Pre-existing videos can be back-filled via `backend/scripts/backfill-video-thumbs.ts`. |
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
| POST | `/move` | File rename or full-folder move via server-side copy + delete |
| POST | `/multipart/create` | Initiate multipart upload, returns `uploadId` |
| POST | `/multipart/sign-part` | Pre-signed PUT URL for one part of an in-flight upload |
| POST | `/multipart/complete` | Finalise the multipart upload with the part list + ETags |
| POST | `/multipart/abort` | Cancel an in-flight multipart upload |
| POST | `/get-derived-url` | Generate (on first call) and return a signed GET URL for a derived asset. Request: `{ key, tier: 'thumbnail' \| 'preview' }`. Response: `{ url, tier, generated, expiresIn }` or `{ url: null, error: 'unsupported_format' }`. |

## Derived asset trees

Two parallel trees live alongside originals in the bucket:

| Tree | Prefix | Size | Purpose |
|---|---|---|---|
| Thumbnails | `.thumbnails/` | ~30–50 KB | Browse grid and list row icons |
| Previews | `.previews/` | ~50–300 KB | Full-screen in-app view (PreviewModal) |

### Path convention

The original extension is stripped before appending the derived suffix,
so the filename reads cleanly:

```
photos/2025/IMG_001.heic  →  .thumbnails/photos/2025/IMG_001.thumb.jpg
                          →  .previews/photos/2025/IMG_001.preview.jpg
IMG_002.jpg               →  .thumbnails/IMG_002.thumb.jpg
                          →  .previews/IMG_002.preview.jpg
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

### Client-side generation for videos (S3B-30)

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
  they exist) alongside. Folder moves recursively move both derived trees.

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

**App-side observability** (Sentry breadcrumbs, error capture) is tracked separately in **S3B-39**.

## Distribution model

V1 ships as **open-source bring-your-own-AWS**. Users deploy the SAM
stack into their own AWS account; their data stays in their bucket; the
app installs from the App Store / Play Store / sideload separately.
Architecture leaves the door open for a hosted multi-tenant tier later
(same backend code, cross-account IAM role to user's bucket). See
[`MONETIZATION.md`](./MONETIZATION.md) for the rollout plan.
