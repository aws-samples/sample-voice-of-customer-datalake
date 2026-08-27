/**
 * @fileoverview What a row HOLDS, and what a reviewer may do about it: change the
 * documents while nothing has been balloted, add another row for another
 * combination, and — for an admin — delete the row with its ballots.
 *
 * Its own module rather than more of `PRFAQRow`, which is at its `max-lines`
 * budget, and a genuine seam besides: everything here is about the row's
 * COMPOSITION, while everything there is about scoring it.
 *
 * THE SERVER OWNS EVERY RULE THIS PANEL APPEARS TO ENFORCE. The freeze is a
 * condition on the write (`ROW_FROZEN_AT_FIELD`), the ownership of a document id is
 * checked against the project's own partition, the count of documents and of rows are
 * bounded there, and the delete is admin-gated by `require_admin`. So what a hidden
 * control buys is a reviewer not being invited to do something that will be refused —
 * never the refusal itself. That is why the page states a 409 rather than assuming its
 * own view of `is_frozen` settled the matter: a first ballot landing while this panel
 * is open loses nothing, it just wins.
 *
 * Mounted only inside an EXPANDED row, like everything else in that column, so at
 * most one of these exists at a time (`expandedId` is a single row). That is what
 * lets the page pass one `pending` flag rather than tracking which row is mid-write.
 *
 * @module pages/Prioritization/RowCompositionPanel
 */

