#!/usr/bin/env node
// Planner for the per-module Python mutation programme (todo.md, Agent 4 → "Mutation hardening").
//
//   node scripts/mutation-plan.mjs plan [out.json] [--only <list>] [--frozen-tests <list>]
//                                                          # inventory → balanced rounds of 8 (default /tmp/mut-plan.json)
//   node scripts/mutation-plan.mjs prompts <round> [plan]  # the orchestrate_subagent stages for one round
//   node scripts/mutation-plan.mjs plan --ts [out.json] [--only <list>] [--baseline <report.json>[,…]]
//                                    [--agents <n>] [--job-work <n>]   # TypeScript jobs (default /tmp/mut-plan-ts.json;
//                                                                      # 10 agents, work 220 per job)
//
// TypeScript mode lives in scripts/mutation-plan-ts.mjs (Stryker, batched jobs of several files; read its
// header). `prompts` reads the plan's `lang` and prints the matching stages.
//
// --only <list>: a file of module paths (relative to voc-datalake/, one per line); only those are planned —
// used while another agent wave edits the rest of the tree. --frozen-tests <list>: test files another wave
// is editing; a module whose existing tests are frozen gets an add-only brief (no pruning).
//
// Every Python Lambda/plugin module (not tests, conftest, layers) gets a weight = lines + 15 × defs. A
// module over SLICE_CAP is cut at top-level statement boundaries into slices so every agent's run has a
// similar length; slices of one file never share a round (they would edit the same test files), and the
// LAST slice of a file owns the pruning of its existing test suite. Modules listed in
// scripts/mutation-done.txt (`path` or `path:from-to`, one per line) are finished and left out.
// `scripts/mutation-round.sh prepare|merge|clean <round>` consumes the plan file.
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildTsPlan, DEFAULT_AGENTS, DEFAULT_JOB_WORK, doneGaps, printTsPlan, tsDoneSet, tsPrompts } from './mutation-plan-ts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'voc-datalake');
const AGENTS_PER_ROUND = 8;
// The round's agents share the machine: each one's pytest-xdist run gets an even share of the CPUs.
const PYTEST_WORKERS_PER_AGENT = Math.max(2, Math.floor(availableParallelism() / AGENTS_PER_ROUND));
const SLICE_CAP = 2100;
const DEF_WEIGHT = 15;
const MIN_INTERVAL_LINES = 10;
const DONE_FILE = join(ROOT, 'scripts', 'mutation-done.txt');
const BRIEF = 'scripts/mutation-brief.md';

const SKIP_DIRS = ['node_modules', '.venv', 'layers', '__pycache__'];

/** Every file under voc-datalake/{lambda,plugins} whose name passes `keep`, skipping `SKIP_DIRS` and
 *  `extraSkip`; paths relative to voc-datalake/, in walk order. */
function walkPackage(keep, extraSkip = []) {
  const skip = [...SKIP_DIRS, ...extraSkip];
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (skip.includes(name)) continue;
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (keep(name)) out.push(relative(PKG, full));
    }
  };
  for (const top of ['lambda', 'plugins']) walk(join(PKG, top));
  return out;
}

/** @returns {string[]} module paths relative to voc-datalake/ */
function listModules() {
  const isModule = (name) => name.endsWith('.py') && !name.startsWith('test_') && name !== 'conftest.py';
  return walkPackage(isModule, ['test', 'tests']).sort();
}

function inventory(file) {
  const lines = readFileSync(join(PKG, file), 'utf8').split('\n');
  const isDef = (l) => /^\s*(async\s+)?def\s/.test(l);
  // weightUpTo[n] = weight of lines 1..n, so a range's weight is weightUpTo[to] - weightUpTo[from - 1].
  const weightUpTo = [0];
  lines.forEach((l, i) => { weightUpTo.push(weightUpTo[i] + 1 + (isDef(l) ? DEF_WEIGHT : 0)); });
  // Top-level statement starts: a slice may begin at any of these lines (decorators belong to the def below).
  const starts = [];
  lines.forEach((l, i) => { if (/^(def|async def|class|@|[A-Z_][A-Z0-9_]*\s*[:=]|if __name__)/.test(l)) starts.push(i + 1); });
  return { file, lines: lines.length, weight: weightUpTo[lines.length], weightUpTo, starts };
}

