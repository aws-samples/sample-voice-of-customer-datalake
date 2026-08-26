/**
 * @fileoverview The three things about ROWS the page has to say in words: a
 * row-lifecycle write that did not land, a delete that did, and a project the
 * default-row route permanently refuses.
 *
 * Their own module rather than more of `Prioritization.tsx`, which is at its
 * `max-lines` budget, and they belong together: both are about which rows EXIST, as
 * opposed to the panels above them, which are about the scores on the rows that do.
 *
 * Each is a labelled `role="alert"` region, like every other panel on this page —
 * two same-role regions with no accessible name are indistinguishable to a screen
 * reader and to a test, which is why every one of them carries its own
 * `aria-labelledby`.
 *
 * @module pages/Prioritization/RowStatePanels
 */

import { AlertTriangle, CheckCircle2, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { isSettledRefusal, isStateConflict } from './useRowLifecycle'
import type { RowActionFailure, RowDeleted } from './useRowLifecycle'
import type { ReactElement, RefObject } from 'react'

/**
 * Which sentence a failed write gets, per action.
 *
 * NAMESPACE-QUALIFIED LITERALS under properties ending in `Key`, which is the one
 * shape `scripts/i18n-check.mjs` can collect from data rather than from a `t(...)`
 * call (`extractDataHeldKeys`) — the same shape `SCORABLE_TYPE_META` and
 * `READ_STATE_I18N_KEY` use, and for the same reason: a key the gate cannot see is
 * reported unused and becomes a deletion candidate in a cleanup pass, leaving the
 * panel rendering a raw key path.
 *
 * THREE SENTENCES PER ACTION, because three different things are being asked of the
 * reader:
 *
 *  * a CONFLICT (409) is a fact about stored state — a ballot froze the composition,
 *    the row is already gone, the project is at its row bound — and the remedy is to
 *    reload and look at the current rows;
 *  * a SETTLED REFUSAL (`isSettledRefusal`: a 400 over the document bound, a 404 for an
 *    id the project no longer holds, a 403 for a delete a non-admin reached anyway) is
 *    an answer about the REQUEST, and asking again with the same selection gets the
 *    same reply — so the sentence points at what was chosen, or at the permission;
 *  * anything ELSE (a 500, a network fault, a throttle) did not land and can simply be
 *    tried again. Saying "reload" for a transient fault sends a reader to re-read state
 *    that never changed, and saying "try again" for a settled refusal is advice that
 *    cannot work.
 */
const FAILURE_I18N_KEY: Record<RowActionFailure['action'], {
  conflictKey: `prioritization:${string}`;
  refusedKey: `prioritization:${string}`;
  failedKey: `prioritization:${string}`
}> = {
  compose: {
    conflictKey: 'prioritization:rowAction.composeConflict',
    refusedKey: 'prioritization:rowAction.composeRefused',
    failedKey: 'prioritization:rowAction.composeFailed',
  },
  recompose: {
    conflictKey: 'prioritization:rowAction.recomposeConflict',
    refusedKey: 'prioritization:rowAction.recomposeRefused',
    failedKey: 'prioritization:rowAction.recomposeFailed',
  },
  delete: {
    conflictKey: 'prioritization:rowAction.deleteConflict',
    refusedKey: 'prioritization:rowAction.deleteRefused',
    failedKey: 'prioritization:rowAction.deleteFailed',
  },
}

/**
 * Which of the three sentences a failure gets. See `FAILURE_I18N_KEY`.
 *
 * A function rather than a ternary chain inside `t(...)`: `scripts/i18n-check.mjs` can
 * only see a key it reads verbatim, so a key chosen inside the call is reported unused
 * — and all three halves would be. Returning the KEY and calling `t` once at the use
 * site keeps every literal collectable.
 */
function failureSentenceKey(failure: RowActionFailure): `prioritization:${string}` {
  const keys = FAILURE_I18N_KEY[failure.action]
  if (isStateConflict(failure)) return keys.conflictKey
  if (isSettledRefusal(failure)) return keys.refusedKey
  return keys.failedKey
}

/**
 * Bring a panel a reader did not ask for INTO VIEW, and put focus on it.
 *
 * Every control that produces one of these lives inside an expanded row, which can be
 * far below the fold, while the panel renders near the top of the page. `role="alert"`
 * announces it to a screen reader and does nothing at all for a sighted reader — so
 * without this, pressing a control could produce a message entirely off screen and look
 * like a button that did nothing, which is the exact failure this feature set out to
 * remove.
 *
 * KEYED ON THE PANEL'S IDENTITY rather than on its mere presence, so a second refusal
 * about a different row (or a different action on the same row) moves the reader again,
 * while a re-render for any other reason does not steal focus back.
 *
 * `block: 'nearest'` scrolls the minimum needed and leaves a panel already on screen
 * where it is. Focus lands on the region itself, which is why the caller gives it
 * `tabIndex={-1}`: it is programmatically focusable without joining the tab order, and
 * focusing the region rather than its dismiss button means the reader hears the message
 * instead of the word "Dismiss".
 *
 * `scrollIntoView` IS CALLED ONLY IF IT EXISTS, which is not defensiveness for its own
 * sake: one of these panels is the page's only account of a write that failed, and an
 * environment without the method (jsdom, notably) would have the report of the failure
 * throw during the commit and take the whole page down with it — a strictly worse
 * outcome than a message that did not scroll. Focus is attempted either way, since
 * that is the half a keyboard reader depends on.
 */
function useAnnouncePanel(identity: string | undefined): RefObject<HTMLDivElement | null> {
  const region = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (identity === undefined) return
    const element = region.current
    if (!element) return
    if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' })
    element.focus()
  }, [identity])
  return region
}

