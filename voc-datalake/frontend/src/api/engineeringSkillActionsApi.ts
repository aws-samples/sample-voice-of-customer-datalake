/**
 * @fileoverview An administrator's actions on a skill version (`POST /agents/engineering/skills/<role>/versions/<n>/
 * accept|reject|rollback|benchmark?connection=`; `lambda/engineering/skills/actions.py`, the skills store's own
 * transactions). Each sends what the screen showed (the version's status, the scope's current version), so the server
 * answers 409 when it moved meanwhile, and an optional reason. Each answers the version as it is now and the action's
 * event.
 *
 * Since 7.50.00 an administrator also adopts a role's updated template (`POST /agents/engineering/skills/<role>/template/
 * adopt?connection=` `{expected_current, template_version}`): the template becomes a new version PROPOSED by that
 * person (provenance `template`), which an administrator then accepts like any other; the answer is that version.
 *
 * Since 7.52.00 (gap M, D6-2) an administrator writes a version of their own (`POST /agents/engineering/skills/<role>/
 * versions?connection=` `{base_version, instructions, examples, summary, reason?}` → 201): a PROPOSAL on the version
 * the scope runs (its tools, model and harness), never applied by itself; 409 when the scope runs another version than
 * `base_version` now, 400 for a version that changes nothing or a body off its shape.
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

const proposePath = (connection: string, role: SkillRole) =>
  `/agents/engineering/skills/${encodeURIComponent(role)}/versions?${new URLSearchParams({ connection }).toString()}`

/** What a person's own version sends (gap M): the version it is written on as the screen showed it (0 for none), its
 * instructions and examples, the one-line summary of what it changes, and an optional reason. */
export interface ProposeBody {
  base_version: number
  instructions: string
  examples: { situation: string; action: string }[]
  summary: string
  reason?: string
}

const adoptPath = (connection: string, role: SkillRole) =>
  `/agents/engineering/skills/${encodeURIComponent(role)}/template/adopt?${new URLSearchParams({ connection }).toString()}`

/** What an adoption sends: the scope's current version and the template version the screen showed. */
export interface AdoptBody {
  expected_current: number
  template_version: number
}

export const engineeringSkillActionsApi = {
  propose: async (connection: string, role: SkillRole, body: ProposeBody): Promise<ActionResult> =>
    parseActionResult(await fetchApi<unknown>(proposePath(connection, role), post(body))),
  adopt: async (connection: string, role: SkillRole, body: AdoptBody): Promise<ActionResult> =>
    parseActionResult(await fetchApi<unknown>(adoptPath(connection, role), post(body))),
  act: async (connection: string, role: SkillRole, version: number, body: ActionBody, reason: string): Promise<ActionResult> => {
    const { action, ...fields } = body
    const sent = reason.trim() === '' ? fields : { ...fields, reason: reason.trim() }
    return parseActionResult(await fetchApi<unknown>(actionPath(connection, role, version, action), post(sent)))
  },
}
