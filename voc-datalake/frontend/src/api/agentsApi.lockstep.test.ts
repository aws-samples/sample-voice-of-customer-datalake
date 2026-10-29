/**
 * @fileoverview Keeps `API_AGENT_LIMITS` (the agent form's bounds) in step with the
 * backend that enforces them, `lambda/shared/agents_store.py`: a named constant
 * where the store has one, else the literal bound of the `_whole(...)` / `_text(...)`
 * call that validates the field. Two bounds are the SPA's own (the store checks
 * those values against a list, not a length) and are named here so a new limit
 * must be classified.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { API_AGENT_LIMITS, type AgentLimits } from './agentsApi'

const STORE = readFileSync(join(__dirname, '../../../lambda/shared/agents_store.py'), 'utf8')

const pyNumber = (text: string | undefined) => (text === undefined ? Number.NaN : Number(text.replace(/_/g, '')))
const constant = (name: string) => pyNumber(new RegExp(`^${name}: Final = ([\\d_]+)$`, 'm').exec(STORE)?.[1])
/** The upper bound of `_whole(raw.get(...), '<label>', low, HIGH, default)`. */
const wholeHigh = (label: string) => pyNumber(new RegExp(`_whole\\(.*?'${label}', \\d+, ([\\d_]+),`).exec(STORE)?.[1])

const FROM_BACKEND: Partial<Record<keyof AgentLimits, number | boolean>> = {
  maxNameChars: constant('MAX_NAME_CHARS'),
  maxDescriptionChars: constant('MAX_DESCRIPTION_CHARS'),
  maxInstructionsChars: constant('MAX_INSTRUCTIONS_CHARS'),
  maxCategories: constant('MAX_SCOPE_ENTRIES'),
  maxSubcategories: constant('MAX_SCOPE_ENTRIES'),
  maxFixedPersonas: constant('MAX_FIXED_PERSONAS'),
  maxTriggers: constant('MAX_TRIGGERS'),
  maxCooldownHours: wholeHigh('cooldown_hours'),
  maxMinNew: wholeHigh('min_new'),
  maxThresholdCount: wholeHigh('threshold count'),
  maxWindowDays: wholeHigh('window_days'),
  maxCronChars: pyNumber(/isinstance\(expression, str\) or len\(expression\) > (\d+)/.exec(STORE)?.[1]),
  maxTimezoneChars: pyNumber(/_text\(raw\.get\('timezone'\), 'timezone', (\d+)\)/.exec(STORE)?.[1]),
  maxScheduledRunsPerDay: constant('MAX_SCHEDULED_RUNS_PER_DAY'),
  minModelCallsPerRun: constant('MIN_MODEL_CALLS_PER_RUN'),
  maxModelCallsPerRun: constant('MAX_MODEL_CALLS_PER_RUN'),
  maxMonthlyCallCap: constant('MAX_MONTHLY_CALL_CAP'),
  monthlyCapNullable: /'monthly_call_cap': None if cap is None else/.test(STORE),
}

/** Bounds the store does not length-check: category names are matched against the categories config, model ids against the allowlist. */
const SPA_ONLY: ReadonlyArray<keyof AgentLimits> = ['maxCategoryNameChars', 'maxModelIdChars']

const isLimitKey = (key: string): key is keyof AgentLimits => key in API_AGENT_LIMITS

describe('API_AGENT_LIMITS', () => {
  it('equals the bounds lambda/shared/agents_store.py enforces', () => {
    for (const value of Object.values(FROM_BACKEND)) expect(value).not.toBeNaN()
    const pinned = Object.fromEntries(Object.keys(FROM_BACKEND).filter(isLimitKey).map((key) => [key, API_AGENT_LIMITS[key]]))
    expect(pinned).toStrictEqual(FROM_BACKEND)
  })

  it('classifies every limit as backend-pinned or SPA-only', () => {
    const byName = (a: string, b: string) => a.localeCompare(b)
    expect(Object.keys(API_AGENT_LIMITS).sort(byName)).toStrictEqual([...Object.keys(FROM_BACKEND), ...SPA_ONLY].sort(byName))
  })
})
