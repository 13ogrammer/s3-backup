#!/usr/bin/env bash
set -euo pipefail

# One-time setup for the dist bucket that hosts the public Launch Stack
# template (and the Lambda code artifacts the template references).
#
# When a user clicks the Launch Stack button in the README, AWS
# CloudFormation needs to fetch the template anonymously, so the
# bucket has to allow public GetObject on its objects. This script
# creates the bucket and applies a tight bucket policy that grants
# only s3:GetObject to Principal "*" — no listings, no writes, just
# reads of objects we put there.
#
# Usage:
#   DIST_BUCKET=my-s3backup-templates ./scripts/bootstrap-dist-bucket.sh
#
# Uses your default AWS credential chain (env vars / ~/.aws/credentials
# / IAM role / etc.). AWS_REGION env var, AWS CLI default region, or
# the bucket-default region.

: "${DIST_BUCKET:?DIST_BUCKET env var is required}"
REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"

echo "Creating bucket s3://${DIST_BUCKET} in ${REGION}…"
if [[ "${REGION}" == "us-east-1" ]]; then
  aws s3api create-bucket --bucket "${DIST_BUCKET}" --region "${REGION}"
else
  aws s3api create-bucket --bucket "${DIST_BUCKET}" --region "${REGION}" \
    --create-bucket-configuration "LocationConstraint=${REGION}"
fi

echo "Relaxing public-access-block so a public bucket policy can be set…"
aws s3api put-public-access-block --bucket "${DIST_BUCKET}" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false"

POLICY_FILE="$(mktemp)"
trap 'rm -f "${POLICY_FILE}"' EXIT
cat > "${POLICY_FILE}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadObjects",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::${DIST_BUCKET}/*"
  }]
}
JSON

echo "Applying public-read bucket policy…"
aws s3api put-bucket-policy --bucket "${DIST_BUCKET}" --policy "file://${POLICY_FILE}"

echo
echo "Done. Next: publish the template."
echo "  DIST_BUCKET=${DIST_BUCKET} npm run publish:template"
