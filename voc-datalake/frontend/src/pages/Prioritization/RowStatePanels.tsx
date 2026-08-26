/**
 * @fileoverview The two things about ROWS the page has to say in words: a
 * row-lifecycle write that did not land, and a project the default-row route
 * permanently refuses.
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

import { AlertTriangle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isStateConflict } from './useRowLifecycle'
import type { RowActionFailure } from './useRowLifecycle'
import type { ReactElement } from 'react'

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
 * TWO SENTENCES PER ACTION, because a 409 and everything else ask different things of
 * the reader. A conflict is a fact about stored state — a ballot froze the
 * composition, the row is already gone, the project is at its row bound — and the
 * remedy is to reload and look at the current rows; anything else (a 500, a network
 * fault, a 403 for a delete a non-admin reached anyway) did not land and can be tried
 * again. Saying "reload" for a transient fault sends a reader to re-read state that
 * never changed.
 */
const FAILURE_I18N_KEY: Record<RowActionFailure['action'], {
  conflictKey: `prioritization:${string}`;
  failedKey: `prioritization:${string}`
}> = {
  compose: {
    conflictKey: 'prioritization:rowAction.composeConflict',
    failedKey: 'prioritization:rowAction.composeFailed',
  },
  recompose: {
    conflictKey: 'prioritization:rowAction.recomposeConflict',
    failedKey: 'prioritization:rowAction.recomposeFailed',
  },
  delete: {
    conflictKey: 'prioritization:rowAction.deleteConflict',
    failedKey: 'prioritization:rowAction.deleteFailed',
  },
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
  if (!failure) return null
  const keys = FAILURE_I18N_KEY[failure.action]
  return (
    <div role="alert" aria-labelledby="row-action-failed-title" className="bg-red-50 border border-red-200 rounded-lg p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="text-red-600 mt-0.5 flex-shrink-0" size={20} aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <h3 id="row-action-failed-title" className="font-medium text-red-900 text-sm sm:text-base">
            {t('rowAction.title')}
          </h3>
          <p className="text-xs sm:text-sm text-red-700 mt-1">
            {/* Both keys are literals with the condition OUTSIDE `t(...)`, per the
                rule the scores panel above records: a ternary inside the call is a key
                `i18n-check` cannot read, and both halves get reported unused. */}
            {isStateConflict(failure)
              ? t(keys.conflictKey, { row: failure.rowTitle })
              : t(keys.failedKey, { row: failure.rowTitle })}
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
