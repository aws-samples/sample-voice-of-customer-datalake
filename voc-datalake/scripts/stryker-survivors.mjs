#!/usr/bin/env node
// Prints a Stryker JSON report (mutation-testing-report-schema) the way scripts/mutate-ts.sh wants it:
// one summary line per file, then every mutant that is not killed as `file:line:col  Mutator  original → replacement`.
//
//   node scripts/stryker-survivors.mjs <report.json>
//
// Exit 0 when every mutant is Killed, Timeout (an infinite loop the timeout caught) or Ignored (a
// `// Stryker disable` marker); 1 when any is Survived or NoCoverage (no test runs that code at all);
// 3 when a mutant crashed the runner or failed to compile (RuntimeError / CompileError: rerun, or
// inspect it, but it is not a pin); 2 on a bad call.
import { readFileSync } from 'node:fs';

const OPEN = new Set(['Survived', 'NoCoverage']);
const BROKEN = new Set(['RuntimeError', 'CompileError']);
const DONE = new Set(['Killed', 'Timeout', 'Ignored']);

const path = process.argv[2];
if (!path) {
  console.error('usage: stryker-survivors.mjs <report.json>');
  process.exit(2);
}
const report = JSON.parse(readFileSync(path, 'utf8'));

/** The source text a mutant replaced, on one line, shortened. */
function original(source, { start, end }) {
  const lines = source.split('\n');
  const text = start.line === end.line
    ? lines[start.line - 1].slice(start.column - 1, end.column - 1)
    : [lines[start.line - 1].slice(start.column - 1), ...lines.slice(start.line, end.line - 1), lines[end.line - 1].slice(0, end.column - 1)].join(' ');
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 70 ? `${flat.slice(0, 67)}...` : flat;
}

let open = 0;
let broken = 0;
const lines = [];
for (const [file, { source, mutants }] of Object.entries(report.files).sort(([a], [b]) => a.localeCompare(b))) {
  const count = {};
  for (const m of mutants) count[m.status] = (count[m.status] ?? 0) + 1;
  const summary = Object.entries(count).sort().map(([s, n]) => `${s} ${n}`).join(', ');
  console.log(`${file}: ${mutants.length} mutants — ${summary || 'none'}`);
  const pending = mutants
    .filter((m) => !DONE.has(m.status))
    .sort((a, b) => a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column);
  for (const m of pending) {
    if (OPEN.has(m.status)) open += 1;
    else if (BROKEN.has(m.status)) broken += 1;
    const where = `${file}:${m.location.start.line}:${m.location.start.column}`;
    const replacement = (m.replacement ?? '').replace(/\s+/g, ' ').trim();
    lines.push(`  [${m.status}] ${where}  ${m.mutatorName}  ${original(source, m.location)}  →  ${replacement.length > 70 ? `${replacement.slice(0, 67)}...` : replacement}`);
  }
}
if (lines.length > 0) console.log(lines.join('\n'));
console.log(open === 0 && broken === 0 ? 'OK: 0 surviving mutants' : `NOT DONE: ${open} surviving/uncovered, ${broken} runtime/compile errors`);
process.exit(open > 0 ? 1 : broken > 0 ? 3 : 0);
