/**
 * @fileoverview Live "how many reviews match" line for the persona wizard's
 * feedback-filters step.
 *
 * Persona generation reads an even sample of the matching reviews, so the count
 * says both how many match and whether the personas will see all of them. A zero
 * is called out because generation fails on an empty set, and finding that out
 * from a failed job wastes a model run.
 *
 * Two requests run at once: a sampled ESTIMATE (~0.3s) and the EXACT count, which
 * reads every matching review (~4-7s on a 40k-review corpus, bounded below by how
 * fast DynamoDB serves one partition). The estimate shows first as "About N", the
 * exact count replaces it. Only the exact count can say "none match": an estimate
 * too thin to trust comes back as null and the line keeps counting.
 *
 * @module pages/ProjectDetail/PersonaFeedbackPreview
 */
import clsx from 'clsx'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { projectsApi } from '../../api/projectsApi'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { personaFeedbackScope, personaFeedbackScopeKey } from './personaFeedbackScope'
import type { PersonaFeedbackPreview as Preview, PersonaPreviewMode } from '../../api/personaFeedbackSchema'
import type { ContextConfig } from '../../components/DataSourceWizard/exports'

/** How long the filters must be still before the count is re-requested. */
export const PERSONA_PREVIEW_DEBOUNCE_MS = 500

interface PersonaFeedbackPreviewProps {
  readonly projectId: string
  readonly contextConfig: ContextConfig
}

/** A preview whose counts were readable; anything else renders as the error line. */
interface KnownPreview {
  readonly matched: number
  readonly lowerBound: boolean
  readonly sampleLimit: number | null
  readonly estimated: boolean
}

function knownPreview(preview: Preview | undefined): KnownPreview | null {
  if (preview === undefined || preview.matched === null) return null
  return {
    matched: preview.matched,
    lowerBound: preview.matched_is_lower_bound,
    sampleLimit: preview.sample_limit,
    estimated: preview.estimated,
  }
}

function matchText(t: TFunction, { matched, lowerBound, estimated }: KnownPreview): string {
  if (estimated) return t('dataSourceWizard.personaPreview.matchesEstimated', { matched })
  return lowerBound
    ? t('dataSourceWizard.personaPreview.matchesAtLeast', { matched })
    : t('dataSourceWizard.personaPreview.matches', { count: matched })
}

/** Whether the personas see every match, or an even sample of `limit` of them. */
function sampleText(t: TFunction, { matched, lowerBound, sampleLimit }: KnownPreview): string {
  if (sampleLimit === null) return ''
  return lowerBound || matched > sampleLimit
    ? t('dataSourceWizard.personaPreview.sampled', { limit: sampleLimit })
    : t('dataSourceWizard.personaPreview.usesAll')
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
      <p className="flex items-start gap-2 text-sm text-amber-700">
        <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
        {t('dataSourceWizard.personaPreview.noMatches')}
      </p>
    )
  }
  return (
    <p className={clsx('text-sm text-gray-700 transition-opacity', stale && 'opacity-60')}>
      <span className="font-medium">{matchText(t, preview)}</span> {sampleText(t, preview)}
      {preview.estimated && confirming ? (
        <span className="ml-1 inline-flex items-center gap-1 text-xs text-gray-400">
          <Loader2 size={12} className="animate-spin" />
          {t('dataSourceWizard.personaPreview.confirming')}
        </span>
      ) : null}
    </p>
  )
}

function usePreview(projectId: string, settled: ContextConfig, mode: PersonaPreviewMode) {
  return useQuery({
    queryKey: ['persona-feedback-preview', projectId, mode, personaFeedbackScopeKey(settled)],
    queryFn: () => projectsApi.previewPersonaFeedback(projectId, personaFeedbackScope(settled), mode),
    enabled: projectId !== '',
    // Keep the last answer on screen (dimmed) while the next one loads.
    placeholderData: keepPreviousData,
  })
}

type PreviewQuery = ReturnType<typeof usePreview>

/** A query's answer for the CURRENT filters, or null while it is still the last filters'. */
const freshAnswer = (query: PreviewQuery) => (query.isPlaceholderData ? null : knownPreview(query.data))

/**
 * What to show, best first: the exact count for these filters, then the estimate
 * for them, then the last exact count (dimmed) while both catch up.
 */
function pickPreview(exact: PreviewQuery, estimate: PreviewQuery): { preview: KnownPreview; stale: boolean } | null {
  const fresh = freshAnswer(exact) ?? freshAnswer(estimate)
  if (fresh) return { preview: fresh, stale: false }
  const previous = knownPreview(exact.data)
  return previous ? { preview: previous, stale: true } : null
}

export default function PersonaFeedbackPreview({ projectId, contextConfig }: PersonaFeedbackPreviewProps) {
  const { t } = useTranslation('components')
  // The parent hands down one config object per edit, so debouncing the object
  // itself waits for the edits to stop; the first render requests immediately.
  const settled = useDebouncedValue(contextConfig, PERSONA_PREVIEW_DEBOUNCE_MS)
  const exact = usePreview(projectId, settled, 'exact')
  const estimate = usePreview(projectId, settled, 'estimate')
  const shown = pickPreview(exact, estimate)
  const failed = !exact.isPending && knownPreview(exact.data) === null

  return (
    // Sticky at the foot of the scrolling step, so the count stays in view while
    // the filters it describes are being toggled further up.
    <div role="status" aria-live="polite" className="sticky bottom-0 border-t bg-white pt-3">
      {shown === null && failed ? (
        <p className="text-sm text-red-600">{t('dataSourceWizard.personaPreview.error')}</p>
      ) : null}
      {shown === null && !failed ? (
        <p className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 size={14} className="animate-spin" />
          {t('dataSourceWizard.personaPreview.counting')}
        </p>
      ) : null}
      {/* `isFetching`, not `!isError`: an exact answer that came back unreadable is
          also finished, and must not leave the estimate "confirming" forever. */}
      {shown ? <StatusLine preview={shown.preview} stale={shown.stale} confirming={exact.isFetching} /> : null}
    </div>
  )
}
