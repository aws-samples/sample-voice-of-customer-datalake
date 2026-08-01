#!/bin/bash
# Generates frontend/.env from the deployed CloudFormation outputs, so the local
# dev server (and a local production build) talk to the real deployed stack.
#
# Writes .env — NOT .env.production — deliberately:
#   * vite loads .env in EVERY mode, so this configures `npm run dev` too.
#     .env.production is ignored by the dev server, which is why the previous
#     version of this script could never fix local development.
#   * .env is gitignored; .env.production is not.
#
# Usage:  AWS_PROFILE=voc-deploy bash scripts/update-env.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Stack names AFTER the stack merge: the old VocAnalyticsStack folded into
# VocApiStack, and VocAuthStack into VocCoreStack. Querying the old names
# silently produced an empty .env (the original cause of "local UI is broken").
API_STACK="${API_STACK:-VocApiStack}"
CORE_STACK="${CORE_STACK:-VocCoreStack}"

cfn_output() { # cfn_output <stack> <OutputKey>
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" \
    --output text 2>/dev/null || true
}

echo "Fetching config from CloudFormation ($API_STACK, $CORE_STACK)..."
API_ENDPOINT=$(cfn_output "$API_STACK" ApiEndpoint)
COGNITO_USER_POOL_ID=$(cfn_output "$CORE_STACK" UserPoolId)
COGNITO_CLIENT_ID=$(cfn_output "$CORE_STACK" UserPoolClientId)
COGNITO_REGION=$(cfn_output "$CORE_STACK" CognitoRegion)
# REQUIRED, not optional: RuntimeConfigSchema demands a non-empty
# cognito.identityPoolId. Omitting it makes the whole env config fail
# validation, and the fallback branch then BLANKS every cognito value — the
# login screen shows "Cognito not configured" even though the user pool and
# client id were both resolved correctly.
IDENTITY_POOL_ID=$(cfn_output "$CORE_STACK" IdentityPoolId)
[ -z "$COGNITO_REGION" ] || [ "$COGNITO_REGION" = "None" ] \
  && COGNITO_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

# Fail loudly rather than writing a half-empty .env that yields a login screen
# stuck on "Cognito not configured".
MISSING=""
[ -z "$API_ENDPOINT" ] || [ "$API_ENDPOINT" = "None" ] && MISSING="$MISSING ApiEndpoint($API_STACK)"
[ -z "$COGNITO_USER_POOL_ID" ] || [ "$COGNITO_USER_POOL_ID" = "None" ] && MISSING="$MISSING UserPoolId($CORE_STACK)"
[ -z "$COGNITO_CLIENT_ID" ] || [ "$COGNITO_CLIENT_ID" = "None" ] && MISSING="$MISSING UserPoolClientId($CORE_STACK)"
[ -z "$IDENTITY_POOL_ID" ] || [ "$IDENTITY_POOL_ID" = "None" ] && MISSING="$MISSING IdentityPoolId($CORE_STACK)"
if [ -n "$MISSING" ]; then
  echo "ERROR: could not resolve:$MISSING" >&2
  echo "       Check AWS_PROFILE/AWS_REGION and that the stacks are deployed." >&2
  echo "       Override stack names with API_STACK=... CORE_STACK=... if renamed." >&2
  exit 1
fi

# NOTE: these VITE_COGNITO_* names must match src/runtimeConfig.ts exactly.
cat > .env << EOF
VITE_API_ENDPOINT=${API_ENDPOINT}
VITE_COGNITO_USER_POOL_ID=${COGNITO_USER_POOL_ID}
VITE_COGNITO_CLIENT_ID=${COGNITO_CLIENT_ID}
VITE_COGNITO_REGION=${COGNITO_REGION}
VITE_IDENTITY_POOL_ID=${IDENTITY_POOL_ID}
EOF

echo "Wrote .env:"
echo "  VITE_API_ENDPOINT=${API_ENDPOINT}"
echo "  VITE_COGNITO_USER_POOL_ID=${COGNITO_USER_POOL_ID}"
echo "  VITE_COGNITO_CLIENT_ID=${COGNITO_CLIENT_ID}"
echo "  VITE_COGNITO_REGION=${COGNITO_REGION}"
echo "  VITE_IDENTITY_POOL_ID=${IDENTITY_POOL_ID}"
echo "✓ done — restart the dev server to pick it up"
