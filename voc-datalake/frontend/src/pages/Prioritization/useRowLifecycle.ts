/**
 * @fileoverview The three row-lifecycle writes the prioritization page offers, and
 * the one thing a reader has to be told about each: whether it failed, and why.
 *
 * Its own hook rather than three more `useMutation` calls in `Prioritization.tsx`,
 * which is at its `max-lines` budget — and a genuine seam: everything here is about
 * CHANGING WHICH ROWS EXIST, while the page's own state is about scoring the ones
 * that do. The page keeps the query key and performs the invalidation, because the
 * read is what it renders.
 *
 * ONE FAILURE AT A TIME, deliberately. These three writes are mutually exclusive in
 * practice — a reviewer presses one control in one expanded row — so a per-mutation
 * error trio would put three panels in the layout to cover states that cannot
 * coexist, and a reader would have to work out which of them describes what they just
 * pressed. The last failure wins, and it carries the ACTION as well as the status, so
 * the sentence on screen names what did not happen.
 *
 * SUCCESS REFRESHES THE AUTHORITATIVE READ, and nothing else. No optimistic row is
 * added or removed: the read reports every row in the partition and is the only thing
 * that knows what a compose actually stored or what a delete actually took with it,
 * and an optimistic list that disagreed with it would flicker back on the next
 * refetch. A delete does not remount the page either — the same query the rest of the
 * page reads simply stops naming that row.
 *
 * @module pages/Prioritization/useRowLifecycle
 */

import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { prioritizationRowsApi } from '../../api/prioritizationRowsApi'
import type { RowCompositionActions } from './RowCompositionPanel'
import type { PrioritizationRowView } from './prioritizationUtils'
import type { ProjectDocument } from '../../api/types'

/** Which of the three writes a failure is about. */
export type RowAction = 'compose' | 'recompose' | 'delete'

/**
 * A write that did not land, as the page states it.
 *
 * `status` is the HTTP status or `null` for a request that never reached a server
 * (`apiErrorStatus`), and the page's copy branches on the ONE status a reviewer can
 * act on differently: a 409 is a conflict with stored state — a ballot froze the
 * composition, the row is gone, the project is at its row bound — where the remedy is
 * to reload and look at the current rows, while everything else is "it did not work,
 * try again".
 */
export interface RowActionFailure {
  readonly action: RowAction
  readonly status: number | null
  /** The row the reviewer was acting on, so the panel can name it. */
  readonly rowTitle: string
}

/** Is this failure a conflict with the row's stored state? See `RowActionFailure`. */
export const isStateConflict = (failure: RowActionFailure): boolean => failure.status === 409

export interface RowLifecycle {
  /** Threaded whole to every row — see `RowCompositionActions`. */
  readonly actions: RowCompositionActions
  /** The last write that failed, or `undefined` while none has. */
  readonly failure: RowActionFailure | undefined
  /** Dismiss the failure panel. */
  readonly clearFailure: () => void
}

export function useRowLifecycle({
  candidatesByProject, canDelete, onRowsChanged,
}: {
  readonly candidatesByProject: ReadonlyMap<string, readonly ProjectDocument[]>
  readonly canDelete: boolean
  /** Refresh the authoritative read — the page owns the query key. */
  readonly onRowsChanged: () => void
}): RowLifecycle {
  const [failure, setFailure] = useState<RowActionFailure | undefined>(undefined)
  /**
   * One mutation for all three writes, keyed by the action it performs.
   *
   * Three `useMutation` calls would give three `isPending` flags for states that
   * cannot coexist, and the panel would then have to decide which one disables a
   * control. One mutation means `isPending` is exactly "a row write is in flight",
   * which is what the controls are gated on.
   *
   * The variables carry the row so both callbacks can name it: a failure has to say
   * which row it is about, and the row is gone by the time a delete settles.
   */
  const mutation = useMutation({
    mutationFn: (input: RowWrite) => performRowWrite(input),
    onSuccess: () => {
      // Cleared on the way in as well as out: a reviewer who retried after a 409 and
      // succeeded must not be left reading the refusal they have just resolved.
      setFailure(undefined)
      onRowsChanged()
    },
    onError: (error, input) => {
      setFailure({
        action: input.action,
        status: apiErrorStatus(error),
        rowTitle: input.row.title,
      })
    },
  })

  const write = (input: RowWrite) => {
    // Dropped BEFORE the request rather than only on success, so the panel describes
    // the write in flight rather than the previous one for as long as it runs.
    setFailure(undefined)
    mutation.mutate(input)
  }

  return {
    actions: {
      candidatesByProject,
      canDelete,
      pending: mutation.isPending,
      onCompose: (row, documentIds) => write({ action: 'compose', row, documentIds }),
      onRecompose: (row, documentIds) => write({ action: 'recompose', row, documentIds }),
      onDelete: (row) => write({ action: 'delete', row, documentIds: [] }),
    },
    failure,
    clearFailure: () => setFailure(undefined),
  }
}

/** One row write, as the mutation's variables — see `mutation` above. */
interface RowWrite {
  readonly action: RowAction
  readonly row: PrioritizationRowView
  /** Empty for a delete, which changes no composition. */
  readonly documentIds: readonly string[]
}

/**
 * The client call one action means.
 *
 * A `switch` with no `default`, so a fourth action fails to compile here rather than
 * silently resolving to nothing — the same reasoning `unscoredLabel` records for its
 * exhaustive switch over `TeamView`.
 *
 * `project_id` is sent on both composition writes because both routes validate the
 * document ids against THAT project's own documents; the recompose additionally
 * asserts it in the write's condition, so a row of another project cannot be given
 * this one's documents.
 */
function performRowWrite(input: RowWrite): Promise<unknown> {
  const composition = {
    project_id: input.row.project_id,
    document_ids: input.documentIds,
  }
  switch (input.action) {
    case 'compose':
      return prioritizationRowsApi.composePrioritizationRow(composition)
    case 'recompose':
      return prioritizationRowsApi.recomposePrioritizationRow(input.row.row_id, composition)
    case 'delete':
      return prioritizationRowsApi.deletePrioritizationRow(input.row.row_id)
  }
}
