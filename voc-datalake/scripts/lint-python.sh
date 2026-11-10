#!/usr/bin/env bash
# Dead Python code, two passes, one gate.
#   --dead-code        production code with the tests left out: a function only a test calls is dead.
#   --dead-code-tests  the whole tree, printing only what the first pass did not: dead test helpers and fixtures.
# Paths, floor and allowlists live in pyproject.toml [tool.vulture]; vulture's CLI flags REPLACE pyproject
# values, so this script passes only the excludes, which are the one thing the passes differ in.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

EXCLUDE='*/.venv/*,*/node_modules/*,*/__pycache__/*,*/dist/*,*/build/*,*/lambda/layers/*,*/cdk.out/*'
# Test support also lives in `test/` directories beside the code (fixture modules like
# lambda/api/test/plugin_manifests.py), not only in test_*.py files.
TEST_FILES='*/test_*.py,*_test.py,*/conftest.py,*/test/*'
FOUND_EXIT=3

case "${1:-}" in
  --dead-code)
    vulture --exclude "$EXCLUDE,$TEST_FILES"
    ;;
  --dead-code-tests)
    production="$(vulture --exclude "$EXCLUDE,$TEST_FILES" || true)"
    everything="$(vulture --exclude "$EXCLUDE" || true)"
    if [[ -z "$production" ]]; then
      tests_only="$everything"
    else
      tests_only="$(grep -vxF -f <(printf '%s\n' "$production") <<<"$everything" || true)"
    fi
    if [[ -n "$tests_only" ]]; then
      printf '%s\n' "$tests_only"
      exit "$FOUND_EXIT"
    fi
    ;;
  *)
    echo "usage: $0 --dead-code | --dead-code-tests" >&2
    exit 2
    ;;
esac
