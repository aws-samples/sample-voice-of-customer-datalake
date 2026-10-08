/**
 * Measure every deployed `voc-*` Lambda against the sizing policy (./policy.ts).
 *
 * READ-ONLY by construction: the only AWS calls are `lambda list-functions`,
 * `logs describe-log-groups`, `logs start-query` and `logs get-query-results`
 * (Logs Insights), run through a caller-supplied CLI runner — the operator's own
 * credentials (scripts/capacity/capacity-report.ts, frontend/e2e/tests/ops-capacity.spec.ts).
 *
 * Sources, per function and per MemorySize seen in the window (so a window that
 * spans a resize never mixes the two sizes):
 * - REPORT lines: invocations and PEAK memory (max of max_memory_used / MemorySize);
 * - `invocation_cost` lines: how many calls logged one, and — over the calls that ran
 *   ≥ CPU_LONG_CALL_MS only — the wall-weighted CPU share and the p95 share.
 * A function measured only at another size is PROJECTED to the size being judged
 * (share × measured MB / judged MB — CPU share and memory % both scale with 1/MB),
 * and the row says so. CPU is "insufficient data" below CPU_MIN_LONG_CALLS long
 * calls, and not judged at all at a size Power Tuning pinned (POWER_TUNED).
 *
 * Dependency-free (type guards, no zod) because the e2e package imports it.
 */
import { byCodeUnit } from '../utils/compare';
import {
  CPU_LONG_CALL_MS,
  CPU_MAX_PCT,
  CPU_MIN_LONG_CALLS,
  CPU_NOT_MEASURED,
  MB_PER_VCPU,
  memoryCeilingPct,
  nextMemoryStep,
  powerTuningPin,
  sizingClass,
  type PowerTuningRecord,
  type SizingClass,
} from './policy';

/** `aws <args> --region … --output json`, parsed. Throws when the CLI fails. */
export type AwsRunner = (args: readonly string[]) => unknown;

export interface DeployedFunction {
  name: string;
  /** Physical name without `-<account>-<region>`. */
  stem: string;
  memoryMb: number;
  timeoutS: number;
  logGroup: string;
}

export interface MemoryStat {
  /** MemorySize the REPORT lines were written at. */
  memoryMb: number;
  invocations: number;
  peakPct: number;
}

export interface CpuStat {
  /** `function_memory_size` of the lines (null when the lines lack it). */
  memoryMb: number | null;
  /** Every call that logged `invocation_cost`. */
  calls: number;
  /** Calls that ran ≥ CPU_LONG_CALL_MS: the only ones either figure is computed over. */
  longCalls: number;
  /** Wall-weighted share over the long calls. */
  weightedPct: number | null;
  /** p95 share over the long calls. */
  p95LongPct: number | null;
}

export interface Measured<T> {
  value: T;
  measuredAtMb: number;
  projected: boolean;
}

/**
 * How the CPU rule came out: judged against the ceiling, too few long calls to judge,
 * waived by a Power Tuning pin, no `invocation_cost` line in the window, or never
 * measured by design.
 */
type CpuStatus = 'judged' | 'insufficient-data' | 'power-tuned' | 'unmeasured' | 'by-design';

export interface FunctionCapacity {
  stem: string;
  /** The size judged: the deployed one, or a target (`targetSizes`). */
  memoryMb: number;
  deployedMb: number;
  sizing: SizingClass;
  memoryCeilingPct: number;
  invocations: number;
  peakMemPct: Measured<number> | null;
  cpu: Measured<{ calls: number; weightedPct: number | null; longCalls: number; p95LongPct: number | null; worstPct: number | null }> | null;
  cpuStatus: CpuStatus;
  /** The Power Tuning run that pinned the judged size, when one did. */
  powerTuning: PowerTuningRecord | null;
  /** Why CPU is never measured for this function, when that is by design. */
  cpuNotMeasured: string | null;
  breaches: string[];
  unmeasured: Array<'memory' | 'cpu'>;
}

// ── queries ───────────────────────────────────────────────────────────────────

export const REPORT_QUERY = [
  'filter @type = "REPORT"',
  '| stats count() as n, max(@maxMemoryUsed / @memorySize * 100) as peakPct by @log, @memorySize',
].join(' ');

/** How many calls logged a CPU line at all (context for the long-call figures). */
export const COST_QUERY = [
  'filter message = "invocation_cost"',
  '| stats count() as n by @log, function_memory_size',
].join(' ');

