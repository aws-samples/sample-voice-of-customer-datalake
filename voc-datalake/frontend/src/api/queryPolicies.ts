/**
 * @fileoverview The SPA's caching policy: how long each kind of query result is
 * reused before it is asked for again. One place, so a page never has to guess.
 *
 * Customer feedback only changes when new reviews are ingested (a scheduled
 * plugin run, an import, a form submission) or an admin reprocesses or erases
 * data. Re-asking for the same counts every 30 s, or every time the browser tab
 * regains focus, costs requests (and per-day DynamoDB walks) for answers that
 * have not changed. So every query key belongs to one of five families:
 *
 * | Family         | staleTime | gcTime | Refetch on focus | What                                        |
 * |----------------|-----------|--------|------------------|---------------------------------------------|
 * | `feedbackData` | 5 min     | 30 min | no               | metrics, feedback lists/detail, Radar data  |
 * | `config`       | 10 min    | 30 min | no               | categories, brand, sources, dimensions, AI models, Radar brands, company context |
 * | `live`         | 30 s      | 5 min  | yes              | per-user moving state: conversations, runs, plans, jobs, brief, logs |
 * | `polled`       | 30 s      | 5 min  | no               | live data a mounted poller already refreshes (the sidebar's agent list) |
 * | `standard`     | 60 s      | 5 min  | yes              | everything else (projects, agents config, users, forms, scrapers) |
 *
 * Writes keep the caches honest rather than short timers: every write that
 * moves feedback data calls `invalidateFeedbackData` (api/invalidateFeedbackData.ts),
 * and a finished reprocess / erasure / S3 import is noticed by the watcher in
 * api/feedbackDataWatch.ts. Pollers (`refetchInterval`) and a query's own
 * explicit `staleTime` still win: query options override these defaults.
 *
 * Retries: once, and never for a 4xx — a 401/403/404/409 is the server's settled
 * answer, so asking again only doubles the request (the "404 fetched twice"
 * finding). 408 and 429 (timeout, throttling) are the exceptions that can change.
 *
 * Every query-key root in `src/` MUST be listed in {@link ROOT_FAMILIES};
 * `queryPolicies.test.ts` scans the source and fails on an unlisted (or stale)
 * root, so a new query cannot ship without a policy.
 *
 * @module api/queryPolicies
 */
import { QueryClient } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'
import { AuthError } from '../lib/errors'
import { apiErrorStatus } from './apiErrorStatus'

export type CacheFamily = 'feedbackData' | 'config' | 'live' | 'polled' | 'standard'

interface FamilyPolicy {
  readonly staleTime: number
  readonly gcTime: number
  readonly refetchOnWindowFocus: boolean
}

const SECOND = 1_000
const MINUTE = 60 * SECOND

/** Every family states all three options, so a sub-key default fully replaces its root's. */
export const FAMILY_POLICIES: Readonly<Record<CacheFamily, FamilyPolicy>> = {
  feedbackData: { staleTime: 5 * MINUTE, gcTime: 30 * MINUTE, refetchOnWindowFocus: false },
  config: { staleTime: 10 * MINUTE, gcTime: 30 * MINUTE, refetchOnWindowFocus: false },
  live: { staleTime: 30 * SECOND, gcTime: 5 * MINUTE, refetchOnWindowFocus: true },
  polled: { staleTime: 30 * SECOND, gcTime: 5 * MINUTE, refetchOnWindowFocus: false },
  standard: { staleTime: MINUTE, gcTime: 5 * MINUTE, refetchOnWindowFocus: true },
}

/**
 * The family of every query-key root (`queryKey[0]`) used in the app.
 * Kept alphabetical; the classification test names any root missing here.
 */
