// TypeScript mode of scripts/mutation-plan.mjs (the per-file Stryker programme; the agent rules are the
// "TypeScript" section of scripts/mutation-brief.md, the runner voc-datalake/scripts/mutate-ts.sh).
//
// Inventory: every tracked .ts/.tsx source file of the three packages (frontend/src, lambda/stream/src,
// the CDK app's lib/ and bin/) except specs, .d.ts, test support, fixtures and ENTRY_POINTS. Each file is
// run through Stryker's own instrumenter (no tests, ~3 s for the whole tree), so a file's weight is its
// EXACT mutant count per line; a file with none (types only) is left out. A file's Stryker cost also
// depends on how many specs import it, directly or through other modules (a hook used by forty
// components re-runs forty components' specs per mutant), so the import graph gives each file a
// fan-in and the cost model below turns both into estimated seconds.
//
// Work: an agent's time goes into the mutants that survive. Without a baseline sweep a file is assumed to
// have SURVIVOR_RATE of them open (the pilot's mean); with `--baseline <report.json,...>` (Stryker JSON
// reports of `mutate-ts.sh <pkg> --all`) the exact Survived + NoCoverage count per line is used, and a
// file already at 0 costs only the reading/pruning share.
//   work(file) = mutants × READ_WORK + open mutants
// Jobs: files are packed in directory order (siblings share specs and context) until a job reaches
// --job-work, or its first Stryker run would exceed JOB_SECONDS; a file over either is sliced at
// top-level statement boundaries. Jobs never mix packages (one Stryker config per run).
// Rounds: --agents jobs at once, longest first; two slices of one file never share a round. Every existing
// spec has ONE owning job (its namesake's, else the one holding most of the files it imports): only the
// owner may edit or prune it, after re-running Stryker on the other planned files it tests; the others
// add tests in their own new spec files.
//
// Done state: scripts/mutation-done-ts.txt — `path` or `path:from-to`, relative to voc-datalake/ like
// the Python list (scripts/mutation-done.txt), kept apart so neither planner reads the other's entries.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { basename, dirname, extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TS_DONE_FILE = 'scripts/mutation-done-ts.txt';
const SURVIVOR_RATE = 0.25;
const READ_WORK = 0.15;
// ≈ 550 mutants of an unmeasured file (~140 open); an agent's ~2 h. Measured: stream 38 % open, the
// frontend pilot 23 %, the CDK partial sweep ≤ 48 %; SURVIVOR_RATE is used where no baseline exists.
export const DEFAULT_JOB_WORK = 220;
export const DEFAULT_AGENTS = 10;
const JOB_SECONDS = 1200; // the first full Stryker run of a job stays under 20 min at concurrency 2
const MIN_SLICE_MUTANTS = 20;

/** Stryker name, package dir and source dirs (both relative to voc-datalake/). */
export const TS_PACKAGES = [
  { name: 'frontend', dir: 'frontend', paths: ['frontend/src'] },
  { name: 'stream', dir: 'lambda/stream', paths: ['lambda/stream/src'] },
  { name: 'cdk', dir: '.', paths: ['lib', 'bin'] },
];

/** Left out on purpose, with the reason the brief repeats. */
export const ENTRY_POINTS = {
  'frontend/src/main.tsx': 'the React root bootstrap; only the built app (e2e) runs it',
  'bin/voc-datalake.ts': 'the CDK app entry; lib/test-support/synth-app.ts synthesizes it OUT of process, where no mutant is active',
};

const IS_SPEC = /\.(test|spec)\.tsx?$/;
const NOT_SOURCE = /\.d\.ts$|(^|\/)(test|test-support|__fixtures__)\/|-fixtures\.tsx?$/;

/**
 * Cost model: seconds of wall time at STRYKER_CONCURRENCY=2, fitted on the pilot (scripts/mutation-brief.md,
 * "TypeScript → Calibration"). A run pays one dry run (every related spec once) plus, per mutant, the
 * specs that cover it until one fails:
 *   dry = DRY[pkg] + fanIn × DRY_PER_SPEC[pkg]
 *   per mutant = min(PER_MUTANT_CAP, PER_MUTANT[pkg] + fanIn × PER_MUTANT_PER_SPEC[pkg])
 */
