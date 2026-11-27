# Sourced by scripts/validate.sh and scripts/pinned.sh: one place for the NUMA pin and the Python lookup.
# bash 3.2 compatible (macOS /bin/bash), like validate.sh; defines functions only, runs nothing.

# pin_node0_cpus: prints node 0's cpulist and returns 0 when this process should re-run itself pinned to it, else
# returns 1 and prints nothing. Pinned only on a machine of several NUMA nodes: not when already pinned (VALIDATE_PINNED,
# or a caller's taskset that leaves fewer CPUs than the machine has), in CI (GITHUB_ACTIONS), or without taskset; and
# only when taskset accepts node 0's CPUs here (a cpuset that excludes them leaves the run as it is). nproc without
# OMP_* (GNU nproc reads them; --all does not). Test hooks: VALIDATE_NUMA_ROOT stands in for /sys/devices/system/node,
# VALIDATE_NPROC_ALL for `nproc --all`.
pin_node0_cpus() {
  local numa_root="${VALIDATE_NUMA_ROOT:-/sys/devices/system/node}" cpus
  if [[ -z "${VALIDATE_PINNED:-}" && -z "${GITHUB_ACTIONS:-}" && -d "$numa_root/node1" && -s "$numa_root/node0/cpulist" ]] \
     && command -v taskset >/dev/null 2>&1 && command -v nproc >/dev/null 2>&1 \
     && [[ "$(env -u OMP_NUM_THREADS -u OMP_THREAD_LIMIT nproc)" -eq "${VALIDATE_NPROC_ALL:-$(nproc --all)}" ]]; then
    cpus="$(tr -d '[:space:]' < "$numa_root/node0/cpulist")"
    if [[ -n "$cpus" ]] && taskset -c "$cpus" true >/dev/null 2>&1; then
      printf '%s' "$cpus"
      return 0
    fi
  fi
  return 1
}

# pin_python_bin <tree root> <label>: prints the Python to use when PYTHON_BIN is unset, in order: the tree's own
# voc-datalake/.venv; the main checkout's (a git worktree has no venv of its own: its common git dir's parent, when that
# is another folder, and only when the tree is its own git top level); python3 on PATH. Says on stderr (prefixed <label>) which one when it is not the tree's own.
# Returns 1 when there is none at all.
pin_python_bin() {
  local root="$1" label="$2" common main here top py
  if [[ -x "$root/voc-datalake/.venv/bin/python" ]]; then
    printf '%s\n' "$root/voc-datalake/.venv/bin/python"; return 0
  fi
  # Only a tree that is itself a git checkout (its own top level, not a folder inside another repository, whose venv
  # would be someone else's) looks for its main checkout.
  here="$(cd "$root" && pwd -P)"
  if command -v git >/dev/null 2>&1 \
     && top="$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" && [[ -n "$top" ]] \
     && top="$(cd "$top" 2>/dev/null && pwd -P)" && [[ "$top" == "$here" ]] \
     && common="$(git -C "$root" rev-parse --git-common-dir 2>/dev/null)" && [[ -n "$common" ]]; then
    [[ "$common" == /* ]] || common="$root/$common"
    # In the main checkout itself `main` is this tree, whose venv was found missing above: `main != here` only keeps
    # the "using the main checkout's" message from naming this tree's own venv, should it appear meanwhile.
    if main="$(cd "$common/.." 2>/dev/null && pwd -P)" && [[ "$main" != "$here" && -x "$main/voc-datalake/.venv/bin/python" ]]; then
      printf '%s: no voc-datalake/.venv in this tree; using the main checkout'"'"'s %s\n' "$label" "$main/voc-datalake/.venv/bin/python" >&2
      printf '%s\n' "$main/voc-datalake/.venv/bin/python"; return 0
    fi
  fi
  py="$(command -v python3)" || return 1
  printf '%s: no voc-datalake/.venv here or in the main checkout; using %s\n' "$label" "$py" >&2
  printf '%s\n' "$py"
}
