# s3-backup

Cross-platform mobile app for backing up phone photos and videos to your
own private S3 bucket. The app talks to a tiny serverless backend you
deploy to **your own AWS account** — your AWS credentials never live on
your phone, your photo and video bytes never traverse the backend, and
your data stays in your bucket.

## How it works

```
┌─────────────┐    HTTPS (auth: bootstrap     ┌───────────────────┐
│  Mobile app │ ────token, mints signed URLs)──▶│  Lambda (backend) │
└──────┬──────┘                                └─────────┬─────────┘
       │                                                 │
       │   pre-signed PUT / GET / DELETE URLs            │
       ▼                                                 ▼
┌─────────────────────────────────────────────────────────────┐
│                   Your private S3 bucket                    │
└─────────────────────────────────────────────────────────────┘
```

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the system
design.

## Install (BYO-AWS)

### 1. Deploy the backend to your AWS account

The backend is a single AWS Lambda + API Gateway behind a SAM
CloudFormation stack. Two paths:

**One-click (Launch Stack):**

[![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?#/stacks/new?templateURL=https://REPLACE-WITH-YOUR-DIST-BUCKET.s3.amazonaws.com/s3-backup-template.yaml)

> Maintainers: replace the `REPLACE-WITH-YOUR-DIST-BUCKET` placeholder
> with your published template URL. See
> [`backend/README.md`](./backend/README.md#publishing-the-launch-stack-template)
> for the `npm run bootstrap:dist-bucket` + `npm run publish:template`
> flow.

**CLI:**

```bash
# Generate a bootstrap token — copy this, you'll paste it into the app too
openssl rand -hex 32

cd backend
npm install
npm run build && sam deploy --guided
```

Leave `BucketName` blank to have the stack create a new bucket with
versioning + public-access-block on; or supply an existing bucket name
to reuse one. After deploy, copy the `ApiUrl` output.

### 2. Build the app for your phone

```bash
cd app
npm install
```

Update `app.json`: change `ios.bundleIdentifier` and `android.package`
from `com.example.s3backup` to a reverse-DNS string you own.

Then either:

- **EAS Build** (recommended) — see [`app/README.md`](./app/README.md#eas-build-installable-apk--ipa).
- **Expo Go** for quick iOS testing — `npm start`, scan the QR code.
  Note: Gallery doesn't work in Expo Go on Android because of
  `expo-media-library` permission constraints.

### 3. Connect the app to your backend

Open the **Settings** tab in the app. Paste:

- **API URL** — the `ApiUrl` from your SAM deploy outputs.
- **Bootstrap token** — the value you supplied during deploy.

Tap **Test**. If it turns green, you're ready to upload.

### 4. (Optional) Backfill thumbnails for existing photos

If you connected to a bucket that already had photos in it, Browse will
work but thumbnails fall back to fetching originals (slow). Generate
proper thumbnail sidecars for everything once:

```bash
cd backend
BUCKET_NAME=your-bucket npm run backfill:thumbs
```

See [`backend/README.md`](./backend/README.md#backfilling-thumbnails-for-existing-buckets)
for details.

## Repository layout

```
s3-backup/
├── app/       Expo (React Native) mobile app — iOS + Android
├── backend/   AWS Lambda + API Gateway (SAM) — deploys to your AWS account
└── docs/      Architecture and monetisation notes
```

## Documentation

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — system design, tech stack, endpoint reference, thumbnail tree contract.
- [`docs/MONETIZATION.md`](./docs/MONETIZATION.md) — cost model, the open-source + optional hosted tier plan.
- Deferred improvements live as issues in the Linear `S3Backup` team — pick the next thing to build there.
- [`CLAUDE.md`](./CLAUDE.md) — conventions and gotchas when continuing development.

## Status

V1 features (gallery → pick → upload to a folder, browse with
thumbnails / sort / list-or-grid, preview with pinch-zoom and swipe,
move / rename / delete, MinIO-based local dev loop, thumbnail backfill
script) all in `main`. What's next lives in the Linear `S3Backup`
team.
