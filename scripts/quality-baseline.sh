#!/usr/bin/env bash
# Counted the quality gates that were not enforced yet (Phase 5 of the quality-gate brief).
# Since wave 6 (2026-10-05) every gate is enforced at zero by scripts/validate.sh: the ruff PENDING
# block, the ESLint PENDING_* maps and the tsconfig overrides are gone, and pyright, jscpd and
# check_tests_assert run in validate.sh. If a new gate is ever introduced with pre-existing findings,
# pend it the same way (ruff.toml PENDING block / an ESLint PENDING_* map) and count it here.
set -euo pipefail
echo "Nothing is pending: every quality gate is enforced by scripts/validate.sh."
