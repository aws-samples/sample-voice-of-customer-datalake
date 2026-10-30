#!/usr/bin/env bash
# Every gate; a green run here is a green CI run. Run it ONCE, on the release branch, just before it is
# pushed for its PR. Topic/agent branches use scripts/validate-affected.sh instead (CONTRIBUTING.md).
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
# (cdk-tests includes the vite build it needs); bridge; repo (version, gitleaks, jscpd); codeql;
# audit = every code-audit detector step, or one family: audit-py-synth, audit-callers, audit-patterns,
# audit-clones-py, audit-clones-ts, audit-ts, audit-unions, audit-locale, audit-tools (docs/code-audit.md).
# Env: VALIDATE_PYTEST_WORKERS (pytest-xdist workers; default: CPUs - 4, at least 2),
#      VALIDATE_LOG_DIR (default .cache/validate/logs/<timestamp>), PYTHON_BIN,
#      VALIDATE_SKIP_CODEQL=1 (skip the CodeQL step), CODEQL_THREADS (default: half the CPUs).
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
# The same value covers hooks: a file's beforeAll synth (default 10 s) timed out under CI load once (5.48.05).
VALIDATE_VITEST_TIMEOUT_MS="${VALIDATE_VITEST_TIMEOUT_MS:-30000}"
export ROOT CDK FRONTEND STREAM KNIP_PROD TSC_CACHE PYTHON_BIN PATH VALIDATE_PYTEST_WORKERS VALIDATE_VITEST_TIMEOUT_MS CPUS

# ---- Options ----
SERIAL=0; FAIL_FAST=1; ONLY=""; LIST=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --serial) SERIAL=1 ;;
    --keep-going) FAIL_FAST=0 ;;
    --only) ONLY="${2:?--only needs a comma-separated group list}"; shift ;;
    --only=*) ONLY="${1#--only=}" ;;
    --list) LIST=1 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) printf 'validate: unknown option %s (see --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# ---- Steps: lane | groups | name | command (run with `bash -euo pipefail -c`) ----
# Lanes (measured: their critical paths are about equal): py (Python lint, types, pytest-xdist),
# tsc (type checks, knip, small node checks, most code-audit detectors), lint (eslint — single-threaded,
# typed — jscpd, gitleaks, ts_reachability), test (vite build, the synth-based audit detectors, then the
# vitest suites: the CDK stacks and the audit synth stage frontend/dist as an asset); sec (CodeQL).
S_LANE=(); S_GROUPS=(); S_NAME=(); S_CMD=()
def() { S_LANE+=("$1"); S_GROUPS+=("$2"); S_NAME+=("$3"); S_CMD+=("$4"); }

# Python (voc-datalake/: ruff.toml, pyproject.toml, pytest.ini, pyrightconfig.json)
def py   python,python-static               "ruff"                               'cd "$CDK" && ruff check lambda plugins scripts'
def py   python,python-static               "vulture: production code"           'cd "$CDK" && bash scripts/lint-python.sh --dead-code'
def py   python,python-static               "vulture: test-support code"         'cd "$CDK" && bash scripts/lint-python.sh --dead-code-tests'
# pyright standard mode + reportUnnecessary* (pyrightconfig.json); zero errors.
def py   python,python-static               "pyright"                            'cd "$CDK" && npx --prefix "$ROOT" pyright --pythonpath "$PYTHON_BIN"'
# Production code only (pyrightconfig.production.json): no use of another module's private names.
def py   python,python-static               "pyright: production (private usage)" 'cd "$CDK" && npx --prefix "$ROOT" pyright --pythonpath "$PYTHON_BIN" -p pyrightconfig.production.json'
# Every pytest test asserts something (directly or through a helper it calls).
def py   python,python-static               "check_tests_assert"                 'cd "$CDK" && out="$("$PYTHON_BIN" scripts/check_tests_assert.py)" && [ -z "$out" ] || { printf "%s\n" "$out"; exit 1; }'
# pytest-xdist; `loadgroup` keeps @pytest.mark.xdist_group tests on one worker.
# Coverage is gated per file (docs/coverage-gate.md): the check runs after the suite.
def py   python,python-tests                "pytest"                             'cd "$CDK" && mkdir -p "$ROOT/.cache/coverage" && rm -f "$ROOT"/.cache/coverage/python.coverage* "$ROOT/.cache/coverage/python.json" && "$PYTHON_BIN" -m pytest -q --no-header --tb=short -p no:cacheprovider -n "$VALIDATE_PYTEST_WORKERS" --dist loadgroup --cov-config="$ROOT/scripts/coverage/python.coveragerc" --cov-report=term-missing:skip-covered --cov-report=html:"$ROOT/.cache/coverage/python-html" --cov-report=json:"$ROOT/.cache/coverage/python.json" && cd "$ROOT" && node scripts/coverage/check-per-file-coverage.mjs --suite python'

