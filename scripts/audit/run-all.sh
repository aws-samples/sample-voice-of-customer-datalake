#!/usr/bin/env bash
# Run every code-audit detector in scripts/audit/ and summarise (docs/code-audit.md).
#
#   bash scripts/audit/run-all.sh            every detector, report-only
#   bash scripts/audit/run-all.sh --list     the detectors it would run, then exit
#   npm run audit:code                       the same, from the repo root
#
# Detectors are DISCOVERED, not listed: every scripts/audit/*.py and *.mjs whose first 5 lines carry the
# marker comment `audit-detector:` (`# audit-detector: ...` / `// audit-detector: ...`). Libraries, aggregators,
# fixtures and tests carry none, so they are never run as detectors. A new detector is picked up the moment it
# lands with the marker. Each runs from the repo root with no arguments (its defaults are the real tree) plus
# `--json .cache/audit/<name>.json` when its --help mentions --json; its console output always goes
# to .cache/audit/<name>.log, and .cache/audit/summary.json lists every detector's exit code.
#
# Exit 0 = every detector clean, 1 = at least one reported findings, 2 = at least one could not run
# (exit 2 or anything else). Detector contract: 0 clean, 1 findings, 2 error.
#
# Env: PYTHON_BIN (default voc-datalake/.venv/bin/python, else python3), AUDIT_OUT (default .cache/audit).
# bash 3.2 compatible (macOS /bin/bash).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT="$PWD"
OUT="${AUDIT_OUT:-$ROOT/.cache/audit}"
if [[ -z "${PYTHON_BIN:-}" ]]; then
  if [[ -x "$ROOT/voc-datalake/.venv/bin/python" ]]; then PYTHON_BIN="$ROOT/voc-datalake/.venv/bin/python"; else PYTHON_BIN="$(command -v python3)"; fi
fi

detectors() {
  local f base
  for f in "$ROOT"/scripts/audit/*.py "$ROOT"/scripts/audit/*.mjs; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f")"
    case "$base" in test_*|*.test.mjs) continue ;; esac
    head -n 5 "$f" | grep -q 'audit-detector:' || continue
    printf '%s\n' "$f"
  done
}

if [[ "${1:-}" == "--list" ]]; then
  detectors | sed "s#^$ROOT/##"
  exit 0
fi
if [[ $# -gt 0 ]]; then printf 'run-all: unknown option %s (see the header)\n' "$1" >&2; exit 2; fi

mkdir -p "$OUT"
worst=0
rows=""
json_rows=""
while IFS= read -r det; do
  name="$(basename "$det")"
  case "$name" in *.py) runner=("$PYTHON_BIN") ;; *) runner=(node) ;; esac
  args=()
  if "${runner[@]}" "$det" --help 2>/dev/null | grep -q -- '--json'; then args=(--json "$OUT/$name.json"); fi
  t0=$(date +%s)
  "${runner[@]}" "$det" "${args[@]+"${args[@]}"}" > "$OUT/$name.log" 2>&1
  rc=$?
  dur=$(( $(date +%s) - t0 ))
  case "$rc" in
    0) status="clean" ;;
    1) status="FINDINGS"; [[ $worst -lt 1 ]] && worst=1 ;;
    *) status="ERROR($rc)"; worst=2 ;;
  esac
  headline="$(head -n 1 "$OUT/$name.log")"
  rows="${rows}$(printf '%-24s %-10s %4ss  %s' "$name" "$status" "$dur" "${headline:0:110}")"$'\n'
  json_rows="${json_rows}${json_rows:+,}{\"detector\":\"$name\",\"exit\":$rc,\"seconds\":$dur,\"log\":\"${OUT#$ROOT/}/$name.log\"}"
  if [[ $rc -ne 0 ]]; then
    sed -n '2,40p' "$OUT/$name.log" | sed 's/^/    /' > "$OUT/$name.excerpt"
  else
    rm -f "$OUT/$name.excerpt"
  fi
done < <(detectors)

if [[ -z "$rows" ]]; then printf 'run-all: no detector found in scripts/audit/\n' >&2; exit 2; fi
printf '[%s]\n' "$json_rows" > "$OUT/summary.json"
printf 'code audit (%s): logs and JSON reports in %s\n\n' "$(date +%F)" "${OUT#$ROOT/}"
printf '%-24s %-10s %5s  %s\n' detector status time 'first line of its report'
printf '%s' "$rows"
for excerpt in "$OUT"/*.excerpt; do
  [[ -f "$excerpt" ]] || continue
  printf '\n--- %s (first lines; full log %s) ---\n' "$(basename "$excerpt" .excerpt)" "${excerpt%.excerpt}.log"
  cat "$excerpt"
done
exit "$worst"
