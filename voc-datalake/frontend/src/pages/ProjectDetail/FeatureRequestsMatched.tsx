/**
 * @fileoverview "Also N feature requests from the boards." under the persona and research wizards'
 * review count, when Feature requests is ticked as evidence (contract C5).
 *
 * The feedback preview does not count board requests, so the count is the boards' own Insights
 * total (`GET /feature-requests/insights` → `totals.requests`, created in the wizard's window): one
 * read per picked board, or one for every board when none is picked. The line is optional: while a
 * read is pending, or when one fails, it shows nothing. It is never added to the review count.
 *
 * @module pages/ProjectDetail/FeatureRequestsMatched
 */
import { useQueries } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { featureRequestInsightKeys, getFeatureRequestInsights, MAX_INSIGHT_DAYS } from '../../api/featureRequestInsights'
import type { InsightsQuery } from '../../api/featureRequestInsights'
import type { ContextConfig } from '../../components/DataSourceWizard/types'
import { featureRequestEvidenceFields } from '../../components/DataSourceWizard/featureRequestEvidence'

/** The Insights figures are as fresh as the board pages keep them. */
const COUNT_STALE_MS = 60_000

export type EvidenceCountSelection = Pick<ContextConfig, 'useFeatureRequests' | 'featureRequestBoardIds' | 'days'>

interface EvidenceCount {
  readonly count: number
  /** Some board stopped at the server's read budget: there are at least `count`. */
  readonly lowerBound: boolean
}

/** One Insights read per picked board, or one for every board; none when the box is not ticked. */
function evidenceCountQueries(selection: EvidenceCountSelection): InsightsQuery[] {
  const fields = featureRequestEvidenceFields(selection)
  if (fields.include_feature_requests !== true) return []
  // The wizard's 0 is all time, like the route's; a wider window than the route reads is all time too.
  const days = selection.days > 0 && selection.days <= MAX_INSIGHT_DAYS ? selection.days : 0
  const boards = fields.feature_request_board_ids ?? []
  return boards.length === 0 ? [{ days }] : boards.map((board) => ({ board, days }))
}

function useEvidenceCount(selection: EvidenceCountSelection): EvidenceCount | null {
  return useQueries({
    queries: evidenceCountQueries(selection).map((query) => ({
      queryKey: featureRequestInsightKeys.insights(query),
      queryFn: () => getFeatureRequestInsights(query),
      staleTime: COUNT_STALE_MS,
      retry: false,
    })),
    combine: (results) => {
      const answers = results.map((result) => result.data)
      if (answers.length === 0 || !answers.every((answer) => answer !== undefined)) return null
      return {
        count: answers.reduce((sum, answer) => sum + answer.totals.requests, 0),
        lowerBound: answers.some((answer) => answer.truncated),
      }
    },
  })
}

export default function FeatureRequestsMatched({ selection }: Readonly<{ selection: EvidenceCountSelection }>) {
  const { t } = useTranslation('components')
  const evidence = useEvidenceCount(selection)
  if (evidence === null) return null
  // Literal keys, so the i18n audit sees both.
  const text = evidence.lowerBound
    ? t('dataSourceWizard.feedbackPreview.featureRequestsAtLeast', { count: evidence.count })
    : t('dataSourceWizard.feedbackPreview.featureRequests', { count: evidence.count })
  return <p className="mt-1 text-sm text-text" data-testid="feature-requests-matched">{text}</p>
}
