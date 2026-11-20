/**
 * @fileoverview A matrix as the Report's heatmap (7.63.00): its rows against its columns, each cell the share of those
 * who rated the row that chose the column (its count beside it), shaded in four steps, and the row's average when the
 * columns are scored.
 *
 * @module pages/FeedbackForms/report/MatrixHeatmap
 */
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { ReportHeatmap } from '../../../api/feedbackFormsReport'
import { formatDecimal, formatPercent } from '../../../utils/numberFormat'
import type { FormV2 } from '../model/formsV2'
import { percentOf } from '../results/scoreMath'
import { matrixLabels, questionHeadline, shadeStep } from './reportLabels'

const SHADES = ['', 'bg-accent-subtle', 'bg-accent/25', 'bg-accent text-accent-fg'] as const

export default function MatrixHeatmap({ form, heatmap }: Readonly<{ form: FormV2; heatmap: ReportHeatmap }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const { row: rowLabel, column: columnLabel } = matrixLabels(form, heatmap.id)
  return (
    <section className="card space-y-2" aria-labelledby={`heatmap-${heatmap.id}`}>
      <h3 id={`heatmap-${heatmap.id}`} className="text-sm font-semibold tracking-tight text-text-strong">{questionHeadline(form, heatmap.id)}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-center text-[13px]">
          <thead className="text-[12px] text-muted">
            <tr>
              <th scope="col" className="px-2 py-1 text-left font-medium"><span className="sr-only">{t('report.heatmap.row')}</span></th>
              {heatmap.columns.map((code) => <th key={code} scope="col" className="px-2 py-1 font-medium">{columnLabel(code)}</th>)}
              {heatmap.scored && <th scope="col" className="px-2 py-1 font-medium">{t('report.heatmap.average')}</th>}
            </tr>
          </thead>
          <tbody>
            {heatmap.rows.map((row) => (
              <tr key={row.code}>
                <th scope="row" className="px-2 py-1 text-left font-medium text-text-strong">{rowLabel(row.code)}</th>
                {heatmap.columns.map((code) => {
                  const count = row.counts[code] ?? 0
                  const share = percentOf(count, row.answered)
                  return (
                    <td key={code} className={clsx('rounded-sm px-2 py-1 tabular-nums', SHADES[shadeStep(share)])}>
                      {formatPercent(share, i18n.language)} <span className="text-[12px] opacity-80">({count})</span>
                    </td>
                  )
                })}
                {heatmap.scored && <td className="px-2 py-1 tabular-nums">{row.average === null ? '—' : formatDecimal(row.average, i18n.language, 1)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
