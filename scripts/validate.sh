#!/usr/bin/env bash
# Every gate; a green run here is a green CI run. Run it ONCE, on the integration branch, just before
# the release commit. Track/agent branches use scripts/validate-affected.sh instead (CONTRIBUTING.md).
#
# Each step is a hard stop with zero findings allowed. Gates whose pre-existing findings are not
# fixed yet are NOT here: scripts/quality-baseline.sh counts them, and a gate moves from there to
# here in the change that brings it to zero. That list only ever shrinks.
#
# The steps run in independent LANES at once (each lane runs its own steps in order), and every step
# writes its own log. The first failing step stops the run (the other lanes are stopped too) and its
# log tail is printed; a table of every step's status and duration ends each run.
#
#   bash scripts/validate.sh                  every step, lanes in parallel, fail fast
#   bash scripts/validate.sh --serial         every step one after another (the old behaviour)
#   bash scripts/validate.sh --keep-going     do not stop the other lanes when a step fails
#   bash scripts/validate.sh --only python,cdk   only the steps tagged with one of these groups
#   bash scripts/validate.sh --list           print the steps (lane, groups, name) and exit
#
# Groups (used by scripts/validate-affected.sh): python, frontend, cdk, stream = every step of that
# package; <package>-static = its lint/type/dead-code steps; <package>-tests = its test suite
# (cdk-tests includes the vite build it needs); bridge; repo (version, gitleaks, jscpd).
# Env: VALIDATE_PYTEST_WORKERS (pytest-xdist workers; default: CPUs - 4, at least 2),
#      VALIDATE_LOG_DIR (default .cache/validate/logs/<timestamp>), PYTHON_BIN.
#
# bash 3.2 (macOS /bin/bash) compatible on purpose: no associative arrays, no `wait -n`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
CDK="$ROOT/voc-datalake"
FRONTEND="$CDK/frontend"
STREAM="$CDK/lambda/stream"
KNIP_PROD="$ROOT/scripts/knip-production.mjs"
# Incremental TypeScript state, per worktree. NOT under node_modules: node_modules is shared between
# worktrees through a symlink, and a shared .tsbuildinfo could make one worktree's check trust another's.
TSC_CACHE="$ROOT/.cache/validate/tsc"

if [[ -z "${PYTHON_BIN:-}" ]]; then
  if [[ -x "$CDK/.venv/bin/python" ]]; then PYTHON_BIN="$CDK/.venv/bin/python"; else PYTHON_BIN="$(command -v python3)"; fi
fi
PATH="$(dirname "$PYTHON_BIN"):$PATH"   # ruff, vulture, pytest from the same environment
CPUS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
if [[ -z "${VALIDATE_PYTEST_WORKERS:-}" ]]; then
  VALIDATE_PYTEST_WORKERS=$(( CPUS > 6 ? CPUS - 4 : 2 ))
fi
# The CDK suite keeps vitest's 5 s default for local runs (a hung test reports fast). Here it runs
# beside three other lanes, and its in-process VocApiStack synths take 1–3 s on an idle machine, so
# load alone could cross 5 s. A per-test timeout is not an assertion: nothing a test checks changes.
VALIDATE_VITEST_TIMEOUT_MS="${VALIDATE_VITEST_TIMEOUT_MS:-30000}"
export ROOT CDK FRONTEND STREAM KNIP_PROD TSC_CACHE PYTHON_BIN PATH VALIDATE_PYTEST_WORKERS VALIDATE_VITEST_TIMEOUT_MS

# ---- Options ----
SERIAL=0; FAIL_FAST=1; ONLY=""; LIST=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --serial) SERIAL=1 ;;
    --keep-going) FAIL_FAST=0 ;;
    --only) ONLY="${2:?--only needs a comma-separated group list}"; shift ;;
    --only=*) ONLY="${1#--only=}" ;;
    --list) LIST=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) printf 'validate: unknown option %s (see --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# ---- Steps: lane | groups | name | command (run with `bash -euo pipefail -c`) ----
# Lanes (measured: their critical paths are about equal): py (Python lint, types, pytest-xdist),
# tsc (type checks, knip, small node checks), lint (eslint — single-threaded, typed — jscpd, gitleaks),
# test (vite build, then the vitest suites: the CDK stacks stage frontend/dist as an asset).
S_LANE=(); S_GROUPS=(); S_NAME=(); S_CMD=()
def() { S_LANE+=("$1"); S_GROUPS+=("$2"); S_NAME+=("$3"); S_CMD+=("$4"); }

