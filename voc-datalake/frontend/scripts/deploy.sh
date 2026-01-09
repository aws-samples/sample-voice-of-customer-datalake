#!/bin/bash
# Deploys the frontend to S3 and invalidates CloudFront cache
# All values are fetched dynamically from CloudFormation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(dirname "$SCRIPT_DIR")"

cd "$FRONTEND_DIR"

echo "=== VoC Frontend Deployment ==="
echo ""

# Step 1: Fetch S3 bucket name and CloudFront distribution ID
echo "Step 1: Fetching deployment targets from CloudFormation..."

BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query "Stacks[0].Outputs[?OutputKey=='WebsiteBucketName'].OutputValue" \
  --output text 2>/dev/null)

if [ -z "$BUCKET_NAME" ] || [ "$BUCKET_NAME" = "None" ]; then
  echo "Error: Could not fetch bucket name from VocCoreStack"
  exit 1
fi

DISTRIBUTION_ID=$(aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
  --output text 2>/dev/null)

if [ -z "$DISTRIBUTION_ID" ] || [ "$DISTRIBUTION_ID" = "None" ]; then
  echo "Error: Could not fetch distribution ID from VocCoreStack"
  exit 1
fi

echo "  Bucket: $BUCKET_NAME"
echo "  Distribution: $DISTRIBUTION_ID"

# Step 2: Fetch runtime config values from CloudFormation
echo ""
echo "Step 2: Fetching runtime configuration..."

API_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name VocApiStack \
  --query "Stacks[0].Outputs[?contains(OutputKey, 'ApiEndpoint')].OutputValue" \
  --output text 2>/dev/null | head -1)

ARTIFACT_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name ArtifactBuilderStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" \
  --output text 2>/dev/null || echo "")

# Handle "None" response
if [ "$ARTIFACT_ENDPOINT" = "None" ]; then
  ARTIFACT_ENDPOINT=""
fi

COGNITO_USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text 2>/dev/null)

COGNITO_CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" \
  --output text 2>/dev/null)

COGNITO_REGION=$(aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoRegion'].OutputValue" \
  --output text 2>/dev/null || echo "us-west-2")

echo "  API Endpoint: $API_ENDPOINT"
echo "  Artifact Builder: ${ARTIFACT_ENDPOINT:-'(not deployed)'}"
echo "  Cognito Pool: $COGNITO_USER_POOL_ID"
echo "  Cognito Client: $COGNITO_CLIENT_ID"
echo "  Cognito Region: $COGNITO_REGION"

# Step 3: Build the frontend
echo ""
echo "Step 3: Building frontend..."
npm run build

# Step 4: Generate runtime config.json
echo ""
echo "Step 4: Generating runtime config.json..."
cat > dist/config.json << EOF
{
  "apiEndpoint": "${API_ENDPOINT}",
  "artifactBuilderEndpoint": "${ARTIFACT_ENDPOINT}",
  "cognito": {
    "userPoolId": "${COGNITO_USER_POOL_ID}",
    "clientId": "${COGNITO_CLIENT_ID}",
    "region": "${COGNITO_REGION}"
  }
}
EOF
echo "  ✓ config.json generated with CloudFormation values"

# Step 5: Sync to S3
echo ""
echo "Step 5: Syncing to S3..."
aws s3 sync dist/ "s3://${BUCKET_NAME}" --delete

# Step 6: Invalidate CloudFront cache
echo ""
echo "Step 6: Invalidating CloudFront cache..."
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths '/*' > /dev/null

echo ""
echo "=== Deployment Complete ==="

# Display the website URL
WEBSITE_URL=$(aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query "Stacks[0].Outputs[?contains(OutputKey, 'WebsiteURL')].OutputValue" \
  --output text 2>/dev/null)

if [ -z "$WEBSITE_URL" ] || [ "$WEBSITE_URL" = "None" ]; then
  DOMAIN=$(aws cloudformation describe-stacks \
    --stack-name VocCoreStack \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" \
    --output text 2>/dev/null)
  WEBSITE_URL="https://${DOMAIN}"
fi

echo "Website URL: $WEBSITE_URL"
