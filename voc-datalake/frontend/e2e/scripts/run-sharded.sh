#!/usr/bin/env bash
# Run the production e2e suite in <n> parallel Playwright shards, then merge their results.
#
#   set -a; . /path/to/e2e-credentials.env; set +a
#   bash e2e/scripts/run-sharded.sh 6                 # from voc-datalake/frontend; ~30 min for the full suite
#   E2E_SHARD_WORKERS=1 bash e2e/scripts/run-sharded.sh 4 tests/writes.spec.ts   # extra args go to playwright
#
# Each shard gets its own E2E_OUT (<base>/shard<i>), so its own saved sessions (<E2E_OUT>/.auth,
# lib/env.ts authDirFor), its own run id, ledger (created.json) and cleanup teardown. A shard never
# reads or cleans another shard's data. Afterwards the blob reports are merged into one list +
# <base>/results.json + <base>/html, and the exit code is non-zero when any shard failed.
#
# Env: E2E_SHARD_OUT  base directory (default e2e/e2e-output/sharded-<epoch s>)
#      E2E_TAG_RUN_ID  the test traffic tag shared by all shards (default e2e-[<track>-]<UTC yyyymmddThhmmssZ>)
#      E2E_SHARD_WRITE_WORKERS  workers per shard for the specs that write (default 2, as before 5.63.00)
#      E2E_SHARD_READ_WORKERS   workers per shard for the read-only specs (lib/parallel.ts; default 2)
#      E2E_SHARD_WORKERS  total workers per shard (default read + write; set alone, writes get at most 2
#                         and the read-only specs the rest; a cap above it is refused)
set -uo pipefail

MAX_SHARDS=16
N="${1:-}"
if ! [[ "$N" =~ ^[0-9]+$ ]] || (( N < 1 || N > MAX_SHARDS )); then
  echo "usage: run-sharded.sh <shards 1-$MAX_SHARDS> [playwright args...]" >&2
  exit 2
fi
shift

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${E2E_SHARD_OUT:-$E2E_DIR/e2e-output/sharded-$(date +%s)}"
cd "$E2E_DIR" || exit 2
# The worker arithmetic lives in lib/parallel.ts shardWorkerPlan (unit/parallel.spec.ts); a bad or
# inconsistent combination stops here, before any shard starts.
PLAN="$(node --experimental-strip-types --no-warnings --input-type=module -e '
  const { shardWorkerPlan } = await import("./lib/parallel.ts")
  try { const p = shardWorkerPlan(); process.stdout.write(`${p.write} ${p.read} ${p.total}`) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2) }')" || exit 2
read -r WRITE_WORKERS READ_WORKERS WORKERS <<< "$PLAN"
echo "workers per shard: $WORKERS ($WRITE_WORKERS writing, $READ_WORKERS read-only)"
BLOBS="$BASE/blob"
mkdir -p "$BLOBS"

# One distinct run id per shard (names stay `e2e-<run id>-…`, and with E2E_TRACK `e2e-<track>-<ms>-…`).
STAMP="$(node -e 'process.stdout.write(String(Date.now()))')"
# ONE test traffic tag for every shard (User-Agent `voc-e2e/<tag>`, lib/trafficTag.ts), so a log
# query excludes or isolates the whole sharded run at once. The shards keep their own run ids.
TAG_RUN_ID="${E2E_TAG_RUN_ID:-e2e-${E2E_TRACK:+$E2E_TRACK-}$(date -u +%Y%m%dT%H%M%SZ)}"
if ! [[ "$TAG_RUN_ID" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
  echo "E2E_TAG_RUN_ID must match ^[A-Za-z0-9._-]{1,64}\$" >&2
  exit 2
fi
echo "test traffic tag: voc-e2e/$TAG_RUN_ID"
PIDS=()
for ((i = 1; i <= N; i++)); do
  OUT="$BASE/shard$i"
  mkdir -p "$OUT"
  RUN_ID="$((STAMP + i))"
  [[ -n "${E2E_TRACK:-}" ]] && RUN_ID="$E2E_TRACK-$RUN_ID"
  (
    export E2E_OUT="$OUT" E2E_RUN_ID="$RUN_ID" E2E_TAG_RUN_ID="$TAG_RUN_ID"
    # The per-project caps playwright.config.ts applies (lib/parallel.ts); --workers is the shard's total.
    export E2E_WRITE_WORKERS="$WRITE_WORKERS" E2E_READ_WORKERS="$READ_WORKERS"
    export PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/results.json"
    # Its own blob directory: the blob reporter empties its output directory when it starts.
    export PLAYWRIGHT_BLOB_OUTPUT_DIR="$OUT/blob" PLAYWRIGHT_BLOB_OUTPUT_NAME="report-$i.zip"
    npx playwright test -c playwright.config.ts --shard="$i/$N" --workers="$WORKERS" \
      --reporter=line,json,blob "$@" > "$OUT/run.log" 2> "$OUT/stderr.log"
    echo "exit $?" >> "$OUT/run.log"
  ) &
  PIDS+=("$!")
  echo "shard $i/$N: pid $!, run id $RUN_ID, log $OUT/run.log"
done

FAILED=0
for ((i = 1; i <= N; i++)); do
  wait "${PIDS[$((i - 1))]}"
  STATUS="$(tail -n 1 "$BASE/shard$i/run.log")"
  echo "shard $i/$N finished: $STATUS"
  [[ "$STATUS" == "exit 0" ]] || FAILED=1
  cp "$BASE/shard$i/blob/"*.zip "$BLOBS/" 2>/dev/null || echo "shard $i/$N left no blob report" >&2
done

PLAYWRIGHT_JSON_OUTPUT_NAME="$BASE/results.json" PLAYWRIGHT_HTML_OUTPUT_DIR="$BASE/html" PLAYWRIGHT_HTML_OPEN=never \
  npx playwright merge-reports --reporter=list,json,html "$BLOBS" > "$BASE/merged.log" 2>&1
tail -n 40 "$BASE/merged.log"
echo "merged: $BASE/results.json, $BASE/html/index.html; evidence per shard: $BASE/shard<i>/"
exit "$FAILED"
