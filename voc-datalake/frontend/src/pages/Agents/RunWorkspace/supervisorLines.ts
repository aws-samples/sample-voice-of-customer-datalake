/**
 * @fileoverview The supervisor's lines in a thread, read for a person (7.51.04). The supervisor words its messages for
 * the record (`lambda/engineering/runtime/supervisor.py`, its figures appended by `runtime/board_bus.py` `message`:
 * "1 booting (tokens 0, cost_usd 0.00)", "coordinator-1 continued in a new session (1). (continuation 1, after crash,
 * checkpoint none)", "coordinator-1 crashed 3 times."); each known shape is read here into what it says, which the
 * thread shows in plain words (its raw text kept behind "Details"), and a run of the same health line in a row is
 * folded into one line that shows the latest (its count beside it). An unknown line is shown as it is.
 *
 * @module pages/Agents/RunWorkspace/supervisorLines
 */
import type { ThreadItem } from '../../../api/engineeringRunWorkspaceApi'

/** A crash is continued twice (runtime/caps.py `max_crash_continuations`); the third fails the agent. */
export const CRASH_TRIES = 3

export type SupervisorLine =
  /** A tick's health: how many agents are in each status, and the run's cost so far. */
  | { readonly kind: 'health'; readonly counts: readonly { readonly status: string; readonly count: number }[]; readonly costUsd: number }
  /** An agent continued in a new session after a crash (its try of CRASH_TRIES), or after a pause. */
  | { readonly kind: 'restarted'; readonly agent: string; readonly attempt: number }
  | { readonly kind: 'continued'; readonly agent: string }
  /** An agent that crashed once too often (a coordinator's run then goes to a person; another's task is posted again). */
  | { readonly kind: 'failedOut'; readonly agent: string; readonly times: number }
  /** (7.51.03) An agent that could not start, and why. */
  | { readonly kind: 'couldNotStart'; readonly agent: string; readonly reason: string }
  | { readonly kind: 'notAnswering'; readonly agent: string }
  | { readonly kind: 'noRoom'; readonly agent: string; readonly times: number }
  | { readonly kind: 'stopped'; readonly sessions: number }

const FIGURES = ' (tokens '
const COUNT = /^(\d{1,6}) ([a-z_]{1,40})$/
const CONTINUED = /^(\S{1,128}) continued in a new session \((\d{1,6})\)\. \(continuation \d{1,6}, after (crash|pause), checkpoint \S{1,512}\)$/
const FAILED_OUT = /^(\S{1,128}) crashed (\d{1,6}) times\.$/
const COULD_NOT_START = /^(\S{1,128}) could not start\. (.+)$/s
const NOT_ANSWERING = /^(\S{1,128}) stopped answering\.$/
const NO_ROOM = /^(\S{1,128}) found no free agent session (\d{1,6}) times in a row: held for a person\.$/
const STOPPED = /^Stopped: (\d{1,6}) session\(s\) ended\.$/

/** A health line: "<n> <status>, <n> <status> (tokens <n>, cost_usd <usd>)". */
function health(text: string): SupervisorLine | null {
  const at = text.lastIndexOf(FIGURES)
  if (at <= 0 || !text.endsWith(')')) return null
  const [tokens, cost] = text.slice(at + FIGURES.length, -1).split(', cost_usd ')
  const usd = Number(cost)
  if (tokens === undefined || !/^\d{1,15}$/.test(tokens) || cost === undefined || cost === '' || !Number.isFinite(usd)) return null
  const counts = text.slice(0, at).split(', ').map((part) => COUNT.exec(part))
  if (counts.some((count) => count === null)) return null
  return {
    kind: 'health', costUsd: usd,
    counts: counts.flatMap((count) => (count === null ? [] : [{ status: count[2] ?? '', count: Number(count[1]) }])),
  }
}

/** One line of the supervisor's, read; null for a line of no known shape. */
export function readSupervisorLine(text: string): SupervisorLine | null {
  const continued = CONTINUED.exec(text)
  if (continued !== null) {
    const agent = continued[1] ?? ''
    // (the first session is the agent's first try: a continuation n after a crash is its try n + 1)
    return continued[3] === 'crash' ? { kind: 'restarted', agent, attempt: Number(continued[2]) + 1 } : { kind: 'continued', agent }
  }
  const failedOut = FAILED_OUT.exec(text)
  if (failedOut !== null) return { kind: 'failedOut', agent: failedOut[1] ?? '', times: Number(failedOut[2]) }
  const couldNotStart = COULD_NOT_START.exec(text)
  if (couldNotStart !== null) return { kind: 'couldNotStart', agent: couldNotStart[1] ?? '', reason: couldNotStart[2] ?? '' }
  const notAnswering = NOT_ANSWERING.exec(text)
  if (notAnswering !== null) return { kind: 'notAnswering', agent: notAnswering[1] ?? '' }
  const noRoom = NO_ROOM.exec(text)
  if (noRoom !== null) return { kind: 'noRoom', agent: noRoom[1] ?? '', times: Number(noRoom[2]) }
  const stopped = STOPPED.exec(text)
  if (stopped !== null) return { kind: 'stopped', sessions: Number(stopped[1]) }
  return health(text)
}

/** Whether an item is the supervisor's. */
export const isSupervisors = (item: ThreadItem): boolean => item.from.kind === 'supervisor'

/** The same health (each status's count), whatever the cost: a repeat of the line before. */
function sameHealth(a: SupervisorLine | null, b: SupervisorLine | null): boolean {
  if (a?.kind !== 'health' || b?.kind !== 'health') return false
  return a.counts.length === b.counts.length && a.counts.every((count, index) => (
    count.status === b.counts[index]?.status && count.count === b.counts[index]?.count))
}

/** An item as the thread shows it: the latest of a run of the same health line, with every item of the run. */
export interface ShownItem {
  /** The run's first item's ref: its place in the list, kept while the run grows. */
  readonly key: string
  readonly item: ThreadItem
  /** Every item it stands for, oldest first (itself alone, or a run of repeats). */
  readonly said: readonly ThreadItem[]
}

/** The thread's items with each run of the supervisor's same health line, one after another, folded into its latest. */
export function foldRepeats(items: readonly ThreadItem[]): ShownItem[] {
  const shown: ShownItem[] = []
  let previous: SupervisorLine | null = null
  for (const item of items) {
    const line = isSupervisors(item) ? readSupervisorLine(item.text) : null
    const last = shown.at(-1)
    if (last !== undefined && sameHealth(previous, line)) shown[shown.length - 1] = { key: last.key, item, said: [...last.said, item] }
    else shown.push({ key: item.ref, item, said: [item] })
    previous = line
  }
  return shown
}