/**
 * What did not happen when a reviewer added, edited or deleted a row.
 *
 * DISMISSABLE, unlike the read-state panels above it: this describes an action the
 * reader took rather than a condition of the page, so it has an end — and the write
 * cleared it too on the next attempt. The close control is a real button with an
 * accessible name, not an icon alone.
 *
 * The ROW IS NAMED by its title, because rows are collapsed by default and a reviewer
 * with a backlog on screen has nothing else identifying which one refused. Titles are
 * data rather than UI copy, so this adds no key to eight catalogues.
 */
export function RowActionFailurePanel({
  failure, onDismiss,
}: {
  readonly failure: RowActionFailure | undefined
  readonly onDismiss: () => void
}): ReactElement | null {
  const { t } = useTranslation('prioritization')
  // Hooks run before the early return, per the rules of hooks. The identity is
  // `undefined` while no failure is on screen, which is what stops the effect firing.
  const region = useAnnouncePanel(
    failure ? `${failure.action}:${failure.status ?? 'none'}:${failure.rowTitle}` : undefined,
  )
  if (!failure) return null
  return (
    <div
      ref={region}
      // Focusable without joining the tab order, so `useAnnouncePanel` can land the
      // reader here — see there.
      tabIndex={-1}
      role="alert"
      aria-labelledby="row-action-failed-title"
      className="bg-red-50 border border-red-200 rounded-lg p-3 sm:p-4"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="text-red-600 mt-0.5 flex-shrink-0" size={20} aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <h3 id="row-action-failed-title" className="font-medium text-red-900 text-sm sm:text-base">
            {t('rowAction.title')}
          </h3>
          <p className="text-xs sm:text-sm text-red-700 mt-1">
            {/* The key is chosen OUTSIDE `t(...)`, per the rule the scores panel above
                records: `i18n-check` only sees a key it reads verbatim, so a condition
                inside the call reports every branch unused. */}
            {t(failureSentenceKey(failure), { row: failure.rowTitle })}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="flex-shrink-0 rounded-lg p-1 text-red-700 hover:bg-red-100"
        >
          <X size={16} aria-hidden="true" />
          <span className="sr-only">{t('rowAction.dismiss')}</span>
        </button>
      </div>
    </div>
  )
}

