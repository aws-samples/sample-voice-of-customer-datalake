/**
 * Read-only CloudWatch Logs evidence for a step's time window: Lambda `REPORT`
 * lines (Duration, Billed, Memory Size / Max Memory Used, Init Duration), their
 * per-Lambda stats, and any lines matching a filter pattern. Runs through the
 * suite's one AWS CLI runner (lib/aws.ts, the operator's credentials).
 *
 * Every function takes a Lambda BASE name (`voc-chat-stream`, as in
 * lib/utils/function-names.ts); the physical name adds `-<account>-<region>`.
 * Steps may record their window with `recordWindow` so a final test resolves
 * them once CloudWatch has ingested the lines (it lags by a few seconds).
 */
import fs from 'node:fs'
import path from 'node:path'
import { aws, physicalName } from './aws'
import { OUT_DIR } from './env'
import { isRecord } from './guards'

/** CloudWatch ingestion lag: pad a window's end by this much so a just-finished invocation is still found. */
export const LOG_LAG_PAD_MS = 120_000

export function lambdaLogGroup(base: string): string {
  return `/aws/lambda/${physicalName(base)}`
}

// ── step windows ──────────────────────────────────────────────────────────────

export interface StepWindow {
  step: string
  startMs: number
  endMs: number
  /** Lambda base names (`voc-feedback-processor`). */
  lambdas: string[]
}

const WINDOWS_FILE = path.join(OUT_DIR, 'windows.json')

export function readWindows(): StepWindow[] {
  if (!fs.existsSync(WINDOWS_FILE)) return []
  const raw: unknown = JSON.parse(fs.readFileSync(WINDOWS_FILE, 'utf8'))
  return Array.isArray(raw)
    ? raw.filter((w): w is StepWindow => isRecord(w) && typeof w['step'] === 'string' && typeof w['startMs'] === 'number'
      && typeof w['endMs'] === 'number' && Array.isArray(w['lambdas']))
    : []
}

/** Appends (or replaces, by step name) a step's window. */
export function recordWindow(window: StepWindow): void {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const next = [...readWindows().filter((w) => w.step !== window.step), window]
  fs.writeFileSync(WINDOWS_FILE, JSON.stringify(next, null, 2))
}

// ── log events ────────────────────────────────────────────────────────────────

interface LogEvent {
  timestamp: number
  message: string
}

function isLogEvent(value: unknown): value is LogEvent {
  return isRecord(value) && typeof value['timestamp'] === 'number' && typeof value['message'] === 'string'
}

/**
 * `aws logs filter-log-events` over [startMs, endMs] (the CLI paginates; `max`
 * caps the items). [] when the group is absent or the CLI fails, so a missing
 * permission degrades the evidence instead of failing the step.
 */
export function filterLogEvents(logGroup: string, pattern: string, startMs: number, endMs: number, max?: number): LogEvent[] {
  try {
    const parsed = aws([
      'logs', 'filter-log-events', '--log-group-name', logGroup,
      '--start-time', String(Math.floor(startMs)), '--end-time', String(Math.ceil(endMs)),
      '--filter-pattern', pattern, ...(max === undefined ? [] : ['--max-items', String(max)]),
    ])
    const events = isRecord(parsed) ? parsed['events'] : undefined
    return Array.isArray(events) ? events.filter(isLogEvent) : []
  } catch (error) {
    console.warn(`filter-log-events ${logGroup} unavailable: ${scrubTokens(String(error)).slice(0, 160)}`)
    return []
  }
}

/** Masks anything shaped like a JWT, so a logged token can never reach the evidence. */
export function scrubTokens(text: string): string {
  return text.replace(/eyJ[\w-]+\.[\w-]+(\.[\w-]+)?/g, '<jwt>')
}

/** Matching log lines (scrubbed, truncated) of a Lambda in the window, padded for log lag. */
export function logLines(base: string, pattern: string, startMs: number, endMs: number, max = 50): string[] {
  return filterLogEvents(lambdaLogGroup(base), pattern, startMs, endMs + LOG_LAG_PAD_MS, max)
    .map((e) => `${new Date(e.timestamp).toISOString()} ${scrubTokens(e.message).trim().slice(0, 600)}`)
}

// ── REPORT lines ──────────────────────────────────────────────────────────────

export interface ReportLine {
  /** Base name. */
  lambda: string
  requestId: string
  at: string
  durationMs: number
  billedMs: number
  memorySizeMb: number
  maxMemoryUsedMb: number
  initDurationMs: number | null
}

const num = (pattern: RegExp, text: string): number | null => {
  const m = pattern.exec(text)
  return m?.[1] === undefined ? null : Number(m[1])
}

/** One REPORT line, or null when a mandatory field is missing. */
export function parseReport(lambda: string, message: string, timestamp: number): ReportLine | null {
  const requestId = /RequestId:\s*(\S+)/.exec(message)?.[1]
  // Anchored: "Billed Duration" and "Init Duration" must not match.
  const durationMs = num(/(?:^|\t)Duration:\s*([\d.]+) ms/, message)
  const billedMs = num(/Billed Duration:\s*([\d.]+) ms/, message)
  const memorySizeMb = num(/Memory Size:\s*(\d+) MB/, message)
  const maxMemoryUsedMb = num(/Max Memory Used:\s*(\d+) MB/, message)
  if (requestId === undefined || durationMs === null || billedMs === null || memorySizeMb === null || maxMemoryUsedMb === null) return null
  return {
    lambda,
    requestId,
    at: new Date(timestamp).toISOString(),
    durationMs,
    billedMs,
    memorySizeMb,
    maxMemoryUsedMb,
    initDurationMs: num(/Init Duration:\s*([\d.]+) ms/, message),
  }
}

/**
 * REPORT lines of one Lambda between two epoch-ms instants. Pass
 * `endMs + LOG_LAG_PAD_MS` when reading right after the step ended.
 */
export function reportLines(base: string, startMs: number, endMs: number): ReportLine[] {
  return filterLogEvents(lambdaLogGroup(base), '"REPORT RequestId"', startMs, endMs)
    .map((e) => parseReport(base, e.message, e.timestamp))
    .filter((r): r is ReportLine => r !== null)
}

export interface ReportStats {
  lambda: string
  invocations: number
  coldStarts: number
  durationP50Ms: number | null
  durationMaxMs: number | null
  maxMemoryUsedMb: number | null
  memorySizeMb: number | null
  initMaxMs: number | null
}

const pct = (values: number[], p: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null
}

export function statsOf(lambda: string, lines: readonly ReportLine[]): ReportStats {
  const durations = lines.map((l) => l.durationMs)
  const inits = lines.map((l) => l.initDurationMs).filter((n): n is number => n !== null)
  return {
    lambda,
    invocations: lines.length,
    coldStarts: inits.length,
    durationP50Ms: pct(durations, 50),
    durationMaxMs: durations.length === 0 ? null : Math.max(...durations),
    maxMemoryUsedMb: lines.length === 0 ? null : Math.max(...lines.map((l) => l.maxMemoryUsedMb)),
    memorySizeMb: lines[0]?.memorySizeMb ?? null,
    initMaxMs: inits.length === 0 ? null : Math.max(...inits),
  }
}
