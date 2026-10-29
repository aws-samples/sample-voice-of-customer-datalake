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

LANGS=${CODEQL_LANGS:-"javascript-typescript python"}   # space-separated subset to (re)scan
for lang in $LANGS; do
  case "$lang" in
    javascript-typescript) db="$OUT/db-js" ;;
    python) db="$OUT/db-py" ;;
    *) echo "unknown language: $lang" >&2; exit 2 ;;
  esac
  build_db "$lang" "$db" .
  analyze "$lang" "$db"
done

sarifs=()
for lang in $LANGS; do sarifs+=("$OUT/$lang.sarif"); done
# No optional-flag array: bash 3.2 (the macOS /bin/bash) calls an EMPTY array unbound under `set -u`, so
# an unguarded "${strict[@]}" stopped the run there (5.48.01). Two plain calls cannot regress that way.
if [ "${CODEQL_STRICT:-0}" = 1 ]; then
  node scripts/codeql-summary.mjs --strict "${sarifs[@]}"
else
  node scripts/codeql-summary.mjs "${sarifs[@]}"
fi