import clsx from 'clsx'
import {
  FilePlus2, Lock, Pencil, Trash2,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal'
import { SCORABLE_TYPE_META } from './prioritizationUtils'
import type { PrioritizationRowView } from './prioritizationUtils'
import type { ProjectDocument } from '../../api/types'
import type { TFunction } from 'i18next'
import type { ReactElement } from 'react'

/**
 * Which picker, if any, is open. One value rather than two booleans: the two
 * pickers ask about the same project's documents and differ only in what a save
 * means, and two independent flags would let both be on screen with two Save
 * buttons a reviewer has to tell apart.
 */
type OpenPicker = 'none' | 'recompose' | 'compose'

/**
 * The two pickers that actually SUBMIT something — `OpenPicker` without its closed
 * state.
 *
 * Its own type so the submit path cannot be reached with `'none'`: the picker is only
 * rendered where the mode is already known to be one of these, so passing that value
 * down narrows the dispatch to a `switch` with no `default`, in which a fourth mode
 * fails to compile. Two independent `if`s over the wider type would instead close the
 * picker and issue no write — a silently discarded submission the compiler could not
 * see — which is exactly the shape `performRowWrite` avoids in `useRowLifecycle`.
 */
type SubmittingPicker = Exclude<OpenPicker, 'none'>

/**
 * Everything a row needs to offer its composition, in one object threaded whole
 * from the page.
 *
 * ROW-AGNOSTIC on purpose, so the list can pass ONE value down rather than
 * building three closures and a document array per row on every render of a page
 * that re-renders on every slider drag: each callback takes the row it is about,
 * and the candidate documents are looked up by the row's project.
 *
 * A single object also keeps the seven-parameter prop lists this page's lint budget
 * refuses out of `PRFAQRow` and `PRFAQList`, which only forward it.
 */
export interface RowCompositionActions {
  /**
   * Each project's own scorable documents — every PRD and PR/FAQ it holds, not just
   * the ones a row was composed from. That is the candidate set the compose and
   * recompose routes validate against (`_scorable_document_ids`), resolved from the
   * project read this page already performs rather than by a request per row.
   *
   * A prototype is deliberately absent: it is context a reviewer looks at rather than
   * a document a row is scored on, and the route refuses one in `document_ids`.
   *
   * A project with no entry contributes an empty list, which leaves the pickers with
   * nothing to tick and Save unavailable — the honest state for a project whose
   * documents have not been read.
   */
  readonly candidatesByProject: ReadonlyMap<string, readonly ProjectDocument[]>
  /**
   * How many rows each project has on screen — see `rowsPerProject`.
   *
   * Read for ONE reason: `api_delete_prioritization_row` refuses a project's DEFAULT
   * row while it is that project's only row, which is the state every project starts
   * in. Without this the delete would be offered on a typical page's every row, behind
   * a dialog stating an irreversible effect that cannot occur.
   */
  readonly rowsByProject: ReadonlyMap<string, number>
  /**
   * Whether that count is complete enough to be STATED as a reason, as opposed to only
   * acted on by withholding a control.
   *
   * False while any read feeding it is still arriving. The gate below runs either way —
   * a momentarily absent control is recoverable, the reader waits and it appears — but
   * the sentence explaining the absence claims a fact about stored state ("this is the
   * project's only default row"), and a reviewer who believes a false one adds a row
   * they did not want. See `rowCountSettled` in `Prioritization.tsx`.
   */
  readonly rowCountSettled: boolean
  /**
   * Whether to OFFER the delete. Read off the caller's admin group; the refusal is
   * the server's (`require_admin` answers 403 before anything is read), so this is
   * the courtesy half — a non-admin is not invited to press a button that cannot
   * work.
   */
  readonly canDelete: boolean
  /** True while any row-composition write is in flight — see the module docstring. */
  readonly pending: boolean
  readonly onCompose: (row: PrioritizationRowView, documentIds: readonly string[]) => void
  readonly onRecompose: (row: PrioritizationRowView, documentIds: readonly string[]) => void
  readonly onDelete: (row: PrioritizationRowView) => void
}

/** Shared empty list, so a project with no read documents allocates nothing per render. */
const NO_CANDIDATES: readonly ProjectDocument[] = []

/**
 * Would deleting this row be refused before it started?
 *
 * `api_delete_prioritization_row` answers 409 for a project's DEFAULT row while it is
 * that project's only row — the state every project begins in — so offering the control
 * there invites an action that cannot work, behind a dialog naming an irreversible
 * effect that will not occur. A COURTESY GATE, not a protection: the server's refusal
 * stays authoritative and `rowAction.deleteConflict` already words it, so a count that
 * has gone stale costs at most an offered control and a sentence — never a delete that
 * happens when it should not.
 *
 * A MISSING COUNT READS AS 1, which withholds the control for a default row: a row on
 * screen is at least one row of its project, so a project with no entry is the
 * single-row shape rather than the multi-row one.
 *
 * WITHHOLDING IS ALL THIS DECIDES, never what to SAY about it. The count is only as
 * complete as the reads behind it, so a project that genuinely holds two rows can
 * present as one while a read is still arriving — and the sentence explaining the
 * absence would then assert something false about stored state. `rowCountSettled` is
 * what keeps the two apart.
 */
function isProjectsOnlyDefaultRow(
  row: PrioritizationRowView,
  rowsByProject: ReadonlyMap<string, number>,
): boolean {
  return row.is_default && (rowsByProject.get(row.project_id) ?? 1) <= 1
}

/**
 * One project's scorable documents, as chosen for a row.
 *
 * A CHECKBOX GROUP in a fieldset with a legend, so the group has an accessible name
 * and every option is reachable and toggleable from the keyboard with no handler of
 * our own — the native control already does that, and a `div` with a click handler
 * would not.
 *
 * SELECTION STARTS FROM `initialIds` and then belongs to the reviewer. Held here rather
 * than in the parent, so closing the picker discards a half-made choice instead of
 * leaving it to reappear later, and NOTHING re-seeds it while it is open: not a prop
 * (state is seeded once, by `useState`) and not a `key` at the call site, which is only
 * the mode. That is what makes the promise real — a background refetch changing the
 * row's stored composition (the hourly prototype re-sign, another reviewer's recompose)
 * must not rewrite what somebody has ticked, and a `key` carrying the stored ids used to
 * do exactly that by remounting.
 *
 * REOPENING is what picks up a landed save: the picker closes on submit, so the next
 * open reads fresh `heldIds` through `initialIds` with no remount involved.
 *
 * AT LEAST ONE is the only rule enforced here, and it is enforced by disabling Save
 * rather than by refusing after the fact: a row with nothing to score is not a row,
 * the API says so in the same words for the default create, and a reviewer who has
 * unticked everything has nothing to submit. The upper bound on documents, the
 * bound on rows per project, and whether the project owns an id are the SERVER'S —
 * this panel neither counts nor filters for them, so it cannot disagree with the
 * route about what is legal.
 */
function DocumentPicker({
  documents, initialIds, submitLabel, pending, onSubmit, onCancel, t,
}: {
  readonly documents: readonly ProjectDocument[]
  readonly initialIds: readonly string[]
  readonly submitLabel: string
  readonly pending: boolean
  readonly onSubmit: (documentIds: readonly string[]) => void
  readonly onCancel: () => void
  readonly t: TFunction
}): ReactElement {
  const [selected, setSelected] = useState<readonly string[]>(
    // Only ids the project still HOLDS, so a row naming a deleted document does not
    // re-submit it — the route answers 404 for an id the project does not hold, and
    // the reviewer never chose it.
    () => initialIds.filter((id) => documents.some((doc) => doc.document_id === id)),
  )
  const toggle = (documentId: string) => {
    setSelected((ids) => (
      ids.includes(documentId) ? ids.filter((id) => id !== documentId) : [...ids, documentId]
    ))
  }
  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-white p-3">
      <fieldset>
        {/* A real `legend` in a real `fieldset`, which is what names the GROUP: the
            checkboxes are one choice about one row, and a heading beside them would
            leave a screen reader announcing seven unrelated boxes. No `id` needed —
            the legend names the fieldset natively, and pointing an
            `aria-labelledby` at it would restate what the element already does. */}
        <legend className="text-sm font-medium text-gray-700">
          {t('composition.documentsLegend')}
        </legend>
        <div className="mt-2 space-y-1.5">
          {documents.map((doc) => {
            const typeMeta = SCORABLE_TYPE_META[doc.document_type]
            return (
              <label key={doc.document_id} className="flex items-start gap-2 text-sm text-gray-800">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.includes(doc.document_id)}
                  onChange={() => toggle(doc.document_id)}
                  disabled={pending}
                />
                {/* The type beside the title, because a project can hold a PRD and a
                    PR/FAQ with the same name and the choice is between them. */}
                <span className="min-w-0">
                  <span className="font-medium">{doc.title}</span>
                  <span className="text-gray-500"> · {typeMeta ? t(typeMeta.i18nKey) : doc.document_type}</span>
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>
      {/* Says WHY Save is unavailable, rather than leaving a disabled button with no
          explanation. Ordinary text next to the control it explains, like the
          over-long-note panel above the list: it renders with the state it describes. */}
      {selected.length === 0 ? (
        <p className="mt-2 text-xs text-amber-700">{t('composition.requiresOne')}</p>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSubmit(selected)}
          disabled={selected.length === 0 || pending}
          className={clsx(
            'px-3 py-1.5 rounded-lg text-sm font-medium',
            selected.length === 0 || pending
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700',
          )}
        >
          {pending ? t('composition.saving') : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="px-3 py-1.5 rounded-lg text-sm text-gray-600 hover:bg-gray-100"
        >
          {t('composition.cancel')}
        </button>
      </div>
    </div>
  )
}

/**
 * What a reviewer may do about this row's composition.
 *
 * THREE STATES OF ONE PANEL, and the frozen one is the reason it exists:
 *
 *  * an UNFROZEN row offers its composition for editing, preselected with the
 *    documents it holds;
 *  * a FROZEN row says the first ballot locked it and points at the action that IS
 *    available — adding another row — because the reviewer's actual goal ("score a
 *    different combination") is still reachable, just not by editing this row. Its
 *    sliders are untouched: a frozen row stays scoreable, which is the whole point
 *    of freezing it rather than closing it;
 *  * an ADMIN additionally gets the delete, behind a confirmation that names the
 *    ballots going with the row, because that is the part a reviewer cannot see and
 *    cannot undo.
 *
 * "Add row" is offered on EVERY row, not only a frozen one. It is the same
 * project-scoped ask either way, and offering it only where an edit is impossible
 * would leave a project whose rows are all editable with no way to score a second
 * combination at all.
 *
 * The picker CLOSES when it submits, and the delete dialog closes when it is confirmed,
 * rather than either waiting for the write to land. The page reports a failed compose,
 * recompose or delete in a panel above the list — including the 409 a ballot that landed
 * first produces — and a delete that landed in another, and both move the reader to
 * them, so nothing is silent; keeping either form open through an in-flight request
 * would instead leave a second submission available for one already on its way, which
 * is also what closing is relied on to prevent.
 */
export default function RowCompositionPanel({
  row, composition,
}: {
  readonly row: PrioritizationRowView
  readonly composition: RowCompositionActions
}): ReactElement {
  const {
    candidatesByProject, rowsByProject, rowCountSettled, canDelete, pending,
    onCompose, onRecompose, onDelete,
  } = composition
  const { t } = useTranslation('prioritization')
  const [openPicker, setOpenPicker] = useState<OpenPicker>('none')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const candidates = candidatesByProject.get(row.project_id) ?? NO_CANDIDATES
  const heldIds = row.documents.map((doc) => doc.document_id)
  const isOnlyDefaultRow = isProjectsOnlyDefaultRow(row, rowsByProject)
  /**
   * Dispatch on the mode the picker was OPENED in, which is a `SubmittingPicker` by
   * construction — the parameter is supplied where the picker is rendered, and the
   * picker only renders when the mode is not `'none'`. So the switch has no `default`
   * and a fourth mode fails to compile, rather than closing the picker and issuing
   * nothing. Same idiom as `performRowWrite`.
   */
  const submit = (mode: SubmittingPicker, documentIds: readonly string[]) => {
    setOpenPicker('none')
    switch (mode) {
      case 'compose':
        onCompose(row, documentIds)
        return
      case 'recompose':
        onRecompose(row, documentIds)
        return
    }
  }
  return (
    <div data-testid={`row-composition-${row.row_id}`} className="rounded-lg border border-gray-200 bg-white p-3">
      <h4 className="font-medium text-gray-900 text-sm">{t('composition.title')}</h4>
      {/* The freeze, in words, with the action that IS available named in the same
          sentence. Not a disabled Edit button with no explanation: the reason a
          composition cannot change is a fact about the row that a reviewer can act on
          — by adding another row — and the button below is exactly that. */}
      {row.is_frozen ? (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-gray-600">
          <Lock size={14} className="mt-0.5 flex-shrink-0 text-gray-400" aria-hidden="true" />
          {t('composition.locked')}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {row.is_frozen ? null : (
          <button
            type="button"
            onClick={() => setOpenPicker((open) => (open === 'recompose' ? 'none' : 'recompose'))}
            // The picker this button controls is its own sibling, so the relationship
            // is announced rather than left to visual proximity.
            aria-expanded={openPicker === 'recompose'}
            disabled={pending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50"
          >
            <Pencil size={14} aria-hidden="true" />
            {t('composition.edit')}
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpenPicker((open) => (open === 'compose' ? 'none' : 'compose'))}
          aria-expanded={openPicker === 'compose'}
          disabled={pending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50"
        >
          <FilePlus2 size={14} aria-hidden="true" />
          {t('composition.addRow')}
        </button>
        {canDelete && !isOnlyDefaultRow ? (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            disabled={pending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            <Trash2 size={14} aria-hidden="true" />
            {t('composition.deleteAction')}
          </button>
        ) : null}
      </div>
      {/* WHY there is no delete here, for the admin who would otherwise look for one.
          Said in words rather than left as an absence, the same treatment the freeze
          gets above: "a project's only default row cannot be deleted" is a fact a reader
          can act on — by adding a second row first — and a silently missing control is
          not. Shown only to somebody who would have been offered the control, since a
          non-admin has no delete to explain, and only where the count behind it has
          settled — see `rowCountSettled`. Where it has not, the control is simply absent
          for the moment, which is the recoverable half of the same caution. */}
      {canDelete && isOnlyDefaultRow && rowCountSettled ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-gray-600">
          <Lock size={14} className="mt-0.5 flex-shrink-0 text-gray-400" aria-hidden="true" />
          {t('composition.onlyRow')}
        </p>
      ) : null}
      {openPicker === 'none' ? null : (
        <>
          {/* Which ask this picker is for, above the group it belongs to: the two
              differ only in what a save means, and a reviewer who opened the wrong one
              has nothing else on screen telling them so. */}
          <p className="mt-2 text-xs text-gray-600">
            {openPicker === 'compose' ? t('composition.addRowHint') : t('composition.editHint')}
          </p>
          <DocumentPicker
            // The MODE alone, so switching between the two asks starts a fresh selection
            // while a background refetch — which moves the row's stored composition but
            // not this — leaves the reviewer's ticks exactly where they are. The stored
            // ids used to be part of this key, and remounting on them silently discarded
            // an in-progress selection; reopening the picker is what picks up a landed
            // save, since it closes on submit.
            key={openPicker}
            documents={candidates}
            // The row's own documents either way. For an edit that is the composition
            // being changed; for a new row it is a starting point a reviewer narrows
            // or widens, since "another combination" is stated relative to this one.
            initialIds={heldIds}
            submitLabel={openPicker === 'compose' ? t('composition.saveNewRow') : t('composition.save')}
            pending={pending}
            // The mode is narrowed HERE, where it is already known not to be `'none'`,
            // which is what lets `submit` dispatch exhaustively — see there.
            onSubmit={(documentIds) => submit(openPicker, documentIds)}
            onCancel={() => setOpenPicker('none')}
            t={t}
          />
        </>
      )}
      {/* The existing shared dialog, used as it is — `ConfirmModal` already owns the
          dialog semantics and the focus trap, and it lands initial focus on Cancel, which
          is the right default for a destructive answer. The copy names the effect a
          reviewer cannot see: the ballots go with the row.
          No `isLoading`: the dialog CLOSES on confirm, before the request is issued, which
          is also what prevents a second confirmation — the same reasoning the picker
          records for closing on submit. Passing the in-flight flag would have no effect,
          since the dialog is already unmounted by the time it can be true, and would read
          as an in-flight lock this code does not use. Whether a delete landed is reported
          by `RowDeletedPanel`, and a refusal by `RowActionFailurePanel`. */}
      <ConfirmModal
        isOpen={confirmingDelete}
        title={t('composition.delete.title')}
        message={t('composition.delete.message')}
        confirmLabel={t('composition.delete.confirm')}
        cancelLabel={t('composition.delete.cancel')}
        variant="danger"
        onConfirm={() => {
          setConfirmingDelete(false)
          onDelete(row)
        }}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  )
}