export const ROOT_FAMILIES: Readonly<Record<string, CacheFamily>> = {
  'agents': 'live', // runs, run events, assistant plans; the list is `polled` (below)
  'all-app-configs': 'config',
  'all-project-details': 'standard',
  'app-configs': 'config',
  'assistant': 'live', // conversation list; approval previews set staleTime 0 themselves
  'ballot-session': 'live',
  'brand-settings': 'config',
  'categories': 'feedbackData',
  'categories-config': 'config',
  'categories-feedback': 'feedbackData',
  'categories-feedback-search': 'feedbackData',
  'categories-feedback-urgent': 'feedbackData',
  'category-reprocess-job': 'live',
  'company-context': 'config',
  'company-persona-jobs': 'live', // the library's generate / import jobs, polled while one runs (like project-jobs)
  'company-personas': 'standard', // Knowledge → Company → Personas (the shared persona library)
  'connect': 'standard',
  'data-explorer-buckets': 'standard',
  'data-explorer-feedback': 'feedbackData',
  'data-explorer-s3': 'standard',
  'data-quality': 'feedbackData', // Data Explorer usefulness distribution (/metrics/data-quality)
  'decision-review-search': 'feedbackData', // ProjectDetail decision evidence picker (/feedback/search)
  'design-system': 'config',
  'inline-image': 'config', // a presigned image read as a data: URL (hooks/useInlineImage)
  'dimension-metrics': 'feedbackData',
  'dimensions-config': 'config',
  'document-comments': 'live', // margin comment threads of a PR/FAQ / PRD series (reviewers comment meanwhile)
  'entities': 'feedbackData',
  'entities-all-sources': 'feedbackData',
  'erasure-jobs': 'live', // GET /settings/erasure → {jobs, sources}: polled while a job runs
  'feature-requests': 'standard', // feedback boards, their requests and a request's detail (api/featureRequestsApi)
  'feedback': 'feedbackData',
  'feedback-access': 'config', // the caller's category/source scope
  'feedback-forms': 'standard',
  'feedback-problems': 'feedbackData',
  'feedback-similar': 'feedbackData',
  'form-stats': 'standard',
  'form-submissions': 'standard',
  'generator-config': 'config',
  'githubMetrics': 'feedbackData',
  'import-history': 'standard', // import runs (Data sources → Import history); a finished upload invalidates it
  'integration-status': 'standard',
  'logs': 'config', // ['logs', 'alerts']: the alerting switch and recipients
  'logs-summary': 'live',
  'memory': 'standard',
  'model-capacity': 'config',
  'model-settings': 'config',
  'my-ai-mode': 'config', // the caller's way of working with AI (GET /users/me/ai-mode, admin-set)
  'my-context': 'config',
  'participants': 'standard', // lists, people, asks (an ask's detail polls itself while sending)
  'prioritization-config': 'config', // the workspace scoring setup (metrics, weights)
  'prioritization-scores': 'standard',
  'processing-logs': 'live',
  'product-context': 'standard',
  'product-docs': 'standard',
  'project': 'standard',
  'persona-copy-sources': 'standard', // a project's "Copy from…" sources (library + the caller's projects)
  'project-jobs': 'live',
  'projects': 'standard',
  'prototype-pins': 'live',
  'radar': 'feedbackData', // overview, detail, releases, compare, reviews; brands are config (below)
  'release-watch': 'feedbackData',
  'resolved-problems': 'live',
  's3-import-files': 'live',
  's3-import-reprocess': 'live', // one reprocess run (GET /s3-import/reprocess/{run_id}), polled while running
  's3-import-sources': 'standard',
  'scraper-logs': 'live',
  'scraper-templates': 'config',
  'scrapers': 'standard',
  'sentiment': 'feedbackData',
  'settings': 'config', // changelog, e-mail inbox; the per-user brief/onboarding are live (below)
  'source-profiles': 'config',
  'source-run-status': 'live',
  'sources': 'feedbackData', // /metrics/sources
  'sources-status': 'live',
  'summary': 'feedbackData',
  'system-log-environment': 'standard', // GET /logs/system/environment: changes only with a deploy or a setting
  'system-log-queues': 'live', // GET /logs/system/queues: failure-queue depth moves with every failed message
  'system-log-request': 'polled', // GET /logs/system/request: one invocation's lines, polled while running
  'system-logs': 'polled', // GET /logs/system: a CloudWatch search, polled while running
  'urgent': 'feedbackData',
  'user-category-access': 'standard',
  'users': 'standard',
  'validation-logs': 'live',
  'voting-session': 'live',
  'voting-session-open': 'live',
  'workflows': 'standard',
}

/** Sub-keys whose family differs from their root's. Registered after the roots, so they win. */
export const SUB_KEY_FAMILIES: readonly (readonly [QueryKey, CacheFamily])[] = [
  // The sidebar polls the agent list every 60 s (hooks/useAgentsNeedingDecision); a focus
  // refetch on top would only repeat it. Runs, run events and plans stay live.
  [['agents', 'list'], 'polled'],
  [['radar', 'brands'], 'config'],
  [['settings', 'my-briefing'], 'live'],
  [['settings', 'my-onboarding'], 'live'],
]

function startsWith(queryKey: QueryKey, prefix: QueryKey): boolean {
  return prefix.every((part, index) => queryKey[index] === part)
}

function rootFamily(root: unknown): CacheFamily {
  return typeof root === 'string' ? (ROOT_FAMILIES[root] ?? 'standard') : 'standard'
}

/** The family a query key resolves to (unknown roots read as `standard`, the global default). */
export function cacheFamilyOf(queryKey: QueryKey): CacheFamily {
  const sub = SUB_KEY_FAMILIES.find(([prefix]) => startsWith(queryKey, prefix))
  return sub === undefined ? rootFamily(queryKey[0]) : sub[1]
}

const MAX_RETRIES = 1
/** 4xx statuses that can answer differently when asked again: a timeout and throttling. */
const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 429])

/**
 * Retry once, but never a settled client error (401/403/404/409/…) nor an
 * ended session (fetchApi already sent the user to /login). A failure with no
 * status (network, aborted) and a 5xx are worth one more try.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES || error instanceof AuthError) return false
  const status = apiErrorStatus(error)
  return status === null || status < 400 || status >= 500 || RETRYABLE_CLIENT_STATUSES.has(status)
}

/** Register every non-default family on `queryClient` (roots first, then the sub-key refinements). */
function registerQueryPolicies(queryClient: QueryClient): void {
  for (const [root, family] of Object.entries(ROOT_FAMILIES)) {
    if (family !== 'standard') queryClient.setQueryDefaults([root], FAMILY_POLICIES[family])
  }
  for (const [prefix, family] of SUB_KEY_FAMILIES) queryClient.setQueryDefaults(prefix, FAMILY_POLICIES[family])
}

/** The app's QueryClient: the `standard` family as the global default, plus every family's defaults. */
export function createAppQueryClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...FAMILY_POLICIES.standard, retry: shouldRetryQuery } },
  })
  registerQueryPolicies(queryClient)
  return queryClient
}
