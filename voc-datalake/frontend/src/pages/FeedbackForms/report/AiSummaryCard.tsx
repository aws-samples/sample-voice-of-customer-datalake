/**
 * @fileoverview The Report's AI summary (7.63.00), always labelled AI: optional, one model call when asked for. It
 * reads the view's open-text answers with the person's own access, labels themes and picks quotes; the quotes shown
 * are always real responses (joined when the report is read). "Newer responses" once a response came in after it;
 * withheld from someone who can't see a response it read.
 *
 * @module pages/FeedbackForms/report/AiSummaryCard
 */
import { useTranslation } from 'react-i18next'
import { RefreshCw, Sparkles } from 'lucide-react'
import type { FormReport, ReportAi } from '../../../api/feedbackFormsReport'
import type { ResultsFilters } from '../../../api/feedbackFormsV2Api'
import { FormsApiError } from '../../../api/feedbackFormsV2Api'
import { formatCount } from '../../../utils/numberFormat'
import { formatDate } from '../../../utils/dateUtils'
import type { FormV2 } from '../model/formsV2'
import { useSummarizeReport } from './useFormReport'

function failureText(t: (key: string, options?: Record<string, unknown>) => string, error: unknown): string {
  if (error instanceof FormsApiError && error.status === 429) return t('report.ai.rateLimited')
  if (error instanceof FormsApiError && error.code === 'no_model') return t('report.ai.noModel')
  if (error instanceof FormsApiError && error.code === 'no_summary') return t('report.ai.noSummary')
  return t('report.ai.failed')
}

/** A stored summary as this reader may see it: its text, its labelled themes with their real quotes, when it was made. */
function StoredSummary({ ai }: Readonly<{ ai: ReportAi }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  if (ai.withheld === 'access') return <p className="text-sm text-muted">{t('report.ai.withheld')}</p>
  const counted = ai.responses_counted ?? 0
  return (
    <>
      {ai.summary !== '' && <p className="text-sm text-text">{ai.summary}</p>}
      <ul className="space-y-2">
        {ai.themes.map((theme) => (
          <li key={theme.label} className="space-y-1">
            <p className="text-sm font-medium text-text-strong">
              {theme.label} <span className="text-[12px] font-normal tabular-nums text-muted">· {t('report.themes.answers', { count: theme.count, formatted: formatCount(theme.count, i18n.language) })}</span>
            </p>
            {theme.quotes.map((quote) => <p key={quote.response_id} className="text-[13px] text-muted"><q>{quote.text}</q></p>)}
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-muted">{t('report.ai.made', { date: formatDate(ai.created_at, i18n.language), count: counted, formatted: formatCount(counted, i18n.language) })}</p>
    </>
  )
}

export default function AiSummaryCard({ form, formId, filters, report }: Readonly<{
  form: FormV2
  formId: string
  filters: ResultsFilters
  report: FormReport
}>) {
  const { t } = useTranslation('feedbackForms')
  const summarize = useSummarizeReport(formId, form, filters)
  const answered = report.themes.reduce((sum, entry) => sum + entry.answered, 0)
  const ai = report.ai
  const start = () => summarize.mutate({ responses: report.responses, lastResponseAt: report.last_response_at })
  const label = ai === null ? t('report.ai.start') : t('report.ai.again')
  return (
    <section className="card space-y-3" aria-labelledby="report-ai">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="report-ai" className="flex items-center gap-2 text-sm font-semibold tracking-tight text-text-strong">
          <Sparkles size={14} className="text-aim" aria-hidden="true" />{t('report.ai.title')}
          <span className="badge badge-info">{t('report.ai.badge')}</span>
          {ai?.stale === true && <span className="badge badge-warn">{t('report.ai.stale')}</span>}
        </h3>
        <button type="button" className="btn btn-secondary btn-sm" disabled={answered === 0 || summarize.isPending} onClick={start}>
          {ai === null ? <Sparkles size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          {summarize.isPending ? t('report.ai.working') : label}
        </button>
      </div>
      {summarize.isError && <p role="alert" className="text-sm text-danger">{failureText(t, summarize.error)}</p>}
      {ai === null
        ? <p className="text-sm text-muted">{answered === 0 ? t('report.ai.nothing') : t('report.ai.intro')}</p>
        : <StoredSummary ai={ai} />}
    </section>
  )
}
