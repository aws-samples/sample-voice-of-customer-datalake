#!/usr/bin/env bash
# Runs one command by hand the way scripts/validate.sh runs its steps on a shared big machine (CONTRIBUTING.md, "On a
# big machine"):
#
#   bash scripts/pinned.sh <command> [args…]       (from any folder: run it where the command itself would run)
#   e.g. cd voc-datalake && bash ../scripts/pinned.sh pytest -q lambda/api/test/test_x.py -n 8
#        cd voc-datalake/frontend && bash ../../scripts/pinned.sh npx vitest run src/x.test.ts
#        cd voc-datalake && bash ../scripts/pinned.sh npx eslint lib/x.ts --concurrency 8
#
# - Pinned: on a machine of more than one NUMA node it runs under `taskset -c <node 0's cpulist>`, exactly when
#   validate.sh would pin itself (scripts/lib/pin.sh: not when already pinned, in CI, or without a taskset that
#   accepts node 0's CPUs); otherwise the command runs as it is. Either way it is exec'd: its exit code is this one's.
# - Capped: PYTEST_XDIST_AUTO_NUM_WORKERS (pytest's `-n auto` / `-n logical` means at most that many workers) is
#   exported as 32, VALIDATE_ESLINT_CONCURRENCY as 8 and CODEQL_THREADS as 16 (scripts/codeql.sh alone would take every
#   CPU it may use); a caller's own value is kept when it is a whole number from 1 to that cap, anything else is
#   replaced by the cap (named on stderr). A pytest command's `-n N` / `-nN` / `--numprocesses N|=N` above 32 is
#   lowered to 32, an eslint command's `--concurrency N|=N` above 8, or `auto`, to 8; each change is named on stderr.
#   pytest is told by the command as given: `pytest …`, or `python`, `python3` or an interpreter's path then `-m pytest`.
# - Python: a command whose first word is `python`, `python3` or `pytest` (`pytest` runs as `<python> -m pytest`)
#   uses PYTHON_BIN (a bare name is looked up on PATH), else the tree's voc-datalake/.venv, else the main checkout's
#   (a git worktree without a venv), else python3. Only an interpreter given by an absolute path inside a `.venv/bin`
#   folder puts that folder first on PATH (ruff, vulture, pyright from the same venv); a bare name or the system
#   python3 leaves PATH as it is. stderr names the interpreter when it is not the tree's own.
#
# Test hooks (as validate.sh's): VALIDATE_NUMA_ROOT (the /sys/devices/system/node stand-in), VALIDATE_NPROC_ALL.
# bash 3.2 compatible, like validate.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/pin.sh
. "$ROOT/scripts/lib/pin.sh"

if [[ $# -eq 0 ]]; then
  printf 'usage: bash scripts/pinned.sh <command> [args…]\n' >&2
  exit 2
fi

PYTEST_CAP=32
ESLINT_CAP=8
CODEQL_CAP=16

note() { printf 'pinned: %s\n' "$*" >&2; }

# cap_env <name> <cap>: exports <name> as the caller's value when it is a whole number from 1 to <cap>, else as <cap>
# (a value that was set and is replaced is named on stderr). scripts/codeql.sh's default (0) is every CPU it may use:
# validate.sh caps it at 16 threads a language, and so does this.
cap_env() {
  local name="$1" cap="$2" v
  v="${!name:-}"
  if [[ "$v" =~ ^[0-9]+$ ]] && (( 10#$v >= 1 && 10#$v <= cap )); then v=$(( 10#$v ))
  else
    [[ -z "$v" ]] || note "$name=$v replaced by $cap"
    v="$cap"
  fi
  export "$name=$v"
}
cap_env PYTEST_XDIST_AUTO_NUM_WORKERS "$PYTEST_CAP"
cap_env VALIDATE_ESLINT_CONCURRENCY "$ESLINT_CAP"
cap_env CODEQL_THREADS "$CODEQL_CAP"

# Which tool the command is, told by the command as given (before a bare python / pytest becomes the interpreter
# chosen below, whose file name may be anything: PYTHON_BIN=…/pypy3): pytest (`pytest …`, `python|python3|<an
# interpreter's path> -m pytest …`) or eslint (`eslint …`, a path to it, or `npx|pnpm|yarn [opts] eslint …`). Other
# commands keep every argument as given (`head -n 96` is not pytest's).
ARGS=("$@")
KIND=""
first="$(basename -- "${ARGS[0]}")"
case "$first" in
  pytest|py.test) KIND=pytest ;;
  eslint) KIND=eslint ;;
  python|python[0-9]*|pypy|pypy[0-9]*)
    [[ "${#ARGS[@]}" -ge 3 && "${ARGS[1]}" == -m && ( "${ARGS[2]}" == pytest || "${ARGS[2]}" == py.test ) ]] && KIND=pytest ;;
  npx|pnpm|yarn)
    for a in "${ARGS[@]:1}"; do [[ "$a" == eslint || "$a" == */eslint ]] && { KIND=eslint; break; }; done ;;
