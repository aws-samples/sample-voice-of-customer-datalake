/**
 * @fileoverview The Results tab (UX §10): Summary (a card per question, the endings, the drop-off) and Responses (a
 * table and a response's dialog), under filters the address holds, with test responses left out unless asked
 * for: "Include test responses" is never remembered, and when on, a banner says these aren't the real results.
 * Download (the familiar CSV, or from its menu the detailed one) follows the filters. Above the summary, the link
 * checks say when the links that bring respondents leave a hidden field empty.
 *
 * @module pages/FeedbackForms/results/ResultsTab
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { BarChart3, FlaskConical, Inbox, Rows3, SearchX, Share2 } from 'lucide-react'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import Notice from '../../../components/Notice/Notice'
import type { ResultsFilters } from '../../../api/feedbackFormsV2Api'
import type { FormResults } from '../../../api/feedbackFormsV2Results'
import { formatCount } from '../../../utils/numberFormat'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'
import { SaveFirstNotice } from '../tabs/linkParts'
import Segmented from '../ui/Segmented'
import ResultsFilterBar from './ResultsFilterBar'
import ResultsSummary from './ResultsSummary'
import ResponsesTable from './ResponsesTable'
import DownloadButton from './DownloadButton'
import LinkHealthNotice from './LinkHealthNotice'
import { useFormResults } from './useFormResults'
import { CLEAR_FILTERS, apiFilters, hidesFunnel, narrows, readFilters, writeFilters } from './resultFilters'
import type { ViewFilters } from './resultFilters'

type View = 'summary' | 'responses'

/** What the summary shows when there is nothing to count; null when there is. */
function EmptyState({ results, filters, includeTest, onInclude, onClear }: Readonly<{
  results: FormResults
  filters: ViewFilters
  includeTest: boolean
  onInclude: () => void
  onClear: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const { go } = useBuilderUi()
  if (results.total > 0) return null
  if (!includeTest && results.test_count > 0) {
    return <Notice variant="empty" icon={FlaskConical} title={t('results.onlyTestTitle')} text={t('results.onlyTest', { count: results.test_count })}
      action={{ label: t('results.includeTest'), onClick: onInclude }} />
  }
  if (narrows(filters)) {
    return <Notice variant="empty" icon={SearchX} title={t('results.noMatchTitle')} text={t('results.noMatch')} action={{ label: t('results.clearFilters'), onClick: onClear }} />
  }
  return <Notice variant="empty" icon={Inbox} title={t('results.noneTitle')} text={t('results.none')} action={{ label: t('results.openShare'), icon: Share2, onClick: () => go('share') }} />
}

function Summary({ formId, filters, view, includeTest, onInclude, onClear }: Readonly<{
  formId: string
  filters: ViewFilters
  view: ResultsFilters
  includeTest: boolean
  onInclude: () => void
  onClear: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  const { go } = useBuilderUi()
  const query = useFormResults(formId, view)
  if (query.isError && query.data === undefined) return <LoadFailed onRetry={() => { void query.refetch() }} retrying={query.isFetching} />
  if (query.data === undefined) return <p role="status" className="text-sm text-muted">{t('results.loading')}</p>
  const results = query.data
  return (
    <div className="space-y-4">
      {includeTest && results.test_count > 0 && <IncludingTestBanner count={results.test_count} />}
      <LinkHealthNotice health={results.link_health} action={{ label: t('results.openShare'), onClick: () => go('share') }} />
      <EmptyState results={results} filters={filters} includeTest={includeTest} onInclude={onInclude} onClear={onClear} />
      {results.total > 0 && <ResultsSummary form={form} results={results} funnelFiltered={hidesFunnel(filters)} onShowAll={() => go('results', ['responses'])} />}
    </div>
  )
}

function IncludingTestBanner({ count }: Readonly<{ count: number }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  return <Notice variant="banner" tone="warn" role="note" icon={FlaskConical} text={t('results.including', { count, formatted: formatCount(count, i18n.language) })} />
}

export default function ResultsTab() {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  const { formId, rest, go } = useBuilderUi()
  const [params, setParams] = useSearchParams()
  // Never remembered (UX §10.5): reset on every visit and reload.
  const [includeTest, setIncludeTest] = useState(false)
  if (formId === null) return <SaveFirstNotice />
  const filters = readFilters(params)
  const view = apiFilters(filters, includeTest)
  const shown: View = rest[0] === 'responses' ? 'responses' : 'summary'
  const setFilters = (next: ViewFilters) => setParams(writeFilters(params, next), { replace: true })
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label={t('results.view')} value={shown} onChange={(next) => go('results', next === 'responses' ? ['responses'] : [])}
          choices={[{ value: 'summary', label: t('results.summary'), icon: BarChart3 }, { value: 'responses', label: t('results.responsesView'), icon: Rows3 }]} />
        <DownloadButton formId={formId} filters={view} />
      </div>
      <ResultsFilterBar form={form} filters={filters} onChange={setFilters} includeTest={includeTest} onIncludeTest={setIncludeTest} />
      {shown === 'summary'
        ? <Summary formId={formId} filters={filters} view={view} includeTest={includeTest} onInclude={() => setIncludeTest(true)} onClear={() => setFilters(CLEAR_FILTERS)} />
        : <ResponsesTable form={form} formId={formId} filters={view} openId={rest[1] ?? null}
            onOpen={(id) => go('results', ['responses', id])} onClose={() => go('results', ['responses'])} />}
    </div>
  )
}
