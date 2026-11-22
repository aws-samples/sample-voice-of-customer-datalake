/**
 * @fileoverview The reads of the wizard's First insights (7.67.00): this import's items only, by the tag every row of
 * a reviews import carries or by a survey's form channel (`form_<id>`), over the last 7 days of processing (an
 * imported row keeps its own date, but it is processed now). The summary is polled every 4 s until every imported row
 * is analysed (or five minutes pass); then the sentiment split, the top categories, three quotes and, for a survey,
 * the NPS from the form's Results. Five minutes with none analysed means the rows were imported before (the processor
 * skips an item it already holds): `alreadyImported`.
 *
 * @module pages/Scrapers/ImportWizard/useFirstInsights
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { feedbackFormsV2Api } from '../../../api/feedbackFormsV2Api'
import type { FormResults } from '../../../api/feedbackFormsV2Results'
import { distributionRows, npsGroups } from '../../FeedbackForms/results/scoreMath'
import type { ImportOutcome } from './useImportWizard'

const POLL_MS = 4000
const POLL_LIMIT_MS = 5 * 60 * 1000
const RANGE = { days: 7 } as const
const QUOTES = 3
const TOP_CATEGORIES = 3
const ALL_TIME = { days: null, language: '', ending: '', hidden: {}, includeTest: false } as const

interface FirstInsights {
  readonly processed: number
  readonly ready: boolean
  readonly slow: boolean
  /** The polling window ended with none of the rows analysed: they were imported before. */
  readonly alreadyImported: boolean
  readonly sentiment: Readonly<Record<string, number>>
  readonly categories: readonly (readonly [string, number])[]
  readonly quotes: readonly { readonly id: string; readonly text: string }[]
  readonly nps: number | null
}

/** Where the polling window is: `'polling'`, then `'slow'` half way through it, then `'over'` at its end. */
type PollPhase = 'polling' | 'slow' | 'over'

function usePollingClock(): PollPhase {
  const [phase, setPhase] = useState<PollPhase>('polling')
  useEffect(() => {
    const slow = setTimeout(() => setPhase('slow'), POLL_LIMIT_MS / 2)
    const over = setTimeout(() => setPhase('over'), POLL_LIMIT_MS)
    return () => { clearTimeout(slow); clearTimeout(over) }
  }, [])
  return phase
}

/** Where the analysis stands: every row analysed (or the window over with some), still going, or none in the window. */
function analysisState(processed: number, accepted: number, phase: PollPhase) {
  const ready = processed > 0 && (processed >= accepted || phase === 'over')
  const alreadyImported = processed === 0 && phase === 'over'
  return { ready, alreadyImported, slow: !ready && !alreadyImported && phase !== 'polling' }
}

export function useFirstInsights(outcome: ImportOutcome): FirstInsights {
  const phase = usePollingClock()
  const key = ['importInsights', outcome.source, outcome.filter] as const
  const summary = useQuery({
    queryKey: [...key, 'summary'],
    queryFn: () => api.getSummary(RANGE, outcome.source, outcome.filter),
    refetchInterval: (query) => ((query.state.data?.total_feedback ?? 0) >= outcome.accepted || phase === 'over'
      ? false : POLL_MS),
  })
  const processed = Math.min(summary.data?.total_feedback ?? 0, outcome.accepted)
  const sentiment = useQuery({ queryKey: [...key, 'sentiment', processed], enabled: processed > 0,
    queryFn: () => api.getSentiment(RANGE, outcome.source, outcome.filter) })
  const categories = useQuery({ queryKey: [...key, 'categories', processed], enabled: processed > 0,
    queryFn: () => api.getCategories(RANGE, outcome.source, outcome.filter) })
  const quotes = useQuery({ queryKey: [...key, 'quotes', processed], enabled: processed > 0,
    queryFn: () => api.getFeedback({ ...RANGE, source: outcome.source, ...outcome.filter, limit: QUOTES }) })
  const results = useQuery({ queryKey: [...key, 'results', processed], enabled: processed > 0 && outcome.formId !== undefined,
    queryFn: () => feedbackFormsV2Api.getResults(outcome.formId ?? '', ALL_TIME) })
  return {
    processed,
    ...analysisState(processed, outcome.accepted, phase),
    sentiment: sentiment.data?.percentages ?? {},
    categories: topCategories(categories.data?.categories),
    quotes: (quotes.data?.items ?? []).slice(0, QUOTES).map((item) => ({ id: item.feedback_id, text: item.original_text })),
    nps: npsOf(outcome.npsQuestionIds, results.data),
  }
}

function topCategories(categories: Readonly<Record<string, number>> | undefined): (readonly [string, number])[] {
  return Object.entries(categories ?? {}).sort((a, b) => b[1] - a[1]).slice(0, TOP_CATEGORIES)
}

/** The NPS of the first NPS question with answers in the form's Results (−100 to 100), null without one. */
function npsOf(questionIds: readonly string[], results: FormResults | undefined): number | null {
  const distribution = questionIds.map((id) => results?.questions[id]?.distribution).find((d) => d !== undefined)
  return distribution === undefined ? null : npsGroups(distributionRows(distribution, 0, 10)).score
}