const DRY = { frontend: 10, stream: 3, cdk: 10 };
const DRY_PER_SPEC = { frontend: 1.3, stream: 0.1, cdk: 1.2 };
const PER_MUTANT = { frontend: 0.5, stream: 0.3, cdk: 2.0 };
const PER_MUTANT_PER_SPEC = { frontend: 0.03, stream: 0.005, cdk: 0 };
const PER_MUTANT_CAP = 4;

export function drySeconds(pkg, fanIn) {
  return Math.round(DRY[pkg] + fanIn * DRY_PER_SPEC[pkg]);
}

export function mutantSeconds(pkg, mutants, fanIn) {
  return Math.round(mutants * Math.min(PER_MUTANT_CAP, PER_MUTANT[pkg] + fanIn * PER_MUTANT_PER_SPEC[pkg]));
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
}

/** Every tracked file of a package: { sources, specs } as voc-datalake/-relative paths. */
function packageFiles(pkgRoot, pkg) {
  const inPkg = git(pkgRoot, ['ls-files', '--', ...pkg.paths]).filter((f) => /\.tsx?$/.test(f));
  return {
    sources: inPkg.filter((f) => !IS_SPEC.test(f) && !NOT_SOURCE.test(f)),
    specs: inPkg.filter((f) => IS_SPEC.test(f)),
    support: inPkg.filter((f) => !IS_SPEC.test(f) && NOT_SOURCE.test(f) && !f.endsWith('.d.ts')),
  };
}

