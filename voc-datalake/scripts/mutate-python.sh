#!/usr/bin/env bash
# Mutation testing for one Python module (mutmut 2.x). Not a gate: a per-module tool, run on what a change touches.
#
#   scripts/mutate-python.sh [--patch <git-range>] <module.py> <test file or dir> [more tests...]
#   scripts/mutate-python.sh --patch origin/development lambda/shared/api.py lambda/shared/test/test_api.py
#
# Paths are relative to voc-datalake/. --patch mutates only the lines the range added or changed in the
# module (`git diff <range>`; a single ref compares it with the working tree). A mutant the tests kill is
# behaviour they pin. A survivor is either a statement no test observes (strengthen the test) or a
# statement with no effect (delete it); an equivalent mutant is the one case to leave, marked
# `# pragma: no mutate` with the reason.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PATCH_RANGE=""
if [[ "${1:-}" == "--patch" ]]; then
  PATCH_RANGE="${2:-}"
  shift 2 || true
fi
if [[ $# -lt 2 || "$PATCH_RANGE" == -* ]]; then
  sed -n '4,5p' "$0" >&2
  exit 2
fi
MODULE="$1"; shift
TESTS=("$@")
PYTHON="${PYTHON_BIN:-python}"

rm -f .mutmut-cache   # a clean cache per run: another module's entries only confuse `mutmut results`

PATCH_ARGS=()
if [[ -n "$PATCH_RANGE" ]]; then
  PATCH_FILE="$(mktemp "${TMPDIR:-/tmp}/mutmut-patch.XXXXXX")"
  trap 'rm -f "$PATCH_FILE"' EXIT
  git diff --unified=0 --no-ext-diff "$PATCH_RANGE" -- "$MODULE" > "$PATCH_FILE"
  if [[ ! -s "$PATCH_FILE" ]]; then
    echo "No lines of $MODULE changed in $PATCH_RANGE: nothing to mutate (drop --patch for the whole module)" >&2
    exit 2
  fi
  PATCH_ARGS=(--use-patch-file "$PATCH_FILE")
fi

# pytest.ini's addopts turn on coverage for the whole suite; a mutation run needs none of it.
PYTEST_OPTS='-o addopts= -q -p no:cacheprovider'

echo "==> Baseline: the tests must pass unmutated"
# shellcheck disable=SC2086
"$PYTHON" -m pytest $PYTEST_OPTS "${TESTS[@]}"

echo "==> Mutating ${PATCH_RANGE:+the lines changed in $PATCH_RANGE of }$MODULE"
# mutmut 2 counts only exit 1 as "killed"; pytest exits 2 when a mutant breaks the import (a collection
# error), which would count as survived, hence `|| exit 1`. -x: one failing test is enough.
mutmut run \
  --paths-to-mutate "$MODULE" \
  --tests-dir "$(dirname "${TESTS[0]}")" \
  --runner "sh -c '$PYTHON -m pytest -x $PYTEST_OPTS ${TESTS[*]} || exit 1'" \
  ${PATCH_ARGS[@]+"${PATCH_ARGS[@]}"} \
  --no-progress || true   # mutmut exits non-zero when mutants survive; the results below are the point

# An interrupted run can leave a mutant in the file; mutmut keeps the original in <module>.bak.
if [[ -f "$MODULE.bak" ]]; then mv -f "$MODULE.bak" "$MODULE"; fi

echo "==> Results (mutmut show <id> prints a survivor's diff)"
mutmut results || true
