#!/usr/bin/env bash
# Mutation testing for TypeScript files (Stryker + vitest), the counterpart of scripts/mutate-python.sh.
# Not a gate: a per-file tool, run on what a change touches and by the mutation programme's agents.
#
#   scripts/mutate-ts.sh <package> [--lines <from>-<to>] [--force] <file>[:<from>-<to>] [more files...]
#   scripts/mutate-ts.sh frontend src/utils/dateUtils.ts
#   scripts/mutate-ts.sh stream --lines 1-200 src/assistant/runner.ts
#   scripts/mutate-ts.sh cdk lib/utils/context.ts lib/stacks/dlq-alarms.ts:1-80
#   scripts/mutate-ts.sh stream --all       # the whole package (the planner's baseline sweep: --baseline)
#   scripts/mutate-ts.sh cdk --exclude-spec lib/stacks/api-stack-webhook-env.test.ts lib/stacks/ingestion-stack.ts
#
# <package>: frontend (voc-datalake/frontend), stream (voc-datalake/lambda/stream), cdk (voc-datalake).
# File paths are relative to the package directory (a voc-datalake/… or repo-root path is accepted too).
# --lines applies to every file without its own range. Stryker runs only the specs related to the
# mutated files (vitest's import graph), per mutant only the tests that cover it (perTest coverage).
#
# Results are incremental per target set (.cache/stryker/, gitignored): a rerun after a test edit only
# re-tests the mutants whose code or covering tests changed. --force re-tests everything (do it once
# after deleting tests). Exit 0 = 0 surviving mutants; 1 = survivors or uncovered mutants (printed as
# file:line:col, mutator, original → replacement); 3 = only runtime/compile-error mutants; 2 = bad call.
#
# --exclude-spec <spec> (repeatable) leaves a spec out of the run: one that reads a target's SOURCE TEXT
# (readFileSync of a .ts file) fails on the instrumented copy and so fails Stryker's initial run. Its
# text assertions pin nothing a mutant could change anyway; the run's log names the failing test.
# --all leaves out every spec that calls readFileSync.
#
# Environment: STRYKER_CONCURRENCY (default 2 test runners), STRYKER_TIMEOUT_MS (default 20000).
# Stryker instruments the files IN PLACE (see stryker-base.mjs): do not edit them while it runs. If
# the run is killed, the EXIT trap puts every target file back from its pre-run copy.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
CDK_ROOT="$PWD"

usage() { sed -n '4,7p' "$0" >&2; exit 2; }
PKG="${1:-}"; shift || true
case "$PKG" in
  frontend) PKG_DIR="$CDK_ROOT/frontend"; PREFIX="voc-datalake/frontend/" ;;
  stream)   PKG_DIR="$CDK_ROOT/lambda/stream"; PREFIX="voc-datalake/lambda/stream/" ;;
  cdk)      PKG_DIR="$CDK_ROOT"; PREFIX="voc-datalake/" ;;
  *) usage ;;
esac

LINES=""; FORCE=(); ALL=0; EXCLUDE=()
TARGETS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --lines) LINES="${2:-}"; [[ "$LINES" =~ ^[0-9]+-[0-9]+$ ]] || { echo "--lines wants <from>-<to>, got '$LINES'" >&2; exit 2; }; shift 2 ;;
    --force) FORCE=(--force); shift ;;
    --all) ALL=1; shift ;;
    --exclude-spec) EXCLUDE+=("${2:?--exclude-spec <spec>}"); shift 2 ;;
    -*) usage ;;
    *) TARGETS+=("$1"); shift ;;
  esac