/** `<dir>/test` when it exists, else the nearest ancestor's `test/` inside the same top-level package
 *  (lambda/agents/nodes/x.py → lambda/agents/test), else the module's own dir (plugins keep tests beside code). */
function nearestTestDir(dir) {
  let probe = dir;
  while (probe && probe !== '.' && probe.split('/').length > 1) {
    if (existsSync(join(PKG, probe, 'test'))) return join(probe, 'test');
    probe = dirname(probe);
  }
  return dir;
}

/** Test-file basenames must be unique within a test dir (and repo-wide under `plugins/`, which has no
 *  __init__.py): a handler.py whose tests do not live in its own `test/` dir carries its parent's name
 *  (`test_webscraper_handler_mutation.py`, `test_scanner_handler_mutation.py`). */
function mutationTestName(file, range) {
  const stem = basename(file, '.py');
  const parts = file.split('/');
  const ownTestDir = existsSync(join(PKG, dirname(file), 'test'));
  let unique = stem;
  if (stem === 'handler' && parts[0] === 'plugins') {
    // plugins/<plugin>/<role>/handler.py → <plugin>_handler, plus the role when it is not the ingestor
    unique = `${parts[1]}${parts.at(-2) === 'ingestor' ? '' : `_${parts.at(-2)}`}_handler`;
  } else if (stem === 'handler' && !ownTestDir) {
    unique = `${parts.at(-2)}_handler`;
  }
  return `test_${unique}_mutation${range ? `_${range.replace('-', '_')}` : ''}.py`;
}

/** Every test file of the package, with its text, read once. */
const TEST_FILES = walkPackage((name) => name.startsWith('test_') && name.endsWith('.py'))
  .map((path) => ({ path, text: readFileSync(join(PKG, path), 'utf8') }));

/** The test files that import the module (`import stem`, `from pkg.stem import`, `pkg.stem.x`), or the
 *  sibling test dir for the many modules named handler.py, whose name matches nothing on its own. */
function testsFor(file) {
  const dir = dirname(file);
  const stem = basename(file, '.py');
  const siblingTestDir = nearestTestDir(dir);
  if (stem === 'handler' || stem === '__init__') {
    const own = TEST_FILES.filter((t) => dirname(t.path) === siblingTestDir).map((t) => t.path);
    return { testDir: siblingTestDir, tests: own };
  }
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const importRe = new RegExp(
    `^\\s*from\\s+[\\w.]*\\b${esc}\\s+import\\b` +           // from shared.stem import x
    `|^\\s*from\\s+[\\w.]+\\s+import\\s+(?:[\\w, ]*\\b)?${esc}\\b` + // from shared import stem
    `|^\\s*import\\s+[\\w.]*\\b${esc}\\b` +                 // import shared.stem
    `|['"][\\w.]*\\b${esc}\\.[\\w.]+['"]`,                    // patch('shared.stem.helper')
    'm',
  );
  const tests = TEST_FILES.filter((t) => importRe.test(t.text)).map((t) => t.path);
  return { testDir: siblingTestDir, tests };
}

/** The still-open line intervals of a file: everything not covered by a done `path:from-to` entry
 *  (any order, gaps allowed); `[]` when the whole module is done. A sliver left by a slice boundary
 *  (a few trailing or in-between lines) is not worth an agent. */
function openIntervals(file, lines, done) {
  return doneGaps(file, lines, done).filter((i) => i.to - i.from + 1 >= MIN_INTERVAL_LINES);
}

