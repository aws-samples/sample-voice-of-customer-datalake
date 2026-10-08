/**
 * @fileoverview The Prioritization page heading, with the Reset and Save controls for pending edits.
 * @module pages/Prioritization/PrioritizationHeader
 */

import clsx from 'clsx'
import { Save, RotateCcw } from 'lucide-react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'

export function PrioritizationHeader({
  hasChanges, isPending, saveBlocked, rowCount, headingRef, onReset, onSave,
}: {
  readonly hasChanges: boolean
  readonly isPending: boolean
  /**
   * True while a save cannot honestly be made, for either of two reasons.
   *
   * NO READABLE BALLOT MAP IS IN HAND — the read failed on first load, has not finished,
   * or arrived carrying ballots that could not be read, with nothing held from an earlier
   * one. Saving then writes the caller's edits against numbers nobody has seen, because
   * the sliders are showing `DEFAULT_SCORE` rather than this reviewer's stored ballot. The
   * panel above the list now covers both halves of that — a failed read AND a response
   * whose ballots were unreadable — and is worded by the SAME predicate, so the sentence
   * on screen cannot contradict the button. Only the in-flight case is silent, because
   * nothing has gone wrong and it clears itself the moment the read lands.
   *
   * Read off `ownBallotRead`'s `inHand` — the caller's OWN ballots, the exact value being
   * protected, and the same value the panel above the list is worded by. Not any proxy for
   * them: two were tried and both were
   * weaker: `!teamReadDelivered(aggregates)` asks about the TEAM column, and a bare
   * `savedScores === undefined` proves only that *a response* arrived, which `select` now
   * makes a much weaker claim than it looks (`normalizeScores` answers `undefined` for a
   * null, a string or an array, not just for an omitted field). An empty `{}` is still a
   * save: the response arrived and this reviewer simply has no ballot yet.
   *
   * A pre-#333 response carrying `scores` and no `aggregates` field shows the other
   * direction: the reviewer's ballot did arrive, so the save is offered even though the
   * team column has nothing to show.
   *
   * A failed REFETCH is deliberately NOT blocked: the cached response is still on screen,
   * sliders included, so the reader is editing their real ballot and a save is as honest
   * as it was a moment earlier. `savedScores` is retained through that failure, which is
   * what lets one predicate cover both.
   *
   * Or a pending edit carries a note past `MAX_NOTE_LENGTH`: the API refuses it
   * rather than truncating, and `fetchApi` discards the reason, so pressing Save
   * would look like a button that does nothing. Its own panel too.
   *
   * Disabled rather than left to look ordinary, whichever reason applies — and each one
   * that a reader cannot infer from the sliders has words above the list.
   */
  readonly saveBlocked: boolean
  /**
   * How many rows the list below is showing.
   *
   * NOT RENDERED AT ZERO, and that one rule is the whole of the state handling here,
   * because "0 proposals" beside the heading asserts an empty backlog. Both states that
   * reach this with nothing to count would be asserting one they have not established:
   * the loading pass, where no documents have arrived to compose rows from and the list
   * is still a spinner; and a genuinely empty list, where the list's own empty state
   * already says so in words and says WHICH emptiness — no documents at all, or none of
   * a scorable type — which a bare `0` cannot. A `number | null` prop was the same rule
   * spelled twice, since a page with no rows yet has no other value to pass.
   *
   * Counts ROWS — the same UNIT as the "Total Proposals" card and as the list itself, so
   * a reader comparing the two is comparing like with like. Deliberately not the number
   * of documents: one row can hold a PRD and a PR/FAQ describing one idea.
   *
   * The same unit, not a promise of the same number. This is the LIST's length and the
   * card's is the backlog's, which are equal only while nothing narrows the list — the
   * first row filter or search box put on this page should make them differ, and each
   * would then be right about what it is labelled.
   */
  readonly rowCount: number
  /**
   * WHERE A DISMISSAL LANDS when the control that produced the panel is gone.
   *
   * The page heading, because it is the one thing on this page guaranteed to outlive
   * any row: a delete that landed takes its own "Delete row" button with it, and
   * `RowDeletedPanel` is announce-only, so dismissing its Dismiss button would otherwise
   * drop a keyboard reader on `<body>`. Focusable without joining the tab order for that
   * one purpose — nothing tabs to a heading. See `useRowLifecycle.restoreFocus`.
   */
  readonly headingRef: RefObject<HTMLHeadingElement | null>
  readonly onReset: () => void
  readonly onSave: () => void
}) {
  const { t } = useTranslation('prioritization')
  const canSave = hasChanges && !saveBlocked && !isPending
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        {/* BESIDE the heading, not inside it: a screen reader announcing this page's
            heading should read "Prioritization", which is also what the breadcrumb and
            the document outline name. The count's own text is self-describing.
            (Not "the only h1" — the app shell's brand is an h1 too, so the deployed
            page has two. That is pre-existing and separate; the point here is only
            that THIS heading's accessible name stays the page's name.) */}
        <div className="flex items-center gap-2 flex-wrap">
          <h1
            ref={headingRef}
            // Programmatically focusable only — see `headingRef`. A heading is never
            // tabbed to, so this adds nothing to the tab order and costs the reader
            // nothing; it is what makes a dismissal with no surviving control land
            // somewhere a tab can reach the rows from.
            tabIndex={-1}
            className="text-2xl font-bold tracking-tight text-text-strong"
          >
            {t('title')}
          </h1>
          {rowCount === 0 ? null : (
            // The testid is what lets a test assert this is ABSENT without depending on
            // how a zero would have been spelled or on where the badge sits. Querying
            // for the text "0 proposals" only rules out one wording — a later
            // `rowCount_zero` form would walk straight past it — and reading the
            // wrapper's text depends on nothing being nested around the heading.
            <span
              data-testid="prioritization-row-count"
              className="inline-flex items-center rounded-full bg-bg-hover px-2.5 py-0.5 text-xs sm:text-sm font-medium font-mono text-text"
            >
              {t('rowCount', { count: rowCount })}
            </span>
          )}
        </div>
        <p className="text-sm text-muted mt-1 max-w-prose">{t('subtitle')}</p>
      </div>
      <div className="flex items-center gap-2 sm:gap-3">
        {hasChanges ? <button onClick={onReset} className="btn btn-ghost" aria-label={t('actions.reset')} title={t('actions.reset')}>
          <RotateCcw size={16} aria-hidden="true" /><span className="hidden sm:inline">{t('actions.reset')}</span>
        </button> : null}
        <button onClick={onSave} disabled={!canSave} className={clsx('btn', canSave ? 'btn-primary' : 'btn-secondary')}>
          <Save size={16} />
          <span className="hidden sm:inline">{isPending ? t('actions.saving') : t('actions.save')}</span>
          <span className="sm:hidden">{isPending ? t('actions.savingMobile') : t('actions.saveMobile')}</span>
        </button>
      </div>
    </div>
  )
}
