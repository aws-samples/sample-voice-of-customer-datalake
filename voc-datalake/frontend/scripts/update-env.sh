#!/bin/bash
# Fetches API endpoint from CloudFormation and updates .env.production

set -e

echo "Fetching API endpoint from CloudFormation..."

API_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name VocAnalyticsStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" \
  --output text 2>/dev/null)

if [ -z "$API_ENDPOINT" ] || [ "$API_ENDPOINT" = "None" ]; then
  echo "Warning: Could not fetch API endpoint from VocAnalyticsStack. Using existing .env.production"
  exit 0
fi

ARTIFACT_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name ArtifactBuilderStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" \
  --output text 2>/dev/null || echo "")

COGNITO_USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name VocAuthStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text 2>/dev/null || echo "")

COGNITO_CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name VocAuthStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" \
  --output text 2>/dev/null || echo "")

COGNITO_REGION=$(aws cloudformation describe-stacks \
  --stack-name VocAuthStack \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoRegion'].OutputValue" \
  --output text 2>/dev/null || echo "us-west-2")

echo "Updating .env.production with:"
echo "  API_ENDPOINT: $API_ENDPOINT"
echo "  ARTIFACT_ENDPOINT: $ARTIFACT_ENDPOINT"
echo "  COGNITO_USER_POOL_ID: $COGNITO_USER_POOL_ID"
echo "  COGNITO_CLIENT_ID: $COGNITO_CLIENT_ID"
echo "  COGNITO_REGION: $COGNITO_REGION"

cat > .env.production << EOF
VITE_API_ENDPOINT=${API_ENDPOINT}
VITE_ARTIFACT_BUILDER_ENDPOINT=${ARTIFACT_ENDPOINT}
VITE_COGNITO_USER_POOL_ID=${COGNITO_USER_POOL_ID}
VITE_COGNITO_CLIENT_ID=${COGNITO_CLIENT_ID}
VITE_COGNITO_REGION=${COGNITO_REGION}
EOF

echo "✓ .env.production updated successfully"
