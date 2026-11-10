#!/usr/bin/env bash
# Secret scan of the WORKING TREE (not git history): what is about to be committed or released.
#
# Uses the repo's .gitleaks.toml (default rules + the platform's own token formats; dependency,
# build and cache directories are allowlisted by path there) and .gitleaksignore. The report is
# redacted, so a real finding never lands in a log in clear text.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v gitleaks >/dev/null 2>&1; then
  printf 'gitleaks: not installed. Install v8.30+ (macOS: brew install gitleaks;\n' >&2
  printf '  elsewhere: https://github.com/gitleaks/gitleaks/releases) and re-run.\n' >&2
  exit 127
fi

gitleaks dir . \
  --config .gitleaks.toml \
  --gitleaks-ignore-path .gitleaksignore \
  --redact \
  --no-banner \
  --no-color \
  --verbose \
  --exit-code 1