/** Both CPU figures, over the calls that ran ≥ CPU_LONG_CALL_MS only. */
export const LONG_COST_QUERY = [
  `filter message = "invocation_cost" and wall_ms >= ${CPU_LONG_CALL_MS}`,
  '| stats count() as n, sum(cpu_pct_of_allocation * wall_ms) / sum(wall_ms) as weightedPct,',
  'pct(cpu_pct_of_allocation, 95) as p95 by @log, function_memory_size',
].join(' ');

/** Logs Insights accepts at most 50 log groups per query. */
const GROUPS_PER_QUERY = 50;

// ── parsing (type guards; the CLI's JSON is untrusted shape) ──────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayAt(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  const found = value[key];
  return Array.isArray(found) ? found : [];
}

function stringAt(value: Record<string, unknown>, key: string): string | undefined {
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
}

function numberAt(value: Record<string, unknown>, key: string): number | undefined {
  const found = value[key];
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined;
}

/** `voc-x-123456789012-us-west-2` → `voc-x`. */
export function functionStem(name: string): string {
  return name.replace(/-\d{12}-[a-z]{2}(-[a-z]+)+-\d$/, '');
}

/** One Insights result row (`[{field, value}]`) as a plain record of strings. */
export function insightsRow(row: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(row)) return out;
  for (const cell of row) {
    if (!isRecord(cell)) continue;
    const field = stringAt(cell, 'field');
    const value = stringAt(cell, 'value');
    if (field !== undefined && value !== undefined) out[field] = value;
  }
  return out;
}

