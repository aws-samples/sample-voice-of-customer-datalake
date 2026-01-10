#!/bin/bash
set -e

echo "🚀 VoC Frontend Deployment"
echo "=========================="

# Get configuration from CloudFormation outputs
echo "📋 Fetching deployment configuration..."

# Get S3 bucket from VocFrontendInfraStack
S3_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name VocFrontendInfraStack \
  --query 'Stacks[0].Outputs[?OutputKey==`FrontendBucketName`].OutputValue' \
  --output text 2>/dev/null)

if [ -z "$S3_BUCKET" ] || [ "$S3_BUCKET" = "None" ]; then
  echo "❌ Could not find S3 bucket. Is VocFrontendInfraStack deployed?"
  exit 1
fi

# Get CloudFront distribution ID
CLOUDFRONT_DISTRIBUTION_ID=$(aws cloudformation describe-stacks \
  --stack-name VocFrontendInfraStack \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' \
  --output text 2>/dev/null)

if [ -z "$CLOUDFRONT_DISTRIBUTION_ID" ] || [ "$CLOUDFRONT_DISTRIBUTION_ID" = "None" ]; then
  echo "❌ Could not find CloudFront distribution. Is VocFrontendInfraStack deployed?"
  exit 1
fi

echo "  S3 Bucket: $S3_BUCKET"
echo "  CloudFront Distribution: $CLOUDFRONT_DISTRIBUTION_ID"

# Navigate to frontend directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$SCRIPT_DIR/../frontend"

cd "$FRONTEND_DIR"

echo "📦 Installing dependencies..."
npm install

echo "🏗️ Building frontend..."
npm run build

echo "☁️ Uploading to S3..."
aws s3 sync dist/ "s3://$S3_BUCKET/" --delete

echo "🔄 Invalidating CloudFront cache..."
aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/*"

echo ""
echo "✅ Frontend deployment complete!"
