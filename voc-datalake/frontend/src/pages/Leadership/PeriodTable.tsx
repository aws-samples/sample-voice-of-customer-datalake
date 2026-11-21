/**
 * @fileoverview The leadership view's table view (dataviz: every chart has one): each period and the range's total,
 * every figure the charts and tiles show, in a collapsible section. The CSV holds the same rows.
 * @module pages/Leadership/PeriodTable
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdoptionPeriod, AdoptionView } from '../../api/adoptionApi'
import CollapsibleSection from '../../components/CollapsibleSection/CollapsibleSection'
import { formatCount, formatDecimal, formatPercent } from '../../utils/numberFormat'
import { periodLabel } from './leadershipRange'

const COLUMNS = ['projects', 'toPrototype', 'validations', 'decisions', 'validated', 'withAi', 'byHand',
  'conversations', 'agentRuns', 'hours'] as const
type Column = typeof COLUMNS[number]

function cells(period: AdoptionPeriod, locale: string): Record<Column, string> {
  const made = Object.values(period.artifacts)
  return {
    projects: formatCount(period.projects_started, locale),
    toPrototype: period.prototype_rate === null ? '—' : formatPercent(period.prototype_rate * 100, locale),
    validations: formatCount(period.validation_reports, locale),
    decisions: formatCount(period.decisions.total, locale),
    validated: formatCount(period.validated_decisions, locale),
    withAi: formatCount(made.reduce((sum, each) => sum + each.ai, 0), locale),
    byHand: formatCount(made.reduce((sum, each) => sum + each.human, 0), locale),
    conversations: formatCount(period.assistant_conversations, locale),
    agentRuns: formatCount(period.agent_runs, locale),
    hours: formatDecimal(period.time_saved_hours, locale, 1),
  }
}

export default function PeriodTable({ view }: Readonly<{ view: AdoptionView }>) {
  const { t, i18n } = useTranslation('leadership')
  const [open, setOpen] = useState(false)
  const quarter = (q: string, year: string) => t('periods.quarter', { quarter: q, year })
  const rows = [...view.periods.map((period) => ({ label: periodLabel(period.period, i18n.language, quarter), period })),
    { label: t('table.total'), period: view.totals }]
  return (
    <CollapsibleSection title={t('table.title')} open={open} onOpenChange={setOpen}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('table.caption')}</caption>
          <thead>
            <tr className="text-left text-muted">
              <th scope="col" className="py-2 pr-3 font-medium">{t('table.period')}</th>
              {COLUMNS.map((column) => (
                <th key={column} scope="col" className="py-2 pr-3 text-right font-medium">{t(`table.columns.${column}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, period }) => {
              const shown = cells(period, i18n.language)
              return (
                <tr key={period.period} className="border-t border-border">
                  <th scope="row" className="py-2 pr-3 text-left font-medium text-text">{label}</th>
                  {COLUMNS.map((column) => (
                    <td key={column} className="py-2 pr-3 text-right font-mono text-text">{shown[column]}</td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </CollapsibleSection>
  )
}
