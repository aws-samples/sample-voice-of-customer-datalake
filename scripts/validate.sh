#!/usr/bin/env bash
# Every gate, cheapest first, tests last; a green run here is a green CI run.
#
# Each step is a hard stop with zero findings allowed. Gates whose pre-existing findings are not
# fixed yet are NOT here: scripts/quality-baseline.sh counts them, and a gate moves from there to
# here in the change that brings it to zero. That list only ever shrinks.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
CDK="$ROOT/voc-datalake"
FRONTEND="$CDK/frontend"
STREAM="$CDK/lambda/stream"
# One command per step: under `set -e` a failure on the left of `&&` does not stop the script.

if [[ -z "${PYTHON_BIN:-}" ]]; then
  if [[ -x "$CDK/.venv/bin/python" ]]; then PYTHON_BIN="$CDK/.venv/bin/python"; else PYTHON_BIN="$(command -v python3)"; fi
fi
export PYTHON_BIN
PATH="$(dirname "$PYTHON_BIN"):$PATH"   # ruff, vulture, pytest from the same environment
export PATH
step() { printf '\n==> %s\n' "$1"; }

# ---- Python (voc-datalake/: ruff.toml, pyproject.toml, pytest.ini) ----
step "ruff";                              (cd "$CDK" && ruff check lambda plugins scripts)

# ---- TypeScript ----
step "tsc: frontend app + node configs";  (cd "$FRONTEND" && npx tsc -b --noEmit)
step "tsc: stream Lambda";                (cd "$STREAM" && npx tsc --noEmit)
step "tsc: CDK app";                      (cd "$CDK" && npx tsc -p tsconfig.json --noEmit)
step "tsc: CDK scripts + configs";        (cd "$CDK" && npx tsc -p tsconfig.tools.json --noEmit)
step "eslint: CDK app";                   (cd "$CDK" && npx eslint . --max-warnings 0)
step "eslint: frontend";                  (cd "$FRONTEND" && npx eslint . --max-warnings 0)
step "eslint: stream Lambda";             (cd "$STREAM" && npx eslint . --max-warnings 0)

# ---- Tests ----
step "pytest";                            (cd "$CDK" && "$PYTHON_BIN" -m pytest -q --no-header --tb=short -p no:cacheprovider)
# The CDK stacks stage frontend/dist as an asset, so the CDK suite needs a built frontend.
step "vite build: frontend";              (cd "$FRONTEND" && npx vite build --logLevel warn)
step "vitest: CDK app";                   (cd "$CDK" && npx vitest run)
step "vitest: stream Lambda";             (cd "$STREAM" && npx vitest run)
step "vitest: frontend";                  (cd "$FRONTEND" && npx vitest run)

printf '\nvalidate: every gate passed (scripts/quality-baseline.sh counts the gates still pending)\n'
