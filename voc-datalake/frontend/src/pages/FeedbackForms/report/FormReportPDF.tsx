/**
 * @fileoverview The Report's one-page PDF (7.63.00): printed by the browser (utils/printUtils.ts `openPrintWindow`, the
 * DocumentExportMenu pattern: no PDF library), with inline Kiro Light colours only (theme/printPalette.test.ts). It
 * holds the KPIs, the segment table (when the Report is grouped), each matrix's heatmap, the themes with their quotes,
 * how many responses it covers and their dates, and never a contact detail (the report holds none). Its words are the
 * reader's language, as the Report's are (rendered off-screen, it reads the app's i18n instance).
 *
 * @module pages/FeedbackForms/report/FormReportPDF
 */
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { FormReport, ReportHeatmap, ReportSegments, Scores } from '../../../api/feedbackFormsReport'
import { PdfReport, PdfReportHeader, PdfSectionHeading } from '../../../components/PdfParts/pdfParts'
import type { PdfStat } from '../../../components/PdfParts/pdfParts'
import { pdfZebraRow } from '../../../components/PdfParts/pdfTones'
import { formatCount, formatPercent } from '../../../utils/numberFormat'
import { formatDate } from '../../../utils/dateUtils'
import type { FormV2 } from '../model/formsV2'
import { percentOf } from '../results/scoreMath'
import { figureText, kpiValue, matrixLabels, measuredIds, questionHeadline, rowAveragesText, segmentValueLabel, shadeStep } from './reportLabels'

const STRONG = '#19161d'
const MUTED = '#5e5966'
const RULE = '#e4e4e7'
const CELL: CSSProperties = { padding: '6px 8px', textAlign: 'left', fontSize: '12px', color: STRONG }
const HEAD: CSSProperties = { ...CELL, color: MUTED, fontWeight: 600, borderBottom: `2px solid ${RULE}` }
/** The heatmap's four shades: white, the accent's subtle tint, its border tint, the accent (white text on it). */
const SHADES: readonly CSSProperties[] = [
  { backgroundColor: '#ffffff' }, { backgroundColor: '#f1e9ff' }, { backgroundColor: '#d7bfff' },
  { backgroundColor: '#8e48ff', color: '#ffffff' },
]
const SECTION: CSSProperties = { marginBottom: '20px' }

interface PdfProps {
  readonly form: FormV2
  readonly report: FormReport
}

