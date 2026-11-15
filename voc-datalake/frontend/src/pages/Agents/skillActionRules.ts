/**
 * @fileoverview The Skills screens' action rules (SkillActions.tsx): which actions a version offers, why Accept is
 * held back for a coach's version, and the Record benchmark form read into what the server takes (its pass rates in
 * percent, its cases and reasons one per line or comma, its failure's case one of the cases). The server checks all of
 * it again; these only say what to fix before a request is sent.
 *
 * @module pages/Agents/skillActionRules
 */
import { useTranslation } from 'react-i18next'
import type { BenchmarkInput } from '../../api/engineeringSkillActionsApi'
import type { SkillVersionDetail } from '../../api/engineeringSkillsApi'
import type { ActionTarget } from './SkillActionParts'

/** A version of a scope: the shared skill's, or the scope's own. */
export interface ScopedVersion { shared: boolean; version: number }

/** The version the scope runs now: its own current one, else (a connection) the shared skill's; null for none. */
export function inUse(target: ActionTarget): ScopedVersion | null {
  if (target.current !== 0) return { shared: target.connection === '', version: target.current }
  return target.connection !== '' && target.sharedCurrent !== 0 ? { shared: true, version: target.sharedCurrent } : null
}

/** Whether a version's base is the version the scope runs now (acceptance needs it; the store checks it again). */
export function baseIsInUse(target: ActionTarget): boolean {
  const base = target.detail.base
  const used = inUse(target)
  if (base === null || used === null) return base === used
  return base.version === used.version && base.shared === used.shared
}

/** A version as an approval card names it: the shared skill's or this connection's (the shared scope's: its number). */
export function useVersionName() {
  const { t } = useTranslation('agents')
  return (version: ScopedVersion | null, connection: string): string => {
    if (version === null) return t('skills.actions.noCurrent')
    if (connection === '') return `v${String(version.version)}`
    return version.shared ? t('skills.actions.sharedVersion', { version: version.version })
      : t('skills.actions.connectionVersion', { version: version.version })
  }
}

export interface OfferedActions {
  accept: boolean
  /** Why Accept is held back (a coach's version without a passing benchmark), else null. */
  acceptHeld: 'unmeasured' | 'failed' | 'noGain' | null
  reject: boolean
  rollback: boolean
  benchmark: boolean
}

/** Why a coach's version cannot be accepted yet, from its recorded benchmark (null: it can). */
function heldBy(measured: SkillVersionDetail['benchmark']['measured']): OfferedActions['acceptHeld'] {
  if (measured === null) return 'unmeasured'
  if (!measured.passed) return 'failed'
  return measured.gained ? null : 'noGain'
}

/** What a version offers, from its status, who proposed it, its benchmark and the scope's current version. */
export function offeredActions(detail: SkillVersionDetail, current: number): OfferedActions {
  const proposed = detail.status === 'proposed'
  const measured = detail.benchmark.measured
  const coach = detail.proposed_by_kind === 'agent'
  return {
    accept: proposed,
    acceptHeld: proposed && coach ? heldBy(measured) : null,
    reject: proposed,
    rollback: detail.status === 'accepted' && current !== 0 && detail.version !== current,
    benchmark: proposed && measured === null,
  }
}

export interface BenchmarkFields {
  before: string
  after: string
  cases: string
  passed: boolean
  reasons: string
  failureCase: string
  /** The administrator's reference to the run (an id or a link), optional. */
  runRef: string
}

export type BenchmarkProblem = 'rates' | 'cases' | 'reasons' | 'failureCase' | 'regressed'
export type BenchmarkRead = { ok: true; benchmark: BenchmarkInput } | { ok: false; problem: BenchmarkProblem }

const CASE = /^[a-z0-9][a-z0-9-]{0,62}$/u

/** A pass rate typed in percent, as the fraction the server takes (null: not a number from 0 to 100). */
const passRateOf = (raw: string): number | null => {
  const value = Number(raw.trim())
  return raw.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= 100 ? value / 100 : null
}

const items = (raw: string, split: RegExp): string[] => raw.split(split).map((item) => item.trim()).filter((item) => item !== '')

/** The cases typed: one or more case ids, each once (null: anything else). */
function casesOf(raw: string): string[] | null {
  const cases = items(raw, /[\s,]+/u)
  const valid = cases.length > 0 && cases.every((name) => CASE.test(name)) && new Set(cases).size === cases.length
  return valid ? cases : null
}

/** The form as the server takes it, or the first thing to fix. */
export function readBenchmark(fields: BenchmarkFields): BenchmarkRead {
  const before = passRateOf(fields.before)
  const after = passRateOf(fields.after)
  if (before === null || after === null) return { ok: false, problem: 'rates' }
  const cases = casesOf(fields.cases)
  if (cases === null) return { ok: false, problem: 'cases' }
  const reasons = items(fields.reasons, /\n/u)
  if (reasons.length === 0) return { ok: false, problem: 'reasons' }
  const failureCase = fields.failureCase.trim()
  if (failureCase !== '' && !cases.includes(failureCase)) return { ok: false, problem: 'failureCase' }
  if (fields.passed && after < before) return { ok: false, problem: 'regressed' }
  const runRef = fields.runRef.trim()
  const benchmark: BenchmarkInput = { before, after, cases, passed: fields.passed, reasons, failure_case: failureCase }
  return { ok: true, benchmark: runRef === '' ? benchmark : { ...benchmark, run_ref: runRef } }
}
