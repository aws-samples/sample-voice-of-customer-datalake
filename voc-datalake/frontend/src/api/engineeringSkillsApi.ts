/**
 * @fileoverview The engineering agents' skills and scorecards, read only (administrators, while the engineering
 * agents are on; `lambda/engineering/skills/views.py`, docs/autonomous-engineering.md "Getting better"):
 * - `GET /agents/engineering/skills?connection=`: each role with a version in a scope (the shared skills, or one
 *   connection's own), its current version, the version numbers handed out and its newest version's summary;
 * - `GET …/skills/<role>/versions?connection=&page=`: the role's history a page at a time, newest first, each version
 *   with its events and its benchmark (the proposer's claimed rates apart from the measured ones);
 * - `GET …/skills/<role>/versions/<n>?connection=`: one version's whole record and its diff from its base;
 * - `GET /agents/engineering/scorecards/<role>?connection=&versions=`: each version's scorecard on a connection.
 * Every text is the server's as data: the screens render it as text, never as HTML.
 *
 * @module api/engineeringSkillsApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { parseEach } from './lenientFields'
import { isRecord } from '../lib/typeGuards'

/** The agent catalog's roles, in the order the runs list them (lambda/shared/workflow_engineering.py ENGINEERING_ROLES). */
const SKILL_ROLES = ['mapper', 'understander', 'hunter', 'fixer', 'builder', 'committer', 'commit-reviewer',
  'gate-runner', 'pr-author', 'pr-reviewer', 'final-go', 'coordinator', 'coach'] as const
export type SkillRole = (typeof SKILL_ROLES)[number]
export const isSkillRole = (value: string): value is SkillRole => SKILL_ROLES.some((role) => role === value)
/** The versions one comparison shows at most (learning/scorecard.py MAX_COMPARED). */
export const MAX_COMPARED = 10

const text = z.string().catch('')
const count = z.number().int().nonnegative().catch(0)
const rate = z.number().min(0).max(1).nullable().catch(null)

const LatestSchema = z.object({ version: count, status: text, summary: text, proposed_at: text })
const RoleSchema = z.object({
  role: z.enum(SKILL_ROLES), current_version: count, versions: count, latest: LatestSchema.nullable().catch(null),
})
export type SkillRoleLine = z.output<typeof RoleSchema>

const EventSchema = z.object({ event: text, by: text, at: text, comment: text })
const MeasuredSchema = z.object({
  before: z.number(), after: z.number(), passed: z.boolean(), gained: z.boolean().catch(false), failure_case: text,
  cases: count, reasons: z.array(z.string()).catch([]), run_ref: text, by: text, at: text,
})
export const LineSchema = z.object({
  version: z.number().int().positive(),
  status: text,
  summary: text,
  why: z.object({ run_id: text, failure: text, comment: text }).catch({ run_id: '', failure: '', comment: '' }),
  proposed_by: text,
  proposed_by_kind: text,
  proposed_at: text,
  accepted_by: text,
  accepted_at: text,
  rejected_by: text,
  rejected_at: text,
  restores: count,
  base: z.object({ shared: z.boolean(), version: count }).nullable().catch(null),
  benchmark: z.object({
    claimed: z.object({ before: rate, after: rate }).nullable().catch(null),
    measured: MeasuredSchema.nullable().catch(null),
  }).catch({ claimed: null, measured: null }),
  expected_case: text,
  events: z.array(EventSchema).catch([]),
})
export type SkillVersionLine = z.output<typeof LineSchema>

const Op = z.enum(['+', '-'])
const DiffSchema = z.object({
  instructions: z.array(z.tuple([Op, z.string()])).catch([]),
  examples: z.array(z.tuple([Op, z.object({ situation: z.string(), action: z.string() })])).catch([]),
  tools_added: z.array(z.string()).catch([]),
  tools_removed: z.array(z.string()).catch([]),
  tools_reordered: z.boolean().catch(false),
  model: z.tuple([z.string(), z.string()]).nullable().catch(null),
  harness: z.tuple([z.string(), z.string()]).nullable().catch(null),
  first: z.boolean().catch(false),
})
export type SkillDiff = z.output<typeof DiffSchema>
const RecordSchema = z.object({
  instructions: text,
  examples: z.array(z.object({ situation: z.string(), action: z.string() })).catch([]),
  tool_policy: z.array(z.string()).catch([]),
  model: text,
  harness: text,
})
const DetailSchema = LineSchema.extend({
  record: RecordSchema,
  diff: DiffSchema,
  made_with: z.object({ model: text, prompt: text }).nullable().catch(null),
})
export type SkillVersionDetail = z.output<typeof DetailSchema>

