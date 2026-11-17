/**
 * @fileoverview The deployment's GitHub Issues source as the repository connections drive it (7.50.02; administrators,
 * while the engineering agents are on; lambda/engineering/connectors/issues_sync.py): connecting a repository through
 * the deployment's GitHub App reads its issues automatically, with no Data sources step.
 *
 * - `GET /agents/engineering/issues-source` → how the source signs in (the App, a token, nothing yet), the
 *   repositories it reads and those its connections added (`managed`), its schedule, and for each connection whether
 *   its switch is on (`read`), whether the source reads it now (`reading`, else `reason`) and its `voc-agent` label;
 * - `PUT /agents/engineering/connections/<id>/issues` `{read}`: the connection's "Read this repository's issues"
 *   switch, answered with the whole view again;
 * - the installation's and Check installation's answers carry what followed for the source (`issues`,
 *   {@link parseIssuesFollow}).
 *
 * The source is the deployment's (D8): every call is sent in the deployment's scope, so no `X-Workspace-Id` is ever
 * sent, from any address. A value the page does not know reads as nothing said (never as reading, never as a label
 * made); an answer without its connections is an error, never "nothing read".
 *
 * @module api/issuesSourceApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { put } from './requestKit'
import { parseEach } from './lenientFields'
import { isRecord } from '../lib/typeGuards'

/**
 * Why a connection's issues are not read: switched off, the source on a token or another App, past its 20
 * repositories, not an App's connection, no source deployed, or not in the source's list yet (`pending`: a connection
 * made before 7.50.02, its next sync adds it). A reason the page does not know reads as `unknown` (a plain "not read").
 */
export const ISSUES_REASONS = ['off', 'token', 'other_app', 'limit', 'not_app', 'not_deployed', 'pending'] as const
export type IssuesReason = (typeof ISSUES_REASONS)[number] | 'unknown'

const isReason = (value: string): value is (typeof ISSUES_REASONS)[number] => ISSUES_REASONS.some((reason) => reason === value)

/** A reason as the page says it: a known one, else `unknown` (null: none given). */
function readReason(reason: string | null): IssuesReason | null {
  if (reason === null) return null
  return isReason(reason) ? reason : 'unknown'
}

/** The `voc-agent` label on a repository: made by the automation, already there, or not made (Check installation tries again). */
export const LABEL_STATES = ['created', 'present', 'failed'] as const
export type LabelState = (typeof LABEL_STATES)[number]

const SIGN_INS = ['app', 'token', 'none'] as const

const SCHEDULES = ['on', 'off', 'unknown'] as const

const repositories = z.array(z.string()).catch([]).transform((list) => list.filter((entry) => entry !== ''))

const ConnectionIssuesSchema = z.object({
  connection_id: z.string().min(1),
  repository: z.string().catch(''),
  /** The connection's switch: on unless an administrator turned it off. */
  read: z.boolean().catch(true),
  /** Whether the source reads the repository now: only the server's `true` says so. */
  reading: z.boolean().catch(false),
  reason: z.string().nullable().catch(null).transform(readReason),
  label: z.enum(LABEL_STATES).nullable().catch(null),
})

export type ConnectionIssues = z.output<typeof ConnectionIssuesSchema>

const ViewSchema = z.object({
  /** Whether the github_issues plugin is deployed here (none: nothing can be read). */
  deployed: z.boolean().catch(false),
  signs_in: z.enum(SIGN_INS).catch('none'),
  app_id: z.string().nullable().catch(null),
  repositories,
  managed: repositories,
  schedule: z.enum(SCHEDULES).catch('unknown'),
  label: z.string().min(1).catch('voc-agent'),
})

export type IssuesSourceView = z.output<typeof ViewSchema> & { connections: ConnectionIssues[] }

/** The view as the server answered it; an answer without its connections is an error, never "nothing read". */
export function parseIssuesSource(raw: unknown): IssuesSourceView {
  if (!isRecord(raw) || !Array.isArray(raw.connections)) throw new Error('The GitHub Issues source answer was unreadable')
  return { ...ViewSchema.parse(raw), connections: parseEach(ConnectionIssuesSchema, raw.connections) }
}

const SKIP_REASONS = ['token', 'other_app', 'limit', 'off'] as const
export type IssuesSkipReason = (typeof SKIP_REASONS)[number]

const FollowSchema = z.object({
  signs_in: z.enum(SIGN_INS).catch('none'),
  /** The repositories the source reads since this step. */
  added: repositories,
  /** Every repository of the App's connections the source reads now. */
  reading: repositories,
  schedule: z.enum(SCHEDULES).catch('unknown'),
  /** What the server could not do for the source (the connections are saved anyway); null for nothing. */
  error: z.string().min(1).nullable().catch(null),
})

const SkippedSchema = z.object({ repository: z.string().min(1), reason: z.enum(SKIP_REASONS) })
const LabelSchema = z.object({ repository: z.string().min(1), state: z.enum(LABEL_STATES) })

/** What followed for the source from an installation or a check. */
export type IssuesFollow = z.output<typeof FollowSchema> & {
  skipped: { repository: string; reason: IssuesSkipReason }[]
  labels: { repository: string; state: LabelState }[]
}

/**
 * The `issues` block of an installation's or a check's answer, or null when there is none (no source deployed here,
 * an answer of before 7.50.02, a block off its shape): never made up.
 */
export function parseIssuesFollow(raw: unknown): IssuesFollow | null {
  if (!isRecord(raw)) return null
  const follow = FollowSchema.safeParse(raw)
  if (!follow.success) return null
  return { ...follow.data, skipped: parseEach(SkippedSchema, raw.skipped), labels: parseEach(LabelSchema, raw.labels) }
}

const ISSUES_SOURCE_PATH = '/agents/engineering/issues-source'
const connectionIssuesPath = (connectionId: string) =>
  `/agents/engineering/connections/${encodeURIComponent(connectionId)}/issues`

export const issuesSourceKeys = { view: () => ['engineering-issues-source'] as const }

export const issuesSourceApi = {
  /** The source and each connection's issues (the deployment's: no workspace header). */
  get: async (): Promise<IssuesSourceView> =>
    parseIssuesSource(await fetchApi<unknown>(ISSUES_SOURCE_PATH, { method: 'GET' }, 'deployment')),
  /** Turn a connection's "Read this repository's issues" on or off: the whole view again. */
  setRead: async (connectionId: string, read: boolean): Promise<IssuesSourceView> =>
    parseIssuesSource(await fetchApi<unknown>(connectionIssuesPath(connectionId), put({ read }), 'deployment')),
}
