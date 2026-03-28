#!/usr/bin/env bash
# Setup git hooks from the repo's .kiro/hooks directory
# Run once after cloning: ./scripts/setup-hooks.sh

set -euo pipefail

HOOK_SRC=".kiro/hooks/pre-push"
HOOK_DST=".git/hooks/pre-push"

if [ ! -f "$HOOK_SRC" ]; then
  echo "Error: $HOOK_SRC not found. Run from repo root."
  exit 1
fi

cp "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_DST"
echo "✓ Installed pre-push hook"

# Verify agents exist
if [ -f ".kiro/agents/security-reviewer.json" ] && [ -f ".kiro/agents/quality-reviewer.json" ]; then
  echo "✓ Review agents found"
else
  echo "⚠ Review agent configs missing in .kiro/agents/"
fi

echo ""
echo "Done. AI code review will run on every git push."
echo "Bypass with: SKIP_AI_REVIEW=1 git push"