function num(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** `@log` is `<account>:<log group>`. */
function logGroupOf(row: Record<string, string>): string {
  const raw = row['@log'] ?? '';
  const colon = raw.indexOf(':');
  return colon >= 0 ? raw.slice(colon + 1) : raw;
}

/** list-functions output → the deployed `voc-*` functions. */
export function parseFunctions(listed: unknown): DeployedFunction[] {
  const out: DeployedFunction[] = [];
  for (const fn of arrayAt(listed, 'Functions')) {
    if (!isRecord(fn)) continue;
    const name = stringAt(fn, 'FunctionName');
    const memoryMb = numberAt(fn, 'MemorySize');
    if (name === undefined || !name.startsWith('voc-') || memoryMb === undefined) continue;
    const logging = fn['LoggingConfig'];
    const logGroup = (isRecord(logging) ? stringAt(logging, 'LogGroup') : undefined) ?? `/aws/lambda/${name}`;
    out.push({ name, stem: functionStem(name), memoryMb, timeoutS: numberAt(fn, 'Timeout') ?? 0, logGroup });
  }
  return out.sort((a, b) => byCodeUnit(a.stem, b.stem));
}

/** REPORT rows → stats by log group. `@memorySize` is in bytes of 10^6 (1024 MB → 1024000000). */
export function parseMemoryStats(rows: readonly unknown[]): Map<string, MemoryStat[]> {
  const out = new Map<string, MemoryStat[]>();
  for (const raw of rows) {
    const row = insightsRow(raw);
    const bytes = num(row['@memorySize']);
    const invocations = num(row['n']);
    const peakPct = num(row['peakPct']);
    if (bytes === null || invocations === null || peakPct === null) continue;
    const group = logGroupOf(row);
    out.set(group, [...(out.get(group) ?? []), { memoryMb: Math.round(bytes / 1e6), invocations, peakPct }]);
  }
  return out;
}

/** invocation_cost rows (all calls) + long-call rows (both figures) → stats by log group. */
export function parseCpuStats(costRows: readonly unknown[], longRows: readonly unknown[]): Map<string, CpuStat[]> {
  const key = (row: Record<string, string>): string => `${logGroupOf(row)}\u0000${row['function_memory_size'] ?? ''}`;
  const long = new Map(longRows.map((raw) => {
    const row = insightsRow(raw);
    return [key(row), { n: num(row['n']) ?? 0, weighted: num(row['weightedPct']), p95: num(row['p95']) }] as const;
  }));
  const out = new Map<string, CpuStat[]>();
  for (const raw of costRows) {
    const row = insightsRow(raw);
    const calls = num(row['n']);
    if (calls === null) continue;
    const longStat = long.get(key(row));
    const group = logGroupOf(row);
    out.set(group, [...(out.get(group) ?? []), {
      memoryMb: num(row['function_memory_size']),
      calls,
      longCalls: longStat?.n ?? 0,
      weightedPct: longStat?.weighted ?? null,
      p95LongPct: longStat?.p95 ?? null,
    }]);
  }
  return out;
}

// ── evaluation ────────────────────────────────────────────────────────────────

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** The stat at `memoryMb`, else the one at the largest other size (sizes only ever went up). */
function pick<T extends { memoryMb: number | null }>(stats: readonly T[], memoryMb: number): T | null {
  const exact = stats.find((s) => s.memoryMb === memoryMb);
  if (exact !== undefined) return exact;
  const sized = [...stats].sort((a, b) => (b.memoryMb ?? 0) - (a.memoryMb ?? 0));
  return sized[0] ?? null;
}

/** A % of one size, re-expressed at another (both memory % and CPU share scale with 1/MB). */
function scale(pct: number | null, fromMb: number, toMb: number): number | null {
  return pct === null ? null : round1((pct * fromMb) / toMb);
}

/** Peak memory at the judged size, or null when no REPORT line was seen. */
function judgeMemory(mem: MemoryStat | null, judgedMb: number): FunctionCapacity['peakMemPct'] {
  if (mem === null) return null;
  return { value: scale(mem.peakPct, mem.memoryMb, judgedMb) ?? 0, measuredAtMb: mem.memoryMb, projected: mem.memoryMb !== judgedMb };
}

/** Both long-call CPU figures and the worse of them at the judged size, or null when no cost line was seen. */
function judgeCpu(cpuStats: readonly CpuStat[], deployedMb: number, judgedMb: number): FunctionCapacity['cpu'] {
  const stat = pick(cpuStats, judgedMb);
  if (stat === null) return null;
  // Lines without function_memory_size (none expected) are taken at the deployed size.
  const at = stat.memoryMb ?? deployedMb;
  const hasLong = stat.longCalls > 0;
  const weightedPct = hasLong ? scale(stat.weightedPct, at, judgedMb) : null;
  const p95LongPct = hasLong ? scale(stat.p95LongPct, at, judgedMb) : null;
  const figures = [weightedPct, p95LongPct].filter((v): v is number => v !== null);
  return {
    value: { calls: stat.calls, weightedPct, longCalls: stat.longCalls, p95LongPct, worstPct: figures.length > 0 ? Math.max(...figures) : null },
    measuredAtMb: at,
    projected: at !== judgedMb,
  };
}

/** How the CPU rule applies, before any comparison with the ceiling. */
function cpuStatusOf(cpu: FunctionCapacity['cpu'], cpuNotMeasured: string | null, pinned: PowerTuningRecord | null): CpuStatus {
  if (cpuNotMeasured !== null) return 'by-design';
  if (cpu === null) return 'unmeasured';
  if (pinned !== null) return 'power-tuned';
  return cpu.value.longCalls < CPU_MIN_LONG_CALLS ? 'insufficient-data' : 'judged';
}

/** Breaches and measurement gaps for one function's judged figures. */
function verdicts(
  peakMemPct: FunctionCapacity['peakMemPct'], ceiling: number, cpu: FunctionCapacity['cpu'], cpuStatus: CpuStatus,
): Pick<FunctionCapacity, 'breaches' | 'unmeasured'> {
  const breaches: string[] = [];
  const unmeasured: Array<'memory' | 'cpu'> = [];
  if (peakMemPct === null) unmeasured.push('memory');
  else if (peakMemPct.value > ceiling) breaches.push(`peak memory ${peakMemPct.value}% > ${ceiling}%`);
  const worstCpu = cpu?.value.worstPct ?? null;
  if (cpuStatus === 'unmeasured') unmeasured.push('cpu');
  else if (cpuStatus === 'judged' && worstCpu !== null && worstCpu > CPU_MAX_PCT) breaches.push(`CPU ${worstCpu}% > ${CPU_MAX_PCT}%`);
  return { breaches, unmeasured };
}

/** Judge one function. `judgedMb` is the size to judge (deployed unless a target is given). */
export function evaluateFunction(
  fn: Pick<DeployedFunction, 'stem' | 'memoryMb'>,
  memoryStats: readonly MemoryStat[],
  cpuStats: readonly CpuStat[],
  judgedMb: number = fn.memoryMb,
): FunctionCapacity {
  const ceiling = memoryCeilingPct(fn.stem);
  const cpuNotMeasured = CPU_NOT_MEASURED[fn.stem] ?? null;
  const mem = pick(memoryStats, judgedMb);
  const peakMemPct = judgeMemory(mem, judgedMb);
  const cpu = judgeCpu(cpuStats, fn.memoryMb, judgedMb);
  const powerTuning = powerTuningPin(fn.stem, judgedMb);
  const cpuStatus = cpuStatusOf(cpu, cpuNotMeasured, powerTuning);
  return {
    stem: fn.stem,
    memoryMb: judgedMb,
    deployedMb: fn.memoryMb,
    sizing: sizingClass(fn.stem),
    memoryCeilingPct: ceiling,
    invocations: mem?.invocations ?? 0,
    peakMemPct,
    cpu,
    cpuStatus,
    powerTuning,
    cpuNotMeasured,
    ...verdicts(peakMemPct, ceiling, cpu, cpuStatus),
  };
}

// ── collection (read-only AWS) ────────────────────────────────────────────────

export interface CollectOptions {
  startSec: number;
  endSec: number;
  sleep?: (ms: number) => Promise<void>;
  /** Poll limit per query (default 90 × 2 s). */
  maxPolls?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The function log groups that exist (a never-created group would fail the whole query). */
function existingGroups(run: AwsRunner, groups: readonly string[]): Set<string> {
  const patterns = new Set(groups.map((g) => (g.startsWith('/aws/lambda/voc-') ? '/aws/lambda/voc-' : g)));
  const found = new Set<string>();
  for (const pattern of patterns) {
    const body = run(['logs', 'describe-log-groups', '--log-group-name-prefix', pattern]);
    for (const group of arrayAt(body, 'logGroups')) {
      const name = isRecord(group) ? stringAt(group, 'logGroupName') : undefined;
      if (name !== undefined) found.add(name);
    }
  }
  return found;
}

const TERMINAL_FAILURES = new Set(['Failed', 'Cancelled', 'Timeout']);

/** Poll one started query until it completes; its result rows. */
async function waitForQuery(run: AwsRunner, queryId: string, options: CollectOptions): Promise<unknown[]> {
  const sleep = options.sleep ?? defaultSleep;
  for (let poll = 0; poll < (options.maxPolls ?? 90); poll += 1) {
    await sleep(2000);
    const result = run(['logs', 'get-query-results', '--query-id', queryId]);
    const status = isRecord(result) ? stringAt(result, 'status') : undefined;
    if (status === 'Complete') return arrayAt(result, 'results');
    if (status !== undefined && TERMINAL_FAILURES.has(status)) throw new Error(`Insights query ${status}`);
  }
  throw new Error('Insights query did not complete');
}

/** Run one Insights query over `groups` (in batches of 50) and return every result row. */
export async function insightsQuery(run: AwsRunner, groups: readonly string[], query: string, options: CollectOptions): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let i = 0; i < groups.length; i += GROUPS_PER_QUERY) {
    const started = run(['logs', 'start-query', '--log-group-names', ...groups.slice(i, i + GROUPS_PER_QUERY),
      '--start-time', String(options.startSec), '--end-time', String(options.endSec),
      '--limit', '10000', '--query-string', query]);
    const queryId = isRecord(started) ? stringAt(started, 'queryId') : undefined;
    if (queryId === undefined) throw new Error('logs start-query returned no queryId');
    rows.push(...await waitForQuery(run, queryId, options));
  }
  return rows;
}