# Release bookkeeping: CHANGELOG.md's newest release = the version in every platform package.json.
def tsc  repo                               "version: CHANGELOG ↔ package.json"  'cd "$ROOT" && node --test scripts/check-version.test.mjs scripts/validate-affected.test.mjs && node scripts/check-version.mjs'
# The repo scripts' own tests: the coverage gate, the PR description check, the dependency audit and
# scheduled-failure watch, and the pre-push hook's verdict parsing.
def tsc  repo                               "node: coverage gate tests"          'cd "$ROOT" && node --test scripts/coverage/check-per-file-coverage.test.mjs'
def tsc  repo                               "node: PR description check"         'cd "$ROOT" && node --test scripts/pr-checks/*.test.mjs'
def tsc  repo                               "node: dependency scripts tests"     'cd "$ROOT" && node --test scripts/dependency-audit.test.mjs scripts/scheduled-failure-watch.test.mjs'
def tsc  repo                               "node: pre-push hook parsing"        'cd "$ROOT" && node --test scripts/git-hooks/pre-push.test.mjs'
# Secrets in the working tree (.gitleaks.toml: default rules + the platform's token formats, build
# output and dependencies allowlisted by path; .gitleaksignore for reviewed fingerprints).
def lint repo                               "gitleaks: working tree"             'cd "$ROOT" && bash scripts/gitleaks-tree.sh'
# CodeQL security-and-quality over JS/TS and Python, zero errors AND warnings (scripts/codeql.sh,
# accepted findings in scripts/codeql-summary.mjs). Its own lane: ~5 min on half the cores. Skipped on
# GitHub Actions, where the repository's CodeQL code scanning runs the same analysis on every PR;
# locally a missing CLI fails (brew install codeql). VALIDATE_SKIP_CODEQL=1 skips it on purpose.
def sec  codeql                             "codeql: security and quality"       'cd "$ROOT" && if [ -n "${GITHUB_ACTIONS:-}" ] || [ "${VALIDATE_SKIP_CODEQL:-0}" = 1 ]; then echo "codeql: skipped (GitHub code scanning / VALIDATE_SKIP_CODEQL)"; else CODEQL_STRICT=1 CODEQL_THREADS="${CODEQL_THREADS:-$(( CPUS / 2 > 1 ? CPUS / 2 : 1 ))}" bash scripts/codeql.sh; fi'
# TypeScript. `tsc -b` gets --force: its up-to-date check trusts the shared node_modules/.tmp buildinfo.
def tsc  frontend,frontend-static           "tsc: frontend app + node configs"   'cd "$FRONTEND" && npx tsc -b --noEmit --force'
def tsc  frontend,frontend-static           "tsc: frontend specs"                'cd "$FRONTEND" && npx tsc -p tsconfig.test.json --noEmit --incremental --tsBuildInfoFile "$TSC_CACHE/frontend-specs.tsbuildinfo"'
def tsc  stream,stream-static               "tsc: stream Lambda"                 'cd "$STREAM" && npx tsc --noEmit --incremental --tsBuildInfoFile "$TSC_CACHE/stream.tsbuildinfo"'
def tsc  cdk,cdk-static                     "tsc: CDK app"                       'cd "$CDK" && npx tsc -p tsconfig.json --noEmit --incremental --tsBuildInfoFile "$TSC_CACHE/cdk.tsbuildinfo"'
def tsc  cdk,cdk-static                     "tsc: CDK scripts + configs"         'cd "$CDK" && npx tsc -p tsconfig.tools.json'
def lint cdk,cdk-static                     "eslint: CDK app"                    'cd "$CDK" && npx eslint . --max-warnings 0'
def lint frontend,frontend-static           "eslint: frontend"                   'cd "$FRONTEND" && npx eslint . --max-warnings 0'
def lint stream,stream-static               "eslint: stream Lambda"              'cd "$STREAM" && npx eslint . --max-warnings 0'
# The gate code itself (eslint-rules/eslint.config.mjs): no package config can reach outside its directory.
def lint repo,cdk,cdk-static                 "eslint: gate rules (eslint-rules/)"  'cd "$ROOT/eslint-rules" && "$CDK/node_modules/.bin/eslint" . --max-warnings 0'
def tsc  cdk,cdk-static                     "knip: CDK app"                      'cd "$CDK" && npx knip --no-progress'
def tsc  cdk,cdk-static                     "knip --production: CDK app"         'cd "$CDK" && npx knip --no-progress --config "$KNIP_PROD" --production --strict'
def tsc  frontend,frontend-static           "knip: frontend"                     'cd "$FRONTEND" && npx knip --no-progress'
def tsc  frontend,frontend-static           "knip --production: frontend"        'cd "$FRONTEND" && npx knip --no-progress --config "$KNIP_PROD" --production --strict'
def tsc  stream,stream-static               "knip: stream Lambda"                'cd "$STREAM" && npx knip --no-progress'
def tsc  stream,stream-static               "knip --production: stream Lambda"   'cd "$STREAM" && npx knip --no-progress --config "$KNIP_PROD" --production --strict'
def tsc  frontend,frontend-static           "node: frontend i18n script tests"   'cd "$FRONTEND" && node scripts/i18n-check.test.mjs && node --test scripts/set-nested.test.mjs scripts/fix-i18n-helpers.test.mjs'
# Every key the source uses exists in English, and no locale misses/adds keys (untranslated values only warn).
def tsc  frontend,frontend-static           "node: frontend i18n audit"          'cd "$FRONTEND" && { out="$(node scripts/i18n-check.mjs)" || { printf "%s\n" "$out"; exit 1; }; }'
# Every fetchApi call site in the SPA has a dev-mock route that answers it (frontend/mock-coverage.json).
def tsc  frontend,frontend-static           "node: frontend mock coverage"       'cd "$FRONTEND" && node --test scripts/check-mock-coverage.test.mjs && node scripts/check-mock-coverage.mjs'
# Duplication across code and tests, whole repo (.jscpd.json: threshold 0). The SPA's
# assistant/contract.ts and approvals/schemas.ts are excluded there on purpose: they mirror the stream
# Lambda's contract/allowlists line for line and the *.lockstep.test.ts specs prove they agree.
def lint repo                               "jscpd"                              'cd "$ROOT" && npx jscpd --fail-on-empty --reporters console --silent'
# GitHub Actions workflows: pinned actionlint (+ shellcheck) and zizmor --offline, every finding fails.
def lint repo                               "actions: actionlint + zizmor"       'cd "$ROOT" && node --test scripts/actions-lint.test.mjs && bash scripts/actions-lint.sh'
def tsc  bridge                             "node: kiro-acp-bridge tests"        'cd "$ROOT/tools/kiro-acp-bridge" && node --test test/*.test.mjs'

