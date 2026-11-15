#!/usr/bin/env bash
# The rebuildable caches of scripts/validate.sh in RAM (VOC_VALIDATE_RAM; on by default with the pool,
# VOC_VALIDATE_JOBS, when /dev/shm exists). Called by validate.sh before a real run:
#
#   bash scripts/validate-ram.sh <repo root> <ram dir>   each cache below moves to <ram dir>/<tree>/ and its old path
#                                                        becomes a link there; prints <ram dir>/<tree> (and makes
#                                                        <ram dir>/t/, where validate.sh puts each run's TMPDIR)
#   bash scripts/validate-ram.sh <repo root> ''          RAM off: a link whose folder is gone becomes an empty folder;
#                                                        a link whose folder is there stays (and is named on stderr)
#
# Only what a run rebuilds lives there: CodeQL's databases and SARIF, the coverage outputs, the audit synth cache and
# tsc's build info. The step logs (what --failed reads) stay on disk. <tree> is the tree's folder name plus a checksum
# of its path, so two worktrees never share a cache. The first move copies the warm contents (cp -a) before the old
# folder is replaced by the link; a copy that fails (RAM full) leaves that cache on disk. After a reboot /dev/shm is
# empty: the folder is made again (a cold run, nothing breaks).
#
# /dev/shm is shared by every user of the machine, so a folder there is used only when this user made it: <ram dir>
# must be an absolute path, and it, <tree> and each cache's folder must be real folders (not links) owned by this
# user and closed to others (made with umask 077; group or world access = refused). Anything else: the caches stay
# on disk, with a warning. Its tests: scripts/validate-ram.test.mjs. bash 3.2 compatible (macOS /bin/bash).
#
# A run's own TMPDIR (validate.sh, after the call above printed a tree):
#   bash scripts/validate-ram.sh --run-tmp <ram dir> <pid>   removes <ram dir>/t/<n> of every run n no longer alive
#                                                            (a run killed outright never ran its EXIT trap), makes
#                                                            and prints <ram dir>/t/<pid>
#   bash scripts/validate-ram.sh --remove <dir>              removes a run's TMPDIR, read-only folders in it too
# Only numbered real folders in the private <ram dir>/t/ are ever removed; a link is never followed.
set -euo pipefail
umask 077

warn() { printf 'validate-ram: %s\n' "$*" >&2; }
private_dir() {  # path -> 0 when it is a real folder of this user's that no one else can open
  [[ -d "$1" && ! -L "$1" && -O "$1" ]] || return 1
  [[ "$(ls -ld "$1" | cut -c5-10)" == "------" ]]   # drwx------: no group or other bits (GNU and BSD ls alike)
}
# Some tests leave read-only folders in their tmp_path (a plain rm -rf cannot empty those): write access back first.
remove_tree() { [[ -L "$1" ]] && return 0; chmod -R u+w "$1" 2>/dev/null || true; rm -rf "$1" 2>/dev/null || true; }

case "${1:-}" in
  --run-tmp)
    runs="${2:?--run-tmp <ram dir> <pid>}/t"; pid="${3:?--run-tmp <ram dir> <pid>}"
    private_dir "$runs" || { warn "$runs is not a folder only this user can open"; exit 1; }
    for d in "$runs"/*; do
      [[ -d "$d" && ! -L "$d" && "${d##*/}" =~ ^[0-9]+$ ]] || continue
      kill -0 "${d##*/}" 2>/dev/null || remove_tree "$d"
    done
    mkdir -p "$runs/$pid"; printf '%s\n' "$runs/$pid"; exit 0 ;;
  --remove)
    remove_tree "${2:?--remove <dir>}"; exit 0 ;;
esac

root="${1:?usage: validate-ram.sh <repo root> <ram dir or empty>}"
ram="${2:-}"
DIRS=".cache/codeql .cache/coverage .cache/audit .cache/validate/tsc"

tree=""
if [[ -n "$ram" ]]; then
  if [[ "$ram" != /* ]]; then
    warn "VOC_VALIDATE_RAM must be an absolute path (got $ram); the caches stay on disk"
  else
    tree="$ram/$(basename "$root")-$(printf '%s' "$root" | cksum | awk '{ print $1 }')"
    mkdir -p "$ram" 2>/dev/null || true
    if private_dir "$ram"; then mkdir -p "$tree" "$ram/t" 2>/dev/null || true; fi   # nothing made through a stranger's
    if ! private_dir "$ram" || ! private_dir "$tree" || ! private_dir "$ram/t"; then
      warn "$ram or a folder in it is not a folder only this user can open; the caches stay on disk"
      tree=""
    fi
  fi
fi

for rel in $DIRS; do
  path="$root/$rel"
  if [[ -z "$tree" ]]; then
    if [[ -L "$path" && ! -d "$path" ]]; then rm -f "$path"; mkdir -p "$path"
    elif [[ -L "$path" ]]; then warn "$rel still links to $(readlink "$path") (remove the link to keep it on disk)"
    fi
    continue
  fi
  target="$tree/$(printf '%s' "$rel" | tr '/' '_')"
  mkdir -p "$target" 2>/dev/null || true
  if ! private_dir "$target"; then
    warn "$target is not a folder only this user can open; $rel stays on disk"
    continue
  fi
  if [[ -L "$path" ]]; then
    [[ "$(readlink "$path")" == "$target" ]] && continue
    rm -f "$path"                                  # a link to some other folder: point it here
  elif [[ -d "$path" ]]; then
    if ! cp -a "$path/." "$target/" 2>/dev/null; then   # the first move keeps the warm contents
      rm -rf "$target"
      warn "copying $rel into $target failed (RAM full?); it stays on disk"
      continue
    fi
    rm -rf "$path"
  elif [[ -e "$path" ]]; then
    warn "$path is not a folder; left on disk"
    continue
  fi
  mkdir -p "$(dirname "$path")"
  ln -s "$target" "$path"
done
if [[ -n "$tree" ]]; then printf '%s\n' "$tree"; fi
