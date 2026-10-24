/**
 * @fileoverview The `GET /metrics/github` body, normalized leniently at the boundary.
 *
 * Every field degrades to an empty/neutral value rather than throwing: a sparse
 * or legacy row (a version with no sentiment yet, a label with no counts) must
 * render as "no data", never blank the Dashboard.
 *
 * @module api/githubMetricsSchema
 */
import { z } from 'zod'
import { readPartialWindow, type PartialWindow } from './partialWindow'

const count = z.number().int().nonnegative().catch(0)
const nullableScore = z.number().nullable().catch(null)

const RankedSchema = z.object({ name: z.string(), count }).catch({ name: '', count: 0 })
const rankedList = z.array(RankedSchema).catch([]).transform((rows) => rows.filter((row) => row.name !== ''))

const StatsShape = {
  count,
  weight: count,
  avg_sentiment: nullableScore,
  negative: count,
}

const VersionRowSchema = z.looseObject({
  version: z.string().catch(''),
  ...StatsShape,
  issues: count,
  comments: count,
  top_complaints: rankedList,
  top_errors: rankedList,
})

const LabelRowSchema = z.looseObject({
  label: z.string().catch(''),
  ...StatsShape,
  open: count,
})

const EMPTY_STATS = { count: 0, weight: 0, avg_sentiment: null, negative: 0 }
const EMPTY_NEW = { errors: [], categories: [], components: [] }

const GithubMetricsSchema = z.looseObject({
  period_days: count,
  total: count,
  repos: z.array(z.string()).catch([]),
  versions: z.array(VersionRowSchema.nullable().catch(null)).catch([]),
  unversioned: z.object(StatsShape).catch(EMPTY_STATS),
  labels: z.array(LabelRowSchema.nullable().catch(null)).catch([]),
  latest_version: z.string().nullable().catch(null),
  previous_version: z.string().nullable().catch(null),
  new_in_latest: z.object({
    errors: rankedList,
    categories: rankedList,
    components: rankedList,
  }).catch(EMPTY_NEW),
})

type VersionRow = z.infer<typeof VersionRowSchema>
type LabelRow = z.infer<typeof LabelRowSchema>

export type GithubVersionRow = Pick<VersionRow, 'version' | 'count' | 'weight' | 'avg_sentiment' | 'negative' | 'issues' | 'comments' | 'top_complaints' | 'top_errors'>
export type GithubLabelRow = Pick<LabelRow, 'label' | 'count' | 'weight' | 'avg_sentiment' | 'negative' | 'open'>
export type GithubRanked = z.infer<typeof RankedSchema>

export interface GithubMetrics {
  total: number
  repos: string[]
  versions: GithubVersionRow[]
  unversioned: z.infer<typeof GithubMetricsSchema>['unversioned']
  labels: GithubLabelRow[]
  latestVersion: string | null
  previousVersion: string | null
  newInLatest: z.infer<typeof GithubMetricsSchema>['new_in_latest']
  partial: PartialWindow
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}

/** The response as the UI reads it; anything unreadable becomes an empty breakdown. */
export function normalizeGithubMetrics(raw: unknown): GithubMetrics {
  const parsed = GithubMetricsSchema.catch(GithubMetricsSchema.parse({})).parse(raw ?? {})
  return {
    total: parsed.total,
    repos: parsed.repos,
    versions: parsed.versions.filter(isPresent).filter((row) => row.version !== ''),
    unversioned: parsed.unversioned,
    labels: parsed.labels.filter(isPresent).filter((row) => row.label !== ''),
    latestVersion: parsed.latest_version,
    previousVersion: parsed.previous_version,
    newInLatest: parsed.new_in_latest,
    partial: readPartialWindow(raw),
  }
}