# Tests that need the built SPA: the CDK stacks stage frontend/dist as an asset. Built once per run.
def test frontend,frontend-static,cdk,cdk-tests,audit,audit-py-synth "vite build: frontend" 'cd "$FRONTEND" && npx vite build --logLevel warn'
# Code audit (the detectors are described below): the CDK-contract and bundle-aware detectors share one offline synth,
# cached in .cache/audit/ (py_assembly.py). They run in ONE step, one after another (every one runs; the
# worst exit wins), so the cache is built once and no two synths ever write it at the same time. The synth
# stages frontend/dist (VocApiStack's website asset), so the step follows the vite build, which carries its
# group for that reason, and comes before the vitest suites so a failing suite cannot leave it unrun.
def test audit,audit-py-synth               "audit: py_reachability + py_env_contract + py_iam_contract + py_layers + py_sfn_errors + py_shared_constants + py_doc_refs + clones_struct.py --kind function" 'cd "$ROOT" && rc=0 && for d in scripts/audit/py_reachability.py scripts/audit/py_env_contract.py scripts/audit/py_iam_contract.py scripts/audit/py_layers.py scripts/audit/py_sfn_errors.py scripts/audit/py_shared_constants.py scripts/audit/py_doc_refs.py "scripts/audit/clones_struct.py --kind function"; do "$PYTHON_BIN" $d || { r=$?; echo "audit: $d exited $r"; [ "$r" -gt "$rc" ] && rc=$r; }; done; exit "$rc"'
def test cdk,cdk-tests                      "vitest: CDK app"                    'cd "$CDK" && npx vitest run --testTimeout "$VALIDATE_VITEST_TIMEOUT_MS" --hookTimeout "$VALIDATE_VITEST_TIMEOUT_MS"'
def test stream,stream-tests                "vitest: stream Lambda"              'cd "$STREAM" && rm -rf "$ROOT/.cache/coverage/stream" && npx vitest run --coverage.enabled --coverage.reporter=json-summary --coverage.reportsDirectory="$ROOT/.cache/coverage/stream" && cd "$ROOT" && node scripts/coverage/check-per-file-coverage.mjs --suite stream'
def test frontend,frontend-tests            "vitest: frontend"                   'cd "$FRONTEND" && rm -rf "$ROOT/.cache/coverage/frontend" && npx vitest run --testTimeout "$VALIDATE_VITEST_TIMEOUT_MS" --coverage.enabled --coverage.reporter=json-summary --coverage.reportsDirectory="$ROOT/.cache/coverage/frontend" && cd "$ROOT" && node scripts/coverage/check-per-file-coverage.mjs --suite frontend'

