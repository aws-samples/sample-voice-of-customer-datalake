#!/usr/bin/env bash
# Local CodeQL run over the whole repository (`npm run validate:codeql`).
#
# Builds one database per language and runs CodeQL's `security-and-quality`
# suite (security + maintainability queries) on each:
#   - javascript-typescript: the SPA, the stream Lambda, the CDK app and the
#     repo scripts;
#   - python: the Lambda handlers, shared code and plugins.
# Dependencies, build output, coverage reports and the e2e evidence writers are
# excluded (scripts/codeql-config.yml → the extractors' path filters).
#
# Output: `.cache/codeql/<lang>.sarif` plus a terse summary on stdout. Exit code is
# 1 when any result of level `error` is found, 0 otherwise (warnings are listed,
# not fatal). `CODEQL_STRICT=1` (set by the validate.sh step) also fails on
# warnings. A full run takes about 5 minutes on 8 cores.
# `CODEQL_REUSE_DB=1` skips the database build when one exists (re-analyse only).
#
# Needs the CodeQL CLI on PATH (`brew install codeql`). On a Mac with a DLP agent
# that stamps files with extended attributes, the launcher's self-`xattr -c` step
# fails and the CLI exits 1 with no output; `chmod -w` on the Caskroom dist dir
# makes the launcher skip that step. Databases and SARIF stay under .cache/
# (gitignored).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUT=.cache/codeql
mkdir -p "$OUT"
THREADS=${CODEQL_THREADS:-0}            # 0 = all cores
RAM=${CODEQL_RAM:-6144}                 # MB

command -v codeql >/dev/null || { echo "codeql CLI not found (brew install codeql)" >&2; exit 2; }
echo "codeql $(codeql version --format=terse)"

# The `paths-ignore` globs of scripts/codeql-config.yml, as the extractor filter
# string both extractors read (`--codescanning-config` is honoured only by the
# Code Scanning action, not by a local `database create`).
exclude_filters() {
  grep -E '^[[:space:]]*-[[:space:]]*"' scripts/codeql-config.yml \
    | sed -E 's/^[[:space:]]*-[[:space:]]*"([^"]+)"[[:space:]]*$/exclude:\1/'
}
CODEQL_EXTRACTOR_FILTERS=$(exclude_filters)
export LGTM_INDEX_FILTERS="$CODEQL_EXTRACTOR_FILTERS"

build_db() { # lang db-dir source-root
  local lang="$1" db="$2" root="$3"
  if [ "${CODEQL_REUSE_DB:-0}" = 1 ] && [ -f "$db/codeql-database.yml" ]; then
    echo "== database: $lang (reusing $db; CODEQL_REUSE_DB=1)"
    return
  fi
  rm -rf "$db"
  echo "== database: $lang ($root)"
  codeql database create "$db" --language="$lang" --source-root="$root" \
    --threads="$THREADS" --ram="$RAM" --overwrite --quiet
}

analyze() { # lang db-dir
  local lang="$1" db="$2"
  local sarif="$OUT/$lang.sarif" pack="${lang%-typescript}"
  echo "== analyze: $lang (security-and-quality)"
  codeql database analyze "$db" "codeql/${pack}-queries:codeql-suites/${pack}-security-and-quality.qls" \
    --format=sarif-latest --output="$sarif" --threads="$THREADS" --ram="$RAM" --quiet
  echo "   sarif: $sarif"
}

db_of() { # lang -> its database directory
  case "$1" in
    javascript-typescript) echo "$OUT/db-js" ;;
    python) echo "$OUT/db-py" ;;
    *) echo "unknown language: $1" >&2; return 2 ;;
  esac
}
LANGS=${CODEQL_LANGS:-"javascript-typescript python"}   # space-separated subset to (re)scan
for lang in $LANGS; do db_of "$lang" >/dev/null || exit 2; done
# CODEQL_PARALLEL=1 (validate.sh's pool, VOC_VALIDATE_JOBS, sets it): the languages' database builds and analyses run
# side by side, each with CODEQL_THREADS threads and its own log; the logs are printed in order and any failure
# fails the run. Default: one language after the other.
if [ "${CODEQL_PARALLEL:-0}" = 1 ]; then
  pids=(); logs=()
  for lang in $LANGS; do
    log="$OUT/$lang.log"; logs+=("$log")
    ( build_db "$lang" "$(db_of "$lang")" . && analyze "$lang" "$(db_of "$lang")" ) > "$log" 2>&1 &
    pids+=("$!")
  done
  failed=0
  for k in "${!pids[@]}"; do
    wait "${pids[$k]}" || { failed=1; echo "codeql: the ${logs[$k]} run failed" >&2; }
    cat "${logs[$k]}"
  done
  [ "$failed" = 0 ] || exit 1
else
  for lang in $LANGS; do
    build_db "$lang" "$(db_of "$lang")" .
    analyze "$lang" "$(db_of "$lang")"
  done
fi

sarifs=()
for lang in $LANGS; do sarifs+=("$OUT/$lang.sarif"); done
# No optional-flag array: bash 3.2 (the macOS /bin/bash) calls an EMPTY array unbound under `set -u`, so
# an unguarded "${strict[@]}" stopped the run there (5.48.01). Two plain calls cannot regress that way.
if [ "${CODEQL_STRICT:-0}" = 1 ]; then
  node scripts/codeql-summary.mjs --strict "${sarifs[@]}"
else
  node scripts/codeql-summary.mjs "${sarifs[@]}"
fi
