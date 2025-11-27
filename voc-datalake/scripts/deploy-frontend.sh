#!/bin/bash
set -e

echo "🚀 VoC Frontend Deployment"
echo "=========================="

# Configuration
S3_BUCKET="voc-datalake-frontend-512144631813"
CLOUDFRONT_DISTRIBUTION_ID="E1HZKV2G738RBE"

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
