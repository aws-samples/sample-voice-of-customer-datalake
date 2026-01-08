#!/bin/bash
# Deploys the frontend to S3 and invalidates CloudFront cache
# All values are fetched dynamically from CloudFormation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(dirname "$SCRIPT_DIR")"

cd "$FRONTEND_DIR"

echo "=== VoC Frontend Deployment ==="
echo ""

# Step 1: Fetch environment variables from CloudFormation
echo "Step 1: Fetching environment configuration..."
./scripts/update-env.sh

# Step 2: Fetch S3 bucket name and CloudFront distribution ID
echo ""
echo "Step 2: Fetching deployment targets from CloudFormation..."

BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name VocFrontendInfraStack \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" \
  --output text 2>/dev/null)

if [ -z "$BUCKET_NAME" ] || [ "$BUCKET_NAME" = "None" ]; then
  echo "Error: Could not fetch bucket name from VocFrontendInfraStack"
  exit 1
fi

DISTRIBUTION_ID=$(aws cloudformation describe-stacks \
  --stack-name VocFrontendInfraStack \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
  --output text 2>/dev/null)

if [ -z "$DISTRIBUTION_ID" ] || [ "$DISTRIBUTION_ID" = "None" ]; then
  echo "Error: Could not fetch distribution ID from VocFrontendInfraStack"
  exit 1
fi

echo "  Bucket: $BUCKET_NAME"
echo "  Distribution: $DISTRIBUTION_ID"

# Step 3: Build the frontend
echo ""
echo "Step 3: Building frontend..."
npm run build

# Step 4: Sync to S3
echo ""
echo "Step 4: Syncing to S3..."
aws s3 sync dist/ "s3://${BUCKET_NAME}" --delete

# Step 5: Invalidate CloudFront cache
echo ""
echo "Step 5: Invalidating CloudFront cache..."
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths '/*' > /dev/null

echo ""
echo "=== Deployment Complete ==="

# Fetch and display the website URL
WEBSITE_URL=$(aws cloudformation describe-stacks \
  --stack-name VocFrontendInfraStack \
  --query "Stacks[0].Outputs[?OutputKey=='WebsiteURL'].OutputValue" \
  --output text 2>/dev/null)

echo "Website URL: $WEBSITE_URL"
