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
 * A COMPLETED DELETE IS ALSO STATED, and only that one of the three. A compose and a
 * recompose show themselves — the row appears, or its documents change — while a
 * deleted row simply vanishes, which is what a filter and a failed read also look
 * like, for the one action whose dialog just called it irreversible and said it takes
 * other reviewers' ballots. `ballots_deleted` is the only evidence of that half, since
 * the row is gone and nothing can be re-read to check.
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
import { apiErrorStatus, isPermanentRefusal } from '../../api/apiErrorStatus'
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
 * (`apiErrorStatus`), and the page's copy branches on the TWO distinctions a reviewer
 * can act on differently — see `isStateConflict` and `isSettledRefusal`.
 */
export interface RowActionFailure {
  readonly action: RowAction
  readonly status: number | null
  /** The row the reviewer was acting on, so the panel can name it. */
  readonly rowTitle: string
}

/**
 * Is this failure a conflict with the row's stored state?
 *
 * A 409 is a fact about what is stored — a ballot froze the composition, the row is
 * already gone, the project is at its row bound, a default row is a project's only one
 * — and the remedy is to reload and look at the current rows.
 */
export const isStateConflict = (failure: RowActionFailure): boolean => failure.status === 409

/**
 * Is this failure SETTLED without being a state conflict — a refusal of the request
 * itself, which asking again cannot change?
 *
 * Three of these are reachable from this page, and all three used to be told "nothing
 * was saved, so you can try again", which is advice that can never work:
 *
 *  * **400** — more documents than `MAX_ROW_DOCUMENT_IDS` allows. The picker
 *    deliberately does not enforce that bound (see `RowCompositionPanel`), so this is
 *    precisely the refusal the client delegates to the server and therefore the one
 *    that most needs a settled sentence.
 *  * **404** — a document id the project no longer holds, because the candidate list
 *    came from a cached project read.
 *  * **403** — a delete a non-admin reached anyway.
 *
 * Built on `isPermanentRefusal`, which is the repo's existing split between a settled
 * 4xx and a passing failure. Note it classifies 403 as RETRYABLE, on the reasoning
 * that a WAF block or a lapsed token lives there too — a judgement that is right for
 * the row-ensure's silent retry loop and wrong for a sentence put in front of a
 * person, who can act on "you may not do this" and cannot act on "try again". So 403
 * is added back here, at the one boundary where the reader is the audience.
 *
 * `status` is re-wrapped in the shape `apiErrorStatus` reads, rather than
 * `isPermanentRefusal` being handed the original rejection: the failure has already
 * crossed into state by this point and carries only the number.
 */
export const isSettledRefusal = (failure: RowActionFailure): boolean => {
  if (failure.status === null || isStateConflict(failure)) return false
  if (failure.status === 403) return true
  return isPermanentRefusal(new Error(`API Error: ${failure.status}`))
}

/**
 * A delete that LANDED, and the receipt it came back with.
 *
 * `ballotsDeleted` is the server's count, and 0 means one of two things the copy has
 * to keep apart: the row genuinely carried no ballots, or the receipt could not be
 * read (`prioritizationRowsApi` answers 0 for an unreadable body rather than turning a
 * completed delete into a rejected mutation). So the zero case gets its own sentence
 * that claims nothing about a number.
 */
export interface RowDeleted {
  readonly rowTitle: string
  readonly ballotsDeleted: number
}

export interface RowLifecycle {
  /** Threaded whole to every row — see `RowCompositionActions`. */
  readonly actions: RowCompositionActions
  /** The last write that failed, or `undefined` while none has. */
  readonly failure: RowActionFailure | undefined
  /** The last delete that landed, or `undefined` while none has. */
  readonly deleted: RowDeleted | undefined
  /** Dismiss the failure panel. */
  readonly clearFailure: () => void
  /** Dismiss the delete-receipt panel. */
  readonly clearDeleted: () => void
}

export function useRowLifecycle({
  candidatesByProject, rowsByProject, canDelete, onRowsChanged, onRowDeleted,
}: {
  readonly candidatesByProject: ReadonlyMap<string, readonly ProjectDocument[]>
  /** How many rows each project has, for the delete's courtesy gate — see the panel. */
  readonly rowsByProject: ReadonlyMap<string, number>
  readonly canDelete: boolean
  /** Refresh the authoritative read — the page owns the query key. */
  readonly onRowsChanged: () => void
  /**
   * A row that is GONE, by id, so the page can drop whatever it holds keyed by it.
   *
   * Fired only for a settled delete, and separately from `onRowsChanged` because the
   * two mean different things: one says "re-read", the other says "this row will never
   * be a legal key again". `patchPrioritizationScores` refuses its WHOLE body with 404
   * when it names a row that no longer exists — deliberately, so nothing is half
   * written — so a pending slider edit left behind on a deleted row would take every
   * other row's unsaved edit down with it on the next Save.
   */
  readonly onRowDeleted?: (rowId: string) => void
}): RowLifecycle {
  const [failure, setFailure] = useState<RowActionFailure | undefined>(undefined)
  const [deleted, setDeleted] = useState<RowDeleted | undefined>(undefined)
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
    onSuccess: (result, input) => {
      // Cleared on the way in as well as out: a reviewer who retried after a 409 and
      // succeeded must not be left reading the refusal they have just resolved.
      setFailure(undefined)
      if (input.action === 'delete') {
        setDeleted({ rowTitle: input.row.title, ballotsDeleted: result })
        // The row will never be a legal key again — see `onRowDeleted`.
        onRowDeleted?.(input.row.row_id)
      }
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
    // Dropped BEFORE the request rather than only on success, so the panels describe
    // the write in flight rather than the previous one for as long as it runs.
    setFailure(undefined)
    setDeleted(undefined)
    mutation.mutate(input)
  }

  return {
    actions: {
      candidatesByProject,
      rowsByProject,
      canDelete,
      pending: mutation.isPending,
      onCompose: (row, documentIds) => write({ action: 'compose', row, documentIds }),
      onRecompose: (row, documentIds) => write({ action: 'recompose', row, documentIds }),
      onDelete: (row) => write({ action: 'delete', row, documentIds: [] }),
    },
    failure,
    deleted,
    clearFailure: () => setFailure(undefined),
    clearDeleted: () => setDeleted(undefined),
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
 * The client call one action means, RESOLVED TO THE ONE NUMBER `onSuccess` reads: how
 * many ballots the write took with it.
 *
 * Narrowed to a number here rather than passed on as the three routes' own answers,
 * because that is the whole of what the settled callback needs and a union of three
 * response shapes would have to be re-narrowed there. Compose and recompose report 0
 * because they destroy no ballot — their `row` is a courtesy the page does not render,
 * since the refreshed read is the authority on what a compose stored.
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
async function performRowWrite(input: RowWrite): Promise<number> {
  const composition = {
    project_id: input.row.project_id,
    document_ids: input.documentIds,
  }
  switch (input.action) {
    case 'compose':
      await prioritizationRowsApi.composePrioritizationRow(composition)
      return NO_BALLOTS_DESTROYED
    case 'recompose':
      await prioritizationRowsApi.recomposePrioritizationRow(input.row.row_id, composition)
      return NO_BALLOTS_DESTROYED
    case 'delete': {
      // Already validated at the wire boundary, which answers 0 for a receipt it could
      // not read rather than rejecting a delete the server completed.
      const receipt = await prioritizationRowsApi.deletePrioritizationRow(input.row.row_id)
      return receipt.ballots_deleted
    }
  }
}

/** What a composition write reports for a count it cannot have — see `performRowWrite`. */
const NO_BALLOTS_DESTROYED = 0
