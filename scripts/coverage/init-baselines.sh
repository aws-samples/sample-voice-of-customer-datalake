#!/usr/bin/env bash
# Creates the per-file coverage baselines (docs/coverage-gate.md): runs the Python, frontend and stream suites with
# coverage on, the same way scripts/validate.sh's test steps do, then `check-per-file-coverage.mjs --suite <s> --init`
# for each.
#
# Why it exists: a baseline is created ONCE, when the gate starts (or when the owner decides to start it again).
# The everyday tool only shrinks a baseline (--update-baseline); nothing else can add a row.
#
#   bash scripts/coverage/init-baselines.sh [python] [frontend] [stream]    (no argument: all three)
#
# It refuses before running anything when a requested baseline exists: delete that file first, on purpose
# (`rm scripts/coverage/baselines/<suite>.txt`), so re-creating is always a visible decision in the diff.
# The suites run one after another (about 14 minutes on 12 cores: pytest ~9, frontend ~4, stream ~0.3): run in
# parallel, the frontend suite's slowest tests crossed their timeout on a loaded machine. Logs: .cache/coverage/.
# Limits: a failing test suite stops it before any baseline is written, and the baselines record the tree as it
# is now, uncommitted changes included.
#
# bash 3.2 (macOS /bin/bash) compatible: no associative arrays, no `wait -n`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT="$PWD"
CDK="$ROOT/voc-datalake"
OUT="$ROOT/.cache/coverage"
if [[ -z "${PYTHON_BIN:-}" ]]; then
  if [[ -x "$CDK/.venv/bin/python" ]]; then PYTHON_BIN="$CDK/.venv/bin/python"; else PYTHON_BIN="$(command -v python3)"; fi
fi
CPUS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
WORKERS="${VALIDATE_PYTEST_WORKERS:-$(( CPUS > 6 ? CPUS - 4 : 2 ))}"
# Same per-test timeout as scripts/validate.sh: coverage instrumentation slows the slowest frontend tests.
TIMEOUT_MS="${VALIDATE_VITEST_TIMEOUT_MS:-30000}"

SUITES=("$@")
[[ "${#SUITES[@]}" -gt 0 ]] || SUITES=(python frontend stream)
for s in "${SUITES[@]}"; do
  case "$s" in python|frontend|stream) ;; *) printf 'init-baselines: unknown suite %s (python, frontend, stream)\n' "$s" >&2; exit 2 ;; esac
  if [[ -e "scripts/coverage/baselines/$s.txt" ]]; then
    printf 'init-baselines: scripts/coverage/baselines/%s.txt exists; delete it first to re-create it on purpose\n' "$s" >&2
    exit 2
  fi
done
mkdir -p "$OUT" scripts/coverage/baselines

run_suite() {  # the coverage half of each scripts/validate.sh test step
  case "$1" in
    python)
      rm -f "$OUT"/python.coverage* "$OUT/python.json"
      cd "$CDK" && "$PYTHON_BIN" -m pytest -q --no-header --tb=short -p no:cacheprovider -n "$WORKERS" --dist loadgroup \
        --cov-config="$ROOT/scripts/coverage/python.coveragerc" --cov-report=term-missing:skip-covered \
        --cov-report=html:"$OUT/python-html" --cov-report=json:"$OUT/python.json" ;;
    frontend)
      rm -rf "$OUT/frontend"
      cd "$CDK/frontend" && npx vitest run --testTimeout "$TIMEOUT_MS" \
        --coverage.enabled --coverage.reporter=json-summary --coverage.reportsDirectory="$OUT/frontend" ;;
    stream)
      rm -rf "$OUT/stream"
      cd "$CDK/lambda/stream" && npx vitest run \
        --coverage.enabled --coverage.reporter=json-summary --coverage.reportsDirectory="$OUT/stream" ;;
  esac
}

for s in "${SUITES[@]}"; do
  printf 'init-baselines: running the %s suite with coverage (log: .cache/coverage/%s.log)\n' "$s" "$s"
  if ! ( run_suite "$s" ) > "$OUT/$s.log" 2>&1 < /dev/null; then
    printf 'init-baselines: the %s suite failed (see .cache/coverage/%s.log); no baseline written\n' "$s" "$s" >&2
    exit 1
  fi
done
for s in "${SUITES[@]}"; do
  node scripts/coverage/check-per-file-coverage.mjs --suite "$s" --init
done
