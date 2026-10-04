#!/usr/bin/env bash
# Counts the findings of every quality gate that is not enforced yet (Phase 5 of the quality-gate
# brief: measure, fix one group, then move its gate into scripts/validate.sh). Never fails: it is a
# measurement. Each count must only go down; a pending gate whose count reaches zero moves into
# validate.sh, and its pending entry (ruff.toml ignore, eslint PENDING_* map) is deleted.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
CDK="$ROOT/voc-datalake"
FRONTEND="$CDK/frontend"
STREAM="$CDK/lambda/stream"
PYTHON_BIN="${PYTHON_BIN:-$CDK/.venv/bin/python}"
PATH="$(dirname "$PYTHON_BIN"):$PATH"
export PATH PYTHON_BIN
KNIP_PROD="$ROOT/scripts/knip-production.mjs"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/quality-baseline.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

section() { printf '\n==> %s\n' "$1"; }
count_lines() { grep -c . "$1" || true; }

section "ruff: pending rules (ruff.toml PENDING block), per rule"
# A CLI `--config lint.ignore=…` does not un-ignore; an explicit `--extend-select` of the pended codes does.
PENDING_RUFF="$(sed -n '/PENDING-BEGIN/,/PENDING-END/p' "$CDK/ruff.toml" | grep -v '^ *#' | grep -oE '"[A-Z]+[0-9]+"' | tr -d '"' | paste -sd, -)"
(cd "$CDK" && ruff check lambda plugins scripts --extend-select "$PENDING_RUFF" --statistics --output-format concise) || true

section "eslint: pending rules (eslint.config PENDING_* maps, QUALITY_BASELINE=1), per package and rule"
for pkg in "$CDK" "$FRONTEND" "$STREAM"; do
  (cd "$pkg" && QUALITY_BASELINE=1 npx eslint . -f json -o "$TMP/eslint.json" >/dev/null 2>&1)
  node -e '
    const r = require(process.argv[1]); const c = {};
    for (const f of r) for (const m of f.messages) { const k = m.ruleId ?? "parse-error"; c[k] = (c[k] ?? 0) + 1; }
    const rows = Object.entries(c).sort((a, b) => b[1] - a[1]);
    console.log(`${process.argv[2]}: ${rows.reduce((s, [, n]) => s + n, 0)} findings`);
    for (const [k, n] of rows) console.log(`  ${String(n).padStart(5)}  ${k}`);
  ' "$TMP/eslint.json" "${pkg#"$ROOT"/}"
done

section "tsc: noUncheckedIndexedAccess (not yet in any tsconfig), errors per program"
tsc_count() { (cd "$1" && npx tsc -p "$2" --noEmit "${@:3}" 2>&1 | grep -c 'error TS') || true; }
echo "  frontend tsconfig.app.json   $(tsc_count "$FRONTEND" tsconfig.app.json --noUncheckedIndexedAccess)"
echo "  frontend tsconfig.node.json  $(tsc_count "$FRONTEND" tsconfig.node.json --noUncheckedIndexedAccess)"
echo "  stream tsconfig.json         $(tsc_count "$STREAM" tsconfig.json --noUncheckedIndexedAccess)"
echo "  CDK tsconfig.json            $(tsc_count "$CDK" tsconfig.json --noUncheckedIndexedAccess)"
echo "  CDK tsconfig.json            $(tsc_count "$CDK" tsconfig.json --noUnusedLocals) (noUnusedLocals, also pending there)"
section "tsc: frontend specs (tsconfig.test.json, the typecheck:tests script), errors"
echo "  as configured                $(tsc_count "$FRONTEND" tsconfig.test.json)"

section "vulture: dead Python code"
(cd "$CDK" && bash scripts/lint-python.sh --dead-code > "$TMP/v1.txt")
(cd "$CDK" && bash scripts/lint-python.sh --dead-code-tests > "$TMP/v2.txt")
echo "  production code      $(count_lines "$TMP/v1.txt")"
echo "  test-support code    $(count_lines "$TMP/v2.txt")"

section "pyright: errors (standard mode + reportUnnecessary*)"
(cd "$CDK" && npx --prefix "$ROOT" pyright --pythonpath "$PYTHON_BIN" --outputjson > "$TMP/pyright.json" 2>/dev/null)
node -e '
  const r = require(process.argv[1]); const c = {};
  for (const d of r.generalDiagnostics) if (d.severity === "error") c[d.rule ?? "other"] = (c[d.rule ?? "other"] ?? 0) + 1;
  console.log(`  ${r.summary.errorCount} errors in ${r.summary.filesAnalyzed} files`);
  for (const [k, n] of Object.entries(c).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
' "$TMP/pyright.json"

section "check_tests_assert: pytest tests that assert nothing"
(cd "$CDK" && "$PYTHON_BIN" scripts/check_tests_assert.py > "$TMP/assert.txt")
echo "  $(count_lines "$TMP/assert.txt")"

section "knip: unused files, exports, types, dependencies (default / --production --strict)"
knip_count() {
  (cd "$1" && npx knip --no-progress --no-exit-code --reporter json "${@:2}" 2>/dev/null) | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const { issues } = JSON.parse(s); let n = 0;
      for (const row of issues) for (const [k, v] of Object.entries(row)) if (Array.isArray(v)) n += v.length;
      console.log(n);
    });'
}
for pkg in "$CDK" "$FRONTEND" "$STREAM"; do
  echo "  ${pkg#"$ROOT"/}: $(knip_count "$pkg") default, $(knip_count "$pkg" --config "$KNIP_PROD" --production --strict) production"
done

section "jscpd: clones in code and tests (one run, all languages)"
npx jscpd --fail-on-empty --reporters console 2>&1 | sed -E $'s/\x1b\\[[0-9;]*m//g' | grep -E '^Found|Total:' || true
