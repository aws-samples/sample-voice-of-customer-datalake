/**
 * @fileoverview The Report's segments (7.63.00): one row per segment of at least 5 responses, then "Other (fewer than
 * 5)" for the smaller ones together, whose figures stay withheld while they are fewer than 5 too, so no one can be
 * picked out. A column per measured question: its NPS, CSAT %, CES % or average, a matrix's row averages.
 *
 * @module pages/FeedbackForms/report/SegmentTable
 */
import { useTranslation } from 'react-i18next'
import type { ReportSegments, Scores } from '../../../api/feedbackFormsReport'
import { formatCount } from '../../../utils/numberFormat'
import type { FormV2 } from '../model/formsV2'
import { figureText, measuredIds, questionHeadline, rowAveragesText, segmentValueLabel } from './reportLabels'

function Cells({ form, ids, scores }: Readonly<{ form: FormV2; ids: readonly string[]; scores: Scores }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  if (scores === null) return <td colSpan={ids.length} className="px-3 py-2 text-[12px] text-muted">{t('report.segments.withheld')}</td>
  return (
    <>
      {ids.map((id) => (
        <td key={id} className="px-3 py-2 tabular-nums">
          {scores[id]?.type === 'matrix' ? rowAveragesText(form, id, scores[id], i18n.language) : figureText(scores[id], i18n.language)}
        </td>
      ))}
    </>
  )
}

export default function SegmentTable({ form, segments }: Readonly<{ form: FormV2; segments: ReportSegments }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const ids = measuredIds(form)
  const label = (value: string) => segmentValueLabel(form, segments.by, value, t('report.segments.noValue'), t('report.segments.other'))
  if (segments.groups.length === 0 && segments.merged === null) return <p className="text-sm text-muted">{t('report.segments.none')}</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{t('report.segments.caption')}</caption>
        <thead className="text-[12px] text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">{t('report.segments.segment')}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t('report.segments.responses')}</th>
            {ids.map((id) => <th key={id} scope="col" className="px-3 py-2 font-medium">{questionHeadline(form, id)}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {segments.groups.map((group) => (
            <tr key={group.value}>
              <th scope="row" className="px-3 py-2 font-medium text-text-strong">{label(group.value)}</th>
              <td className="px-3 py-2 tabular-nums">{formatCount(group.responses, i18n.language)}</td>
              <Cells form={form} ids={ids} scores={group.scores} />
            </tr>
          ))}
          {segments.merged !== null && (
            <tr>
              <th scope="row" className="px-3 py-2 font-medium text-text-strong">
                {t('report.segments.merged', { count: segments.merged.segments, minimum: segments.min_size })}
              </th>
              <td className="px-3 py-2 tabular-nums">{formatCount(segments.merged.responses, i18n.language)}</td>
              <Cells form={form} ids={ids} scores={segments.merged.scores} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
