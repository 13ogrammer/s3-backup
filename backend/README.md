# s3-backup backend

Tiny serverless API the mobile app talks to. Mints pre-signed S3 URLs (upload,
download, delete, move) and lists bucket contents. Deploys to your own AWS
account; your photo/video bytes never traverse this service.

## Endpoints

All require `Authorization: Bearer <BOOTSTRAP_TOKEN>` except `GET /health`.

| Method | Path             | Purpose |
|--------|------------------|---------|
| GET    | `/health`        | Liveness check |
| POST   | `/list`          | List a prefix: returns folders + files |
| POST   | `/sign-upload`   | Pre-signed PUT URL for a key |
| POST   | `/sign-download` | Pre-signed GET URL for a key |
| POST   | `/delete`        | Batch delete keys |
| POST   | `/move`          | Move a file or rename a folder (server-side copy + delete) |

## Deploy (CLI)

```bash
# Generate a bootstrap token, copy this — you'll paste it into the app too
openssl rand -hex 32

# First-time deploy (asks for region, bucket name, etc.)
cd backend
npm install
sam build
sam deploy --guided
```

Leave `BucketName` blank to have the stack create a new bucket with
versioning + public-access-block on. Supply an existing bucket name to
reuse one.

After deploy, the `ApiUrl` output is what you paste into the app's
Settings screen along with your bootstrap token.

## Publishing the Launch Stack template

The CloudFormation template can be deployed via a "Launch Stack" button
in the root README — one-click install for users who don't want to
touch the CLI. To wire that button up to a working template, you need
to publish the packaged template (and its Lambda code artifacts) to a
public-read S3 bucket you control.

### One-time setup

```bash
DIST_BUCKET=my-s3backup-templates npm run bootstrap:dist-bucket
```

Creates the bucket and applies a tight bucket policy granting only
anonymous `s3:GetObject`. No listings, no writes.

### Publish (re-run on every template change)

```bash
DIST_BUCKET=my-s3backup-templates npm run publish:template
```

Builds the SAM artifact, packages Lambda code into the bucket, uploads
the rewritten template at `s3://<bucket>/s3-backup-template.yaml`, and
prints both the public template URL and the ready-to-paste Launch Stack
markdown for the README.

Until the bucket is set up, the root README's Launch Stack button
points at a placeholder URL — users have to fall back to
`sam deploy --guided` (the CLI path documented above).

## Local dev (MinIO + Node, no SAM/Docker for the backend itself)

The fastest dev loop: backend runs as plain Node via `tsx watch`, S3 is
emulated by **MinIO** (one Docker container, MIT-licensed, open-source).
Hot reload on save, no Lambda cold-start, no AWS bill.

> Why MinIO and not LocalStack? LocalStack went fully commercial in
> v2026.03 — both `latest` and `s3-latest` images now require a paid
> license to start. MinIO is the simplest free, open-source S3-compatible
> server and the AWS SDK works against it unchanged.

### Prereqs

- Node 20+
- Docker Desktop (for MinIO only — the backend itself does not run in Docker)
- AWS CLI v2

### One-time setup

```bash
cd backend
cp .env.example .env

# Find your Mac's LAN IP (the one the phone sees).
ipconfig getifaddr en0   # en0 = WiFi on most Macs; try en1 if blank

# Edit .env: set S3_ENDPOINT_URL=http://<that-IP>:9000
```

### Each session

```bash
# 1. Start MinIO (S3 API on :9000, web console on :9001)
npm run dev:minio    # runs `docker compose up -d`

# 2. Create the dev bucket inside MinIO (once per fresh volume)
AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin AWS_DEFAULT_REGION=us-east-1 \
  aws --endpoint-url=http://localhost:9000 s3 mb s3://dev-bucket

# 3. Run the dev server (loads .env automatically, watches src for changes)
npm run dev
```

The dev server prints the URL + token to paste into the app's Settings tab.

MinIO web console: <http://localhost:9001> (user `minioadmin` / pass `minioadmin`)
Stop the container with `npm run dev:minio:stop`.

### Why the LAN IP matters

The backend mints pre-signed URLs whose hostname matches whatever
`S3_ENDPOINT_URL` is set to. Your phone (on the same WiFi as your Mac, but
not on the Mac itself) cannot reach `localhost:9000` — only the Mac can.
So we set the endpoint to the Mac's LAN IP, and MinIO listens on
`0.0.0.0:9000` so the phone can hit it directly.

### Quick smoke test from the Mac

```bash
HOST=http://localhost:8080
TOKEN="$BOOTSTRAP_TOKEN"

curl $HOST/health
curl -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{}' $HOST/list
curl -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"key":"hello.txt","contentType":"text/plain"}' $HOST/sign-upload
```

## Preflight: check an existing bucket

If you plan to point the stack at a pre-existing bucket (rather than
letting it create a fresh one), run the bucket check first to verify
the recommended settings are in place:

```bash
npm run check:bucket -- <bucket-name> [--region us-east-1]
```

Read-only — uses your default AWS credential chain (`aws configure`,
env vars, or an SSO profile). Three tiers of findings:

- **Blocker** — bucket doesn't exist or your creds can't see it. Exits 1.
- **Strongly recommended** — versioning, public-access-block, ownership
  controls, default encryption. Exits 1 by default. Pass
  `--allow-warnings` to proceed anyway.
- **Nice-to-have** — abort-incomplete-multipart lifecycle, region match.
  Informational, never fails the script.

Each failed check prints a one-line `→` hint for where to fix it in
the S3 console. Skip this step if you're letting the SAM stack create
a new bucket — the template ships with all recommended settings on.

## Backfilling thumbnails for existing buckets

If you connect the app to a bucket that already has photos in it (e.g.
uploaded outside this app, or via an older version), Browse will still
work but thumbnails fall back to fetching the original image each time
— slow. Run the backfill script once to generate `.thumb.jpg` sidecars
for every image:

```bash
# Against MinIO local dev (loads .env automatically)
npm run backfill:thumbs

# Against real AWS (uses your default AWS credential chain)
BUCKET_NAME=your-bucket npm run backfill:thumbs
```

The script is idempotent — re-running it skips images that already have
a sidecar. HEIC images may be skipped if `sharp` can't decode them
without `libheif`; they'll keep falling back to the original.

## SAM local (alternative)

If you'd rather run the Lambda exactly as it will run in prod:

```bash
BOOTSTRAP_TOKEN=devtoken BUCKET_NAME=dev-bucket S3_ENDPOINT_URL=http://host.docker.internal:9000 \
  sam local start-api
```

Requires SAM CLI + Docker. Slower iteration than `npm run dev`.
