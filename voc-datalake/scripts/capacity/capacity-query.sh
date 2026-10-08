#!/usr/bin/env bash
# Read-only Lambda capacity check under the sizing policy (docs/lambda-sizing.md).
#
#   scripts/capacity/capacity-query.sh [--hours 168] [--region us-west-2] [--json out.json] [--repo-sizes]
#
# Runs the peak-memory (REPORT) and CPU (`invocation_cost`) Logs Insights queries over
# every voc-* function with the operator's ambient AWS credentials, prints a table,
# lists unmeasured functions, and exits 1 on a breach (2 on an error). Nothing is
# written to AWS. Every flag is passed through to capacity-report.ts.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec npx ts-node --transpile-only scripts/capacity/capacity-report.ts "$@"
