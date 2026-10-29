/**
 * @fileoverview The Prioritization list sort buttons, and the hint naming what they order by.
 * @module pages/Prioritization/SortControls
 */

import clsx from 'clsx'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { axisText, joinNames } from './axisText'
import { axisSortField } from './prioritizationUtils'
import type { SortField, SortDirection } from './prioritizationUtils'
import type { ScoringAxis } from '../../api/prioritizationAxes'

export function SortControls({
  axes, sortField, sortDirection, onToggleSort, ordersByTeam,
}: {
  /** The ACTIVE metrics of the scoring setup. */
  readonly axes: readonly ScoringAxis[];
  readonly sortField: SortField;
  readonly sortDirection: SortDirection;
  readonly onToggleSort: (f: SortField) => void;
  /**
   * Can the three score buttons actually order the list by the team's numbers?
   *
   * `teamOrderingAvailable(aggregates)` — see there for which states answer false. When
   * they do, `sortRows` leaves the order as it arrived for those three fields, and the
   * hint below the buttons is permanently visible — so leaving it up left the page
   * asserting the list is ordered by the team's numbers while nothing was ordering it.
   */
  readonly ordersByTeam: boolean
}) {
  const { t, i18n } = useTranslation('prioritization')
  // Also announced, not only hovered. A `title` tooltip never appears on a touch
  // device and screen-reader support for it is inconsistent, so the readers who most
  // need "whose numbers are these" were the ones who could not reach the answer. The
  // three team-ordered buttons point at one visible line below the row; `title` stays
  // as the pointer affordance.
  const hintId = useId()
  const axisOptions = axes.map((axis) => {
    const text = axisText(axis, t)
    return { field: axisSortField(axis.id), label: text.shortName, fullLabel: text.name }
  })
  const teamOrderedFields = [t('sort.priorityFull'), ...axisOptions.map((option) => option.fullLabel)]
  // Describes the BUTTONS, not the current sort, and names them from the same values
  // the buttons render — so a renamed or added metric cannot leave the hint naming an
  // option that is not on screen. Withdrawn when nothing gives the buttons a number to
  // order by (`teamOrderingAvailable`).
  const teamOrdered = ordersByTeam
    ? t('sort.teamOrdered', { fields: joinNames(teamOrderedFields, i18n.language) })
    : undefined
  const options = [
    {
      field: 'priority_score' as const,
      label: t('sort.priority'),
      fullLabel: t('sort.priorityFull'),
      hint: teamOrdered,
    },
    // Every ACTIVE metric of the scoring setup is a sort, in its configured order.
    ...axisOptions.map((option) => ({ ...option, hint: teamOrdered })),
    {
      field: 'created_at' as const,
      label: t('sort.date'),
      fullLabel: t('sort.dateFull'),
      hint: undefined,
    },
  ]
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted w-full sm:w-auto">{t('sort.label')}</span>
        <div className="tabs-track flex-wrap">
          {options.map(({
            field, label, fullLabel, hint,
          }) => (
            <button key={field} type="button" aria-pressed={sortField === field} title={hint} aria-describedby={hint === undefined ? undefined : hintId} onClick={() => onToggleSort(field)} className={clsx('tab', sortField === field && 'tab-active')}>
              <span className="sm:hidden">{label}</span>
              <span className="hidden sm:inline">{fullLabel}</span>
              {/* A directional arrow, not the symmetric ArrowUpDown, which looked the
                  same rotated or not and so never showed which way the list ran. */}
              {sortField === field && (sortDirection === 'desc'
                ? <ArrowDown size={14} aria-hidden="true" />
                : <ArrowUp size={14} aria-hidden="true" />)}
            </button>
          ))}
        </div>
      </div>
      {teamOrdered === undefined ? null : (
        <p id={hintId} className="text-xs text-muted mt-1.5">{teamOrdered}</p>
      )}
    </div>
  )
}
