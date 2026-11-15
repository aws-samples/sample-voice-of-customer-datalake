/**
 * @fileoverview An administrator's actions on a skill version (`POST /agents/engineering/skills/<role>/versions/<n>/
 * accept|reject|rollback|benchmark?connection=`; `lambda/engineering/skills/actions.py`, the skills store's own
 * transactions). Each sends what the screen showed (the version's status, the scope's current version), so the server
 * answers 409 when it moved meanwhile, and an optional reason. Each answers the version as it is now and the action's
 * event.
 *
 * @module api/engineeringSkillActionsApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { post } from './requestKit'
import { LineSchema } from './engineeringSkillsApi'
import type { SkillRole, SkillVersionLine } from './engineeringSkillsApi'

export type SkillAction = 'accept' | 'reject' | 'rollback' | 'benchmark'

/** An administrator's record of a benchmark run, its rates, cases and verdict as they enter them (skills/model.py
 * BenchmarkRun): linked to no measurement, with an optional reference to the run (an id or a link). */
export interface BenchmarkInput {
  before: number
  after: number
  cases: string[]
  passed: boolean
  reasons: string[]
  failure_case: string
  run_ref?: string
}

/** What each action sends beside its reason: what the screen showed, and a benchmark's own fields. */
export type ActionBody =
  | { action: 'accept'; expected_status: string; expected_current: number }
  | { action: 'reject'; expected_status: string }
  | { action: 'rollback'; expected_current: number }
  | ({ action: 'benchmark'; expected_status: string } & BenchmarkInput)

const ResultSchema = z.object({ version: LineSchema })

export interface ActionResult {
  version: SkillVersionLine
}

/** The answer read strictly: an action whose answer is unreadable is reported, never taken as done silently. */
function parseActionResult(raw: unknown): ActionResult {
  const parsed = ResultSchema.safeParse(raw)
  if (!parsed.success) throw new Error('The answer to the action was unreadable')
  return parsed.data
}

/** Each action's route below its version's path (one literal per route, so each is named where it is called). */
const ACTION_PATHS: Readonly<Record<SkillAction, (base: string) => string>> = {
  accept: (base) => `${base}/accept`,
  reject: (base) => `${base}/reject`,
  rollback: (base) => `${base}/rollback`,
  benchmark: (base) => `${base}/benchmark`,
}

const actionPath = (connection: string, role: SkillRole, version: number, action: SkillAction) => {
  const base = `/agents/engineering/skills/${encodeURIComponent(role)}/versions/${String(version)}`
  return `${ACTION_PATHS[action](base)}?${new URLSearchParams({ connection }).toString()}`
}

export const engineeringSkillActionsApi = {
  act: async (connection: string, role: SkillRole, version: number, body: ActionBody, reason: string): Promise<ActionResult> => {
    const { action, ...fields } = body
    const sent = reason.trim() === '' ? fields : { ...fields, reason: reason.trim() }
    return parseActionResult(await fetchApi<unknown>(actionPath(connection, role, version, action), post(sent)))
  },
}
