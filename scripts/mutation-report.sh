#!/usr/bin/env bash
# The mutation report of a change: every module it touched, mutated against its own tests, only the
# lines it added or changed (a module whose test alone changed is mutated whole: a test change is the
# moment to ask what else the tests miss). A report you act on before merging/releasing, not a gate.
#
#   scripts/mutation-report.sh <base-ref>            # e.g. origin/development, or the last release tag
#   scripts/mutation-report.sh <base-ref> --whole    # every changed module whole
#
# Every survivor gets one outcome before merge: a test that kills it, deleting the statement it
# proves has no effect, or an equivalence marker with its reason (`# pragma: no mutate`, or
# `// Stryker disable next-line <mutator>: <reason>`).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
BASE="${1:?usage: $0 <base-ref> [--whole]}"
WHOLE="${2:-}"
PY_ROOT="voc-datalake"   # pytest, mutmut and scripts/mutate-python.sh all run from here

own_lines_changed() { [[ "$WHOLE" != "--whole" ]] && ! git diff --quiet "$BASE" -- "$1"; }

# ---- Python: module -> its namesake test (test_<stem>.py anywhere under $PY_ROOT) ----
py_changed() {
  git diff --name-only "$BASE" -- "$PY_ROOT/*.py" | grep -v "^$PY_ROOT/lambda/layers/" | while IFS= read -r f; do
    base="$(basename "$f")"
    case "$base" in
      conftest.py|__init__.py) ;;
      test_*.py) stem="${base#test_}"; git ls-files "$PY_ROOT/*/$stem" | grep -v '/test/' | head -1 ;;
      *) case "$f" in */test/*) ;; *) [[ -f "$f" ]] && echo "$f" ;; esac ;;
    esac
  done | sort -u
}
while IFS= read -r module <&3; do
  stem="$(basename "$module" .py)"
  tests="$(git ls-files "$PY_ROOT/*test_${stem//-/_}.py" | sed "s|^$PY_ROOT/||" | tr '\n' ' ')"
  if [[ -z "$tests" ]]; then echo "--- $module: NO TESTS (a finding)"; continue; fi
  scope=()
  own_lines_changed "$module" && scope=(--patch "$BASE")
  echo "--- $module (${scope[*]:-whole}) against: $tests"
  # shellcheck disable=SC2086
  bash "$PY_ROOT/scripts/mutate-python.sh" ${scope[@]+"${scope[@]}"} "${module#"$PY_ROOT"/}" $tests \
    || echo "    (tests fail unmutated, or no changed lines)"
done 3< <(py_changed)   # fd 3: mutmut and stryker read stdin and would eat the list

# ---- TypeScript: file -> its spec beside it; Stryker line ranges per changed hunk ----
# Each package holds its own stryker.config.mjs. The CDK package's directory contains the other two,
# so its file list leaves them out.
ts_changed() {
  local pkg="$1"
  git diff --name-only "$BASE" -- "$pkg" | grep -E '\.tsx?$' | grep -vE '\.d\.ts$|-fixtures\.|/test/|/test-support/|/__fixtures__/' \
    | { if [[ "$pkg" == "voc-datalake" ]]; then grep -vE '^voc-datalake/(frontend|lambda)/' || true; else cat; fi; } \
    | while IFS= read -r f; do
        case "$f" in
          *.spec.ts|*.spec.tsx|*.test.ts|*.test.tsx) m="$(sed -E 's/\.(spec|test)\.(tsx?)$/.\2/' <<<"$f")"; [[ -f "$m" ]] && echo "$m" ;;
          *) [[ -f "$f" ]] && echo "$f" ;;
        esac
      done | sort -u
}
for pkg in voc-datalake voc-datalake/frontend voc-datalake/lambda/stream; do
  while IFS= read -r file <&3; do
    ext="${file##*.}"; spec_a="${file%.*}.spec.$ext"; spec_b="${file%.*}.test.$ext"
    if [[ ! -f "$spec_a" && ! -f "$spec_b" ]]; then echo "--- $file: NO SPEC (a finding)"; continue; fi
    relative="${file#"$pkg"/}"
    target="$relative"
    if own_lines_changed "$file"; then
      target="$(git diff --unified=0 "$BASE" -- "$file" \
        | sed -nE 's/^@@ -[0-9,]+ \+([0-9]+)(,([0-9]+))? @@.*/\1 \3/p' \
        | awk -v f="$relative" '{ n = ($2 == "" ? 1 : $2); if (n > 0) printf "%s%s:%d-%d", (c++ ? "," : ""), f, $1, $1 + n - 1 }')"
    fi
    if [[ -z "$target" ]]; then echo "--- $file: only deletions"; continue; fi
    echo "--- $file ($target)"
    (cd "$pkg" && npx stryker run --mutate "$target") | grep -E '^\[Survived\]|^[-+] |^ *[A-Za-z].*\|' || true
  done 3< <(ts_changed "$pkg")
done