/** Where a scorecard's version number comes from (views.py score_source: `shipped`, or `not_shipped` for a number
 * no shipped skill of the role had). */
const SCORE_SOURCES = ['shipped', 'not_shipped', 'shared', 'connection'] as const
const CardSchema = z.object({
  version: z.number().int().positive(),
  // (a source the page does not know is shown as unknown, never as one it is not)
  source: z.enum(SCORE_SOURCES).nullable().catch(null),
  label: text, runs: count, pass_rate: rate, tasks_done: count,
  tasks_failed: count, needs_human: count, reposts: count, review_rounds: count, attempts: count,
  cost_usd: z.number().nonnegative().catch(0), seconds: count, more: z.boolean().catch(false),
})
export type ScoreCard = z.output<typeof CardSchema>

export interface SkillHistoryPage {
  currentVersion: number
  versions: SkillVersionLine[]
  /** The next page's token (the server's, passed back as it is), null on the last page. */
  nextPage: string | null
}

/** An answer with no list where the list should be is an error, never "no versions" (a false statement). */
function listOf(raw: unknown, name: string): unknown[] {
  if (!isRecord(raw) || !Array.isArray(raw[name])) throw new Error('The skills answer was unreadable')
  return raw[name]
}

export function parseRoles(raw: unknown): SkillRoleLine[] {
  return parseEach(RoleSchema, listOf(raw, 'roles'))
}

export function parseHistory(raw: unknown): SkillHistoryPage {
  const versions = parseEach(LineSchema, listOf(raw, 'versions'))
  const record = isRecord(raw) ? raw : {}
  return {
    currentVersion: typeof record.current_version === 'number' ? record.current_version : 0,
    versions,
    nextPage: typeof record.next_page === 'string' && record.next_page !== '' ? record.next_page : null,
  }
}

export function parseDetail(raw: unknown): SkillVersionDetail {
  const parsed = DetailSchema.safeParse(isRecord(raw) ? raw.version : undefined)
  if (!parsed.success) throw new Error('The skill version answer was unreadable')
  return parsed.data
}

export interface Scorecards {
  cards: ScoreCard[]
  /** Whether the sessions' labels say which scope a number is (false today: the server says so). */
  scopeKnown: boolean
}

export function parseScorecards(raw: unknown): Scorecards {
  const cards = parseEach(CardSchema, listOf(raw, 'cards'))
  return { cards, scopeKnown: isRecord(raw) && raw.scope_known === true }
}

/** `connection` and the other view options, as the server reads them ('' is the shared skills). */
function query(connection: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({ connection, ...extra }).toString()
}

const skillsPath = (connection: string) => `/agents/engineering/skills?${query(connection)}`
const historyPath = (connection: string, role: SkillRole, page: string) =>
  `/agents/engineering/skills/${encodeURIComponent(role)}/versions?${query(connection, page === '' ? {} : { page })}`
const versionPath = (connection: string, role: SkillRole, version: number) =>
  `/agents/engineering/skills/${encodeURIComponent(role)}/versions/${String(version)}?${query(connection)}`
const scorecardsPath = (connection: string, role: SkillRole, versions: readonly number[]) =>
  `/agents/engineering/scorecards/${encodeURIComponent(role)}?${query(connection, versions.length === 0 ? {} : { versions: versions.join(',') })}`

export const engineeringSkillsKeys = {
  /** Every skills read (what an action makes stale). */
  all: () => ['engineering-skills'] as const,
  /** Every scorecards read. */
  allScorecards: () => ['engineering-scorecards'] as const,
  roles: (connection: string) => ['engineering-skills', connection] as const,
  history: (connection: string, role: SkillRole) => ['engineering-skills', connection, role] as const,
  version: (connection: string, role: SkillRole, version: number) => ['engineering-skills', connection, role, version] as const,
  scorecards: (connection: string, role: SkillRole, versions: readonly number[]) =>
    ['engineering-scorecards', connection, role, versions.join(',')] as const,
}

export const engineeringSkillsApi = {
  roles: async (connection: string): Promise<SkillRoleLine[]> =>
    parseRoles(await fetchApi<unknown>(skillsPath(connection))),
  history: async (connection: string, role: SkillRole, page: string): Promise<SkillHistoryPage> =>
    parseHistory(await fetchApi<unknown>(historyPath(connection, role, page))),
  version: async (connection: string, role: SkillRole, version: number): Promise<SkillVersionDetail> =>
    parseDetail(await fetchApi<unknown>(versionPath(connection, role, version))),
  scorecards: async (connection: string, role: SkillRole, versions: readonly number[]): Promise<Scorecards> =>
    parseScorecards(await fetchApi<unknown>(scorecardsPath(connection, role, versions))),
}
