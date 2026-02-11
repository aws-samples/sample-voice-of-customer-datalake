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
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" \
  --output text 2>&1)

if [ $? -ne 0 ]; then
  echo "Error: Failed to fetch API endpoint from VocApiStack"
  echo "$API_ENDPOINT"
  exit 1
fi

COGNITO_USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text 2>&1)

if [ $? -ne 0 ]; then
  echo "Error: Failed to fetch User Pool ID from VocCoreStack"
  echo "$COGNITO_USER_POOL_ID"
  exit 1
fi

COGNITO_CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" \
  --output text 2>&1)

if [ $? -ne 0 ]; then
  echo "Error: Failed to fetch Client ID from VocCoreStack"
  echo "$COGNITO_CLIENT_ID"
  exit 1
fi

COGNITO_REGION=$(aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoRegion'].OutputValue" \
  --output text 2>&1 || echo "us-west-2")

IDENTITY_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query "Stacks[0].Outputs[?OutputKey=='IdentityPoolId'].OutputValue" \
  --output text 2>&1)

if [ $? -ne 0 ]; then
  echo "Error: Failed to fetch Identity Pool ID from VocCoreStack"
  echo "$IDENTITY_POOL_ID"
  exit 1
fi

echo "  API Endpoint: $API_ENDPOINT"
echo "  Cognito Pool: $COGNITO_USER_POOL_ID"
echo "  Cognito Client: $COGNITO_CLIENT_ID"
echo "  Cognito Region: $COGNITO_REGION"
echo "  Identity Pool: $IDENTITY_POOL_ID"

# Step 3: Build the frontend
echo ""
echo "Step 3: Building frontend..."
npm run build

# Step 4: Generate runtime config.json
echo ""
echo "Step 4: Generating runtime config.json..."

# Use jq to properly escape values and generate valid JSON
jq -n \
  --arg apiEndpoint "$API_ENDPOINT" \
  --arg userPoolId "$COGNITO_USER_POOL_ID" \
  --arg clientId "$COGNITO_CLIENT_ID" \
  --arg region "$COGNITO_REGION" \
  --arg identityPoolId "$IDENTITY_POOL_ID" \
  '{
    apiEndpoint: $apiEndpoint,
    cognito: {
      userPoolId: $userPoolId,
      clientId: $clientId,
      region: $region,
      identityPoolId: $identityPoolId
    }
  }' > dist/config.json

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
