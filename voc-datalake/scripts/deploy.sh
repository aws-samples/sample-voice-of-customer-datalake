#!/bin/bash
set -e

echo "🚀 VoC Data Lake Deployment Script"
echo "=================================="

# Check prerequisites
command -v npm >/dev/null 2>&1 || { echo "❌ npm is required"; exit 1; }
command -v cdk >/dev/null 2>&1 || { echo "❌ AWS CDK CLI required: npm install -g aws-cdk"; exit 1; }
command -v pip >/dev/null 2>&1 || { echo "❌ pip is required"; exit 1; }

# Parse arguments
BRAND_NAME="${BRAND_NAME:-MyBrand}"
BRAND_HANDLES="${BRAND_HANDLES:-@mybrand}"
PRIMARY_LANGUAGE="${PRIMARY_LANGUAGE:-en}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --brand-name) BRAND_NAME="$2"; shift 2 ;;
    --brand-handles) BRAND_HANDLES="$2"; shift 2 ;;
    --language) PRIMARY_LANGUAGE="$2"; shift 2 ;;
    --bootstrap) BOOTSTRAP=true; shift ;;
    --destroy) DESTROY=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "📦 Installing dependencies..."
npm install

echo "🔧 Building Lambda layers..."
cd lambda/layers/ingestion-deps/python
pip install -r ../requirements.txt -t . --quiet
cd ../../../processing-deps/python
pip install -r ../requirements.txt -t . --quiet
cd ../../../../

echo "🏗️ Building TypeScript..."
npm run build

if [ "$DESTROY" = true ]; then
  echo "🗑️ Destroying all stacks..."
  cdk destroy --all --force
  exit 0
fi

if [ "$BOOTSTRAP" = true ]; then
  echo "🥾 Bootstrapping CDK..."
  cdk bootstrap
fi

echo "🚀 Deploying stacks..."
cdk deploy --all --require-approval never \
  --context brandName="$BRAND_NAME" \
  --context brandHandles="$BRAND_HANDLES" \
  --context primaryLanguage="$PRIMARY_LANGUAGE"

# Invalidate CloudFront cache for frontend
echo "🔄 Invalidating CloudFront cache..."
DISTRIBUTION_ID=$(aws cloudformation describe-stacks --stack-name VocFrontendStack --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' --output text 2>/dev/null)
if [ -n "$DISTRIBUTION_ID" ] && [ "$DISTRIBUTION_ID" != "None" ]; then
  aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*" > /dev/null
  echo "   ✓ Cache invalidation started for distribution $DISTRIBUTION_ID"
else
  echo "   ⚠ Could not find CloudFront distribution ID, skipping cache invalidation"
fi

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Next steps:"
echo "1. Update API credentials in Secrets Manager:"
echo "   aws secretsmanager put-secret-value --secret-id voc-datalake/api-credentials --secret-string '{...}'"
echo ""
echo "2. Test the API:"
echo "   curl \$(aws cloudformation describe-stacks --stack-name VocAnalyticsStack --query 'Stacks[0].Outputs[?OutputKey==\`ApiEndpoint\`].OutputValue' --output text)metrics/summary"
