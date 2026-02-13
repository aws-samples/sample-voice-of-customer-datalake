#!/bin/bash
# Deploys the frontend to S3 and invalidates CloudFront cache
# All values are fetched dynamically from CloudFormation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(dirname "$SCRIPT_DIR")"

cd "$FRONTEND_DIR"

echo "=== VoC Frontend Deployment ==="
echo ""

# Step 1: Fetch all outputs from CloudFormation stacks
echo "Step 1: Fetching configuration from CloudFormation..."

CORE_OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query 'Stacks[0].Outputs' \
  --output json 2>&1)

if [ $? -ne 0 ]; then
  echo "Error: Failed to fetch VocCoreStack outputs"
  echo "$CORE_OUTPUTS"
  exit 1
fi

API_OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name VocApiStack \
  --query 'Stacks[0].Outputs' \
  --output json 2>&1)

if [ $? -ne 0 ]; then
  echo "Error: Failed to fetch VocApiStack outputs"
  echo "$API_OUTPUTS"
  exit 1
fi

# Extract values from JSON outputs
BUCKET_NAME=$(echo "$CORE_OUTPUTS" | jq -r '.[] | select(.OutputKey=="WebsiteBucketName") | .OutputValue')
DISTRIBUTION_ID=$(echo "$CORE_OUTPUTS" | jq -r '.[] | select(.OutputKey=="DistributionId") | .OutputValue')
COGNITO_USER_POOL_ID=$(echo "$CORE_OUTPUTS" | jq -r '.[] | select(.OutputKey=="UserPoolId") | .OutputValue')
COGNITO_CLIENT_ID=$(echo "$CORE_OUTPUTS" | jq -r '.[] | select(.OutputKey=="UserPoolClientId") | .OutputValue')
COGNITO_REGION=$(echo "$CORE_OUTPUTS" | jq -r '.[] | select(.OutputKey=="CognitoRegion") | .OutputValue // "us-west-2"')
IDENTITY_POOL_ID=$(echo "$CORE_OUTPUTS" | jq -r '.[] | select(.OutputKey=="IdentityPoolId") | .OutputValue')
API_ENDPOINT=$(echo "$API_OUTPUTS" | jq -r '.[] | select(.OutputKey=="ApiEndpoint") | .OutputValue')
STREAM_ENDPOINT=$(echo "$API_OUTPUTS" | jq -r '.[] | select(.OutputKey=="ChatStreamUrl") | .OutputValue // empty')
AVATARS_CDN_URL=$(echo "$CORE_OUTPUTS" | jq -r '.[] | select(.OutputKey=="AvatarsCdnUrl") | .OutputValue // empty')

# Validate required values
if [ -z "$BUCKET_NAME" ] || [ "$BUCKET_NAME" = "null" ]; then
  echo "Error: Could not fetch bucket name from VocCoreStack"
  exit 1
fi

if [ -z "$DISTRIBUTION_ID" ] || [ "$DISTRIBUTION_ID" = "null" ]; then
  echo "Error: Could not fetch distribution ID from VocCoreStack"
  exit 1
fi

if [ -z "$API_ENDPOINT" ] || [ "$API_ENDPOINT" = "null" ]; then
  echo "Error: Could not fetch API endpoint from VocApiStack"
  exit 1
fi

echo "  Bucket: $BUCKET_NAME"
echo "  Distribution: $DISTRIBUTION_ID"
echo "  API Endpoint: $API_ENDPOINT"
echo "  Cognito Pool: $COGNITO_USER_POOL_ID"
echo "  Cognito Client: $COGNITO_CLIENT_ID"
echo "  Cognito Region: $COGNITO_REGION"
echo "  Identity Pool: $IDENTITY_POOL_ID"
echo "  Stream Endpoint: $STREAM_ENDPOINT"
echo "  Avatars CDN: $AVATARS_CDN_URL"

# Step 2: Build the frontend
echo ""
echo "Step 3: Building frontend..."
npm run build

# Step 3: Generate runtime config.json
echo ""
echo "Step 4: Generating runtime config.json..."

# Use jq to properly escape values and generate valid JSON
jq -n \
  --arg apiEndpoint "$API_ENDPOINT" \
  --arg streamEndpoint "$STREAM_ENDPOINT" \
  --arg avatarsCdnUrl "$AVATARS_CDN_URL" \
  --arg userPoolId "$COGNITO_USER_POOL_ID" \
  --arg clientId "$COGNITO_CLIENT_ID" \
  --arg region "$COGNITO_REGION" \
  --arg identityPoolId "$IDENTITY_POOL_ID" \
  '{
    apiEndpoint: $apiEndpoint,
    streamEndpoint: $streamEndpoint,
    avatarsCdnUrl: $avatarsCdnUrl,
    cognito: {
      userPoolId: $userPoolId,
      clientId: $clientId,
      region: $region,
      identityPoolId: $identityPoolId
    }
  }' > dist/config.json

echo "  ✓ config.json generated with CloudFormation values"

# Step 4: Sync to S3
echo ""
echo "Step 5: Syncing to S3..."
aws s3 sync dist/ "s3://${BUCKET_NAME}" --delete

# Step 5: Invalidate CloudFront cache
echo ""
echo "Step 6: Invalidating CloudFront cache..."
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths '/*' > /dev/null

echo ""
echo "=== Deployment Complete ==="

# Display the website URL
WEBSITE_URL=$(echo "$CORE_OUTPUTS" | jq -r '.[] | select(.OutputKey | contains("WebsiteURL")) | .OutputValue // empty')

if [ -z "$WEBSITE_URL" ]; then
  DOMAIN=$(echo "$CORE_OUTPUTS" | jq -r '.[] | select(.OutputKey=="DistributionDomainName") | .OutputValue')
  WEBSITE_URL="https://${DOMAIN}"
fi

echo "Website URL: $WEBSITE_URL"
