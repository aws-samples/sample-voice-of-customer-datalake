/**
 * @fileoverview "Keep both versions": the control that marks a row's `Crosses
 * generations` label as intentional, and undoes the mark (#399).
 *
 * Shown only on a row whose documents cross generations. A row composed of PRD v1 and
 * PRD v2 on purpose (two drafts scored side by side) otherwise carries an amber warning
 * forever. Marked, the row shows a quiet "Kept on purpose" label instead; the mark is
 * stored for the exact document set, so it lapses by itself when the row is recomposed
 * (`lineageAck.ts`).
 *
 * Its own mutation rather than a fourth action on `useRowLifecycle`: the mark changes
 * nothing a ballot or the composition depends on, so it needs none of that hook's focus
 * and failure-panel machinery. A failure is stated inline beside the button that caused
 * it. Success re-reads the prioritization read, which is the authority on the mark.
 *
 * NOT A GATE, like everything about lineage: the row stays scorable either way.
 *
 * @module pages/Prioritization/RowLineageAckControl
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { prioritizationRowsApi } from '../../api/prioritizationRowsApi'
import { PRIORITIZATION_SCORES_KEY } from './prioritizationKeys'
import type { PrioritizationRowView } from './prioritizationUtils'
import type { ReactElement } from 'react'

export function RowLineageAckControl({ row }: {
  readonly row: Pick<PrioritizationRowView, 'row_id' | 'project_id' | 'documents' | 'lineage'>
}): ReactElement | null {
  const { t } = useTranslation('prioritization')
  const queryClient = useQueryClient()
  const mutation = useMutation({
    // The documents ON SCREEN are the set the reviewer is acknowledging. When a stored
    // id no longer resolves the two differ and the API answers 409, which is right: the
    // reviewer is not looking at the set the row holds.
    mutationFn: (acknowledged: boolean) => prioritizationRowsApi.setRowLineageAck(row.row_id, {
      project_id: row.project_id,
      acknowledged,
      document_ids: row.documents.map((document) => document.document_id),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PRIORITIZATION_SCORES_KEY }),
  })

  if (row.lineage.state !== 'crossGeneration') return null
  // One button either way: marking and undoing are the same write with the flag flipped.
  const acknowledged = row.lineage.acknowledged === true
  const Icon = acknowledged ? Undo2 : BadgeCheck
  const idle = acknowledged ? t('lineage.acknowledgeUndo') : t('lineage.acknowledge')

  return (
    <div data-testid="row-lineage-ack" className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {acknowledged ? <BadgeCheck size={14} className="flex-shrink-0" aria-hidden="true" /> : null}
        <span>{acknowledged ? t('lineage.acknowledgedNote') : t('lineage.acknowledgeHint')}</span>
        <button
          type="button"
          data-testid={acknowledged ? 'row-lineage-ack-undo' : 'row-lineage-ack-mark'}
          className={acknowledged ? 'btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm'}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate(!acknowledged)}
        >
          <Icon size={12} aria-hidden="true" />
          {mutation.isPending ? t('lineage.acknowledgeSaving') : idle}
        </button>
      </div>
      {mutation.isError ? (
        <p role="alert" className="text-xs text-danger">{t('lineage.acknowledgeFailed')}</p>
      ) : null}
    </div>
  )
}
