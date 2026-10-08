/**
 * @fileoverview The Prioritization list body: one PRFAQRow per row, or the empty and loading states.
 * @module pages/Prioritization/PRFAQList
 */

import { useTranslation } from 'react-i18next'
import PRFAQRow from './PRFAQRow'
import ListEmptyState from './ListEmptyState'
import { getScore } from './prioritizationUtils'
import type { PrioritizationRowView } from './prioritizationUtils'
import type { TeamAggregates } from './teamRead'
import { getTeamView } from './teamScore'
import type { RowCompositionActions } from './RowCompositionPanel'
import type { LinkedForm } from './formLinkUtils'
import type { PrioritizationScore } from '../../api/types'

export function PRFAQList({
  isLoading, rows, scores, aggregates, linkedFormsByDocument, apiEndpoint, composition, expandedId, onToggleExpand, onUpdateScore, hasNonScorableOnly,
}: {
  readonly isLoading: boolean
  readonly rows: PrioritizationRowView[]
  /** The caller's own ballots, PER ROW, behind each row's own sliders. */
  readonly scores: Record<string, PrioritizationScore>
  /**
   * What every reviewer together said — the resting row, and the sort order.
   *
   * A map, or a read state saying why there is none; see `TeamAggregates` for what the
   * three absences mean, rather than a restatement here that can go stale (this one did,
   * naming a `null` that left the union). Each row states the read state as such rather
   * than as an absence of votes.
   */
  readonly aggregates: TeamAggregates
  /**
   * Forms per DOCUMENT, threaded whole rather than resolved per row: a row holds a
   * set of documents and the evidence belongs to each document, so the row's
   * expansion looks up its own — see `PRFAQRow.RowDocument`.
   */
  readonly linkedFormsByDocument: ReadonlyMap<string, readonly LinkedForm[]>
  /** Passed through to each row's linked-form panels — see PRFAQRow. */
  readonly apiEndpoint: string
  /**
   * What a reviewer may do to a row's COMPOSITION, threaded whole and row-agnostic
   * so this list passes ONE value to every row rather than building callbacks per row
   * on a page that re-renders on every slider drag. See `RowCompositionActions`.
   */
  readonly composition: RowCompositionActions
  readonly expandedId: string | null
  readonly onToggleExpand: (id: string) => void
  readonly onUpdateScore: (rowId: string, field: keyof PrioritizationScore, value: number | string) => void
  readonly hasNonScorableOnly: boolean
}) {
  const { t } = useTranslation('prioritization')

  if (isLoading) {
    return <div role="status" className="text-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent mx-auto" aria-hidden="true" /><p className="text-sm text-muted mt-4">{t('loading')}</p></div>
  }
  if (rows.length === 0) {
    if (hasNonScorableOnly) {
      return <ListEmptyState title={t('empty.wrongTypeTitle')} description={t('empty.wrongTypeDescription')} />
    }
    return <ListEmptyState title={t('empty.title')} description={t('empty.description')} />
  }
  return (
    <div className="space-y-3">
      {rows.map((row, index) => (
        <PRFAQRow
          key={row.row_id}
          row={row}
          index={index}
          score={getScore(scores, row.row_id)}
          team={getTeamView(aggregates, row.row_id)}
          linkedFormsByDocument={linkedFormsByDocument}
          apiEndpoint={apiEndpoint}
          composition={composition}
          isExpanded={expandedId === row.row_id}
          onToggle={() => onToggleExpand(row.row_id)}
          onUpdateScore={(field, value) => onUpdateScore(row.row_id, field, value)}
        />
      ))}
    </div>
  )
}
