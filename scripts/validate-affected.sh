#!/usr/bin/env bash
# The gates a TRACK / AGENT branch needs: only the scripts/validate.sh steps for what it changed.
#
#   bash scripts/validate-affected.sh [<base>] [validate.sh options…]   e.g. --keep-going
#   bash scripts/validate-affected.sh --explain [<base>]                 print the mapping, run nothing
#
# <base> defaults to the integration branch, kiro-voc. "Changed" is everything in
# `git diff --name-only <base>...HEAD`, plus uncommitted and untracked (not ignored) files.
#
# This is NOT the release gate. The full `bash scripts/validate.sh` still runs ONCE on the
# integration branch before each release commit (CONTRIBUTING.md); that run is the backstop for
# anything the mapping below misses.
#
# The mapping, path → validate.sh groups (see `validate.sh --list`):
#   - every run: repo (version check, gitleaks, jscpd — seconds)
#   - a package's own files → that package's static steps and tests
#   - known cross-package readers: the CDK suite stages frontend/dist and reads handler, plugin,
#     doc and script files; the frontend lockstep specs read the stream Lambda's contract
#   - any test suite whose test files NAME a changed file (its basename, or parent/basename for
#     generic names such as handler.py) — that is how the lockstep tests read across packages
#   - gate configuration (validate.sh, .gitleaks.toml, CI, root package files, eslint-rules) or an
#     unknown top-level path → everything
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

EXPLAIN=0
if [[ "${1:-}" == "--explain" ]]; then EXPLAIN=1; shift; fi
BASE="kiro-voc"
if [[ $# -gt 0 && "$1" != -* ]]; then BASE="$1"; shift; fi
if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  printf 'validate-affected: base %s is not a commit (pass one: validate-affected.sh <base>)\n' "$BASE" >&2
  exit 2
fi

CHANGED="$( { git diff --name-only "$BASE...HEAD"; git diff --name-only HEAD; git ls-files --others --exclude-standard; } \
  | awk 'NF && $0 !~ /(^|\/)node_modules$/ && !seen[$0]++' )"   # node_modules symlinks are not gitignored

AFFECTED=" repo "
REASONS=""
add() {  # add <groups (comma-separated)> <reason>
  local g
  for g in ${1//,/ }; do
    case "$AFFECTED" in *" $g "*) ;; *) AFFECTED="$AFFECTED$g " ;; esac
  done
  REASONS="${REASONS}  $(printf '%-44s' "$1") $2"$'\n'
}
ALL="python,frontend,cdk,stream,bridge,repo"

# Test files per suite (git pathspecs), for the cross-reference pass.
suite_pathspecs() {
  case "$1" in
    python-tests)   printf '%s\n' 'voc-datalake/lambda/*test_*.py' 'voc-datalake/lambda/*conftest.py' 'voc-datalake/plugins/*test_*.py' 'voc-datalake/plugins/*conftest.py' ':!voc-datalake/lambda/stream' ;;
    cdk-tests)      printf '%s\n' 'voc-datalake/lib/*.test.ts' 'voc-datalake/lib/test-support/*.ts' ;;
    stream-tests)   printf '%s\n' 'voc-datalake/lambda/stream/*.test.ts' ;;
    frontend-tests) printf '%s\n' 'voc-datalake/frontend/src/*.test.ts' 'voc-datalake/frontend/src/*.test.tsx' 'voc-datalake/frontend/src/test/*' ;;
  esac
}
GENERIC_NAMES=" handler.py __init__.py conftest.py index.ts index.tsx types.ts README.md package.json manifest.json requirements.txt config.ts utils.ts schema.ts "
cross_reference() {  # a changed file named by another suite's tests pulls that suite in
  local path="$1" base parent suite pattern hit spec specs
  base="$(basename "$path")"
  parent="$(basename "$(dirname "$path")")"
  for suite in python-tests cdk-tests stream-tests frontend-tests; do
    case "$AFFECTED" in *" $suite "*|*" ${suite%-tests} "*) continue ;; esac
    if [[ "$GENERIC_NAMES" == *" $base "* ]]; then
      pattern="$parent/$base|'$parent', '$base'"
    else
      pattern="${base//./\\.}"
    fi
    specs=()
    while IFS= read -r spec; do specs+=("$spec"); done < <(suite_pathspecs "$suite")
    hit="$(git grep -l -E "$pattern" -- "${specs[@]}" 2>/dev/null | grep -vxF "$path" | head -n 1 || true)"
    if [[ -n "$hit" ]]; then add "$suite" "$path is named in $hit"; fi
  done
}

while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  case "$path" in
    scripts/validate.sh|scripts/validate-affected.sh|scripts/gitleaks-tree.sh|.gitleaks.toml|.gitleaksignore|.jscpd.json|.github/*|package.json|package-lock.json|eslint-rules/*|.python-version|scripts/knip-production.mjs)
      add "$ALL" "$path configures the gate itself" ;;
    voc-datalake/lambda/stream/*)
      add "stream,frontend-tests,cdk-tests" "$path (stream Lambda; the SPA mirrors its contract, the CDK app bundles it)" ;;
    voc-datalake/lambda/*/test/*|voc-datalake/plugins/*/test/*|*/test_*.py|*/conftest.py)
      add "python" "$path (Python tests)" ;;
    voc-datalake/lambda/*|voc-datalake/plugins/*)
      add "python,cdk-tests" "$path (Python; the CDK app packages it and its suite reads handlers/plugins)"
      case "$path" in voc-datalake/plugins/*) add "frontend-tests" "$path (plugin manifests feed the SPA)" ;; esac ;;
    voc-datalake/pyproject.toml|voc-datalake/ruff.toml|voc-datalake/pytest.ini|voc-datalake/pyrightconfig.json|voc-datalake/requirements-dev.txt|voc-datalake/scripts/*.py|voc-datalake/scripts/*/*.py)
      add "python" "$path (Python tooling)" ;;
    voc-datalake/frontend/*)
      add "frontend,cdk-tests" "$path (SPA; the CDK suite stages frontend/dist and reads SPA files)" ;;
    voc-datalake/cdk.context.json)
      add "cdk,frontend,python-tests" "$path (plugin/menu status: CDK app, generated SPA config, Python lockstep)" ;;
    voc-datalake/*)
      add "cdk" "$path (CDK app, its tooling and configs)" ;;
    tools/kiro-acp-bridge/*)
      add "bridge" "$path" ;;
    docs/*|.kiro/*|*.md|scripts/*|static/*)
      add "repo" "$path (docs/scripts: covered by repo unless a suite names it, below)" ;;
    *)
      add "$ALL" "$path is outside every known area: running everything" ;;
  esac
  cross_reference "$path"
done <<< "$CHANGED"

ONLY="$(printf '%s' "$AFFECTED" | xargs | tr ' ' ',')"
printf 'validate-affected: base %s, %s changed file(s)\n' "$BASE" "$(printf '%s' "$CHANGED" | awk 'NF' | wc -l | tr -d ' ')"
printf '%s' "$REASONS" | awk '!seen[$0]++'
printf 'groups: %s\n' "$ONLY"
printf 'reminder: the FULL scripts/validate.sh runs once on the integration branch before the release commit.\n\n'
if [[ "$EXPLAIN" -eq 1 ]]; then
  bash "$ROOT/scripts/validate.sh" --only "$ONLY" --list
  exit 0
fi
exec bash "$ROOT/scripts/validate.sh" --only "$ONLY" "$@"