# Python (voc-datalake/: ruff.toml, pyproject.toml, pytest.ini, pyrightconfig.json)
def py   python,python-static               "ruff"                               'cd "$CDK" && ruff check lambda plugins scripts'
def py   python,python-static               "vulture: production code"           'cd "$CDK" && bash scripts/lint-python.sh --dead-code'
def py   python,python-static               "vulture: test-support code"         'cd "$CDK" && bash scripts/lint-python.sh --dead-code-tests'
# pyright standard mode + reportUnnecessary* (pyrightconfig.json); zero errors.
def py   python,python-static               "pyright"                            'cd "$CDK" && npx --prefix "$ROOT" pyright --pythonpath "$PYTHON_BIN"'
# Every pytest test asserts something (directly or through a helper it calls).
def py   python,python-static               "check_tests_assert"                 'cd "$CDK" && out="$("$PYTHON_BIN" scripts/check_tests_assert.py)" && [ -z "$out" ] || { printf "%s\n" "$out"; exit 1; }'
# pytest-xdist; `loadgroup` keeps @pytest.mark.xdist_group tests on one worker. Coverage is not a
# gate (pytest.ini has --cov-fail-under=0), so the gate skips its tracing; plain `pytest` still reports it.
def py   python,python-tests                "pytest"                             'cd "$CDK" && "$PYTHON_BIN" -m pytest -q --no-header --tb=short -p no:cacheprovider --no-cov -n "$VALIDATE_PYTEST_WORKERS" --dist loadgroup'

# Release bookkeeping: CHANGELOG.md's newest release = the version in every platform package.json.
def tsc  repo                               "version: CHANGELOG ↔ package.json"  'cd "$ROOT" && node --test scripts/check-version.test.mjs && node scripts/check-version.mjs'
# Secrets in the working tree (.gitleaks.toml: default rules + the platform's token formats, build
# output and dependencies allowlisted by path; .gitleaksignore for reviewed fingerprints).
def lint repo                               "gitleaks: working tree"             'cd "$ROOT" && bash scripts/gitleaks-tree.sh'
# TypeScript. `tsc -b` gets --force: its up-to-date check trusts the shared node_modules/.tmp buildinfo.
def tsc  frontend,frontend-static           "tsc: frontend app + node configs"   'cd "$FRONTEND" && npx tsc -b --noEmit --force'
def tsc  frontend,frontend-static           "tsc: frontend specs"                'cd "$FRONTEND" && npx tsc -p tsconfig.test.json --noEmit --incremental --tsBuildInfoFile "$TSC_CACHE/frontend-specs.tsbuildinfo"'
def tsc  stream,stream-static               "tsc: stream Lambda"                 'cd "$STREAM" && npx tsc --noEmit --incremental --tsBuildInfoFile "$TSC_CACHE/stream.tsbuildinfo"'
def tsc  cdk,cdk-static                     "tsc: CDK app"                       'cd "$CDK" && npx tsc -p tsconfig.json --noEmit --incremental --tsBuildInfoFile "$TSC_CACHE/cdk.tsbuildinfo"'
def tsc  cdk,cdk-static                     "tsc: CDK scripts + configs"         'cd "$CDK" && npx tsc -p tsconfig.tools.json'
def lint cdk,cdk-static                     "eslint: CDK app"                    'cd "$CDK" && npx eslint . --max-warnings 0'
def lint frontend,frontend-static           "eslint: frontend"                   'cd "$FRONTEND" && npx eslint . --max-warnings 0'
def lint stream,stream-static               "eslint: stream Lambda"              'cd "$STREAM" && npx eslint . --max-warnings 0'
def tsc  cdk,cdk-static                     "knip: CDK app"                      'cd "$CDK" && npx knip --no-progress'
def tsc  cdk,cdk-static                     "knip --production: CDK app"         'cd "$CDK" && npx knip --no-progress --config "$KNIP_PROD" --production --strict'
def tsc  frontend,frontend-static           "knip: frontend"                     'cd "$FRONTEND" && npx knip --no-progress'
def tsc  frontend,frontend-static           "knip --production: frontend"        'cd "$FRONTEND" && npx knip --no-progress --config "$KNIP_PROD" --production --strict'
def tsc  stream,stream-static               "knip: stream Lambda"                'cd "$STREAM" && npx knip --no-progress'
def tsc  stream,stream-static               "knip --production: stream Lambda"   'cd "$STREAM" && npx knip --no-progress --config "$KNIP_PROD" --production --strict'
def tsc  frontend,frontend-static           "node: frontend i18n script tests"   'cd "$FRONTEND" && node scripts/i18n-check.test.mjs'
# Every key the source uses exists in English, and no locale misses/adds keys (untranslated values only warn).
def tsc  frontend,frontend-static           "node: frontend i18n audit"          'cd "$FRONTEND" && { out="$(node scripts/i18n-check.mjs)" || { printf "%s\n" "$out"; exit 1; }; }'
# Every fetchApi call site in the SPA has a dev-mock route that answers it (frontend/mock-coverage.json).
def tsc  frontend,frontend-static           "node: frontend mock coverage"       'cd "$FRONTEND" && node --test scripts/check-mock-coverage.test.mjs && node scripts/check-mock-coverage.mjs'
# Duplication across code and tests, whole repo (.jscpd.json: threshold 0). The SPA's
# assistant/contract.ts and approvals/schemas.ts are excluded there on purpose: they mirror the stream
# Lambda's contract/allowlists line for line and the *.lockstep.test.ts specs prove they agree.
def lint repo                               "jscpd"                              'cd "$ROOT" && npx jscpd --fail-on-empty --reporters console --silent'
def tsc  bridge                             "node: kiro-acp-bridge tests"        'cd "$ROOT/tools/kiro-acp-bridge" && node --test test/*.test.mjs'

