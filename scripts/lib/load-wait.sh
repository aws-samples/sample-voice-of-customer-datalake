#!/usr/bin/env bash
# Waits before a heavy step starts while the machine is loaded (7.105.00): until the 5-minute load average (the second
# field of /proc/loadavg) is under <max>, checking every 30 s, after one line saying it waits and why; after
# <max-wait> minutes it starts anyway, with a warning.
#
#   bash scripts/lib/load-wait.sh <what> <max> <max-wait-minutes> [-- <command…>]
#   e.g. bash scripts/lib/load-wait.sh codeql "${VOC_CODEQL_MAX_LOAD:-}" "${VOC_CODEQL_MAX_WAIT:-60}" -- bash scripts/codeql.sh
#
# An empty <max> is 0.85 x the CPUs this run may use (`nproc`, after validate.sh pinned itself to node 0).
# No wait: in CI (GITHUB_ACTIONS), on a machine without /proc/loadavg (macOS), or when the file holds no number.
# Once it may start it execs the command after `--` (its exit code is this one's), else exits 0; 2 when an argument
# or setting is not a number.
# Test hooks: VALIDATE_LOADAVG_FILE (the /proc/loadavg stand-in), VALIDATE_LOAD_WAIT_SECONDS (the 30 s between checks),
# VALIDATE_CPUS (the CPU count, as validate.sh's).
# bash 3.2 compatible, like validate.sh.
set -euo pipefail
NUM='^[0-9]+([.][0-9]+)?$'
what="${1:?usage: load-wait.sh <what> <max> <max-wait-minutes>}"
max="${2-}"
max_wait="${3:?usage: load-wait.sh <what> <max> <max-wait-minutes>}"
every="${VALIDATE_LOAD_WAIT_SECONDS:-30}"
refuse() { printf 'load-wait: %s: %s\n' "$what" "$1" >&2; exit 2; }
HAS_CMD=0
if [[ $# -gt 3 ]]; then
  [[ "$4" == -- && $# -gt 4 ]] || refuse "after the three arguments comes -- <command…> (got ${4})"
  shift 4; HAS_CMD=1
fi
start() { if [[ "$HAS_CMD" -eq 1 ]]; then exec "$@"; fi; exit 0; }
[[ "$max_wait" =~ $NUM ]] || refuse "the longest wait must be a number of minutes (got $max_wait)"
[[ "$every" =~ $NUM ]] && awk -v s="$every" 'BEGIN { exit !(s > 0) }' || refuse "the interval must be a number of seconds over 0 (got $every)"
why=""
if [[ -z "$max" ]]; then
  cpus="${VALIDATE_CPUS:-$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
  [[ "$cpus" =~ ^[0-9]+$ ]] || refuse "the CPU count must be a whole number (got $cpus)"
  max="$(awk -v c="$cpus" 'BEGIN { printf "%.2f", 0.85 * c }')"
  why=" (0.85 x $cpus CPUs)"
fi
[[ "$max" =~ $NUM ]] || refuse "the load limit must be a number (got $max)"
[[ -z "${GITHUB_ACTIONS:-}" ]] || start "$@"
file="${VALIDATE_LOADAVG_FILE:-/proc/loadavg}"
[[ -r "$file" ]] || start "$@"
waited=0   # seconds, summed from the interval (no clock read): bounded by <max-wait>
while :; do
  load="$(awk '{ print $2; exit }' "$file" 2>/dev/null || true)"
  [[ "$load" =~ $NUM ]] || start "$@"
  if awk -v l="$load" -v m="$max" 'BEGIN { exit !(l < m) }'; then start "$@"; fi
  if [[ "$waited" == 0 ]]; then
    printf 'load-wait: %s waits: the 5-minute load average is %s, at or over %s%s; checking every %ss, at most %s min\n' \
      "$what" "$load" "$max" "$why" "$every" "$max_wait"
  fi
  if awk -v w="$waited" -v m="$max_wait" 'BEGIN { exit !(w >= m * 60) }'; then
    printf 'load-wait: WARNING: %s starts anyway after %s min: the 5-minute load average is still %s (limit %s)\n' \
      "$what" "$max_wait" "$load" "$max"
    start "$@"
  fi
  sleep "$every"
  waited="$(awk -v w="$waited" -v s="$every" 'BEGIN { print w + s }')"
done
