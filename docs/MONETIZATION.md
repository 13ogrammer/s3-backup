# Monetization & cost model

## The architectural lever

The system is designed so **infra cost scales with user count, not
data volume**. Photo and video bytes flow phone ↔ S3 directly via
pre-signed URLs; the backend only mints URLs and lists. Backend egress
and compute stay near zero per active user. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Fixed costs

| Item | Cost |
|---|---|
| Apple Developer Program | $99 / yr |
| Google Play one-time registration | $25 |
| Domain (for the eventual hosted tier) | ~$12 / yr |

## Variable backend cost (realistic, per month)

| Users | Cost |
|---|---|
| 0–100 | $0 (free tier covers Lambda + API Gateway + DynamoDB) |
| 100–1,000 active | $0–20 |
| Thousands of DAU | Starts to matter; revisit then |

## Chosen path: open-source + optional hosted tier

1. **Now (v1)** — ship as open-source. Users deploy their own backend
   stack via SAM into their own AWS account. Zero hosting cost to the
   project. The "Launch Stack" CloudFormation button (shipped) is the
   one-click install path for non-technical users.

2. **Later (if demand justifies)** — stand up a single hosted instance
   of the same backend code, charge roughly $2–3 / month or $20 / year
   for users who don't want to touch AWS. The hosted tier connects to
   the user's own S3 bucket via a cross-account IAM role so data
   continues to live in their AWS account, not ours. Per-device auth
   tokens (Linear S3B-8) are prep work for this.

## Other paths considered, deprioritised

- **One-time App Store / Play purchase** ($5–10) — easy revenue, but
  no recurring funding for support or maintenance. Apple/Google take
  15% under $1M revenue.
- **Sponsorship / donations** — fine if treated as a side project;
  won't fund anything that needs support hours.

## Implications for engineering decisions

These are hard constraints on what we build, because they preserve the
near-zero per-user cost that makes the chosen path viable:

- **Don't add features that route user bytes through Lambda.** The
  on-demand derived-asset generation (`/get-derived-url`) is the
  intentional exception: Lambda downloads the original and uploads a
  resized JPEG on the first view of each image. After that the cached
  derived asset is served directly from S3 via signed URL — no further
  Lambda involvement. This is still S3-internal; no internet egress from
  Lambda. Lambda memory was bumped to 1024 MB and timeout to 29 s to
  accommodate the resize workload; this stays well within free-tier
  limits for a personal-use instance. Video bytes never traverse Lambda.
- **Keep the backend small enough that a single hosted instance can
  serve a non-trivial user base on the AWS free tier** when the
  hosted-tier moment arrives. Resist the urge to introduce stateful
  components that scale with users (large DDB tables, persistent
  connections, etc.) without weighing them against this constraint.
- **Avoid AWS-Pro-only or paid-tier lock-in** that would prevent
  users self-hosting affordably. Stick to services with generous
  free tiers and S3-compatible interfaces where possible.