done
[[ ${#TARGETS[@]} -gt 0 || $ALL -eq 1 ]] || usage

MUTATE=(); FILES=()
for t in ${TARGETS[@]+"${TARGETS[@]}"}; do
  file="${t%%:*}"; range=""
  [[ "$t" == *:* ]] && range="${t#*:}"
  file="${file#"$PREFIX"}"; file="${file#"${PREFIX#voc-datalake/}"}"
  [[ -f "$PKG_DIR/$file" ]] || { echo "no such file: $PKG_DIR/$file" >&2; exit 2; }
  [[ -z "$range" && -n "$LINES" ]] && range="$LINES"
  [[ -z "$range" || "$range" =~ ^[0-9]+-[0-9]+$ ]] || { echo "bad range '$range' in $t (want <from>-<to>)" >&2; exit 2; }
  FILES+=("$file")
  MUTATE+=("$file${range:+:$range}")
done
MUTATE_ARG="$(IFS=,; echo "${MUTATE[*]-}")"

cd "$PKG_DIR"
if [[ $ALL -eq 1 ]]; then
  # The config's own globs; every tracked TypeScript file is backed up (the restore below is per file).
  MUTATE_ARG=""
  while IFS= read -r f; do FILES+=("$f"); done < <(git ls-files -- '*.ts' '*.tsx' | grep -vE '^(frontend|lambda)/|\.(test|spec)\.tsx?$|\.d\.ts$' || true)
  if [[ "$PKG" != cdk ]]; then FILES=(); while IFS= read -r f; do FILES+=("$f"); done < <(git ls-files -- 'src/*.ts' 'src/*.tsx' | grep -vE '\.(test|spec)\.tsx?$|\.d\.ts$'); fi
  while IFS= read -r f; do EXCLUDE+=("$f"); done < <(git grep -l 'readFileSync' -- '*.test.ts' '*.test.tsx' ':!frontend/' ':!lambda/' 2>/dev/null || true)
fi
# One incremental file and one report per target set, so two scopes in one worktree never clobber each other.
SLUG="$(printf '%s' "${MUTATE_ARG:-all}" | shasum | cut -c1-12)"
mkdir -p .cache/stryker
REPORT=".cache/stryker/report-$SLUG.json"
BACKUP="$(mktemp -d "${TMPDIR:-/tmp}/mutate-ts.XXXXXX")"
for f in ${FILES[@]+"${FILES[@]}"}; do mkdir -p "$BACKUP/$(dirname "$f")"; cp -p "$f" "$BACKUP/$f"; done
restore() {
  for f in ${FILES[@]+"${FILES[@]}"}; do
    if ! cmp -s "$f" "$BACKUP/$f" && grep -q 'stryMutAct_9fa48\|__stryker__' "$f"; then
      cp -p "$BACKUP/$f" "$f"; echo "restored $f (the run left it instrumented)" >&2
    fi
  done
  rm -rf "$BACKUP" .stryker-tmp
  rm -f stryker-setup-*.js   # the vitest runner's per-worker setup files, left behind by a killed run
}
trap restore EXIT

rm -f "$REPORT"
echo "==> Stryker ($PKG): ${MUTATE_ARG:-every file}  [concurrency ${STRYKER_CONCURRENCY:-2}]"
started=$SECONDS
SCOPE=(); [[ -n "$MUTATE_ARG" ]] && SCOPE=(--mutate "$MUTATE_ARG")
if [[ ${#EXCLUDE[@]} -gt 0 ]]; then
  # A vitest config of this run only: the package's own, minus the excluded specs.
  node -e '
    const [dir, ...specs] = process.argv.slice(1);
    const list = JSON.stringify(specs);
    require("fs").writeFileSync(`${dir}/.cache/stryker/vitest.config.mts`, [
      "import { configDefaults, mergeConfig } from \"vitest/config\";",
      `import base from \"${dir}/vitest.config.ts\";`,
      `export default mergeConfig(base, { root: \"${dir}\", test: { exclude: [...(base.test?.exclude ?? configDefaults.exclude), ...${list}] } });`,
    ].join("\n") + "\n");' "$PWD" ${EXCLUDE[@]+"${EXCLUDE[@]}"}
  export STRYKER_VITEST_CONFIG=.cache/stryker/vitest.config.mts
  echo "    leaving out ${#EXCLUDE[@]} spec(s): ${EXCLUDE[*]}"
fi
if [[ ${#FILES[@]} -eq 1 ]]; then NOCHECK="${FILES[0]}"; else NOCHECK="{$(IFS=,; echo "${FILES[*]}")}"; fi
STRYKER_TYPECHECK_OFF="$NOCHECK" STRYKER_PER_FILE=1 STRYKER_JSON_REPORT="$REPORT" STRYKER_INCREMENTAL_FILE=".cache/stryker/incremental-$SLUG.json" \
  npx stryker run ${SCOPE[@]+"${SCOPE[@]}"} ${FORCE[@]+"${FORCE[@]}"} > ".cache/stryker/run-$SLUG.log" 2>&1 || true
echo "==> Done in $((SECONDS - started)) s (log: $PKG_DIR/.cache/stryker/run-$SLUG.log)"
if [[ ! -f "$REPORT" ]]; then
  echo "Stryker wrote no report — the unmutated tests probably fail. Log tail:" >&2
  tail -n 40 ".cache/stryker/run-$SLUG.log" >&2
  exit 2
fi
echo "==> Report: $PKG_DIR/$REPORT"
node "$CDK_ROOT/scripts/stryker-survivors.mjs" "$REPORT"