function SegmentRows({ form, segments }: Readonly<{ form: FormV2; segments: ReportSegments }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const language = i18n.language
  const ids = measuredIds(form)
  const cells = (scores: Scores) => (scores === null
    ? <td colSpan={ids.length} style={{ ...CELL, color: MUTED }}>{t('report.segments.withheld')}</td>
    : ids.map((id) => (
      <td key={id} style={CELL}>{scores[id]?.type === 'matrix' ? rowAveragesText(form, id, scores[id], language) : figureText(scores[id], language)}</td>
    )))
  const label = (value: string) => segmentValueLabel(form, segments.by, value, t('report.segments.noValue'), t('report.segments.other'))
  return (
    <div data-pdf-section style={SECTION}>
      <PdfSectionHeading>{t('report.pdf.segments')}</PdfSectionHeading>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={HEAD}>{t('report.segments.segment')}</th>
            <th style={HEAD}>{t('report.segments.responses')}</th>
            {ids.map((id) => <th key={id} style={HEAD}>{questionHeadline(form, id)}</th>)}
          </tr>
        </thead>
        <tbody>
          {segments.groups.map((group, i) => (
            <tr key={group.value} style={pdfZebraRow(i)}>
              <td style={CELL}>{label(group.value)}</td>
              <td style={CELL}>{formatCount(group.responses, language)}</td>
              {cells(group.scores)}
            </tr>
          ))}
          {segments.merged !== null && (
            <tr style={pdfZebraRow(segments.groups.length)}>
              <td style={CELL}>{t('report.segments.merged', { count: segments.merged.segments, minimum: segments.min_size })}</td>
              <td style={CELL}>{formatCount(segments.merged.responses, language)}</td>
              {cells(segments.merged.scores)}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function Heatmap({ form, heatmap }: Readonly<{ form: FormV2; heatmap: ReportHeatmap }>) {
  const { i18n } = useTranslation('feedbackForms')
  const language = i18n.language
  const { row, column } = matrixLabels(form, heatmap.id)
  return (
    <div data-pdf-section style={SECTION}>
      <PdfSectionHeading>{questionHeadline(form, heatmap.id)}</PdfSectionHeading>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr><th style={HEAD} />{heatmap.columns.map((code) => <th key={code} style={HEAD}>{column(code)}</th>)}</tr>
        </thead>
        <tbody>
          {heatmap.rows.map((entry) => (
            <tr key={entry.code}>
              <td style={CELL}>{row(entry.code)}</td>
              {heatmap.columns.map((code) => {
                const share = percentOf(entry.counts[code] ?? 0, entry.answered)
                return <td key={code} style={{ ...CELL, ...SHADES[shadeStep(share)] }}>{formatPercent(share, language)}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Themes({ form, report }: PdfProps) {
  const { t, i18n } = useTranslation('feedbackForms')
  const language = i18n.language
  const entries = report.themes.filter((entry) => entry.answered > 0)
  const ai = report.ai !== null && report.ai.withheld === undefined ? report.ai : null
  if (entries.length === 0 && ai === null) return null
  return (
    <div data-pdf-section style={SECTION}>
      <PdfSectionHeading>{t('report.pdf.themes')}</PdfSectionHeading>
      {ai !== null && ai.summary !== '' && (
        <p style={{ fontSize: '12px', color: STRONG, margin: '0 0 8px 0' }}><strong>{t('report.ai.badge')}</strong> · {ai.summary}</p>
      )}
      {ai?.themes.map((theme) => (
        <div key={`ai-${theme.label}`} style={{ marginBottom: '8px' }}>
          <p style={{ fontSize: '12px', fontWeight: 600, color: STRONG, margin: 0 }}>{theme.label} ({t('report.ai.badge')}) · {formatCount(theme.count, language)}</p>
          {theme.quotes.map((quote) => <p key={quote.response_id} style={{ fontSize: '11px', color: MUTED, margin: '2px 0 0 12px' }}>“{quote.text}”</p>)}
        </div>
      ))}
      {entries.map((entry) => (
        <div key={entry.question_id} style={{ marginBottom: '8px' }}>
          <p style={{ fontSize: '12px', fontWeight: 600, color: STRONG, margin: '0 0 4px 0' }}>{questionHeadline(form, entry.question_id)}</p>
          {entry.themes.map((theme) => (
            <div key={`${theme.category}#${theme.subcategory}`} style={{ marginLeft: '12px', marginBottom: '4px' }}>
              <p style={{ fontSize: '11px', color: STRONG, margin: 0 }}>
                {[theme.category, theme.subcategory].filter((part) => part !== '').join(' · ') || t('report.themes.unprocessed')} · {formatCount(theme.count, language)}
              </p>
              {theme.quotes.map((quote) => <p key={quote.response_id} style={{ fontSize: '11px', color: MUTED, margin: '2px 0 0 12px' }}>“{quote.text}”</p>)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** The dates the report covers, "12 Nov 2026 – 18 Nov 2026" (one date when they are the same day). */
function span(report: FormReport, language: string): string {
  const first = report.first_response_at === null ? '' : formatDate(report.first_response_at, language)
  const last = report.last_response_at === null ? '' : formatDate(report.last_response_at, language)
  return first === last ? first : `${first} – ${last}`
}

export default function FormReportPDF({ form, report }: PdfProps) {
  const { t, i18n } = useTranslation('feedbackForms')
  const language = i18n.language
  const stats: PdfStat[] = [
    { label: t('report.pdf.responses'), value: report.responses, bg: '#f1e9ff', color: STRONG },
    ...report.kpis.map((kpi) => ({ label: questionHeadline(form, kpi.id), value: kpiValue(kpi, language), bg: '#f5f5f5', color: STRONG })),
  ]
  return (
    <PdfReport
      header={<PdfReportHeader title={report.name || form.name} subtitle={t('report.pdf.subtitle', { count: report.responses, formatted: formatCount(report.responses, language), dates: span(report, language) })}
        stats={stats} statMinWidth="120px" statValueSize="20px" />}
      footer={t('report.pdf.footer', { date: formatDate(new Date().toISOString(), language) })}>
      {report.segments !== null && <SegmentRows form={form} segments={report.segments} />}
      {report.matrices.map((heatmap) => <Heatmap key={heatmap.id} form={form} heatmap={heatmap} />)}
      <Themes form={form} report={report} />
    </PdfReport>
  )
}
