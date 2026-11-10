#!/usr/bin/env bash
# Lint the GitHub Actions configuration: actionlint, then zizmor, over .github/.
#
# Why. The workflows run with repository tokens on a PUBLIC repo, and their mistakes do not show up as a
# failing build: an `${{ ... }}` expanded into a `run:` script is a script-injection path, an over-broad
# `permissions:` or a persisted checkout credential is a token another step can steal, and a typo in an
# expression or a `needs:` silently skips a job. Two complementary tools catch these:
#
#   - actionlint (https://github.com/rhysd/actionlint): workflow syntax, expression types, `needs:` /
#     `outputs` references, runner labels, untrusted input in inline scripts, and (when shellcheck is on
#     PATH) shellcheck over every `run:` body. Every finding fails.
#   - zizmor (https://docs.zizmor.sh): security audits (template injection, excessive permissions,
#     credential persistence, dangerous triggers, unpinned uses, cache poisoning, ...). Run with the
#     regular persona and NO severity or confidence floor: the step-output injection this gate was added
#     for is reported as informational with low confidence, so `--min-severity low` would have hidden it.
#     A reviewed exception is an inline `# zizmor: ignore[<audit>]` with the reason beside it.
#
# Both tools run even when the first fails, so one run reports everything. A missing tool FAILS with an
# install hint (like gitleaks in scripts/gitleaks-tree.sh): a gate that skips itself when its tool is
# absent passes on exactly the machines that never ran it. CI installs the pinned versions below with
# checksum verification; locally an OLDER version fails (it lacks audits CI has) and a newer one only
# prints a note (it may report findings CI does not yet see).
#
# Limits. zizmor runs `--offline`: the audits that need the GitHub API (impostor commits, known-vulnerable
# action versions, ref confusion) are not run, so a pinned SHA is not proven to belong to the action it
# names. actionlint's shellcheck pass runs only where shellcheck is installed (it is on GitHub's Ubuntu
# runners); its pyflakes pass is turned off so local and CI results agree. Neither tool executes a
# workflow: a logic error that is valid YAML and a valid expression passes.
#
# Overrides: ACTIONLINT / ZIZMOR name the binaries (default: from PATH).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ACTIONLINT_VERSION=1.7.12
ZIZMOR_VERSION=1.31.1
ACTIONLINT="${ACTIONLINT:-actionlint}"
ZIZMOR="${ZIZMOR:-zizmor}"

# 0 when dotted version $1 is older than $2 (numeric per field; bash 3.2 has no sort -V guarantee).
version_older() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    n = split(a, x, "."); m = split(b, y, "."); k = (n > m ? n : m)
    for (i = 1; i <= k; i++) { if ((x[i] + 0) < (y[i] + 0)) exit 0; if ((x[i] + 0) > (y[i] + 0)) exit 1 }
    exit 1
  }'
}

# The first x.y.z in the tool's version output.
version_of() {
  "$1" "$2" 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true
}

# Fails (exit 127) when the tool is missing or older than the pinned version.
require_tool() {
  local label="$1" bin="$2" flag="$3" pinned="$4" hint="$5" found
  if ! command -v "$bin" >/dev/null 2>&1; then
    printf '%s: not installed. Install v%s (%s) and re-run.\n' "$label" "$pinned" "$hint" >&2
    exit 127
  fi
  found="$(version_of "$bin" "$flag")"
  if [ -z "$found" ]; then
    printf '%s: could not read the version of %s.\n' "$label" "$bin" >&2
    exit 127
  fi
  if version_older "$found" "$pinned"; then
    printf '%s: v%s is older than the pinned v%s (%s).\n' "$label" "$found" "$pinned" "$hint" >&2
    exit 127
  fi
  if [ "$found" != "$pinned" ]; then
    printf '%s: note: v%s, CI pins v%s; findings may differ.\n' "$label" "$found" "$pinned"
  fi
}

require_tool actionlint "$ACTIONLINT" -version "$ACTIONLINT_VERSION" \
  'macOS: brew install actionlint; elsewhere: https://github.com/rhysd/actionlint/releases'
require_tool zizmor "$ZIZMOR" --version "$ZIZMOR_VERSION" \
  "macOS: brew install zizmor; elsewhere: pipx install zizmor==$ZIZMOR_VERSION"

if ! command -v shellcheck >/dev/null 2>&1; then
  printf 'actionlint: note: shellcheck not on PATH, run: bodies are not shellchecked (CI runs it).\n'
fi

failed=0
echo "actionlint: .github/workflows"
"$ACTIONLINT" -pyflakes= -no-color || failed=1
echo "zizmor: .github (offline, regular persona, every severity and confidence)"
"$ZIZMOR" --quiet --offline --no-progress --color never --persona regular \
  --min-severity informational --min-confidence low .github || failed=1

if [ "$failed" -ne 0 ]; then
  printf 'actions-lint: findings above. Fix them, or for zizmor add a reviewed inline "# zizmor: ignore[<audit>]" with its reason.\n' >&2
  exit 1
fi
echo "actions-lint: clean"
