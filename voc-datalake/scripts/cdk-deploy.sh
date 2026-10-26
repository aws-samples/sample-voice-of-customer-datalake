#!/bin/bash
# `cdk deploy <args>`, then the API stage refresh (scripts/refresh-api-stage.sh).
#
# Every documented deploy command goes through here, so a route removed from
# lib/stacks/api-routes.ts is never left live on the stage (3.00.00 R1 — see
# refresh-api-stage.sh for why CloudFormation cannot order it). Arguments pass
# straight to `cdk deploy`, so `npm run deploy:infra -- -c frontendDomain=x`
# keeps working. The refresh runs only when the deploy succeeded.
#
# A prefixed deployment (-c deploymentPrefix=<p>) also sets API_STACK=<p>-VocApiStack
# so the refresh targets its own API.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

npx cdk deploy "$@"
bash scripts/refresh-api-stage.sh
