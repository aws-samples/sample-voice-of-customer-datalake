#!/usr/bin/env bash
# Mutation testing for one Python module (mutmut 2.x). Not a gate: a per-module tool, run on what a change touches.
#
#   scripts/mutate-python.sh [--patch <git-range> | --lines <from>-<to>] <module.py> <test file or dir> [more tests...]
#   scripts/mutate-python.sh --patch origin/development lambda/shared/api.py lambda/shared/test/test_api.py
#   scripts/mutate-python.sh --lines 1-400 lambda/api/projects.py lambda/api/test/test_projects.py
#
# Paths are relative to voc-datalake/. --patch mutates only the lines the range added or changed in the
# module (`git diff <range>`; a single ref compares it with the working tree). --lines mutates only that
# line range (inclusive), so a large module can be worked in slices whose runs stay short. A mutant the
# tests kill is behaviour they pin. A survivor is either a statement no test observes (strengthen the
# test) or a statement with no effect (delete it); an equivalent mutant is the one case to leave,
# marked `# pragma: no mutate` with the reason.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PATCH_RANGE=""
LINE_RANGE=""
if [[ "${1:-}" == "--patch" ]]; then
  PATCH_RANGE="${2:-}"
  shift 2 || true
elif [[ "${1:-}" == "--lines" ]]; then
  LINE_RANGE="${2:-}"
  shift 2 || true
fi
if [[ $# -lt 2 || "$PATCH_RANGE" == -* || "$LINE_RANGE" == -* ]]; then
  sed -n '4,6p' "$0" >&2
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
elif [[ -n "$LINE_RANGE" ]]; then
  # mutmut 2 has no line filter of its own, but it does read the ADDED lines of a unified diff; a
  # synthetic diff that "adds" the chosen range is that filter.
  if [[ ! "$LINE_RANGE" =~ ^[0-9]+-[0-9]+$ ]]; then
    echo "--lines wants <from>-<to>, got '$LINE_RANGE'" >&2
    exit 2
  fi
  FROM="${LINE_RANGE%-*}"; TO="${LINE_RANGE#*-}"
  PATCH_FILE="$(mktemp "${TMPDIR:-/tmp}/mutmut-lines.XXXXXX")"
  trap 'rm -f "$PATCH_FILE"' EXIT
  {
    printf -- '--- a/%s\n+++ b/%s\n' "$MODULE" "$MODULE"
    printf -- '@@ -0,0 +%s,%s @@\n' "$FROM" "$((TO - FROM + 1))"
    sed -n "${FROM},${TO}p" "$MODULE" | sed 's/^/+/'
  } > "$PATCH_FILE"
  PATCH_ARGS=(--use-patch-file "$PATCH_FILE")
fi

# pytest.ini's addopts turn on coverage for the whole suite; a mutation run needs none of it.
PYTEST_OPTS='-o addopts= -q -p no:cacheprovider'
# mutmut's own timeout kills only the `sh -c` wrapper: on an infinite-loop mutant the orphaned pytest
# keeps the pipe open and the run hangs. The runner therefore sets its own alarm (seconds; a baseline
# of the module's tests takes a few seconds, so the default is generous) and exits 1 = killed.
RUNNER_TIMEOUT="${MUTMUT_RUNNER_TIMEOUT:-120}"

echo "==> Baseline: the tests must pass unmutated"
# shellcheck disable=SC2086
"$PYTHON" -m pytest $PYTEST_OPTS "${TESTS[@]}"

echo "==> Mutating ${PATCH_RANGE:+the lines changed in $PATCH_RANGE of }${LINE_RANGE:+lines $LINE_RANGE of }$MODULE"
# mutmut 2 counts only exit 1 as "killed"; pytest exits 2 when a mutant breaks the import (a collection
# error) and the perl parent maps any non-zero child status — or a timeout — to exit 1. The child is
# pytest itself (no shell in between). The alarm is armed in BOTH processes: a pending alarm survives
# exec, so when mutmut's own (shorter) timeout SIGKILLs the perl parent first, the orphaned pytest still
# dies after RUNNER_TIMEOUT instead of looping forever. -x: one failing test is enough.
mutmut run \
  --paths-to-mutate "$MODULE" \
  --tests-dir "$(dirname "${TESTS[0]}")" \
  --runner "perl -e 'my \$t = shift; my \$pid = fork; unless (\$pid) { alarm \$t; exec @ARGV } \$SIG{ALRM} = sub { kill KILL => \$pid; exit 1 }; alarm \$t; waitpid \$pid, 0; exit(\$? ? 1 : 0)' $RUNNER_TIMEOUT $PYTHON -m pytest -x $PYTEST_OPTS ${TESTS[*]}" \
  ${PATCH_ARGS[@]+"${PATCH_ARGS[@]}"} \
  --no-progress || true   # mutmut exits non-zero when mutants survive; the results below are the point

# An interrupted run can leave a mutant in the file; mutmut keeps the original in <module>.bak.
if [[ -f "$MODULE.bak" ]]; then mv -f "$MODULE.bak" "$MODULE"; fi

echo "==> Results (mutmut show <id> prints a survivor's diff)"
mutmut results || true
