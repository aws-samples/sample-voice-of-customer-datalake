#!/usr/bin/env bash
# Mutation testing for one Python module (mutmut 3.x). Not a gate: a per-module tool, run on what a change touches.
#
#   scripts/mutate-python.sh [--patch <git-range> | --lines <from>-<to>] <module.py> <test file or dir> [more tests...]
#   scripts/mutate-python.sh --patch origin/development lambda/shared/api.py lambda/shared/test/test_api.py
#   scripts/mutate-python.sh --lines 1-400 lambda/api/projects.py lambda/api/test/test_projects.py
#   scripts/mutate-python.sh show <mutant name> | results | browse      # the last run, after it finished
#
# Paths are relative to voc-datalake/. --patch mutates only the lines the range added or changed in the
# module (`git diff <range>`; a single ref compares it with the working tree). --lines mutates only that
# line range (inclusive), so a large module can be worked in slices whose runs stay short. A mutant the
# tests kill is behaviour they pin. A survivor is either a statement no test observes (strengthen the
# test) or a statement with no effect (delete it); an equivalent mutant is the one case to leave,
# marked `# pragma: no mutate` with the reason.
#
# mutmut 3 never edits the source tree. It mutates a copy in `mutants/` below its working directory and
# names each mutant after the module's IMPORT name (`shared.llm_json.x_first_json_object__mutmut_1`), so
# the run happens in a stage, .cache/mutmut/ (gitignored, rebuilt by every run): `src/` is a copy of
# voc-datalake's Python tree (lambda/ and plugins/ as git lists them, untracked files included, and the
# top-level files; every other entry is a symlink to the real one), and `mutants` points at the copy of
# the directory the tests import the module from (lambda/ for `shared.*`, lambda/api/ for a handler, ...).
# mutmut 3 mutates only function and method bodies, and skips decorated functions (except
# @staticmethod/@classmethod): module-level code and e.g. `@app.get` routes get no mutants.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
PYTHON="${PYTHON_BIN:-python}"
DRIVER="$ROOT/scripts/mutmut_run.py"
STAGE="$ROOT/.cache/mutmut"

case "${1:-}" in
  show|results|browse)
    if [[ ! -d "$STAGE/mutants" ]]; then echo "No mutation run to read: run the script on a module first" >&2; exit 2; fi
    cd "$STAGE" && exec "$PYTHON" "$DRIVER" "$@" ;;
esac

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
  sed -n '4,7p' "$0" >&2
  exit 2
fi
MODULE="$1"; shift
TESTS=("$@")

# ---- The lines to mutate (empty = the whole module), as <from>-<to>[,<from>-<to>...] ----
ONLY_LINES=""
if [[ -n "$PATCH_RANGE" ]]; then
  # Every hunk's new-side span; a pure deletion (`+n,0`) adds no line.
  ONLY_LINES="$(git diff --unified=0 --no-ext-diff "$PATCH_RANGE" -- "$MODULE" \
    | sed -nE 's/^@@ -[0-9,]+ \+([0-9]+)(,([0-9]+))? @@.*/\1 \3/p' \
    | awk '{ n = ($2 == "" ? 1 : $2); if (n > 0) printf "%s%d-%d", (c++ ? "," : ""), $1, $1 + n - 1 }')"
  if [[ -z "$ONLY_LINES" ]]; then
    echo "No lines of $MODULE changed in $PATCH_RANGE: nothing to mutate (drop --patch for the whole module)" >&2
    exit 2
  fi
elif [[ -n "$LINE_RANGE" ]]; then
  if [[ ! "$LINE_RANGE" =~ ^[0-9]+-[0-9]+$ ]]; then
    echo "--lines wants <from>-<to>, got '$LINE_RANGE'" >&2
    exit 2
  fi
  ONLY_LINES="$LINE_RANGE"
fi

echo "==> Baseline: the tests must pass unmutated"
NAMES_FILE="$(mktemp "${TMPDIR:-/tmp}/mutmut-names.XXXXXX")"
trap 'rm -f "$NAMES_FILE"' EXIT
"$PYTHON" "$DRIVER" baseline "$NAMES_FILE" "$MODULE" "${TESTS[@]}"

# ---- The import root: the directory below which the module's path spells its import name ----
NAME="$(head -1 "$NAMES_FILE")"
if [[ -z "$NAME" ]]; then
  echo "The tests never import $MODULE: give the tests that exercise it" >&2
  exit 2
fi
if [[ "$(wc -l < "$NAMES_FILE")" -gt 1 ]]; then
  echo "    note: the tests import $MODULE under several names ($(tr '\n' ' ' < "$NAMES_FILE")); mutating '$NAME'," \
    "so a test that reaches it only through another name cannot kill a mutant"
fi
DOTTED_PATH="${MODULE%.py}"; DOTTED_PATH="${DOTTED_PATH%/__init__}"
NAME_PATH="${NAME//.//}"
if [[ "$DOTTED_PATH" != "$NAME_PATH" && "$DOTTED_PATH" != */"$NAME_PATH" ]]; then
  echo "$MODULE is imported as '$NAME', which its path does not end in: mutmut 3 cannot link its tests" >&2
  exit 2