# Tests that need the built SPA: the CDK stacks stage frontend/dist as an asset. Built once per run.
def test frontend,frontend-static,cdk,cdk-tests "vite build: frontend"          'cd "$FRONTEND" && npx vite build --logLevel warn'
def test cdk,cdk-tests                      "vitest: CDK app"                    'cd "$CDK" && npx vitest run --testTimeout "$VALIDATE_VITEST_TIMEOUT_MS"'
def test stream,stream-tests                "vitest: stream Lambda"              'cd "$STREAM" && npx vitest run'
def test frontend,frontend-tests            "vitest: frontend"                   'cd "$FRONTEND" && npx vitest run'

# ---- Selection ----
selected() {  # step index -> 0 when it runs in this invocation
  [[ -z "$ONLY" ]] && return 0
  local want have
  for want in ${ONLY//,/ }; do
    for have in ${S_GROUPS[$1]//,/ }; do [[ "$want" == "$have" ]] && return 0; done
  done
  return 1
}
if [[ -n "$ONLY" ]]; then
  for want in ${ONLY//,/ }; do
    case "$want" in python|frontend|cdk|stream|python-static|frontend-static|cdk-static|stream-static|python-tests|frontend-tests|cdk-tests|stream-tests|bridge|repo) ;; *) printf 'validate: unknown group %s\n' "$want" >&2; exit 2 ;; esac
  done
fi
if [[ "$LIST" -eq 1 ]]; then
  for i in "${!S_NAME[@]}"; do
    selected "$i" && printf '%-5s %-42s %s\n' "${S_LANE[$i]}" "${S_GROUPS[$i]}" "${S_NAME[$i]}"
  done
  exit 0
fi
[[ "$SERIAL" -eq 1 ]] && for i in "${!S_LANE[@]}"; do S_LANE[$i]=serial; done

# ---- Run ----
LOG_DIR="${VALIDATE_LOG_DIR:-$ROOT/.cache/validate/logs/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$LOG_DIR" "$TSC_CACHE"
RESULTS="$LOG_DIR/results.tsv"   # index \t exit code \t seconds
STARTED="$LOG_DIR/started.tsv"   # index
: > "$RESULTS"; : > "$STARTED"
step_log() { printf '%s/%02d-%s.log' "$LOG_DIR" "$1" "$(printf '%s' "${S_NAME[$1]}" | tr -cs 'A-Za-z0-9' '-' | sed 's/-$//')"; }
exec 3>&1   # progress lines go to the console from every lane

run_lane() {
  local lane="$1" i rc t0 dur
  for i in "${!S_NAME[@]}"; do
    [[ "${S_LANE[$i]}" == "$lane" ]] && selected "$i" || continue
    printf '%s\n' "$i" >> "$STARTED"
    printf '%s  [%-6s] start  %s\n' "$(date +%T)" "$lane" "${S_NAME[$i]}" >&3
    t0=$(date +%s)
    rc=0
    bash -euo pipefail -c "${S_CMD[$i]}" > "$(step_log "$i")" 2>&1 < /dev/null || rc=$?
    dur=$(( $(date +%s) - t0 ))
    printf '%s\t%s\t%s\n' "$i" "$rc" "$dur" >> "$RESULTS"
    if [[ "$rc" -ne 0 ]]; then
      printf '%s  [%-6s] FAIL   %s (%ss, exit %s)\n' "$(date +%T)" "$lane" "${S_NAME[$i]}" "$dur" "$rc" >&3
      return 1
    fi
    printf '%s  [%-6s] ok     %s (%ss)\n' "$(date +%T)" "$lane" "${S_NAME[$i]}" "$dur" >&3
  done
}

tree_pids() {  # a pid, then every descendant (parents before children)
  local child
  printf '%s\n' "$1"
  for child in $(pgrep -P "$1" 2>/dev/null || true); do tree_pids "$child"; done
}
kill_tree() {  # a lane and every process it started (never anything else)
  # The whole tree is listed first, then killed lane-first, so a lane cannot record its dying
  # step as a failure of its own.
  local p
  for p in $(tree_pids "$1"); do kill "$p" 2>/dev/null || true; done
}

LANES=()
for lane in $(printf '%s\n' "${S_LANE[@]}" | awk '!seen[$0]++'); do
  for i in "${!S_NAME[@]}"; do
    if [[ "${S_LANE[$i]}" == "$lane" ]] && selected "$i"; then LANES+=("$lane"); break; fi
  done
done
if [[ "${#LANES[@]}" -eq 0 ]]; then printf 'validate: no step matches --only %s\n' "$ONLY" >&2; exit 2; fi
T_ALL=$(date +%s)
printf 'validate: %s lane(s) [%s], pytest workers %s, logs in %s\n' "${#LANES[@]}" "${LANES[*]}" "$VALIDATE_PYTEST_WORKERS" "$LOG_DIR"
PIDS=(); DONE=()
for lane in "${LANES[@]}"; do
  run_lane "$lane" &
  PIDS+=("$!"); DONE+=(0)
done
stop_all() { local p; for p in "${PIDS[@]}"; do kill_tree "$p"; done; }
trap 'stop_all; exit 130' INT TERM

FAILED=0; STOPPED=0; remaining=${#PIDS[@]}
while [[ "$remaining" -gt 0 ]]; do
  for k in "${!PIDS[@]}"; do
    [[ "${DONE[$k]}" -eq 0 ]] || continue
    kill -0 "${PIDS[$k]}" 2>/dev/null && continue
    rc=0; wait "${PIDS[$k]}" || rc=$?
    DONE[$k]=1; remaining=$(( remaining - 1 ))
    if [[ "$rc" -ne 0 ]]; then
      FAILED=1
      if [[ "$FAIL_FAST" -eq 1 && "$STOPPED" -eq 0 && "$remaining" -gt 0 ]]; then
        STOPPED=1
        printf '%s  validate: lane %s failed; stopping the other lanes (--keep-going to let them finish)\n' "$(date +%T)" "${LANES[$k]}"
        stop_all
      fi
    fi
  done
  [[ "$remaining" -gt 0 ]] && sleep 1
done
trap - INT TERM
TOTAL=$(( $(date +%s) - T_ALL ))

# ---- Report ----
result_of() { awk -F'\t' -v i="$1" '$1 == i { print $2 "\t" $3 }' "$RESULTS"; }
printf '\n%-8s %6s  %-6s %s\n' STATUS SECONDS LANE STEP
for i in "${!S_NAME[@]}"; do
  selected "$i" || continue
  r="$(result_of "$i")"
  if [[ -n "$r" ]]; then
    rc="${r%%$'\t'*}"; dur="${r##*$'\t'}"
    if [[ "$rc" -eq 0 ]]; then status=ok
    elif [[ "$STOPPED" -eq 1 && ( "$rc" -eq 143 || "$rc" -eq 137 ) ]]; then status=stopped
    else status=FAIL
    fi
  elif grep -qx "$i" "$STARTED"; then status=stopped; dur=-
  else status=not-run; dur=-
  fi
  printf '%-8s %6s  %-6s %s\n' "$status" "$dur" "${S_LANE[$i]}" "${S_NAME[$i]}"
  printf '%s\t%s\t%s\t%s\n' "$status" "$dur" "${S_LANE[$i]}" "${S_NAME[$i]}" >> "$LOG_DIR/timings.tsv"
done
printf '%-8s %6s  wall clock\n' total "$TOTAL"

if [[ "$FAILED" -ne 0 ]]; then
  while IFS=$'\t' read -r i rc _dur; do
    [[ "$rc" -eq 0 ]] && continue
    [[ "$STOPPED" -eq 1 && ( "$rc" -eq 143 || "$rc" -eq 137 ) ]] && continue   # stopped, not failed
    log="$(step_log "$i")"
    printf '\n======== FAILED: %s (exit %s) — last 80 lines of %s ========\n' "${S_NAME[$i]}" "$rc" "$log"
    tail -n 80 "$log"
    printf '======== end of %s ========\n' "${S_NAME[$i]}"
  done < "$RESULTS"
  printf '\nvalidate: FAILED (logs in %s)\n' "$LOG_DIR"
  exit 1
fi
printf '\nvalidate: every gate passed (logs in %s)\n' "$LOG_DIR"
