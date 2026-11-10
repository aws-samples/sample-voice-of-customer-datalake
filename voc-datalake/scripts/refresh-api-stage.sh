#!/bin/bash
# Re-deploys the API Gateway stage AFTER `cdk deploy` has finished, so a route
# removed from lib/stacks/api-routes.ts stops being served (3.00.00 R1).
#
# Why CDK alone cannot do it: removing a method changes the RestApi
# Deployment's logical id, so CloudFormation CREATES the new Deployment (a
# snapshot of the API as it stands at that moment) and points the stage at it
# during the update phase — but it DELETES the removed Method resources only in
# the cleanup phase, after every create and update, the new Deployment
# included. The snapshot therefore still holds the retired methods, and the
# stage keeps serving them (3.00.00: POST /mcp and ANY /mcp/{proxy+} answered
# 500 after their Lambda was gone). No dependency or custom resource inside the
# stack can run after its own cleanup phase, so the refresh is a deploy step:
# a fresh deployment of the stage once the stack update is COMPLETE.
#
# Idempotent and safe to run any time: create-deployment snapshots the API as
# it is now and repoints the stage at it, keeping the stage's settings
# (throttles, logging, variables). It writes nothing else.
#
#   bash voc-datalake/scripts/refresh-api-stage.sh
#   API_STACK=b-VocApiStack bash voc-datalake/scripts/refresh-api-stage.sh   # a prefixed deployment
#
# Reads AWS_REGION / AWS_PROFILE like the AWS CLI. Called by `npm run
# deploy:infra` (repo root) and `npm run deploy` / `deploy:api` (voc-datalake).

set -euo pipefail

# Overridable for a deployment created with -c deploymentPrefix=<p> (same seam as
# frontend/scripts/deploy.sh: a shell script cannot read the CDK context).
API_STACK="${API_STACK:-VocApiStack}"

output() {
  aws cloudformation describe-stacks \
    --stack-name "$API_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text
}

API_ID="$(output ApiId)"
API_ENDPOINT="$(output ApiEndpoint)"
if [ -z "$API_ID" ] || [ "$API_ID" = "None" ] || [ -z "$API_ENDPOINT" ] || [ "$API_ENDPOINT" = "None" ]; then
  echo "refresh-api-stage: $API_STACK has no ApiId/ApiEndpoint output (not deployed, or wrong region?)" >&2
  exit 1
fi

# The stage is the endpoint's last path segment: https://<id>.execute-api.<region>.amazonaws.com/<stage>/
STAGE="$(basename "${API_ENDPOINT%/}")"

DEPLOYMENT_ID="$(aws apigateway create-deployment \
  --rest-api-id "$API_ID" \
  --stage-name "$STAGE" \
  --description "post-deploy stage refresh (scripts/refresh-api-stage.sh)" \
  --query id \
  --output text)"

echo "refresh-api-stage: stage $STAGE of $API_ID now serves deployment $DEPLOYMENT_ID"