export interface CapacityReport {
  window: { startSec: number; endSec: number };
  functions: FunctionCapacity[];
}

/**
 * Measure every deployed `voc-*` function over the window. `targetSizes` (stem → MB)
 * judges a function at a size other than the deployed one — e.g. the repo's
 * `MEMORY_SIZES` before a release that changes them is deployed.
 */
export async function collectCapacity(
  run: AwsRunner,
  options: CollectOptions & { targetSizes?: Readonly<Record<string, number | null>> },
): Promise<CapacityReport> {
  const deployed = parseFunctions(run(['lambda', 'list-functions']));
  const exists = existingGroups(run, deployed.map((f) => f.logGroup));
  const groups = [...new Set(deployed.map((f) => f.logGroup).filter((g) => exists.has(g)))];
  const [report, cost, longCost] = [
    await insightsQuery(run, groups, REPORT_QUERY, options),
    await insightsQuery(run, groups, COST_QUERY, options),
    await insightsQuery(run, groups, LONG_COST_QUERY, options),
  ];
  const memory = parseMemoryStats(report);
  const cpu = parseCpuStats(cost, longCost);
  return {
    window: { startSec: options.startSec, endSec: options.endSec },
    functions: deployed.map((fn) => {
      const target = options.targetSizes?.[fn.stem];
      return evaluateFunction(fn, memory.get(fn.logGroup) ?? [], cpu.get(fn.logGroup) ?? [], typeof target === 'number' ? target : fn.memoryMb);
    }),
  };
}

// ── rendering ────────────────────────────────────────────────────────────────