/** Cut one open interval into slices of at most SLICE_CAP weight at top-level statement boundaries. */
function sliceInterval(inv, interval) {
  const { weightUpTo } = inv;
  const openWeight = weightUpTo[interval.to] - weightUpTo[interval.from - 1];
  const count = Math.max(1, Math.ceil(openWeight / SLICE_CAP));
  const target = openWeight / count;
  const slices = [];
  let from = interval.from;
  for (let k = 1; k < count; k += 1) {
    const goal = weightUpTo[interval.from - 1] + target * k;
    // A decorator line is itself a start, so cutting at any start keeps decorators with their def. Only
    // boundaries strictly inside the interval qualify; none left → the rest is one slice.
    const candidates = inv.starts.filter((s) => s > from + 1 && s < interval.to);
    if (candidates.length === 0) break;
    const cut = candidates.reduce((best, s) => (Math.abs(weightUpTo[s - 1] - goal) < Math.abs(weightUpTo[best - 1] - goal) ? s : best));
    slices.push({ file: inv.file, from, to: cut - 1 });
    from = cut;
  }
  slices.push({ file: inv.file, from, to: interval.to });
  return slices;
}

function slice(inv, done) {
  const intervals = openIntervals(inv.file, inv.lines, done);
  const slices = intervals.flatMap((interval) => sliceInterval(inv, interval));
  const { weightUpTo } = inv;
  // Whole-module notation only when the single slice is the whole file. Pruning of the existing tests is
  // owned by the slice that is the ONLY one still open (the chronologically last one); earlier slices add tests only.
  const sliced = !(slices.length === 1 && slices[0].from === 1 && slices[0].to === inv.lines);
  return slices.map((s) => ({
    ...s, sliced, last: slices.length === 1,
    weight: weightUpTo[s.to] - weightUpTo[s.from - 1], lines: s.to - s.from + 1,
  }));
}

/** A list file (one entry per line, `#` comments) → Set; null when no path was given. */
function readList(path) {
  if (!path) return null;
  return new Set(readFileSync(path, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean));
}

function doneSet() {
  return existsSync(DONE_FILE) ? readList(DONE_FILE) : new Set();
}

function buildPlan({ only = null, frozenTests = new Set() } = {}) {
  const done = doneSet();
  const open = listModules().filter((f) => !only || only.has(f)).map(inventory).filter((i) => i.weight >= 40).flatMap((inv) => slice(inv, done));
  const roundCount = Math.ceil(open.length / AGENTS_PER_ROUND);
  const rounds = Array.from({ length: roundCount }, () => []);
  const roundWeight = (r) => r.reduce((t, x) => t + x.weight, 0);
  // Longest-processing-time first: each slice goes to the lightest round that has room and no slice of the
  // same file; when none qualifies (a file with more slices than open rounds) a new round is opened.
  for (const s of [...open].sort((a, b) => b.weight - a.weight)) {
    const candidates = rounds.filter((r) => r.length < AGENTS_PER_ROUND && !r.some((x) => x.file === s.file));
    let target = candidates.sort((a, b) => roundWeight(a) - roundWeight(b))[0];
    if (!target) { target = []; rounds.push(target); }
    const { testDir, tests } = testsFor(s.file);
    const range = s.sliced ? `${s.from}-${s.to}` : null;
    const frozen = tests.filter((t) => frozenTests.has(t));
    target.push({
      file: s.file, lines_range: range, from: s.from, to: s.to, weight: s.weight, last_slice: s.last,
      tests, frozen_tests: frozen, new_test_file: join(testDir, mutationTestName(s.file, range)),
    });
  }
  return { generated: new Date().toISOString(), slice_cap: SLICE_CAP, agents_per_round: AGENTS_PER_ROUND, done: [...done], rounds };
}

function printPlan(plan) {
  plan.rounds.forEach((r, i) => {
    const total = r.reduce((t, m) => t + m.weight, 0);
    console.log(`round ${i + 1} (weight ${total}):`);
    for (const m of r) console.log(`  ${m.weight.toString().padStart(5)}  ${m.file}${m.lines_range ? `:${m.lines_range}` : ''}  ${m.tests.length} test file(s)${m.tests.length === 0 ? ' — NONE: the agent must find or write them' : ''}`);
  });
  console.log(`${plan.rounds.flat().length} slices open, ${plan.done.length} done`);
}

