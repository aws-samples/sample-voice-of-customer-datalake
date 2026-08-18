#!/bin/bash
# VoC API Deployment Validation Script
# Tests all API endpoints after deployment.
#
# Usage: test-api.sh [API_URL] [STREAM_URL]
#
# Environment:
#   VOC_TEST_USER / VOC_TEST_PASS - Cognito test creds (default: deployment-test / DeployTest!2025)
#   RUN_SYNTHETIC=1               - also fire a synthetic_reviews generation run (SIDE EFFECTS:
#                                   writes synthetic feedback + incurs Bedrock cost). Off by default.
#
# Flags (may appear anywhere in args):
#   --run-synthetic   - same as RUN_SYNTHETIC=1
#   --synthetic-only  - only run the synthetic generation test (skip the endpoint sweep)
set -e

# --- Parse flags, keep positional args (API_URL, STREAM_URL) ---
RUN_SYNTHETIC="${RUN_SYNTHETIC:-0}"
SYNTHETIC_ONLY=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --run-synthetic)  RUN_SYNTHETIC=1 ;;
    --synthetic-only) RUN_SYNTHETIC=1; SYNTHETIC_ONLY=1 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
set -- "${POSITIONAL[@]:-}"

# Fetch configuration from CloudFormation outputs
echo "📋 Fetching deployment configuration..."

CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name VocCoreStack \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolClientId`].OutputValue' \
  --output text 2>/dev/null)

if [ -z "$CLIENT_ID" ] || [ "$CLIENT_ID" = "None" ]; then
  echo "❌ Could not find Cognito Client ID. Is VocCoreStack deployed?"
  echo "   You can also pass API_URL and STREAM_URL as arguments."
  exit 1
fi

DEFAULT_API=$(aws cloudformation describe-stacks \
  --stack-name VocApiStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
  --output text 2>/dev/null)

# Legacy: a dedicated chat-stream Function URL. Newer deployments serve streaming
# from the main API Gateway at /chat/stream, so this output may not exist.
DEFAULT_STREAM_URL=$(aws cloudformation describe-stacks \
  --stack-name VocApiStack \
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
# Fall back to the main API Gateway for streaming (/chat/stream) when there is no
# dedicated Function URL output.
if [ -z "$STREAM_URL" ] || [ "$STREAM_URL" = "None" ]; then
  STREAM_URL="$API"
fi

if [ -z "$API" ] || [ "$API" = "None" ]; then
  echo "❌ Could not find API endpoint. Is VocApiStack deployed?"
  echo "   Usage: $0 [API_URL] [STREAM_URL]"
  exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== VoC API Validation ===${NC}"
echo "API Endpoint: $API"
echo "Stream URL:   $STREAM_URL"
echo "Cognito Client ID: $CLIENT_ID"
echo "Run synthetic generation: $([ "$RUN_SYNTHETIC" = "1" ] && echo yes || echo 'no (pass --run-synthetic to enable)')"

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
  printf "  GET  %-48s " "$1"
  c=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $AUTH" "$API$1")
  if [ "$c" = "200" ]; then echo -e "${GREEN}$c${NC}"; PASS=$((PASS+1))
  else echo -e "${RED}$c${NC}"; FAIL=$((FAIL+1)); fi
}

tpost() {
  printf "  POST %-48s " "$1"
  c=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: $AUTH" -H "Content-Type: application/json" -d "$2" "$API$1")
  if [ "$c" = "200" ]; then echo -e "${GREEN}$c${NC}"; PASS=$((PASS+1))
  else echo -e "${RED}$c${NC}"; FAIL=$((FAIL+1)); fi
}

tpub() {
  printf "  GET  %-48s " "$1 (public)"
  c=$(curl -s -o /dev/null -w "%{http_code}" "$API$1")
  if [ "$c" = "200" ]; then echo -e "${GREEN}$c${NC}"; PASS=$((PASS+1))
  else echo -e "${RED}$c${NC}"; FAIL=$((FAIL+1)); fi
}

run_endpoint_sweep() {
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
  tget "/feedback/search?q=test&days=30"
  # Per-item endpoints need a real id; fetch one (90d window) and exercise if present
  FID=$(curl -s -H "Authorization: $AUTH" "$API/feedback?days=90&limit=1" | python3 -c "import sys,json
d=json.load(sys.stdin)
items=d.get('items', d if isinstance(d,list) else [])
print(items[0].get('id','') if items else '')" 2>/dev/null || echo "")
  if [ -n "$FID" ]; then
    tget "/feedback/$FID"
    tget "/feedback/$FID/similar"
  else
    echo -e "  ${YELLOW}⚠️  No feedback items found, skipping /feedback/{id} + /similar${NC}"
  fi

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
  tget "/projects/config"
  tget "/projects/prioritization"

  # PR #131: document-generation (Step Functions) + product-context workspace.
  # Project-scoped read endpoints, exercised only if a project exists. GET-only on
  # purpose — POST routes here (documents, prfaq-autofill, suggest-*, product-report)
  # trigger Bedrock generation and/or create documents, so they're left out of the
  # smoke test.
  echo -e "\n${BLUE}Document Gen & Product Context (PR #131)${NC}"
  PROJECT_ID=$(curl -s -H "Authorization: $AUTH" "$API/projects" | python3 -c "import sys,json; d=json.load(sys.stdin); items=d.get('items') or d.get('projects') or (d if isinstance(d,list) else []); print((items[0].get('project_id') or items[0].get('id','')) if items else '')" 2>/dev/null)
  if [ -n "$PROJECT_ID" ]; then
    tget "/projects/$PROJECT_ID/product-context"
    tget "/projects/$PROJECT_ID/product-docs"
  else
    echo -e "  ${YELLOW}⚠️  No projects found, skipping product-context/document endpoints${NC}"
  fi

  echo -e "\n${BLUE}Logs API${NC}"
  tget "/logs/validation"
  tget "/logs/processing"
  tget "/logs/summary"

  echo -e "\n${BLUE}Data Explorer API${NC}"
  tget "/data-explorer/s3"
  tget "/data-explorer/buckets"
  tget "/data-explorer/stats"

  echo -e "\n${BLUE}Users API (Admin)${NC}"
  tget "/users"

  echo -e "\n${BLUE}S3 Import API${NC}"
  tget "/s3-import/files"
  tget "/s3-import/sources"

  echo -e "\n${BLUE}Feedback Forms${NC}"
  tget "/feedback-forms"
  # Public per-form endpoints require a form id; exercise them only if a form exists
  FORM_ID=$(curl -s -H "Authorization: $AUTH" "$API/feedback-forms" | python3 -c "import sys,json; f=json.load(sys.stdin).get('forms',[]); print(f[0].get('form_id', f[0].get('id','')) if f else '')" 2>/dev/null || echo "")
  if [ -n "$FORM_ID" ]; then
    tpub "/feedback-forms/$FORM_ID/config"
    tpub "/feedback-forms/$FORM_ID/iframe"
  else
    echo -e "  ${YELLOW}⚠️  No feedback forms configured, skipping public per-form endpoints${NC}"
  fi

  echo -e "\n${BLUE}Chat Stream API (${STREAM_URL}/chat/stream)${NC}"
  printf "  POST %-48s " "/chat/stream"
  # Streaming (SSE) response — assert on HTTP status; curl consumes the full stream.
  sc=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"message":"hello"}' "${STREAM_URL}/chat/stream")
  if [ "$sc" = "200" ]; then echo -e "${GREEN}$sc${NC}"; PASS=$((PASS+1))
  else echo -e "${RED}$sc${NC}"; FAIL=$((FAIL+1)); fi
}

run_synthetic_test() {
  echo -e "\n${BLUE}Synthetic Reviews Generation (end-to-end)${NC}"
  echo -e "  ${YELLOW}Firing on-demand run — generates synthetic feedback + Bedrock cost${NC}"
  printf "  POST %-48s " "/sources/synthetic_reviews/run"
  resp=$(curl -s -X POST -H "Authorization: $AUTH" -H "Content-Type: application/json" -d '{}' "$API/sources/synthetic_reviews/run")
  if echo "$resp" | grep -q '"success"'; then
    echo -e "${GREEN}200${NC}"; PASS=$((PASS+1))
  else
    echo -e "${RED}ERR${NC}"; echo "    Response: $resp"; FAIL=$((FAIL+1)); return
  fi

  echo "  Polling /sources/status?run_status=synthetic_reviews (up to ~120s)..."
  status="unknown"; items="0"; last=""
  for i in $(seq 1 12); do
    sleep 10
    last=$(curl -s -H "Authorization: $AUTH" "$API/sources/status?run_status=synthetic_reviews")
    status=$(echo "$last" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")
    items=$(echo "$last" | python3 -c "import sys,json;print(json.load(sys.stdin).get('items_found',0))" 2>/dev/null || echo "0")
    printf "    [%2d] status=%-10s items_found=%s\n" "$i" "$status" "$items"
    if [ "$status" = "completed" ] || [ "$status" = "error" ]; then break; fi
  done

  if [ "$status" = "completed" ]; then
    echo -e "  ${GREEN}Synthetic run completed (items_found=$items)${NC}"; PASS=$((PASS+1))
  else
    echo -e "  ${RED}Synthetic run ended status=$status${NC}"; echo "    Last: $last"; FAIL=$((FAIL+1))
  fi
}

if [ "$SYNTHETIC_ONLY" != "1" ]; then
  run_endpoint_sweep
fi
if [ "$RUN_SYNTHETIC" = "1" ]; then
  run_synthetic_test
fi

echo ""
T=$((PASS+FAIL))
echo -e "Results: ${GREEN}$PASS${NC}/$T passed"
[ $FAIL -gt 0 ] && echo -e "${RED}FAILED${NC}" && exit 1
echo -e "${GREEN}PASSED${NC}"