function cell(measured: Measured<number | null> | null, digits = 1): string {
  const value = measured?.value ?? null;
  if (measured === null || value === null) return '—';
  const shown = value.toFixed(digits);
  return measured.projected ? `${shown} (from ${measured.measuredAtMb} MB)` : shown;
}

/** What to do about a breach: one step up, or Power Tuning once a step buys no more CPU. */
export function remedy(fn: Pick<FunctionCapacity, 'memoryMb' | 'breaches'>): string | null {
  if (fn.breaches.length === 0) return null;
  const next = nextMemoryStep(fn.memoryMb);
  if (next === fn.memoryMb) return 'at the top of the ladder: Power Tuning (docs/lambda-sizing.md)';
  const cpuNote = fn.memoryMb >= MB_PER_VCPU ? ' (above 1 vCPU a step adds RAM, not CPU: Power Tuning first)' : '';
  return `raise one step to ${next} MB${cpuNote}`;
}

function verdictText(fn: FunctionCapacity): string {
  if (fn.breaches.length > 0) return `BREACH: ${fn.breaches.join('; ')} → ${remedy(fn) ?? ''}`;
  if (fn.unmeasured.length > 0) return `unmeasured: ${fn.unmeasured.join(', ')}`;
  if (fn.cpuStatus === 'insufficient-data') return `OK (CPU: insufficient data, ${fn.cpu?.value.longCalls ?? 0} calls ≥ ${CPU_LONG_CALL_MS} ms)`;
  if (fn.cpuStatus === 'power-tuned') return 'OK (CPU: Power Tuning pin)';
  return 'OK';
}

function cpuCells(fn: FunctionCapacity): [string, string] {
  if (fn.cpuNotMeasured !== null) return ['n/a', 'n/a'];
  if (fn.cpu === null) return ['—', '—'];
  const { value, ...where } = fn.cpu;
  return [`${cell({ ...where, value: value.weightedPct })} (${value.longCalls}/${value.calls})`, cell({ ...where, value: value.p95LongPct })];
}

function renderRow(fn: FunctionCapacity): string {
  const mb = fn.memoryMb === fn.deployedMb ? String(fn.memoryMb) : `${fn.memoryMb} (deployed ${fn.deployedMb})`;
  const peak = `${cell(fn.peakMemPct)} (${fn.memoryCeilingPct})`;
  const [weighted, long] = cpuCells(fn);
  return ['', fn.stem, fn.sizing, mb, String(fn.invocations), peak, weighted, long, verdictText(fn), ''].join(' | ').trim();
}

/** `label (n): a, b` — or `label (0): none`. */
function listLine(label: string, items: readonly string[]): string {
  return `${label} (${items.length}): ${items.length === 0 ? 'none' : items.join(', ')}`;
}

/** A Markdown table, one row per function, then the unmeasured, insufficient, pinned and by-design lists. */
export function renderReport(report: CapacityReport): string {
  const lines = [
    `| Function | Class | MB | Invocations | Peak mem % (ceiling) | CPU weighted % ≥${CPU_LONG_CALL_MS} ms (long/all calls) | CPU p95 % ≥${CPU_LONG_CALL_MS} ms | Verdict |`,
    '|---|---|---|---|---|---|---|---|',
    ...report.functions.map(renderRow),
  ];
  const withStatus = (status: CpuStatus): FunctionCapacity[] => report.functions.filter((f) => f.cpuStatus === status);
  lines.push(
    '',
    listLine('Unmeasured in the window', report.functions.filter((f) => f.unmeasured.length > 0).map((f) => `${f.stem} [${f.unmeasured.join(', ')}]`)),
    listLine(`CPU insufficient data (< ${CPU_MIN_LONG_CALLS} calls ≥ ${CPU_LONG_CALL_MS} ms, not a breach)`,
      withStatus('insufficient-data').map((f) => `${f.stem} (${f.cpu?.value.longCalls ?? 0})`)),
    listLine('CPU rule waived by a Power Tuning pin (peak memory still judged)',
      withStatus('power-tuned').map((f) => `${f.stem} @ ${f.memoryMb} MB (${f.powerTuning?.date ?? ''})`)),
  );
  const byDesign = withStatus('by-design').map((f) => `${f.stem} (${f.cpuNotMeasured ?? ''})`);
  if (byDesign.length > 0) lines.push(`CPU not measured by design: ${byDesign.join('; ')}`);
  return lines.join('\n');
}

export function breaches(report: CapacityReport): FunctionCapacity[] {
  return report.functions.filter((f) => f.breaches.length > 0);
}
