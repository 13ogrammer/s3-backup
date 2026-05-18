# Going live: deployment guide

A step-by-step runbook for deploying your own copy of s3-backup to real
AWS and installing the app on your phone. Targets a **single-user,
personal deployment** — you own the AWS account, the bucket, and the
app build. Multi-user onboarding is out of scope here; that's a
separate rethink (see [`MONETIZATION.md`](./MONETIZATION.md)).

iOS distribution via the App Store / TestFlight requires a paid Apple
Developer account ($99/yr) and is **deferred** in this guide. Android
sideload is free and is the primary path documented below. See
[Going to iOS later](#going-to-ios-later) for the no-paid-account
options when you're ready.

---

## Prerequisites

One-time setup on your Mac:

- **AWS account** with a billing alert set (recommended: $5/month threshold while testing).
- **AWS CLI v2** configured with credentials that have `AdministratorAccess`
  on the account you'll deploy to. Verify with `aws sts get-caller-identity`.
- **SAM CLI** — `brew install aws-sam-cli`.
- **Node 20+** and **npm**.
- **EAS CLI** — `npm install -g eas-cli`, then `eas login` (free Expo
  account at <https://expo.dev>).
- **Android phone** with Developer Options enabled and "Install
  unknown apps" allowed for your file manager / browser.

---

## Step 1 — Decide your bucket strategy

You have two choices. Pick before deploying — switching later means
either re-deploying the stack or migrating data.

### Option A: let the SAM stack create a new bucket (recommended)

Easiest. The stack provisions a bucket with versioning,
public-access-block, ownership controls, and an
abort-incomplete-multipart lifecycle rule already on. You skip Step 2.

### Option B: use an existing bucket

Provide the bucket name as the `BucketName` parameter when deploying.
**Before you do**, confirm the bucket has these settings — the app
will work without them, but you're carrying real risk:

| Setting | Recommended | Why |
|---|---|---|
| Versioning | Enabled | Recover from accidental overwrite / delete |
| Public-access-block (all 4 flags) | All `true` | Photo bucket should never be public |
| Object Ownership | `BucketOwnerEnforced` (ACLs disabled) | Simpler permission model |
| Default encryption | SSE-S3 (default since 2023) | At-rest encryption |
| Abort incomplete multipart | 7-day cleanup rule | Failed uploads otherwise cost storage forever |
| Region | Same as where you'll deploy the Lambda | Cross-region = latency + egress cost |

Rather than eyeballing the S3 console, run the preflight script:

```bash
cd backend
npm install     # if you haven't already
npm run check:bucket -- <your-bucket-name> --region <aws-region>
```

It's read-only (uses your default AWS credential chain) and prints a
checklist with `→` hints for anything that needs fixing. Three tiers:

- **Blocker** — bucket missing or unreachable. Exits non-zero.
- **Strongly recommended** — versioning, public-access-block, ownership
  controls, encryption. Exits non-zero by default; pass
  `--allow-warnings` to proceed anyway.
- **Nice-to-have** — abort-incomplete-multipart lifecycle, region match.
  Informational only.

Fix anything marked `✗` in the S3 console (each result includes the
exact console path), then re-run until the script exits 0. After that,
proceed to Step 2.

---

## Step 2 — Generate a bootstrap token

The app authenticates to the backend with a shared secret. Generate
one and save it somewhere safe (password manager).

```bash
openssl rand -hex 32
```

You'll paste this twice: once into the SAM deploy prompt, once into
the app's Settings tab. **Do not commit it. Do not reuse the dev
`devtoken` from `.env`.**

---

## Step 3 — Deploy the backend

```bash
cd backend
npm install
npm run build           # wraps `sam build`; see note below
sam deploy --guided
```

> **Why `npm run build` and not `sam build` directly?** SAM's
> esbuild bundler needs `esbuild` on `$PATH`. `npm run` prepends
> `node_modules/.bin`, so the local devDependency is found. Running
> `sam build` directly fails with "Cannot find esbuild" unless you
> install esbuild globally.

The `--guided` flag walks you through prompts. Suggested answers:

| Prompt | Value |
|---|---|
| Stack Name | `s3-backup` |
| AWS Region | Closest to you (e.g. `ap-southeast-2` for Sydney) |
| `BootstrapToken` | The token from Step 2 |
| `BucketName` | Blank (Option A) or your existing bucket name (Option B) |
| Confirm changes before deploy | `Y` (review the IAM role being created) |
| Allow SAM CLI IAM role creation | `Y` |
| Disable rollback | `N` |
| Save arguments to config file | `Y` (writes `samconfig.toml` so next deploy is just `sam deploy`) |

Deploy takes ~2–3 minutes. When it finishes, the **Outputs** section
prints:

- `ApiUrl` — `https://<id>.execute-api.<region>.amazonaws.com`
- `BucketName` — the bucket the Lambda will write to

Save both. The `ApiUrl` goes into the app; the `BucketName` is what
you'll point at in the AWS console to see your photos.

> If `sam deploy` fails with `bucket already exists` and you supplied
> a name in Option A, the SAM-managed S3 artifacts bucket may already
> be present from a prior failed deploy. That's fine — re-run the
> command.

---

## Step 4 — (Optional but recommended) Add a lifecycle rule for cost

By default, every object stays in S3 Standard at ~$0.023/GB/month.
For a backup workload — write once, read rarely — tiering to cheaper
storage classes after a delay can cut long-tail cost 60–80% with no
UX impact.

A sensible default for personal backup:

| Age | Storage class | Cost (us-east-1) |
|---|---|---|
| 0–30 days | Standard | $0.023/GB/mo |
| 30–90 days | Standard-IA | $0.0125/GB/mo |
| 90+ days | Glacier Instant Retrieval | $0.004/GB/mo |

Add via the S3 console: **Bucket → Management → Lifecycle rules →
Create rule**. Add two transitions (Standard-IA at 30 days, Glacier
IR at 90).

**Important — exclude thumbnails from the rule.** Thumbnails live
under the `.thumbnails/` prefix and the Browse / Gallery tabs fetch
them every time you scroll through old folders. If thumbs also move
to Glacier IR, every scroll triggers a per-GB retrieval fee. The fix:
limit the rule to objects above the thumbnail size. In the rule's
**Filter** section choose *"Limit the scope using filters"* and set:

- **Minimum object size**: `102400` (100 KB)

Thumbnails are typically 20–50 KB so they stay on Standard for free
browsing, while originals (photos ≥ a few hundred KB, videos in the
MBs) get tiered as intended.

> If your filter form doesn't expose object size, prefer creating
> the rule via the AWS CLI with an `ObjectSizeGreaterThan` filter on
> the `And` clause.

Don't add this rule at all if you frequently re-download old
originals — Glacier IR's per-GB retrieval fee will dominate the
storage savings.

---

## Step 5 — Build the Android APK

```bash
cd ../app
npm install
eas project:init       # one-time; links this dir to your Expo account
eas build --profile preview --platform android
```

EAS runs the build on Expo's servers (~10 minutes). When it finishes,
it prints a URL to the `.apk` artifact — also visible at
<https://expo.dev/accounts/<your-handle>/projects/s3-backup/builds>.

Download the `.apk` to your phone (email it to yourself, AirDrop to
the phone, or open the EAS URL on the phone's browser).

---

## Step 6 — Install and configure the app

1. On the Android phone, tap the downloaded `.apk`. If it warns about
   "unknown apps," allow it for your file manager.
2. After install, open **s3-backup** → **Settings** tab.

### Option A: Scan QR (recommended)

Run this from your Mac after deploying:

```bash
cd backend
npm run qr
```

The script retrieves the API URL and bootstrap token from the live
CloudFormation stack and prints a scannable QR code.

> **SECURITY WARNING — treat the QR code like a password.** The QR
> encodes your bootstrap token. Do not share it, screenshot it, or
> leave it on screen in a shared space. Anyone who scans it gains full
> access to your backend.

In the app, tap **Scan QR**, point the camera at the code, and the
fields fill automatically. Tap **Test** to verify.

Pass `--stack <name>` if you chose a custom stack name during deploy
(default: `s3-backup`), and `--region <region>` if needed.

### Option B: Paste manually

3. Paste:
   - **API URL**: the `ApiUrl` from the SAM outputs (no trailing slash).
   - **Bootstrap token**: the token from Step 2.
4. Tap **Save**, then **Test**. You should see a green confirmation.

### If Test fails

- Check the URL is exactly what SAM printed — no trailing `/`, no
  typos.
- Check the token matches.
- Check CloudWatch Logs: AWS Console → CloudWatch → Log groups →
  `/aws/lambda/s3-backup-ApiFn-<id>`. The most recent stream shows
  the request and any error.

---

## Step 7 — First backup smoke test

1. Open the **Gallery** tab → pick a small photo.
2. Tap upload (single, not a batch — easier to debug if it fails).
3. Open the AWS S3 console → your bucket → confirm the object is
   present, and a corresponding entry in `.thumbnails/...` appears
   within a few seconds.
4. Switch to the **Browse** tab in the app → pull-to-refresh → the
   photo should be visible with a thumbnail.

If thumbnails are slow / missing on Browse, the thumbnail generation
ran but didn't sync — pull-to-refresh once more. If they're
persistently broken, see "Backfilling thumbnails" in
[`backend/README.md`](../backend/README.md).

---

## Step 8 — Day-2 operations

### Redeploying the backend

After code changes in `backend/`:

```bash
cd backend
npm run build
sam deploy            # uses samconfig.toml from the guided deploy
```

The `ApiUrl` and `BucketName` stay the same across redeploys, so the
app doesn't need re-configuration.

### Pushing a new app version

```bash
cd app
eas build --profile preview --platform android
```

Download the new `.apk`, install over the existing app — your
Settings (API URL, token) persist across upgrades because they're
stored in `expo-secure-store`.

### Release workflow

The app has two release paths. Pick based on whether the change touches
native code:

| Change type | Release path | `version` bump? | How users get it |
|---|---|---|---|
| JS-only fix / feature | `eas update --branch preview --message "..."` | No | OTA — downloaded and applied on next launch |
| Native change (new dep, SDK bump, native fix) | `eas build --profile preview --platform android` | Yes | In-app update banner → user taps Download → sideloads new APK |

`runtimeVersion` is set to `{ policy: "appVersion" }`. That means bumping
`version` in `app/app.json` produces a new runtime, and OTA bundles
published against it cannot reach existing installs. **Don't bump
`version` for a JS-only change** — it strands existing users. See
`app/README.md#releasing` for the semver rules.

#### Updating the version manifest (for the update banner)

The in-app update banner reads a JSON manifest from the URL set in
`EXPO_PUBLIC_VERSION_MANIFEST_URL`. Unset → empty string → feature
disabled (no banner, no network call). To enable it:

1. Deploy the backend with `CreateReleaseBucket=true` — this creates the
   public release bucket and outputs `ReleaseManifestUrl`.
2. Set the env var so it reaches both your local dev builds and your EAS
   builds:
   - **Locally**: copy `app/.env.example` to `app/.env` and set
     `EXPO_PUBLIC_VERSION_MANIFEST_URL=<ReleaseManifestUrl>/manifest.json`.
     Expo auto-loads `.env` on `npm start`.
   - **EAS builds**: set `EXPO_PUBLIC_VERSION_MANIFEST_URL` under the
     `preview` (and/or `production`) profile's environment variables
     in the EAS dashboard. The value is read by `app/app.config.ts` at
     build time and baked into `Constants.expoConfig.extra` in the APK.
3. After each native release (a fresh APK that existing installs should be nudged to download), publish an updated manifest. Easiest path is the helper script:

```bash
./scripts/publish-manifest.sh
# prompts for APK URL; reads version from app.json;
# looks up the release bucket from the CFN stack outputs; uploads.
```

Skip this step for OTA-only releases (no new APK, no manifest change).

Or do it by hand:

```bash
aws s3 cp manifest.json s3://<ReleaseBucketName>/manifest.json --acl bucket-owner-full-control
```

Manifest format (`manifest.json`):

```json
{
  "latestNativeVersion": "1.2.0",
  "apkUrl": "<EAS build artifact URL from expo.dev>"
}
```

- `apkUrl`: the direct `.apk` download link from
  **expo.dev → your project → Builds → (select the build) → Download**.
- `latestNativeVersion`: versions below this see a dismissible banner.
  Advance this on every native rebuild.
- Release notes live on [GitHub Releases](https://github.com/13ogrammer/s3-backup/releases),
  not in the manifest. The in-app "Changelog" link in About opens that page.

#### Cutting a release

Native releases (new APK) get a git tag and a GitHub Release. OTA-only
shipments do not — they're invisible by design, and their commits are
folded into the next native release's notes.

```bash
./scripts/bump-version.sh 1.3.0
git add app/app.json && git commit -m "chore(app): bump version to 1.3.0"
git tag v1.3.0
git push --follow-tags

./scripts/release-notes.sh > /tmp/notes.md   # preview, edit if needed
gh release create v1.3.0 --notes-file /tmp/notes.md
```

`release-notes.sh` wraps `git-cliff` (install: `brew install git-cliff`)
and groups commits since the last tag by Conventional Commits prefix
(Features / Bug fixes / Performance / Polish / Refactoring / Documentation).
Linear IDs in commit messages auto-link. Config lives at `cliff.toml`.

The app version, the git tag, and the GitHub Release version are all
the same number. `runtimeVersion: { policy: 'appVersion' }` ties them
together — there is no separate "release version" to track.

### Watching logs / errors

CloudWatch Logs → `/aws/lambda/s3-backup-ApiFn-<id>`. Filter by
`ERROR` or by your request ID.

### Cost monitoring

AWS Console → **Billing** → **Cost Explorer**. Group by Service. For a
single user backing up phone photos:

- S3 storage: pennies/GB/month
- Lambda: free tier covers ~1M requests/month
- API Gateway: free tier covers ~1M requests/month
- Data transfer: free in; outbound matters only if you download a lot

Expect <$1/month for the first ~40 GB. Set a billing alert anyway.

### Tear-down

If you ever want to remove everything:

```bash
cd backend
sam delete           # deletes the stack
```

**The S3 bucket is retained** (`DeletionPolicy: Retain` in the
template). Empty and delete it manually if you want it gone — the
template intentionally protects you from a misclicked stack delete
wiping your photos.

---

## Going to iOS later

When you want the app on iPhone, three options (cheapest first):

1. **Free 7-day Xcode sideload.** Build with EAS dev profile, sign
   with your free Apple ID via Xcode, USB-install. Re-sign every 7
   days. Tolerable for personal use.
2. **AltStore.** Same 7-day cert under the hood, but a companion app
   on your Mac re-signs automatically. Functionally persistent.
3. **Apple Developer Program ($99/yr).** Real path — `eas build
   --profile production --platform ios` → TestFlight (up to 10K
   testers for free) or App Store submission.

Pick (1) or (2) for "I just want it on my phone." Pick (3) when you
want to share with non-technical friends without them needing a Mac.

---

## What this guide deliberately doesn't cover

- **Multi-user onboarding.** Today, deployment assumes you're both
  the operator and the user. A "friend signs up, brings their own
  bucket" flow needs a different design — auth, a user table,
  cross-account `AssumeRole`. See [`MONETIZATION.md`](./MONETIZATION.md).
- **The "Launch Stack" one-click installer.** The template publishing
  workflow in [`backend/README.md`](../backend/README.md) is for that
  future, not for your personal deploy.
- **iOS App Store submission.** Deferred until you've decided to pay
  Apple.
- **Custom domain / HTTPS cert.** The default API Gateway URL is
  HTTPS and works fine; a custom domain is cosmetic.
