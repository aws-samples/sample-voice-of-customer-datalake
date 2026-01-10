#!/bin/bash
# VoC API Deployment Validation Script
# Tests all API endpoints after deployment
set -e

# Fetch configuration from CloudFormation outputs
echo "📋 Fetching deployment configuration..."

# Get Cognito Client ID from VocAuthStack
CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name VocAuthStack \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolClientId`].OutputValue' \
  --output text 2>/dev/null)

if [ -z "$CLIENT_ID" ] || [ "$CLIENT_ID" = "None" ]; then
  echo "❌ Could not find Cognito Client ID. Is VocAuthStack deployed?"
  echo "   You can also pass API_URL and STREAM_URL as arguments."
  exit 1
fi

# Get API Gateway URL from VocAnalyticsStack
DEFAULT_API=$(aws cloudformation describe-stacks \
  --stack-name VocAnalyticsStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
  --output text 2>/dev/null)

# Get Chat Stream URL from VocAnalyticsStack
DEFAULT_STREAM_URL=$(aws cloudformation describe-stacks \
  --stack-name VocAnalyticsStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ChatStreamUrl`].OutputValue' \
  --output text 2>/dev/null)

# Test credentials - should be created in Cognito for deployment testing
# Create with: aws cognito-idp admin-create-user --user-pool-id <pool-id> --username deployment-test
DEPLOY_USER="${VOC_TEST_USER:-deployment-test}"
# NOTE: Use single quotes for password to prevent bash history expansion of '!'
DEPLOY_PASS="${VOC_TEST_PASS:-DeployTest!2025}"

# Allow override via command line arguments
API="${1:-$DEFAULT_API}"
API="${API%/}"
STREAM_URL="${2:-$DEFAULT_STREAM_URL}"
STREAM_URL="${STREAM_URL%/}"

if [ -z "$API" ] || [ "$API" = "None" ]; then
  echo "❌ Could not find API endpoint. Is VocAnalyticsStack deployed?"
  echo "   Usage: $0 [API_URL] [STREAM_URL]"
  exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== VoC API Validation ===${NC}"
echo "API Endpoint: $API"
echo "Stream URL: $STREAM_URL"
echo "Cognito Client ID: $CLIENT_ID"

echo -n "Authenticating... "
# Use single quotes around auth-parameters to prevent bash ! expansion
AUTH_JSON=$(aws cognito-idp initiate-auth \
  --client-id "$CLIENT_ID" \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters 'USERNAME='"$DEPLOY_USER"',PASSWORD='"$DEPLOY_PASS"'' \
  --no-cli-pager 2>&1)

if echo "$AUTH_JSON" | grep -q "IdToken"; then
  TOKEN=$(echo "$AUTH_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['AuthenticationResult']['IdToken'])")
  AUTH="Bearer $TOKEN"
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAILED${NC}"
  echo "  Ensure test user exists: aws cognito-idp admin-create-user --user-pool-id <pool-id> --username $DEPLOY_USER"
  exit 1
fi

PASS=0
FAIL=0

tget() {
  printf "  GET  %-45s " "$1"
  c=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $AUTH" "$API$1")
  if [ "$c" = "200" ]; then echo -e "${GREEN}$c${NC}"; PASS=$((PASS+1))
  else echo -e "${RED}$c${NC}"; FAIL=$((FAIL+1)); fi
}

tpost() {
  printf "  POST %-45s " "$1"
  c=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: $AUTH" -H "Content-Type: application/json" -d "$2" "$API$1")
  if [ "$c" = "200" ]; then echo -e "${GREEN}$c${NC}"; PASS=$((PASS+1))
  else echo -e "${RED}$c${NC}"; FAIL=$((FAIL+1)); fi
}

tpub() {
  printf "  GET  %-45s " "$1 (public)"
  c=$(curl -s -o /dev/null -w "%{http_code}" "$API$1")
  if [ "$c" = "200" ]; then echo -e "${GREEN}$c${NC}"; PASS=$((PASS+1))
  else echo -e "${RED}$c${NC}"; FAIL=$((FAIL+1)); fi
}

echo -e "\n${BLUE}Metrics API${NC}"
tget "/metrics/summary?days=7"
tget "/metrics/sentiment?days=7"
tget "/metrics/categories?days=7"
tget "/metrics/sources?days=7"
tget "/metrics/personas?days=7"

echo -e "\n${BLUE}Feedback API${NC}"
tget "/feedback?days=7&limit=5"
tget "/feedback/urgent?days=7&limit=5"
tget "/feedback/entities?days=7"

echo -e "\n${BLUE}Chat API${NC}"
tpost "/chat" '{"message":"test"}'

echo -e "\n${BLUE}Integrations API${NC}"
tget "/integrations/status"
tget "/sources/status"

echo -e "\n${BLUE}Settings API${NC}"
tget "/settings/brand"
tget "/settings/categories"

echo -e "\n${BLUE}Scrapers API${NC}"
tget "/scrapers"
tget "/scrapers/templates"

echo -e "\n${BLUE}Projects API${NC}"
tget "/projects"

echo -e "\n${BLUE}Users API (Admin)${NC}"
tget "/users"

echo -e "\n${BLUE}S3 Import API${NC}"
tget "/s3-import/files"
tget "/s3-import/sources"

echo -e "\n${BLUE}Feedback Form (Public)${NC}"
tpub "/feedback-form/config"
tpub "/feedback-form/iframe"

echo -e "\n${BLUE}Chat Stream API (Lambda Function URL)${NC}"
tstream() {
  printf "  POST %-45s " "$1"
  # Stream API uses Lambda Function URL directly (bypasses API Gateway 29s timeout)
  resp=$(curl -s -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$2" \
    "${STREAM_URL}$1" 2>&1)
  # Check if response contains error or success
  if echo "$resp" | grep -q '"response"'; then
    echo -e "${GREEN}200${NC}"
    PASS=$((PASS+1))
  elif echo "$resp" | grep -q '"error"'; then
    echo -e "${RED}ERR${NC}"
    echo "    Response: $resp"
    FAIL=$((FAIL+1))
  else
    echo -e "${RED}???${NC}"
    echo "    Response: $resp"
    FAIL=$((FAIL+1))
  fi
}

if [ -n "$STREAM_URL" ] && [ "$STREAM_URL" != "None" ]; then
  tstream "/chat/stream" '{"message":"hello"}'
else
  echo "  ⚠️  Stream URL not configured, skipping"
fi

echo ""
T=$((PASS+FAIL))
echo -e "Results: ${GREEN}$PASS${NC}/$T passed"
[ $FAIL -gt 0 ] && echo -e "${RED}FAILED${NC}" && exit 1
echo -e "${GREEN}PASSED${NC}"
