#!/usr/bin/env bash
# Driver for the per-module mutation programme (see todo.md, Agent 4): one worktree per module of a round.
#
#   scripts/mutation-round.sh prepare <round>   # worktrees /tmp/mut-<round>-<n> on branches kiro-voc-mut/<stem>
#                                               # (branched from MUT_BASE when set, else HEAD — e.g. another
#                                               # wave's integration tip while it has not landed yet)
#   scripts/mutation-round.sh merge <round>     # merge every finished branch of the round into the current branch;
#                                               # then ONE full `bash scripts/validate.sh` (the agents ran only
#                                               # their targeted gates and scripts/validate-affected.sh)
#   scripts/mutation-round.sh clean <round>     # remove the round's worktrees (branches stay until merged)
#   scripts/mutation-round.sh land <ver> <summary> <bullet>  # the round's one release commit (CHANGELOG + 3× package.json)
#
# Reads the plan written by `node scripts/mutation-plan.mjs plan [/tmp/mut-plan.json]` (rounds[] of
# {file, lines_range, tests, new_test_file, last_slice}); prints a per-agent line on prepare. A TypeScript
# plan (`plan --ts`, MUT_PLAN=/tmp/mut-plan-ts.json) holds jobs of several files: each carries its own
# `branch` and `title`, and its finished files go to scripts/mutation-done-ts.txt. The agent
# prompts come from `node scripts/mutation-plan.mjs prompts <round>`; the agent rules are
# scripts/mutation-brief.md. After a merged round, add its modules to scripts/mutation-done.txt and
# regenerate the plan. Runs from the main checkout; never touches a worktree's files itself.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
PLAN="${MUT_PLAN:-/tmp/mut-plan.json}"
ACTION="${1:?usage: $0 prepare|merge|clean <round> | land <ver> <summary> <bullet>}"
ROUND="${2:-}"

modules() { [[ -n "$ROUND" ]] || { echo "round number required" >&2; exit 2; }; node -e '
  const p = require(process.argv[1]); const r = p.rounds[Number(process.argv[2]) - 1] ?? [];
  for (const m of r) console.log(JSON.stringify(m));' "$PLAN" "$ROUND"; }

# Branch name from the module path (several modules are named handler.py) plus the slice, if any.
branch_of() { node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.branch) { console.log(m.branch); process.exit(0); }
  const base = m.file.replace(/^(lambda|plugins)\//, "").replace(/\.py$/, "").replace(/\//g, "-");
  console.log("kiro-voc-mut/" + base + (m.lines_range ? "-" + m.lines_range : ""));' "$1"; }

case "$ACTION" in
  prepare)
    n=0
    while IFS= read -r m; do
      n=$((n + 1))
      dir="/tmp/mut-$ROUND-$n"
      branch="$(branch_of "$m")"
      git worktree add -q -b "$branch" "$dir" "${MUT_BASE:-HEAD}"
      for d in node_modules voc-datalake/node_modules voc-datalake/frontend/node_modules voc-datalake/lambda/stream/node_modules voc-datalake/.venv; do
        ln -s "$ROOT/$d" "$dir/$d"
      done
      mkdir -p "$dir/voc-datalake/frontend/dist"
      echo "AGENT $n: worktree=$dir branch=$branch $(node -e 'const m = JSON.parse(process.argv[1]); console.log(m.title ?? JSON.stringify(m))' "$m")"
    done < <(modules)
    ;;
  merge)
    while IFS= read -r m; do
      file="$(node -e 'const m = JSON.parse(process.argv[1]); console.log(m.file ?? m.title)' "$m")"
      branch="$(branch_of "$m")"
      ahead="$(git rev-list --count "HEAD..$branch" 2>/dev/null || echo 0)"
      if [[ "$ahead" == "0" ]]; then echo "skip $branch (no commits)"; continue; fi
      if git merge --no-ff -q -m "merge: mutation-hardened $file" "$branch"; then
        echo "merged $branch (+$ahead)"
      else
        echo "CONFLICT merging $branch — resolve by hand, then continue"; exit 1
      fi
    done < <(modules)
    ;;
  clean)
    for dir in /tmp/mut-"$ROUND"-*; do
      [[ -d "$dir" ]] && git worktree remove --force "$dir" && echo "removed $dir"
    done
    ;;
  land)
    # land <version 2.YY.ZZ> "<one-line summary>" "<bullet>"  — the round's single release commit (changelog
    # steering: patch bump for tests-only work). Writes the CHANGELOG section under [Unreleased], sets the
    # three package.json versions, checks them, commits everything staged plus the version files.
    VERSION="${2:?version like 2.12.5}"; SUMMARY="${3:?summary}"; BULLET="${4:?bullet}"
    CURRENT="$(node -p 'require("./package.json").version')"
    if [[ "$CURRENT" == "$VERSION" ]]; then echo "version $VERSION is already current (package.json); pick the next patch" >&2; exit 2; fi
    PADDED="$(node -e 'const [a,b,c]=process.argv[1].split("."); console.log(`${a}.${b.padStart(2,"0")}.${c.padStart(2,"0")}`)' "$VERSION")"
    node - "$PADDED" "$(date +%F)" "$SUMMARY" "$BULLET" <<'EOF'
const fs = require('fs');
const [version, date, summary, bullet] = process.argv.slice(2);
const path = 'CHANGELOG.md';
const text = fs.readFileSync(path, 'utf8');
const marker = /## \[Unreleased\]\n+/;
if (!marker.test(text)) throw new Error('CHANGELOG.md has no [Unreleased] heading');
const section = `## [Unreleased]\n\n## [${version}] - ${date}\n\n${summary}\n\n### Changed\n\n- ${bullet}\n\n`;
fs.writeFileSync(path, text.replace(marker, section));
EOF
    for d in . voc-datalake voc-datalake/frontend; do (cd "$d" && npm version "$VERSION" --no-git-tag-version > /dev/null); done
    node scripts/check-version.mjs
    git add CHANGELOG.md package.json package-lock.json voc-datalake/package.json voc-datalake/package-lock.json \
      voc-datalake/frontend/package.json voc-datalake/frontend/package-lock.json scripts/mutation-done.txt voc-datalake/scripts/mcp_gate.py
    [[ -f scripts/mutation-done-ts.txt ]] && git add scripts/mutation-done-ts.txt
    git commit -q -m "chore(release): $PADDED — $SUMMARY" && git log --oneline -1
    ;;
  *) echo "unknown action $ACTION" >&2; exit 2 ;;
esac