fi
IMPORT_ROOT="${DOTTED_PATH%"$NAME_PATH"}"; IMPORT_ROOT="${IMPORT_ROOT%/}"
SOURCE_PATH="${MODULE#"$IMPORT_ROOT"/}"   # the module's path below the import root = mutmut's source path
UP=""                                      # from the import root back to voc-datalake/
if [[ -n "$IMPORT_ROOT" ]]; then UP="$(sed -E 's|[^/]+|..|g' <<<"$IMPORT_ROOT")/"; fi

# ---- The stage ----
if [[ "$STAGE" != */.cache/mutmut ]]; then echo "Unexpected stage path $STAGE" >&2; exit 2; fi
rm -rf -- "$STAGE"
mkdir -p "$STAGE/src"
# Copies keep their mtime: mutmut mutates a copy only while it is not newer than its source.
git ls-files -z --cached --others --exclude-standard -- lambda plugins ':(glob)*' \
  ':(exclude)lambda/stream' ':(exclude)lambda/layers' \
  | while IFS= read -r -d '' file; do [[ -f "$file" ]] && printf '%s\0' "$file"; done \
  | tar -c --null -T - -f - | tar -x -p -f - -C "$STAGE/src"
for entry in "$ROOT"/* "$ROOT"/.[!.]*; do
  name="$(basename "$entry")"
  [[ -e "$entry" && ! -e "$STAGE/src/$name" && "$name" != .cache ]] && ln -s "$entry" "$STAGE/src/$name"
done
for entry in lambda/stream lambda/layers; do [[ -e "$entry" ]] && ln -s "$ROOT/$entry" "$STAGE/src/$entry"; done
ln -s "src/${IMPORT_ROOT:-.}" "$STAGE/mutants"
# mutmut reads the source from <stage>/<source path>: the real module, through a symlink.
ln -s "$ROOT/${IMPORT_ROOT:+$IMPORT_ROOT/}${SOURCE_PATH%%/*}" "$STAGE/${SOURCE_PATH%%/*}"

toml_list() { local sep="" item; printf '['; for item in "$@"; do printf "%s'%s'" "$sep" "$item"; sep=", "; done; printf ']'; }
SELECTION=()
for test in "${TESTS[@]}"; do
  if [[ -n "$IMPORT_ROOT" && "$test" == "$IMPORT_ROOT"/* ]]; then SELECTION+=("${test#"$IMPORT_ROOT"/}"); else SELECTION+=("$UP$test"); fi
done
# The per-mutant timeout: wall clock = (the mutant's tests' baseline + timeout_constant) × timeout_multiplier,
# CPU = twice that; a timed-out mutant counts as killed.
RUNNER_TIMEOUT="${MUTMUT_RUNNER_TIMEOUT:-120}"
{
  echo "# Written by scripts/mutate-python.sh for this run only."
  echo "[tool.mutmut]"
  echo "source_paths = $(toml_list "$SOURCE_PATH")"
  echo "pytest_add_cli_args = $(toml_list -o addopts= -p no:cacheprovider)"
  echo "pytest_add_cli_args_test_selection = $(toml_list "${SELECTION[@]}")"
  echo "timeout_multiplier = 1.0"
  echo "timeout_constant = $RUNNER_TIMEOUT.0"
  echo "use_git_change_detection = false"
} > "$STAGE/pyproject.toml"

echo "==> Mutating ${PATCH_RANGE:+the lines changed in $PATCH_RANGE of }${LINE_RANGE:+lines $LINE_RANGE of }$MODULE (as $NAME)"
LINE_ARGS=()
if [[ -n "$ONLY_LINES" ]]; then LINE_ARGS=(--only-lines "$SOURCE_PATH:$ONLY_LINES"); fi
# One mutant at a time by default: several mutation runs usually share the machine.
(cd "$STAGE" && "$PYTHON" "$DRIVER" ${LINE_ARGS[@]+"${LINE_ARGS[@]}"} run --max-children "${MUTMUT_MAX_CHILDREN:-1}") \
  || true   # mutmut exits non-zero when it cannot start; the results below say what happened

echo "==> Results (scripts/mutate-python.sh show <name> prints a survivor's diff; \"no tests\" = no test calls it, a survivor)"
RESULTS="$(cd "$STAGE" && "$PYTHON" "$DRIVER" results --all true)"
grep -v ': killed$' <<<"$RESULTS" || true
SUMMARY="$(sed -nE 's/^ +[^ ]+: (.+)$/\1/p' <<<"$RESULTS" | sort | uniq -c | awk '{ n = $1; $1 = ""; printf "%s%s%s", (c++ ? ", " : ""), substr($0, 2) " ", n }')"
echo "==> $MODULE: $(grep -c ': ' <<<"$RESULTS" || true) mutants: ${SUMMARY:-none}"
