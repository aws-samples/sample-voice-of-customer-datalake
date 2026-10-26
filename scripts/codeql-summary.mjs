#!/usr/bin/env node
/**
 * Summarise CodeQL SARIF files (scripts/codeql.sh): results grouped by level
 * and rule, each with its locations, then a totals line. Exits 1 when any
 * result has level `error` — or, with `--strict` (the validate.sh gate), `error` OR `warning` —
 * and 0 otherwise. Notes are listed, never fatal.
 *
 * Usage: node scripts/codeql-summary.mjs [--strict] <file.sarif> [<file.sarif> ...]
 */
import { readFileSync } from 'node:fs';

const LEVEL_ORDER = { error: 0, warning: 1, note: 2, none: 3 };

/**
 * Findings accepted by rule + path prefix, each with the reason. They are
 * reported in their own section and never counted as errors or warnings; a
 * finding of the same rule OUTSIDE the prefix is still reported normally.
 * Keep this list short and every entry justified.
 */
const ACCEPTED = [
  {
    rule: 'js/http-to-file-access',
    prefix: 'voc-datalake/frontend/e2e/',
    reason: 'the e2e suite saves API responses as evidence files by design (ledger, ops, step records)',
  },
  {
    rule: 'js/file-access-to-http',
    prefix: 'voc-datalake/frontend/e2e/',
    reason: 'the e2e suite uploads fixture files and replays saved tokens by design',
  },
  {
    rule: 'js/file-access-to-http',
    prefix: 'voc-datalake/frontend/scripts/check-mock-coverage.mjs',
    reason: 'sends the repo\'s own mock-coverage.json probes to the local mock server (127.0.0.1) by design; flagged since javascript-queries 2.4.8',
  },
  {
    rule: 'js/eval-like-call',
    prefix: 'voc-datalake/frontend/e2e/tests/prototype-enlarge.spec.ts',
    reason: 'document.write IS the behaviour under test (a prototype rewriting its own document)',
  },
  {
    rule: 'py/unnecessary-delete',
    prefix: 'voc-datalake/lambda/shared/tracing.py',
    reason: 'NoOpSubsegment keeps the BaseSegment signatures; `del` is how ruff/pyright accept the unused parameters',
  },
  {
    rule: 'py/uninitialized-local-variable',
    prefix: 'voc-datalake/lambda/shared/converse.py',
    reason: 'extractor false positive: `**ChainParams` is a PEP 695 ParamSpec on `_texts_of`, not a local (CodeQL 2.27 reads the generic clause as a use before assignment)',
  },
  {
    rule: 'py/uninitialized-local-variable',
    prefix: 'voc-datalake/lambda/shared/workflow_schema.py',
    reason: 'extractor false positive: `unchanged` is assigned unconditionally on the line before the one flagged (`diff_definitions` return)',
  },
];

function acceptedBy(ruleId, file) {
  return ACCEPTED.find((entry) => entry.rule === ruleId && file.startsWith(entry.prefix));
}

/** `{ruleId -> {level, name, locations[]}}` for one SARIF file, plus the accepted findings. */
function collect(path) {
  const sarif = JSON.parse(readFileSync(path, 'utf8'));
  const byRule = new Map();
  const accepted = [];
  for (const run of sarif.runs ?? []) {
    const rules = new Map((run.tool?.driver?.rules ?? []).map((r) => [r.id, r]));
    for (const result of run.results ?? []) {
      const rule = rules.get(result.ruleId) ?? {};
      const level = result.level ?? rule.defaultConfiguration?.level ?? 'warning';
      const loc = result.locations?.[0]?.physicalLocation;
      const file = loc?.artifactLocation?.uri ?? '?';
      const line = loc?.region?.startLine ?? 0;
      const acceptance = acceptedBy(result.ruleId, file);
      if (acceptance) {
        accepted.push({ rule: result.ruleId, where: `${file}:${line}`, reason: acceptance.reason });
        continue;
      }
      const entry = byRule.get(result.ruleId) ?? {
        level,
        name: rule.shortDescription?.text ?? result.ruleId,
        tags: rule.properties?.tags ?? [],
        locations: [],
      };
      entry.locations.push(`${file}:${line}  ${result.message?.text?.replace(/\s+/g, ' ').slice(0, 140) ?? ''}`);
      byRule.set(result.ruleId, entry);
    }
  }
  return { byRule, accepted };
}

function print(path, byRule, accepted) {
  const rules = [...byRule.entries()].sort(
    ([, a], [, b]) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9) || b.locations.length - a.locations.length,
  );
  console.log(`\n===== ${path}: ${rules.reduce((n, [, r]) => n + r.locations.length, 0)} result(s) in ${rules.length} rule(s)`
    + (accepted.length > 0 ? `, ${accepted.length} accepted` : ''));
  for (const [id, rule] of rules) {
    const security = rule.tags.some((t) => t.startsWith('security')) ? ' [security]' : '';
    console.log(`\n[${rule.level}] ${id}${security} — ${rule.name} (${rule.locations.length})`);
    for (const location of rule.locations.slice(0, 25)) console.log(`   ${location}`);
    if (rule.locations.length > 25) console.log(`   … ${rule.locations.length - 25} more`);
  }
  if (accepted.length > 0) {
    console.log('\n[accepted] by rule + path, see ACCEPTED in this script:');
    const byReason = new Map();
    for (const a of accepted) byReason.set(`${a.rule} — ${a.reason}`, [...(byReason.get(`${a.rule} — ${a.reason}`) ?? []), a.where]);
    for (const [head, wheres] of byReason) console.log(`   ${head} (${wheres.length})\n      ${wheres.join('\n      ')}`);
  }
}

const STRICT = process.argv.includes('--strict');
const totals = { error: 0, warning: 0, note: 0, accepted: 0 };
for (const path of process.argv.slice(2).filter((arg) => arg !== '--strict')) {
  const { byRule, accepted } = collect(path);
  print(path, byRule, accepted);
  for (const rule of byRule.values()) totals[rule.level] = (totals[rule.level] ?? 0) + rule.locations.length;
  totals.accepted += accepted.length;
}
console.log(`\nTOTAL errors=${totals.error} warnings=${totals.warning} notes=${totals.note} accepted=${totals.accepted}`);
const failing = totals.error + (STRICT ? totals.warning : 0);
if (failing > 0 && STRICT) console.log('codeql: --strict fails on errors and warnings; fix them or accept one in ACCEPTED with a reason');
process.exit(failing > 0 ? 1 : 0);
