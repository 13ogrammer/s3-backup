# s3-backup

Cross-platform mobile app for backing up phone photos and videos to your own
private S3 bucket. The app talks to a tiny serverless backend you deploy to
your own AWS account — your AWS credentials never live on your phone, and
your photo/video bytes never traverse the backend.

## Repository layout

```
s3-backup/
├── app/       Expo (React Native) mobile app — iOS + Android
└── backend/   AWS Lambda + API Gateway (SAM) — deploys to your AWS account
```

## Status

V1 in progress. See `/Users/prabs/.claude/plans/i-want-to-create-crystalline-papert.md`
for the high-level plan.

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

Photo/video bytes flow phone ↔ bucket directly. The backend only mints
short-lived pre-signed URLs and lists bucket contents.

## Deploying

See [`backend/README.md`](./backend/README.md) for one-click "Launch Stack"
deploy and CLI deploy instructions.

## Running the app

See [`app/README.md`](./app/README.md) for dev setup and EAS Build
instructions for iOS / Android.
