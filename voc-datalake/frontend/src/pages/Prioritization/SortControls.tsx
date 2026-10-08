/**
 * @fileoverview The Prioritization list sort buttons, and the hint naming what they order by.
 * @module pages/Prioritization/SortControls
 */

import clsx from 'clsx'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { SortField, SortDirection } from './prioritizationUtils'

export function SortControls({
  sortField, sortDirection, onToggleSort, ordersByTeam,
}: {
  readonly sortField: SortField;
  readonly sortDirection: SortDirection;
  readonly onToggleSort: (f: SortField) => void;
  /**
   * Can the three score buttons actually order the list by the team's numbers?
   *
   * `teamOrderingAvailable(aggregates)` — see there for which states answer false. When
   * they do, `sortPRFAQs` leaves the order as it arrived for those three fields, and the
   * hint below the buttons is permanently visible — so leaving it up left the page
   * asserting the list is ordered by the team's numbers while nothing was ordering it.
   */
  readonly ordersByTeam: boolean
}) {
  const { t } = useTranslation('prioritization')
  // Also announced, not only hovered. A `title` tooltip never appears on a touch
  // device and screen-reader support for it is inconsistent, so the readers who most
  // need "whose numbers are these" were the ones who could not reach the answer. The
  // three team-ordered buttons point at one visible line below the row; `title` stays
  // as the pointer affordance.
  const hintId = useId()
  const teamOrderedFields = [t('sort.priorityFull'), t('sort.impact'), t('sort.ttmFull')]
  // Describes the BUTTONS, not the current sort. It is permanently visible — that is
  // the point of moving it out of a `title` — so a sentence about "the list" was false
  // for as long as the reader had Date Created active: an ascending date order sat
  // directly beneath the words "orders the list by the team's numbers". Naming the
  // three options instead is true in every state, including before the reader has
  // clicked anything, which is when the hint is most use.
  //
  // The names are INTERPOLATED from the same keys the buttons render, rather than
  // restated inside the sentence in eight catalogues, so a relabelled button cannot
  // leave the hint naming an option that is no longer on screen.
  //
  // And withdrawn entirely when nothing gives the buttons a number to order by — the
  // read failed, or arrived with no readable row (`teamOrderingAvailable`): the sentence
  // would be describing an effect the reader can click for and not get. The rows and the
  // stats cards already say why the team's numbers are missing; this line's only job is
  // to attribute an ordering that is not happening.
  const teamOrdered = ordersByTeam
    ? t('sort.teamOrdered', { fields: teamOrderedFields.join(', ') })
    : undefined
  const options = [
    {
      field: 'priority_score' as const,
      label: t('sort.priority'),
      fullLabel: t('sort.priorityFull'),
      hint: teamOrdered,
    },
    {
      field: 'impact' as const,
      label: t('sort.impact'),
      fullLabel: t('sort.impact'),
      hint: teamOrdered,
    },
    {
      field: 'time_to_market' as const,
      label: t('sort.ttm'),
      fullLabel: t('sort.ttmFull'),
      hint: teamOrdered,
    },
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
        <div className="tabs-track">
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
