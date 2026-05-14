#!/usr/bin/env bash
set -euo pipefail

# Publish the SAM stack template (and its Lambda code artifacts) to a
# public S3 bucket so the Launch Stack button in the root README can
# point at it.
#
# One-time prereq: a public-read distribution bucket. Create it with
#   DIST_BUCKET=my-bucket ./scripts/bootstrap-dist-bucket.sh
#
# Usage:
#   DIST_BUCKET=my-s3backup-templates npm run publish:template
#   DIST_BUCKET=my-s3backup-templates DIST_KEY=v0.2.yaml npm run publish:template

: "${DIST_BUCKET:?DIST_BUCKET env var is required}"
DIST_KEY="${DIST_KEY:-s3-backup-template.yaml}"
REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"

# This script lives in backend/scripts/, run from backend/.
cd "$(dirname "$0")/.."

echo "Building SAM artifact…"
sam build > /dev/null

echo "Packaging Lambda code to s3://${DIST_BUCKET}/ and rewriting template…"
sam package \
  --s3-bucket "${DIST_BUCKET}" \
  --output-template-file packaged.yaml > /dev/null

echo "Uploading template to s3://${DIST_BUCKET}/${DIST_KEY}…"
aws s3 cp packaged.yaml "s3://${DIST_BUCKET}/${DIST_KEY}" \
  --content-type "text/yaml" > /dev/null

rm -f packaged.yaml

TEMPLATE_URL="https://${DIST_BUCKET}.s3.${REGION}.amazonaws.com/${DIST_KEY}"
LAUNCH_URL="https://console.aws.amazon.com/cloudformation/home?#/stacks/new?templateURL=${TEMPLATE_URL}"

echo
echo "Published template:"
echo "  ${TEMPLATE_URL}"
echo
echo "Launch Stack URL:"
echo "  ${LAUNCH_URL}"
echo
echo "Markdown to drop into the README:"
echo
echo "  [![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](${LAUNCH_URL})"
