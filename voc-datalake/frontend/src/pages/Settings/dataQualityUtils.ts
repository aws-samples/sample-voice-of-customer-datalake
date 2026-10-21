/**
 * @fileoverview Pure helpers for the Settings → Data Quality tab: job-state
 * predicates, chart-series ordering, and progress maths.
 *
 * Kept out of the component files so they stay component-only (react-refresh)
 * and so the logic is testable without rendering.
 *
 * @module pages/Settings/dataQualityUtils
 */
import type { DataQualityJob } from '../../api/dataQualityApi'

/** How often the tab re-reads job progress while any job is running. */
export const DATA_QUALITY_POLL_MS = 3000

export const DATA_QUALITY_QUERY_KEY = ['data-quality'] as const

/** Profile buckets, in display order (`RATING_NONE` / `LENGTH_BUCKETS` in shared/data_quality.py). */
export const RATING_BUCKETS = ['1', '2', '3', '4', '5', 'none'] as const
export const SENTIMENT_BUCKETS = ['positive', 'neutral', 'negative', 'mixed'] as const
export const LENGTH_BUCKETS = ['0-100', '101-500', '501-1000', '1001-2000', '2000+'] as const

export const isJobRunning = (job: DataQualityJob): boolean => job.status === 'running'

export const hasRunningJob = (jobs: readonly DataQualityJob[]): boolean => jobs.some(isJobRunning)

export const isProfileRunning = (jobs: readonly DataQualityJob[]): boolean =>
  jobs.some((job) => isJobRunning(job) && job.kind === 'profile')

/** Is an enrich job already running for this exact source + field (the server's lock target)? */
export const isEnrichRunning = (jobs: readonly DataQualityJob[], source: string, field: string): boolean =>
  jobs.some((job) => isJobRunning(job) && job.kind === 'enrich' && job.source === source && job.field === field)

export interface CountDatum {
  readonly key: string
  readonly value: number
}

/**
 * A count map as a chart series: the expected buckets first, in order and
 * zero-filled so every source's chart has the same axis, then any bucket the
 * server sent that is not expected (e.g. sentiment `unknown`), sorted by name.
 */
export function orderedCounts(counts: Readonly<Record<string, number>>, expected: readonly string[]): CountDatum[] {
  const extras = Object.keys(counts)
    .filter((key) => !expected.includes(key))
    .sort((a, b) => a.localeCompare(b))
  return [...expected, ...extras].map((key) => ({ key, value: counts[key] ?? 0 }))
}

/** Whole-number share of `part` in `total`; 0 for an empty total. */
export const percentOf = (part: number, total: number): number =>
  total > 0 ? Math.round((part / total) * 100) : 0

/**
 * Determinate progress for a job bar, or `null` when there is no meaningful
 * fraction: a profile job only learns its total at the end (so it is a fraction
 * only once completed), and an enrich job has none until the planner counts a
 * row. The caller decides what `null` looks like — indeterminate while running,
 * no bar otherwise.
 */
export function jobProgressPercent(job: DataQualityJob): number | null {
  if (job.kind === 'profile') return job.status === 'completed' ? 100 : null
  if (job.total <= 0) return null
  return Math.min(100, percentOf(job.processed, job.total))
}

/** Locale-formatted timestamp, falling back to the raw value when unparseable. */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}
