/**
 * @fileoverview A request's light enrichment as chips: its category and sentiment (and, in the detail,
 * the one-sentence problem summary). Nothing is shown for a request not enriched yet or whose
 * enrichment failed.
 *
 * Shared with `/board`, where a board-pool session cannot read the app's category config, so the
 * category reads as its humanized id rather than through `useDisplayLabels`.
 *
 * @module pages/FeatureRequests/EnrichmentChips
 */
import { Sparkles, Tag } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import SentimentBadge from '../../components/SentimentBadge/SentimentBadge'
import { humanizeId } from '../../utils/displayLabels'
import type { RequestEnrichment } from '../../api/featureRequestInsightsSchema'

/** The enrichment worth showing (status ok), else undefined. */
function shownEnrichment(enrichment: RequestEnrichment | undefined): RequestEnrichment | undefined {
  return enrichment?.status === 'ok' ? enrichment : undefined
}

export default function EnrichmentChips({ enrichment }: Readonly<{ enrichment: RequestEnrichment | undefined }>) {
  const { t } = useTranslation('featureRequests')
  const shown = shownEnrichment(enrichment)
  if (shown === undefined || (shown.category === null && shown.sentiment === null)) return null
  return (
    <p className="flex flex-wrap items-center gap-1.5" data-testid="fr-enrichment">
      <span className="sr-only">{t('enrichment.label')}</span>
      {shown.category === null ? null : (
        <span className="badge badge-muted inline-flex items-center gap-1 break-words" title={t('enrichment.category')}>
          <Tag size={12} aria-hidden="true" />{humanizeId(shown.category)}
        </span>
      )}
      {shown.sentiment === null ? null : <SentimentBadge sentiment={shown.sentiment} />}
    </p>
  )
}

/** The detail's "In one sentence" line, when the enrichment has one. */
export function ProblemSummary({ enrichment }: Readonly<{ enrichment: RequestEnrichment | undefined }>) {
  const { t } = useTranslation('featureRequests')
  const summary = shownEnrichment(enrichment)?.problem_summary ?? null
  if (summary === null) return null
  return (
    <p className="text-xs text-muted flex items-start gap-1.5 break-words" data-testid="fr-problem-summary">
      <Sparkles size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span><span className="font-medium text-text">{t('enrichment.summary')}</span> {summary}</span>
    </p>
  )
}
