/**
 * @fileoverview Results › Report (7.63.00, docs/feedback-forms.md "Report"): the form's auto-report under the Results
 * filters. The KPIs (each score question's NPS, CSAT %, CES % or average), the segments when a hidden field, a single
 * choice or a matrix row is picked (each of at least 5 responses, so no one is picked out), each matrix as a heatmap,
 * the optional AI summary (labelled AI), the themes of the open answers with real quotes, Compare, and a one-page PDF
 * printed by the browser.
 *
 * @module pages/FeedbackForms/report/ReportView
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, FileDown, Inbox } from 'lucide-react'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import MetricCard from '../../../components/MetricCard/MetricCard'
import Notice from '../../../components/Notice/Notice'
import type { FormReport } from '../../../api/feedbackFormsReport'
import type { ResultsFilters } from '../../../api/feedbackFormsV2Api'
import { openPrintWindow } from '../../../utils/printUtils'
import { formatCount } from '../../../utils/numberFormat'
import { useDraft } from '../builder/formDraftContext'
import type { FormV2 } from '../model/formsV2'
import AiSummaryCard from './AiSummaryCard'
import ComparePanel from './ComparePanel'
import FormReportPDF from './FormReportPDF'
import MatrixHeatmap from './MatrixHeatmap'
import ReportThemes from './ReportThemes'
import SegmentTable from './SegmentTable'
import { kpiValue, questionHeadline, segmentChoices } from './reportLabels'
import { useFormReport } from './useFormReport'

function Kpis({ form, report }: Readonly<{ form: FormV2; report: FormReport }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard title={t('report.responses')} value={report.responses} icon={<Inbox size={20} aria-hidden="true" />} />
      {report.kpis.map((kpi) => (
        <MetricCard key={kpi.id} title={questionHeadline(form, kpi.id)} value={kpiValue(kpi, i18n.language)} icon={<BarChart3 size={20} aria-hidden="true" />}
          detail={t('report.kpiAnswered', { count: kpi.answered, formatted: formatCount(kpi.answered, i18n.language) })} />
      ))}
    </div>
  )
}

function SegmentPicker({ form, value, onChange }: Readonly<{ form: FormV2; value: string | null; onChange: (next: string | null) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const choices = segmentChoices(form)
  return (
    <span className="flex items-center gap-2">
      <label htmlFor={id} className="text-[12px] font-medium text-muted">{t('report.segmentBy')}</label>
      <select id={id} className="select select-sm w-auto max-w-xs" value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}>
        <option value="">{t('report.noSegments')}</option>
        {choices.map(({ value: by, label }) => <option key={by} value={by}>{label}</option>)}
      </select>
    </span>
  )
}

export default function ReportView({ formId, view }: Readonly<{ formId: string; view: ResultsFilters }>) {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  const [groupBy, setGroupBy] = useState<string | null>(null)
  const [printFailed, setPrintFailed] = useState(false)
  const query = useFormReport(formId, view, groupBy)
  const report = query.data
  if (report === undefined) {
    return query.isError ? <LoadFailed onRetry={() => { void query.refetch() }} retrying={query.isFetching} />
      : <p role="status" className="text-sm text-muted">{t('report.loading')}</p>
  }
  const print = () => {
    const frame = openPrintWindow({ title: t('report.pdf.title', { name: report.name || form.name }),
      content: <FormReportPDF form={form} report={report} /> })
    setPrintFailed(frame === null)
  }
  const segmentName = segmentChoices(form).find((choice) => choice.value === groupBy)?.label ?? ''
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentPicker form={form} value={groupBy} onChange={setGroupBy} />
        <button type="button" className="btn btn-secondary btn-sm" onClick={print} disabled={report.responses === 0}>
          <FileDown size={14} aria-hidden="true" />{t('report.pdf.download')}
        </button>
      </div>
      {printFailed && <p role="alert" className="text-sm text-danger">{t('report.pdf.failed')}</p>}
      {report.responses === 0
        ? <Notice variant="empty" icon={Inbox} title={t('report.emptyTitle')} text={t('report.empty')} />
        : (
          <>
            <Kpis form={form} report={report} />
            {report.segments !== null && (
              <section className="card space-y-2" aria-labelledby="report-segments">
                <h3 id="report-segments" className="text-sm font-semibold tracking-tight text-text-strong">{t('report.segments.title', { segment: segmentName })}</h3>
                <p className="text-[12px] text-muted">{t('report.segments.hint', { minimum: report.min_segment })}</p>
                <SegmentTable form={form} segments={report.segments} />
              </section>
            )}
            {report.matrices.map((heatmap) => <MatrixHeatmap key={heatmap.id} form={form} heatmap={heatmap} />)}
            <AiSummaryCard form={form} formId={formId} filters={view} report={report} />
            <section className="space-y-2" aria-labelledby="report-themes">
              <h3 id="report-themes" className="text-sm font-semibold tracking-tight text-text-strong">{t('report.themes.title')}</h3>
              <p className="text-[12px] text-muted">{t('report.themes.hint')}</p>
              <ReportThemes form={form} themes={report.themes} />
            </section>
          </>
        )}
      <ComparePanel form={form} formId={formId} filters={view} />
    </div>
  )
}