# Code-audit detectors (scripts/audit/, docs/code-audit.md): dead code, renamed clones and re-implemented
# helpers the gates above cannot see. Each exits 0 clean, 1 findings, 2 cannot run, and any non-zero exit
# fails its step. A finding is fixed, or allowlisted WITH a reason in scripts/audit/allowlists/<tool>.json.
# Lanes: the tsc lane finishes minutes before the py, lint and test lanes, so most run there; the slowest,
# ts_reachability, runs at the end of the lint lane, and the synth step in the test lane (above, right
# after the vite build).
# Their groups (audit = every one) let validate-affected.sh run only the detectors whose inputs changed.
def tsc  audit,audit-callers                "audit: py_route_callers"            'cd "$ROOT" && "$PYTHON_BIN" scripts/audit/py_route_callers.py'
def tsc  audit,audit-callers                "audit: py_stored_attrs"             'cd "$ROOT" && "$PYTHON_BIN" scripts/audit/py_stored_attrs.py'
def tsc  audit,audit-patterns               "audit: patterns"                    'cd "$ROOT" && "$PYTHON_BIN" scripts/audit/patterns.py'
def tsc  audit,audit-clones-py              "audit: clones_struct.py"            'cd "$ROOT" && "$PYTHON_BIN" scripts/audit/clones_struct.py'
def tsc  audit,audit-clones-py              "audit: py_dead_params"              'cd "$ROOT" && "$PYTHON_BIN" scripts/audit/py_dead_params.py'
def lint audit,audit-ts                     "audit: ts_reachability"             'cd "$ROOT" && node scripts/audit/ts_reachability.mjs'
def tsc  audit,audit-ts                     "audit: ts_api_callers"              'cd "$ROOT" && node scripts/audit/ts_api_callers.mjs'
def tsc  audit,audit-unions                 "audit: ts_union_members"            'cd "$ROOT" && node scripts/audit/ts_union_members.mjs'
def tsc  audit,audit-locale                 "audit: ts_locale_keys"              'cd "$ROOT" && node scripts/audit/ts_locale_keys.mjs'
def tsc  audit,audit-clones-ts              "audit: clones_struct.mjs"           'cd "$ROOT" && node scripts/audit/clones_struct.mjs'
def tsc  audit,repo                         "audit: stack_outputs"               'cd "$ROOT" && "$PYTHON_BIN" scripts/audit/stack_outputs.py'
def tsc  audit,repo                         "audit: repo_contracts"              'cd "$ROOT" && node scripts/audit/repo_contracts.mjs'
def tsc  audit,repo                         "audit: doc_contract"                'cd "$ROOT" && "$PYTHON_BIN" scripts/audit/doc_contract.py'
def tsc  audit,audit-ts                     "audit: ts_prop_usage"               'cd "$ROOT" && node scripts/audit/ts_prop_usage.mjs'
def tsc  audit,audit-ts                     "audit: ts_css_tokens"               'cd "$ROOT" && node scripts/audit/ts_css_tokens.mjs'
def tsc  audit,audit-ts                     "audit: ts_mock_routes"              'cd "$ROOT" && node scripts/audit/ts_mock_routes.mjs'
def tsc  audit,audit-ts                     "audit: ts_stale_refs"               'cd "$ROOT" && node scripts/audit/ts_stale_refs.mjs'
def tsc  audit,audit-clones-ts              "audit: ts_name_twins"               'cd "$ROOT" && node scripts/audit/ts_name_twins.mjs'
def tsc  audit,audit-ts                     "audit: ts_query_keys"               'cd "$ROOT" && node scripts/audit/ts_query_keys.mjs'
# The detectors' own tests and lint (root package.json test:audit / lint:audit), and a check that every
# detector run-all.sh discovers has a step above, so a new detector cannot land outside the gate.
def tsc  audit,audit-tools                  "audit: detector tests"              'cd "$ROOT" && "$PYTHON_BIN" -m pytest -c scripts/audit/pytest.ini scripts/audit && node --test scripts/audit/*.test.mjs'
def tsc  audit,audit-tools                  "audit: detector lint (ruff + pyright)" 'cd "$CDK" && ruff check --config ruff.toml ../scripts/audit && cd "$ROOT" && npx pyright --pythonpath "$PYTHON_BIN" -p scripts/audit/pyrightconfig.json'
def tsc  audit,audit-tools                  "audit: every detector has a step"   'cd "$ROOT" && missing="" && defs="$(grep "^def " scripts/validate.sh)" && for d in $(bash scripts/audit/run-all.sh --list); do grep -qF "$d" <<<"$defs" || missing="$missing $d"; done && [ -z "$missing" ] || { echo "detectors with no scripts/validate.sh step:$missing"; exit 1; }'

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
    case "$want" in python|frontend|cdk|stream|python-static|frontend-static|cdk-static|stream-static|python-tests|frontend-tests|cdk-tests|stream-tests|bridge|repo|codeql|audit|audit-py-synth|audit-callers|audit-patterns|audit-clones-py|audit-clones-ts|audit-ts|audit-unions|audit-locale|audit-tools) ;; *) printf 'validate: unknown group %s\n' "$want" >&2; exit 2 ;; esac
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