/**
 * That a delete LANDED, and what went with the row.
 *
 * THE ONLY ONE OF THE THREE WRITES THAT NEEDS SAYING. A compose and a recompose show
 * themselves in the list; a delete leaves a row silently absent, which is also what a
 * filter or a failed read looks like — for the one action whose dialog just called it
 * irreversible and said it takes other reviewers' ballots with it.
 * `ballots_deleted` is the only evidence of that half, because the row is gone and
 * nothing can be re-read to check.
 *
 * TWO SENTENCES, and the split is about honesty rather than grammar. A count of 0 means
 * either a row nobody had voted on or a receipt the client could not read — the wire
 * boundary answers 0 for both, deliberately, rather than failing a completed delete —
 * so the zero case says the row and its ballots are gone WITHOUT asserting a number
 * nobody vouched for.
 *
 * A `status` region rather than an `alert`: this is the confirmation of something the
 * reader asked for, so it belongs in the polite queue, behind whatever a screen reader
 * is already saying.
 */
export function RowDeletedPanel({
  deleted, onDismiss,
}: {
  readonly deleted: RowDeleted | undefined
  readonly onDismiss: () => void
}): ReactElement | null {
  const { t } = useTranslation('prioritization')
  const region = useAnnouncePanel(
    deleted ? `${deleted.rowTitle}:${deleted.ballotsDeleted}` : undefined,
  )
  if (!deleted) return null
  return (
    <div
      ref={region}
      tabIndex={-1}
      role="status"
      aria-labelledby="row-deleted-title"
      className="bg-green-50 border border-green-200 rounded-lg p-3 sm:p-4"
    >
      <div className="flex items-start gap-3">
        <CheckCircle2 className="text-green-700 mt-0.5 flex-shrink-0" size={20} aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <h3 id="row-deleted-title" className="font-medium text-green-900 text-sm sm:text-base">
            {t('rowDeleted.title')}
          </h3>
          <p className="text-xs sm:text-sm text-green-800 mt-1">
            {/* Both keys are literals with the condition outside the call, and the
                count is interpolated as a plain `{{ballots}}` rather than i18next's
                `count`: a plural key needs `_one`/`_other` forms that differ per locale
                and renders the raw path when one is missing, which the note-length
                panel above records for the same reason. */}
            {deleted.ballotsDeleted > 0
              ? t('rowDeleted.description', { row: deleted.rowTitle, ballots: deleted.ballotsDeleted })
              : t('rowDeleted.descriptionNoCount', { row: deleted.rowTitle })}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="flex-shrink-0 rounded-lg p-1 text-green-800 hover:bg-green-100"
        >
          <X size={16} aria-hidden="true" />
          <span className="sr-only">{t('rowDeleted.dismiss')}</span>
        </button>
      </div>
    </div>
  )
}

/**
 * The projects the default-row route permanently refuses, named.
 *
 * ONE STATUS REACHES HERE — the 409 for a project holding more documents than a row
 * can be composed from in one read — and `refusalsByProject` in `Prioritization.tsx`
 * owns why the others do not. What matters at this end is that the project is MISSING
 * from the backlog and, until now, nothing said so: the row-ensure's failures were
 * silent by design, on the reasoning that a reader could not act on them, which is
 * true of a transient 500 and false of a settled refusal that removes a project from
 * the page for good.
 *
 * Named by project, not counted, and the name comes from the project read the page
 * already has. A project whose name is not on screen falls back to its id rather than
 * rendering blank — the same fallback the over-long-note panel uses for a row.
 */
export function EnsureRefusalPanel({
  refusals, namesByProject,
}: {
  /** Project id → the status that refused it. */
  readonly refusals: Record<string, number>
  readonly namesByProject: Readonly<Record<string, string>>
}): ReactElement | null {
  const { t } = useTranslation('prioritization')
  const projectIds = Object.keys(refusals)
  if (projectIds.length === 0) return null
  return (
    <div role="alert" aria-labelledby="row-unavailable-title" className="bg-amber-50 border border-amber-200 rounded-lg p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="text-amber-600 mt-0.5 flex-shrink-0" size={20} aria-hidden="true" />
        <div>
          <h3 id="row-unavailable-title" className="font-medium text-amber-900 text-sm sm:text-base">
            {t('rowUnavailable.title')}
          </h3>
          <p className="text-xs sm:text-sm text-amber-700 mt-1">{t('rowUnavailable.description')}</p>
          <ul className="text-xs sm:text-sm text-amber-800 mt-2 list-disc list-inside">
            {projectIds.map((projectId) => (
              <li key={projectId}>{namesByProject[projectId] ?? projectId}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
