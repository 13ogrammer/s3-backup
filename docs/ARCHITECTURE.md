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

## Thumbnail sidecar contract

For each image upload, the app also uploads a small JPEG sidecar at
`<key>.thumb.jpg` (~320 px, q70, 30–50 KB). Backend handlers that touch
image objects need to be sidecar-aware:

- `handlers/list.ts` — filters `.thumb.jpg` out of user-facing results,
  returns the thumb URL as `previewUrl` when it exists.
- `handlers/del.ts` — schedules `<key>.thumb.jpg` for deletion when the
  image key is deleted.
- `handlers/move.ts` — copies + deletes the sidecar alongside single
  file moves. Folder moves already pick sidecars up since they walk the
  entire prefix.

When extending the backend, any new operation that creates or moves
image keys must update its sidecar similarly. The `THUMB_SUFFIX`
constant lives in each handler that needs it.

## Distribution model

V1 ships as **open-source bring-your-own-AWS**. Users deploy the SAM
stack into their own AWS account; their data stays in their bucket; the
app installs from the App Store / Play Store / sideload separately.
Architecture leaves the door open for a hosted multi-tenant tier later
(same backend code, cross-account IAM role to user's bucket). See
[`MONETIZATION.md`](./MONETIZATION.md) for the rollout plan.
