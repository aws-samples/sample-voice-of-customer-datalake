#!/usr/bin/env bash
# Runs one command holding a named lock, so one session at a time runs that suite on a shared machine:
#
#   bash scripts/suite-lock.sh <name> -- <command…>
#   e.g. bash scripts/suite-lock.sh voc-pytest -- bash scripts/pinned.sh python -m pytest -q <files>
#
# The lock is an flock on <folder>/<name>.lock (scripts/feature_gate/lock.py), freed when the command ends, however it
# ends. The folder is the user's own: $VOC_SUITE_LOCK_DIR, else $XDG_RUNTIME_DIR/voc-suite-locks, else
# /tmp/voc-suite-locks-<uid>; made 0700, and refused when it is a link, someone else's or writable by group or others.
# A waiter is told who holds it (pid, start time, the lock's name and the command's program, never its arguments) and
# waits. The exit code is the command's; 2 is a malformed command line or an unsafe folder. The system python3 runs it
# isolated (-I): standard library only, and Python 3.8 or newer (lock.py keeps to 3.8; scripts/feature_gate/test/
# test_lock.py checks it against 3.8's grammar).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! python3 -I -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
  printf 'suite-lock: needs Python 3.8 or newer as python3 (found: %s)\n' "$(python3 --version 2>&1 || echo none)" >&2
  exit 2
fi
exec python3 -I "$ROOT/scripts/feature_gate/lock.py" "$@"