function prompts(round, plan) {
  const modules = plan.rounds[round - 1] ?? [];
  return modules.map((m, i) => {
    const n = i + 1;
    const dir = `/tmp/mut-${round}-${n}`;
    const slice = m.lines_range ? ` lines ${m.lines_range} (slice; run \`--lines ${m.lines_range}\`)` : '';
    let prune = 'You own the pruning of the module\'s existing test files listed under tests.';
    if (!m.last_slice) prune = 'Another slice of this file owns the existing test files: ADD tests only in your new file, never delete or edit the existing tests.';
    else if (m.frozen_tests.length > 0) prune = `Another live agent wave is editing these existing test files: ${m.frozen_tests.map((t) => `voc-datalake/${t}`).join(', ')}. Do NOT edit or delete anything in them; ADD tests only in your new file and list in the report the existing tests you would have deleted (file::test name, one line each) instead of deleting them.`;
    return {
      name: `mut-${round}-${n}`,
      role: 'general-task-execution',
      prompt_template: [
        `Read ${dir}/${BRIEF} first and follow it exactly.`,
        `Worktree: ${dir} (cd there || exit 1 in every command). Branch: already checked out.`,
        `Module: voc-datalake/${m.file}${slice}. Weight ${m.weight}.`,
        `Existing tests: ${m.tests.map((t) => `voc-datalake/${t}`).join(', ') || 'none'}. New test file: voc-datalake/${m.new_test_file}.`,
        prune,
        `Gates: targeted only (the brief's "Gates" section); never the full scripts/validate.sh. Final check: \`VALIDATE_PYTEST_WORKERS=${PYTEST_WORKERS_PER_AGENT} bash scripts/validate-affected.sh ${process.env.MUT_BASE || 'kiro-voc'}\`.`,
        'Report in the brief\'s format, under 3,000 characters.',
      ].join('\n'),
    };
  });
}

const [cmd, ...args] = process.argv.slice(2);
const VALUE_FLAGS = ['--only', '--frozen-tests', '--baseline', '--agents', '--job-work'];
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1] ?? ''));
const positiveInt = (name, fallback) => {
  const n = Number(flag(name) ?? fallback);
  if (!Number.isInteger(n) || n < 1) { console.error(`${name} wants a positive integer`); process.exit(2); }
  return n;
};
if (cmd === 'plan' && args.includes('--ts')) {
  const out = positional[0] ?? '/tmp/mut-plan-ts.json';
  const plan = await buildTsPlan({
    root: ROOT,
    only: readList(flag('--only')),
    done: tsDoneSet(ROOT, readList),
    baselines: (flag('--baseline') ?? '').split(',').filter(Boolean),
    agents: positiveInt('--agents', DEFAULT_AGENTS),
    jobWork: positiveInt('--job-work', DEFAULT_JOB_WORK),
  });
  writeFileSync(out, JSON.stringify(plan, null, 2));
  printTsPlan(plan);
  console.log(`written ${out}`);
} else if (cmd === 'plan') {
  const out = positional[0] ?? '/tmp/mut-plan.json';
  const plan = buildPlan({ only: readList(flag('--only')), frozenTests: readList(flag('--frozen-tests')) ?? new Set() });
  writeFileSync(out, JSON.stringify(plan, null, 2));
  printPlan(plan);
  console.log(`written ${out}`);
} else if (cmd === 'prompts') {
  const round = Number(args[0]);
  const planPath = args[1] ?? '/tmp/mut-plan.json';
  if (!round) { console.error('prompts <round> [plan.json]'); process.exit(2); }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const stages = plan.lang === 'ts' ? tsPrompts(round, plan, BRIEF, process.env.MUT_BASE || 'kiro-voc') : prompts(round, plan);
  console.log(JSON.stringify(stages, null, 2));
} else {
  console.error('usage: mutation-plan.mjs plan [--ts] [out.json] [--only list] [--frozen-tests list] [--baseline r.json,…] [--agents n] [--job-work n] | prompts <round> [plan.json]');
  process.exit(2);
}
