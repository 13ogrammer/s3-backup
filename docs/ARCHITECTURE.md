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
| Backend runtime | Node.js 20, ARM64 Lambda | Bundled with esbuild via SAM `BuildMethod: esbuild`. |
| API surface | HTTP API Gateway, single Lambda router | All routes go through `backend/src/index.ts`. |
| Auth (v1) | Single bootstrap token, `timingSafeEqual` compare | See [BACKLOG](./BACKLOG.md) → "Rotatable / per-device auth tokens" for the replacement plan. |
| Local S3 emulator | **MinIO** via docker-compose | LocalStack went paid in v2026.03 — don't reach for it. |
| Local backend dev | Node `http` wrapper around the Lambda handler, `tsx watch` | `backend/src/dev-server.ts`. |
| Upload UX | `expo-image-picker` (system picker) | Inline gallery grid is blocked in Expo Go on Android — see [`CLAUDE.md`](../CLAUDE.md#gotchas). |
| Image thumbnails | Client-side resize via `expo-image-manipulator`, uploaded as `<key>.thumb.jpg` sidecar | Backend list returns the thumb URL when present, falls back to original otherwise. |
| Preview | `expo-image` + `expo-video` + custom `ZoomableImage` for pinch | Adjacent files prefetched on index change. |

## Endpoints

All POST routes require `Authorization: Bearer <BOOTSTRAP_TOKEN>` except `GET /health`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check |
| POST | `/list` | Folders + files at a prefix; returns signed preview URLs for images |
| POST | `/sign-upload` | Pre-signed PUT for a key + content-type |
| POST | `/sign-download` | Pre-signed GET for a key |
| POST | `/delete` | Batch delete by keys, prefixes, or both |
| POST | `/move` | File rename or full-folder move via server-side copy + delete |

## Thumbnail tree

Thumbnails live in a single top-level folder, `.thumbnails/`, that
mirrors the bucket's directory structure. Each thumb is a 320 px JPEG
(~30–50 KB) at:

```
.thumbnails/<original_key>.jpg
```

So `photos/2025/IMG_001.heic` has its thumb at
`.thumbnails/photos/2025/IMG_001.thumb.jpg`. The original extension is
stripped before appending `.thumb.jpg` so the filename reads cleanly.
Trade-off: if `IMG_001.jpg` and `IMG_001.heic` coexist in the same
folder, they share one thumb path; the last-written wins. Rare in
practice.

Why a separate tree instead of `<key>.thumb.jpg` sidecars: blast-radius.
The whole tree can be nuked with one `aws s3 rm` to drop every thumb,
and listing real folders doesn't have to filter sidecars out.

Helpers live in `backend/src/thumbs.ts` — `THUMB_PREFIX`, `thumbKey()`,
`thumbPrefix()`, `originalFromThumbKey()`.

Backend handlers that touch image objects need to be thumb-aware:

- `handlers/list.ts` — in parallel with the regular S3 listing, lists
  `.thumbnails/<prefix>` and builds a set of original keys that have
  thumbs. For each image in the user-facing listing, returns the thumb
  URL as `previewUrl` if found, falls back to the original URL
  otherwise. Filters `.thumbnails/` out of the root folder listing so
  the user doesn't see it as a regular folder.
- `handlers/del.ts` — when deleting an image key, also schedules its
  thumb for deletion. When deleting a folder prefix, also deletes the
  parallel `.thumbnails/<prefix>` tree.
- `handlers/move.ts` — single-file moves move the thumb alongside.
  Folder moves recursively move the `.thumbnails/<fromPrefix>` tree to
  `.thumbnails/<toPrefix>`.

When extending the backend, any new operation that creates or moves
image keys must update the parallel thumb path similarly.

The upload-time thumb generation (`expo-image-manipulator` in
`app/lib/upload.ts`) and the one-time backfill script
(`backend/scripts/backfill-thumbnails.ts`) both write to this same
tree.

## Distribution model

V1 ships as **open-source bring-your-own-AWS**. Users deploy the SAM
stack into their own AWS account; their data stays in their bucket; the
app installs from the App Store / Play Store / sideload separately.
Architecture leaves the door open for a hosted multi-tenant tier later
(same backend code, cross-account IAM role to user's bucket). See
[`MONETIZATION.md`](./MONETIZATION.md) for the rollout plan.