// ---- import graph -------------------------------------------------------------------------------------
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;(=])import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]|vi\.(?:mock|importActual)\(\s*['"]([^'"]+)['"]/gm;

function resolveImport(pkgRoot, pkg, from, spec, known) {
  let base;
  if (spec.startsWith('.')) base = normalize(join(dirname(from), spec));
  else if (pkg.name === 'frontend' && spec.startsWith('@/')) base = join('frontend/src', spec.slice(2));
  else if (pkg.name === 'frontend' && spec.startsWith('@test/')) base = join('frontend/src/test', spec.slice(6));
  else return null;
  const stem = base.replace(/\.(js|jsx|mjs)$/, '');
  for (const cand of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`]) {
    if (known.has(cand)) return cand;
  }
  return null;
}

/** importers[file] = files that import it; directSpecs[file] = specs importing it (or vi.mock-ing it). */
function importGraph(pkgRoot, pkg, files) {
  const known = new Set(files);
  const importers = new Map(files.map((f) => [f, new Set()]));
  for (const file of files) {
    const text = readFileSync(join(pkgRoot, file), 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = resolveImport(pkgRoot, pkg, file, m[1] ?? m[2] ?? m[3] ?? m[4], known);
      if (target && target !== file) importers.get(target).add(file);
    }
  }
  return importers;
}

/** Specs that reach `file` through the import graph (the set vitest's `related` mode would run). */
function relatedSpecs(file, importers) {
  const seen = new Set([file]);
  const queue = [file];
  const specs = new Set();
  while (queue.length > 0) {
    const next = queue.pop();
    for (const imp of importers.get(next) ?? []) {
      if (seen.has(imp)) continue;
      seen.add(imp);
      if (IS_SPEC.test(imp)) specs.add(imp);
      else queue.push(imp);
    }
  }
  return specs;
}

// ---- mutants per line ---------------------------------------------------------------------------------
async function loadInstrumenter(pkgRoot) {
  const require = createRequire(join(pkgRoot, 'package.json'));
  const core = require.resolve('@stryker-mutator/core/package.json');
  const path = createRequire(core).resolve('@stryker-mutator/instrumenter');
  const { Instrumenter } = await import(pathToFileURL(path).href);
  const quiet = () => false;
  const noop = () => {};
  const logger = { isTraceEnabled: quiet, isDebugEnabled: quiet, isInfoEnabled: quiet, isWarnEnabled: quiet, isErrorEnabled: quiet, isFatalEnabled: quiet, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
  return new Instrumenter(logger);
}

/** perLine[n] = mutants starting on line n (1-based), Stryker-disabled ones left out. */
async function mutantsPerLine(instrumenter, pkgRoot, file) {
  const content = readFileSync(join(pkgRoot, file), 'utf8');
  if (content.includes('stryMutAct_9fa48')) {
    throw new Error(`${file} is instrumented: a Stryker run is active (or was killed) in this checkout`);
  }
  const lineCount = content.split('\n').length;
  const perLine = new Array(lineCount + 1).fill(0);
  const { mutants } = await instrumenter.instrument([{ name: file, content, mutate: true }], { plugins: null, excludedMutations: [], ignorers: [], noHeader: true });
  // The instrumenter's locations are 0-based (the JSON report's are 1-based).
  for (const m of mutants) if (m.status !== 'Ignored') perLine[m.location.start.line + 1] += 1;
  return { lineCount, perLine, total: perLine.reduce((a, b) => a + b, 0), content };
}

/** file (voc-datalake/-relative) → Map(line → Survived + NoCoverage mutants) from Stryker JSON reports,
 *  whose keys are relative to the package that wrote them (read from the report's projectRoot), plus the
 *  packages the reports cover (a package without a report keeps the assumed SURVIVOR_RATE). */
function baselineOpen(reports) {
  const open = new Map();
  open.packages = new Set();
  for (const path of reports) {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const root = String(report.projectRoot ?? '');
    const prefix = root.endsWith('/frontend') ? 'frontend/' : root.endsWith('/lambda/stream') ? 'lambda/stream/' : '';
    open.packages.add(prefix === 'frontend/' ? 'frontend' : prefix ? 'stream' : 'cdk');
    for (const [file, { mutants }] of Object.entries(report.files)) {
      const key = `${prefix}${file}`;
      const lines = open.get(key) ?? new Map();
      for (const m of mutants) {
        if (m.status !== 'Survived' && m.status !== 'NoCoverage') continue;
        lines.set(m.location.start.line, (lines.get(m.location.start.line) ?? 0) + 1);
      }
      open.set(key, lines);
    }
  }
  return open;
}

// ---- slicing ------------------------------------------------------------------------------------------
const TOP_LEVEL = /^(export\s|function\s|async\s|const\s|let\s|var\s|class\s|interface\s|type\s|enum\s|declare\s|abstract\s|\/\*\*|\/\/ ---)/;

/** The line intervals of a file no `path:from-to` entry of `done` covers (any order, gaps allowed);
 *  `[]` when the whole file is listed. Shared with the Python planner. */
export function doneGaps(file, lineCount, done) {
  if (done.has(file)) return [];
  const ranges = [...done]
    .map((e) => e.match(/^(.*):(\d+)-(\d+)$/))
    .filter((m) => m && m[1] === file)
    .map((m) => ({ from: Number(m[2]), to: Number(m[3]) }))
    .sort((a, b) => a.from - b.from);
  const open = [];
  let next = 1;
  for (const r of ranges) {
    if (r.from > next) open.push({ from: next, to: r.from - 1 });
    next = Math.max(next, r.to + 1);
  }
  if (next <= lineCount) open.push({ from: next, to: lineCount });
  return open;
}

/** Cut [from, to] into `count` pieces of similar work at top-level starts (else blank-line starts). */
function cutInterval(info, interval, count) {
  const { lines, workUpTo } = info;
  const starts = (re) => lines.map((l, i) => (re(l, i) ? i + 1 : 0)).filter((n) => n > interval.from + 1 && n <= interval.to);
  let cands = starts((l) => TOP_LEVEL.test(l));
  if (cands.length < count - 1) cands = [...new Set([...cands, ...starts((l, i) => i > 0 && lines[i - 1].trim() === '' && l.trim() !== '')])].sort((a, b) => a - b);
  const total = workUpTo[interval.to] - workUpTo[interval.from - 1];
  const pieces = [];
  let from = interval.from;
  for (let k = 1; k < count; k += 1) {
    const goal = workUpTo[interval.from - 1] + (total * k) / count;
    const usable = cands.filter((c) => c > from + 1);
    if (usable.length === 0) break;
    const cut = usable.reduce((best, c) => (Math.abs(workUpTo[c - 1] - goal) < Math.abs(workUpTo[best - 1] - goal) ? c : best));
    pieces.push({ from, to: cut - 1 });
    from = cut;
  }
  pieces.push({ from, to: interval.to });
  return pieces;
}

// ---- plan ---------------------------------------------------------------------------------------------
function newSpecName(file, range) {
  const ext = extname(file);
  const stem = basename(file, ext);
  return join(dirname(file), `${stem}.mutation${range ? `-${range}` : ''}.test${ext}`);
}

export async function buildTsPlan({ root, only = null, done = new Set(), baselines = [], agents = DEFAULT_AGENTS, jobWork = DEFAULT_JOB_WORK }) {
  const pkgRoot = join(root, 'voc-datalake');
  const instrumenter = await loadInstrumenter(pkgRoot);
  const open = baselines.length > 0 ? baselineOpen(baselines) : null;
  const units = [];
  const owners = new Map(); // spec → Map(jobKey → count), filled once jobs exist
  const specsOf = new Map();
  for (const pkg of TS_PACKAGES) {
    const { sources, specs, support } = packageFiles(pkgRoot, pkg);
    const importers = importGraph(pkgRoot, pkg, [...sources, ...specs, ...support]);
    for (const file of sources) {
      if (ENTRY_POINTS[file] || (only && !only.has(file))) continue;
      const info = await mutantsPerLine(instrumenter, pkgRoot, file);
      if (info.total === 0) continue;
      const related = relatedSpecs(file, importers);
      const direct = [...(importers.get(file) ?? [])].filter((f) => IS_SPEC.test(f)).sort();
      specsOf.set(file, direct);
      const rel = pkg.dir === '.' ? file : file.slice(pkg.dir.length + 1);
      const measured = open?.packages.has(pkg.name) ?? false;
      const openLines = measured ? (open.get(file) ?? new Map()) : null;
      const perLineWork = info.perLine.map((n, line) => n * READ_WORK + (openLines ? (openLines.get(line) ?? 0) : n * SURVIVOR_RATE));
      const workUpTo = [0];
      for (let l = 1; l <= info.lineCount; l += 1) workUpTo.push(workUpTo[l - 1] + perLineWork[l]);
      const mutUpTo = [0];
      for (let l = 1; l <= info.lineCount; l += 1) mutUpTo.push(mutUpTo[l - 1] + info.perLine[l]);
      const lines = info.content.split('\n');
      for (const interval of doneGaps(file, info.lineCount, done)) {
        const mutants = mutUpTo[interval.to] - mutUpTo[interval.from - 1];
        if (mutants === 0) continue;
        const work = workUpTo[interval.to] - workUpTo[interval.from - 1];
        const dry = drySeconds(pkg.name, related.size);
        // Slicing pays the dry run again per slice, so only the per-mutant time decides it.
        const count = Math.max(1, Math.ceil(work / jobWork), Math.ceil(mutantSeconds(pkg.name, mutants, related.size) / Math.max(300, JOB_SECONDS - dry)));
        const pieces = count === 1 ? [interval] : cutInterval({ lines, workUpTo }, interval, Math.min(count, Math.ceil(mutants / MIN_SLICE_MUTANTS)));
        const whole = pieces.length === 1 && interval.from === 1 && interval.to === info.lineCount;
        for (const p of pieces) {
          const m = mutUpTo[p.to] - mutUpTo[p.from - 1];
          if (m === 0) continue;
          const range = whole ? null : `${p.from}-${p.to}`;
          units.push({
            pkg: pkg.name, pkgDir: pkg.dir, file, rel, range, from: p.from, to: p.to, mutants: m,
            open: openLines ? [...openLines].filter(([l]) => l >= p.from && l <= p.to).reduce((t, [, n]) => t + n, 0) : null,
            work: Math.round((workUpTo[p.to] - workUpTo[p.from - 1]) * 10) / 10,
            fan_in: related.size, dry, seconds: mutantSeconds(pkg.name, m, related.size),
            specs: direct, sliced: !whole,
            new_spec: newSpecName(file, range),
          });
        }
      }
    }
  }

  // Jobs: next-fit in package + path order, so a job is one directory's neighbourhood.
  units.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.file.localeCompare(b.file) || a.from - b.from);
  const jobs = [];
  let cur = null;
  for (const u of units) {
    // One dry run per job: its specs are (roughly) the union, so the largest target's dry run stands for it.
    const seconds = (j) => Math.max(j.dry, u.dry) + j.mutantSeconds + u.seconds;
    const fits = cur && cur.pkg === u.pkg && cur.work + u.work <= jobWork && seconds(cur) <= JOB_SECONDS
      && !cur.targets.some((t) => t.file === u.file);
    if (!fits) { cur = { pkg: u.pkg, pkgDir: u.pkgDir, targets: [], work: 0, dry: 0, mutantSeconds: 0, seconds: 0, mutants: 0 }; jobs.push(cur); }
    cur.targets.push(u);
    cur.work = Math.round((cur.work + u.work) * 10) / 10;
    cur.dry = Math.max(cur.dry, u.dry);
    cur.mutantSeconds += u.seconds;
    cur.seconds = cur.dry + cur.mutantSeconds;
    cur.mutants += u.mutants;
  }
  jobs.forEach((j, i) => {
    j.id = `ts${String(i + 1).padStart(3, '0')}`;
    const first = j.targets[0].file.replace(/^(frontend\/src|lambda\/stream\/src|lib|bin)\//, '').replace(/\.tsx?$/, '').replace(/[/.]/g, '-');
    j.branch = `kiro-voc-mut/ts-${j.pkg}-${first}${j.targets[0].range ? `-${j.targets[0].range}` : ''}`;
    j.title = `${j.pkg}: ${j.targets.map((t) => `${t.file}${t.range ? `:${t.range}` : ''}`).join(', ')}`.slice(0, 200);
  });

  // Spec ownership: the namesake (`x.test.tsx` → `x.tsx` in the same dir, any slice's job → the first
  // one), else the job holding most of the files the spec imports; ties → the earlier job.
  const stemOf = (f) => join(dirname(f), basename(f).replace(/(\.mutation[-\d]*)?\.(test|spec)\.tsx?$/, '').replace(/\.tsx?$/, ''));
  for (const j of jobs) for (const t of j.targets) for (const s of t.specs) {
    const tally = owners.get(s) ?? new Map();
    const namesake = stemOf(s) === stemOf(t.file) ? 1000 : 1;
    tally.set(j.id, (tally.get(j.id) ?? 0) + namesake);
    owners.set(s, tally);
  }
  const ownerOf = new Map([...owners].map(([s, tally]) => [s, [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]]));
  for (const j of jobs) {
    const specs = [...new Set(j.targets.flatMap((t) => t.specs))].sort();
    j.owned_specs = specs.filter((s) => ownerOf.get(s) === j.id);
    j.read_only_specs = specs.filter((s) => ownerOf.get(s) !== j.id).map((s) => ({ spec: s, owner: ownerOf.get(s) }));
    j.files = [...new Set(j.targets.map((t) => t.file))];
  }
  // Before pruning a test from an owned spec, the owner re-runs Stryker on every OTHER planned file that
  // spec imports directly (that test may be what kills their mutants).
  for (const j of jobs) {
    j.prune_check = j.owned_specs.map((s) => ({
      spec: s,
      also_tests: [...new Set(units.filter((u) => u.specs.includes(s) && !j.files.includes(u.file)).map((u) => u.file))].sort(),
    })).filter((p) => p.also_tests.length > 0);
  }

  // Rounds: longest first into the lightest round with room and no clash. Two jobs clash only when they
  // hold slices of one file. A job may prune a spec another job's mutants rely on in the same round:
  // `prune_check` makes the owner re-run those files before deleting a test, which protects them.
  const rounds = [];
  const clash = (r, j) => r.some((x) => x.files.some((f) => j.files.includes(f)));
  const load = (r) => r.reduce((t, x) => t + x.work, 0);
  for (const j of [...jobs].sort((a, b) => b.work - a.work)) {
    const target = rounds.filter((r) => r.length < agents && !clash(r, j)).sort((a, b) => load(a) - load(b))[0];
    if (target) target.push(j); else rounds.push([j]);
  }
  return {
    lang: 'ts', generated: new Date().toISOString(), agents_per_round: agents,
    stryker_concurrency: strykerConcurrency(agents), job_work: jobWork, job_seconds: JOB_SECONDS,
    baseline: baselines, measured_packages: open ? [...open.packages] : [], survivor_rate_assumed: SURVIVOR_RATE,
    excluded: ENTRY_POINTS, done: [...done], rounds,
  };
}

/** Each agent's share of the CPUs for its Stryker test runners (never below 2: one runner is too slow). */
export function strykerConcurrency(agents) {
  return Math.max(2, Math.floor((availableParallelism() * 1.5) / agents));
}

export function printTsPlan(plan) {
  let mutants = 0;
  let jobs = 0;
  plan.rounds.forEach((r, i) => {
    const longest = Math.max(...r.map((j) => j.seconds));
    console.log(`round ${i + 1}: ${r.length} jobs, work ${Math.round(r.reduce((t, j) => t + j.work, 0))}, longest first Stryker run ~${Math.round(longest / 60)} min`);
    for (const j of r) {
      mutants += j.mutants; jobs += 1;
      console.log(`  ${j.id} ${j.pkg.padEnd(8)} ${String(j.mutants).padStart(4)} mutants, work ${String(j.work).padStart(5)}, ~${String(Math.round(j.seconds / 60)).padStart(2)} min, ${j.targets.length} target(s): ${j.targets[0].file}${j.targets[0].range ? `:${j.targets[0].range}` : ''}${j.targets.length > 1 ? ` … ${j.targets.at(-1).file}` : ''}`);
    }
  });
  console.log(`${jobs} jobs in ${plan.rounds.length} rounds (${plan.agents_per_round} agents, STRYKER_CONCURRENCY=${plan.stryker_concurrency}), ${mutants} mutants open, ${plan.done.length} done entries`);
}

export function tsPrompts(round, plan, brief, base) {
  const jobs = plan.rounds[round - 1] ?? [];
  return jobs.map((j, i) => {
    const n = i + 1;
    const dir = `/tmp/mut-${round}-${n}`;
    const pkgPath = j.pkgDir === '.' ? 'voc-datalake' : `voc-datalake/${j.pkgDir}`;
    const targets = j.targets.map((t) => `${t.rel}${t.range ? `:${t.range}` : ''}`).join(' ');
    const lines = j.targets.map((t) => `  - voc-datalake/${t.file}${t.range ? ` lines ${t.range} (slice: other slices of this file are other jobs)` : ''}: ${t.mutants} mutants${t.open === null ? '' : `, ${t.open} open in the baseline`}, ${t.fan_in} related spec(s). New spec if you need one: voc-datalake/${t.new_spec}`);
    const owned = j.owned_specs.map((s) => `voc-datalake/${s}`).join(', ') || 'none';
    const readOnly = j.read_only_specs.map((s) => `voc-datalake/${s.spec} (owner ${s.owner})`).join(', ') || 'none';
    return {
      name: `mut-${round}-${n}`,
      role: 'general-task-execution',
      prompt_template: [
        `Read ${dir}/${brief} first — the TypeScript section — and follow it exactly.`,
        `Worktree: ${dir} (cd there || exit 1 in every command). Branch: already checked out.`,
        `Job ${j.id}, package ${j.pkg} (${pkgPath}): ${j.mutants} mutants, first Stryker run ~${Math.max(1, Math.round(j.seconds / 60))} min. Targets:`,
        ...lines,
        ...(j.prune_check.length > 0 ? [`Before deleting a test from an owned spec, also run mutate-ts.sh on the other files it tests and keep the test if it kills any of their mutants: ${j.prune_check.map((p) => `${p.spec} → ${p.also_tests.join(' ')}`).join('; ')}.`] : []),
        `Run (from voc-datalake/): STRYKER_CONCURRENCY=${plan.stryker_concurrency} bash scripts/mutate-ts.sh ${j.pkg} ${targets}`,
        `Existing specs YOU own (edit and prune): ${owned}.`,
        `Existing specs owned by another job (read, never edit; add your tests in your new spec): ${readOnly}.`,
        `Gates: targeted only (the brief's TypeScript gates); never the full scripts/validate.sh. Final check: \`bash scripts/validate-affected.sh ${base}\`.`,
        'Report in the brief\'s TypeScript format, under 3,000 characters.',
      ].join('\n'),
    };
  });
}

export function tsDoneSet(root, readList) {
  const path = join(root, TS_DONE_FILE);
  return existsSync(path) ? readList(path) : new Set();
}