esac

# Python: the interpreter for a bare python / python3 / pytest.
case "${ARGS[0]}" in
  python|python3|pytest)
    if [[ -n "${PYTHON_BIN:-}" ]]; then PY="$PYTHON_BIN"
    else PY="$(pin_python_bin "$ROOT" pinned)" || { note "no Python found (no voc-datalake/.venv, no python3)"; exit 127; }
    fi
    if [[ "$PY" != */* ]]; then
      PY="$(command -v -- "$PY")" || { note "PYTHON_BIN=$PYTHON_BIN is not on PATH"; exit 127; }
    fi
    # Only a venv's own folder goes first on PATH (its ruff, vulture, pyright): never `.` (a bare name's dirname) or
    # /usr/bin (the python3 fallback), which would shadow the caller's own PATH.
    PYDIR="$(dirname "$PY")"
    case "$PYDIR" in
      /*/.venv/bin) PATH="$PYDIR:$PATH"; export PATH ;;
    esac
    if [[ "${ARGS[0]}" == pytest ]]; then ARGS=("$PY" -m pytest "${ARGS[@]:1}"); else ARGS[0]="$PY"; fi
    ;;
esac

# over <value> <cap>: the value is a number above the cap.
over() { [[ "$1" =~ ^[0-9]+$ ]] && (( 10#$1 > $2 )); }

if [[ -n "$KIND" ]]; then
  OUT=(); i=0; n=${#ARGS[@]}
  while (( i < n )); do
    a="${ARGS[$i]}"
    if [[ "$a" == -- ]]; then OUT+=("${ARGS[@]:$i}"); break; fi
    if [[ "$KIND" == pytest ]]; then
      case "$a" in
        -n|--numprocesses)
          if (( i + 1 < n )) && over "${ARGS[$((i + 1))]}" "$PYTEST_CAP"; then
            note "pytest $a ${ARGS[$((i + 1))]} lowered to $PYTEST_CAP"; OUT+=("$a" "$PYTEST_CAP"); i=$(( i + 2 )); continue
          fi ;;
        --numprocesses=*)
          if over "${a#--numprocesses=}" "$PYTEST_CAP"; then note "pytest $a lowered to $PYTEST_CAP"; a="--numprocesses=$PYTEST_CAP"; fi ;;
        -n[0-9]*)
          if over "${a#-n}" "$PYTEST_CAP"; then note "pytest $a lowered to $PYTEST_CAP"; a="-n$PYTEST_CAP"; fi ;;
      esac
    else
      case "$a" in
        --concurrency)
          if (( i + 1 < n )); then
            v="${ARGS[$((i + 1))]}"
            if [[ "$v" == auto ]] || over "$v" "$ESLINT_CAP"; then
              note "eslint --concurrency $v lowered to $ESLINT_CAP"; OUT+=("$a" "$ESLINT_CAP"); i=$(( i + 2 )); continue
            fi
          fi ;;
        --concurrency=*)
          v="${a#--concurrency=}"
          if [[ "$v" == auto ]] || over "$v" "$ESLINT_CAP"; then note "eslint $a lowered to $ESLINT_CAP"; a="--concurrency=$ESLINT_CAP"; fi ;;
      esac
    fi
    OUT+=("$a"); i=$(( i + 1 ))
  done
  ARGS=("${OUT[@]}")
fi

if NODE0_CPUS="$(pin_node0_cpus)"; then
  export VALIDATE_PINNED=1
  exec taskset -c "$NODE0_CPUS" "${ARGS[@]}"
fi
exec "${ARGS[@]}"
