/**
 * @fileoverview Live "N reviews match" line at the foot of the persona and research wizards'
 * feedback-filters step (ported from #429 by @aws-bryan).
 *
 * The count is the run's own read (`POST /projects/{id}/feedback-preview`), so it cannot
 * disagree with what the generation then samples. Two requests run at once: a sampled
 * ESTIMATE (well under a second) shows first as "About N", and the EXACT count (seconds on a
 * big corpus) replaces it. Only the exact count can say "none match": an estimate too thin to
 * trust is null and the line keeps counting. The persona wizard also says whether the
 * personas read every match or an even sample of them.
 *
 * @module pages/ProjectDetail/FeedbackMatchPreview
 */
import clsx from 'clsx'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { projectsApi } from '../../api/projectsApi'
import type { FeedbackPreviewBody } from '../../api/projectsApi'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import type { FeedbackPreview, FeedbackPreviewMode, FeedbackPreviewPurpose } from '../../api/feedbackPreviewSchema'
import type { ContextConfig } from '../../components/DataSourceWizard/types'

/** How long the filters must be still before the count is re-requested. */
const FEEDBACK_PREVIEW_DEBOUNCE_MS = 500
/** The server reuses a count for five minutes (`CACHE_SECONDS`); the SPA keeps it as long. */
const PREVIEW_STALE_MS = 5 * 60_000

interface FeedbackMatchPreviewProps {
  readonly projectId: string
  readonly contextConfig: ContextConfig
  readonly purpose: FeedbackPreviewPurpose
}

/** A preview whose count was readable; anything else renders as the error line. */
interface KnownPreview {
  readonly matched: number
  readonly lowerBound: boolean
  readonly sampleLimit: number | null
  readonly estimated: boolean
}

function knownPreview(preview: FeedbackPreview | undefined): KnownPreview | null {
  if (preview === undefined || preview.matched === null) return null
  return {
    matched: preview.matched,
    lowerBound: preview.matched_is_lower_bound,
    sampleLimit: preview.sample_limit,
    estimated: preview.estimated,
  }
}

const sorted = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b))

/** The request fields, with the lists sorted: the same selection made in another order is one query. */
function previewBody(config: ContextConfig): FeedbackPreviewBody {
  return {
    sources: sorted(config.sources),
    categories: sorted(config.categories),
    sentiments: sorted(config.sentiments),
    days: config.days,
  }
}

function matchText(t: TFunction, { matched, lowerBound, estimated }: KnownPreview): string {
  if (estimated) return t('dataSourceWizard.feedbackPreview.matchesEstimated', { count: matched })
  return lowerBound
    ? t('dataSourceWizard.feedbackPreview.matchesAtLeast', { count: matched })
    : t('dataSourceWizard.feedbackPreview.matches', { count: matched })
}

/** Whether the personas read every match, or an even sample of `limit` of them ('' without a limit). */
function sampleText(t: TFunction, { matched, lowerBound, sampleLimit }: KnownPreview): string {
  if (sampleLimit === null) return ''
  return lowerBound || matched > sampleLimit
    ? t('dataSourceWizard.feedbackPreview.sampled', { limit: sampleLimit })
    : t('dataSourceWizard.feedbackPreview.usesAll')
}

interface StatusLineProps {
  readonly preview: KnownPreview
  readonly stale: boolean
  /** The exact count is still on its way, so an estimate says it will be confirmed. */
  readonly confirming: boolean
}

function StatusLine({ preview, stale, confirming }: StatusLineProps) {
  const { t } = useTranslation('components')
  if (preview.matched === 0 && !preview.estimated) {
    return (
      <p className="flex items-start gap-2 text-sm text-warn">
        <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
        {t('dataSourceWizard.feedbackPreview.noMatches')}
      </p>
    )
  }
  return (
    <p className={clsx('text-sm text-text transition-opacity', stale && 'opacity-60')}>
      <span className="font-medium">{matchText(t, preview)}</span> {sampleText(t, preview)}
      {preview.estimated && confirming ? (
        <span className="ml-1 inline-flex items-center gap-1 text-xs text-muted">
          <Loader2 size={12} aria-hidden="true" className="animate-spin" />
          {t('dataSourceWizard.feedbackPreview.confirming')}
        </span>
      ) : null}
    </p>
  )
}

function usePreview(projectId: string, body: FeedbackPreviewBody, mode: FeedbackPreviewMode, purpose: FeedbackPreviewPurpose) {
  return useQuery({
    queryKey: ['feedback-preview', projectId, purpose, mode, body],
    queryFn: () => projectsApi.previewFeedback(projectId, body, mode, purpose),
    enabled: projectId !== '',
    staleTime: PREVIEW_STALE_MS,
    retry: false,
    // Keep the last answer on screen (dimmed) while the next one loads.
    placeholderData: keepPreviousData,
  })
}

type PreviewQuery = ReturnType<typeof usePreview>

/** A query's answer for the CURRENT filters, or null while it is still the last filters'. */
const freshAnswer = (query: PreviewQuery) => (query.isPlaceholderData ? null : knownPreview(query.data))

/** Best first: the exact count for these filters, the estimate for them, then the last exact count (dimmed). */
function pickPreview(exact: PreviewQuery, estimate: PreviewQuery): { preview: KnownPreview; stale: boolean } | null {
  const fresh = freshAnswer(exact) ?? freshAnswer(estimate)
  if (fresh) return { preview: fresh, stale: false }
  const previous = knownPreview(exact.data)
  return previous ? { preview: previous, stale: true } : null
}

export default function FeedbackMatchPreview({ projectId, contextConfig, purpose }: FeedbackMatchPreviewProps) {
  const { t } = useTranslation('components')
  // One body per config object (the parent hands down a new one per edit): a body built on every
  // render would never settle, and the debounce would fire forever.
  const body = useMemo(() => previewBody(contextConfig), [contextConfig])
  const settled = useDebouncedValue(body, FEEDBACK_PREVIEW_DEBOUNCE_MS)
  const exact = usePreview(projectId, settled, 'exact', purpose)
  const estimate = usePreview(projectId, settled, 'estimate', purpose)
  const shown = pickPreview(exact, estimate)
  // Settled for these filters (not a placeholder) and still unreadable: a failure or a bad answer.
  const failed = !exact.isFetching && !exact.isPlaceholderData && knownPreview(exact.data) === null

  return (
    // Sticky at the foot of the scrolling step, so the count stays in view while the filters change.
    <div role="status" aria-live="polite" className="sticky bottom-0 border-t border-border bg-card pt-3">
      {shown === null && failed ? (
        <p className="text-sm text-danger">{t('dataSourceWizard.feedbackPreview.error')}</p>
      ) : null}
      {shown === null && !failed ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} aria-hidden="true" className="animate-spin" />
          {t('dataSourceWizard.feedbackPreview.counting')}
        </p>
      ) : null}
      {/* `isFetching`, not `!isError` (#429, 6039aecb): an exact answer that came back unreadable
          is also finished, and must not leave the estimate "confirming" forever. */}
      {shown ? <StatusLine preview={shown.preview} stale={shown.stale} confirming={exact.isFetching} /> : null}
    </div>
  )
}
