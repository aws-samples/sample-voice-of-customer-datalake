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
#
# Opt-in: CDK_DEPLOY_CHANGED=1 deploys only the stacks that changed. It runs
# `cdk diff --all` once (with the -c/--context and --profile arguments), reads
# the stacks with differences (scripts/cdk-changed-stacks.mjs), deploys exactly
# those with --exclusively (CDK orders them by dependency) and ALWAYS refreshes
# the stage afterwards, also when VocApiStack had no differences or nothing was
# deployed: an earlier deploy whose refresh never ran (interrupted, failed) would
# otherwise leave removed routes live until the API stack next changes, and the
# refresh is one idempotent create-deployment. When the diff fails or cannot be read
# with certainty it falls back to the full deploy + refresh below. It is for
# whole-app deploys (deploy:infra, deploy): `--all` is replaced by the changed
# list, so do not name stacks in the arguments. docs/deployment.md has details.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

full_deploy() {
  npx cdk deploy "$@"
  bash scripts/refresh-api-stage.sh
}

if [ "${CDK_DEPLOY_CHANGED:-0}" != "1" ]; then
  full_deploy "$@"
  exit 0
fi

# ---- CDK_DEPLOY_CHANGED=1 ----------------------------------------------------
diff_args=()   # what `cdk diff` must see to synthesize the same app
deploy_args=() # everything but --all
args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  arg="${args[$i]}"
  case "$arg" in
    --all) ;;
    -c|--context|--profile)
      value="${args[$((i + 1))]:-}"
      diff_args+=("$arg" "$value")
      deploy_args+=("$arg" "$value")
      i=$((i + 1))
      ;;
    -c=*|--context=*|--profile=*)
      diff_args+=("$arg")
      deploy_args+=("$arg")
      ;;
    *) deploy_args+=("$arg") ;;
  esac
  i=$((i + 1))
done

diff_out="$(mktemp)"
trap 'rm -f "$diff_out"' EXIT

echo "cdk-deploy: CDK_DEPLOY_CHANGED=1, diffing every stack first..."
if ! NO_COLOR=1 FORCE_COLOR=0 npx cdk diff --all ${diff_args[@]+"${diff_args[@]}"} >"$diff_out" 2>&1; then
  tail -n 20 "$diff_out" >&2
  echo "cdk-deploy: cdk diff failed; falling back to the full deploy" >&2
  full_deploy "$@"
  exit 0
fi

if ! changed_list="$(node scripts/cdk-changed-stacks.mjs <"$diff_out")"; then
  echo "cdk-deploy: could not tell which stacks changed; falling back to the full deploy" >&2
  full_deploy "$@"
  exit 0
fi

changed=()
while IFS= read -r stack; do
  [ -n "$stack" ] && changed+=("$stack")
done <<<"$changed_list"

if [ "${#changed[@]}" -eq 0 ]; then
  echo "cdk-deploy: no stack has differences; nothing deployed"
else
  echo "cdk-deploy: deploying only the changed stacks: ${changed[*]}"
  npx cdk deploy --exclusively ${deploy_args[@]+"${deploy_args[@]}"} "${changed[@]}"
fi

# Always, whichever stacks changed (see the header): the stage serves exactly the API definition.
bash scripts/refresh-api-stage.sh
