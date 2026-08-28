/**
 * @fileoverview How a row SHOWS what its documents say about each other: a badge
 * on the resting row, the reason in words inside the expansion, and — for a
 * frozen row the project has moved past — where to go instead.
 *
 * Its own module rather than more of `PRFAQRow`, which is near its `max-lines`
 * budget, and a genuine seam besides: everything here is about the row's
 * EVIDENCE, while that file is about scoring it and `RowCompositionPanel` is
 * about changing it.
 *
 * NOTHING HERE GATES ANYTHING. Every state renders words and nothing else: no
 * control is withheld, no slider disabled, no row filtered. A row whose documents
 * cross generations, or record no lineage at all, is fully scorable — see the
 * `rowLineage` module docstring for why that is the deliberate reading rather
 * than a leniency.
 *
 * THE STATE IS NEVER CARRIED BY COLOUR ALONE. Each badge renders a text label,
 * and the reason behind it is announced (visually-hidden text) as well as
 * hovered (`title`) — because a `title` alone never appears on a touch device and
 * is announced inconsistently, which is the trap `SortControls` records for its
 * own hint. So the tint is reinforcement for a reader who can see it, never the
 * distinction itself.
 *
 * @module pages/Prioritization/RowLineagePanels
 */

import clsx from 'clsx'
import { GitBranch, History } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LINEAGE_REASON_KEY, LINEAGE_STYLE } from './rowLineage'
import type { RowLineage } from './rowLineage'
import type { ReactElement } from 'react'

/**
 * Which lineage state this row is in, on the resting row beside the priority band.
 *
 * ON THE COLLAPSED ROW, because that is where a reviewer decides which proposals
 * to open: "how good is the evidence behind this number" is exactly the question
 * a ranked backlog cannot answer today, and a signal only visible after expanding
 * a row is a signal for the rows somebody already trusted.
 *
 * The label is the distinction and the reason is the explanation, both of them
 * text. The reason is visually hidden rather than printed: the header already
 * carries the title, the document badges, the band, the spread and the team's
 * four numbers, and a sentence per row there would bury all of it — while a
 * screen reader, which reads the header as one button, gets the sentence as part
 * of it. The same sentence is printed in full inside the expansion
 * (`RowLineageNote`), so the sighted reader has somewhere to read it too.
 *
 * THE COST OF THAT, NAMED: this row header is one big `button`, so everything
 * inside it — this sentence included — joins its accessible name, which was
 * already long (title, type badges, band, spread, project, date, four team
 * numbers). Accepted on the precedent `SortControls` sets, in its own words: a
 * `title` "never appears on a touch device and screen-reader support for it is
 * inconsistent, so the readers who most need [the answer] were the ones who could
 * not reach it". Dropping to `title` alone would leave a screen-reader user with
 * strictly less than a mouse user, which is the trade this page has already
 * refused once. `aria-describedby` is not the escape either — inside a `button` a
 * description is announced with the name anyway; it becomes the right shape only
 * if the header is ever split so the badges sit outside the button.
 */
export function RowLineageBadge({ lineage }: { readonly lineage: RowLineage }): ReactElement {
  const { t } = useTranslation('prioritization')
  const style = LINEAGE_STYLE[lineage.state]
  // Both keys are looked up OUTSIDE `t(...)` — from the two tables in
  // `rowLineage`, whose entries are namespace-qualified literals — because
  // `scripts/i18n-check.mjs` only collects a key it reads verbatim. A key
  // assembled inside the call is reported unused and becomes a deletion
  // candidate, which lands a raw key path on every row.
  const reason = t(LINEAGE_REASON_KEY[lineage.reason].sentenceKey)
  return (
    <span
      data-testid="row-lineage"
      data-lineage={lineage.state}
      title={reason}
      className={clsx('inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full whitespace-nowrap', style.color)}
    >
      <GitBranch size={12} aria-hidden="true" />
      {t(style.labelKey)}
      {/* Announced, not only hovered — see the module docstring. */}
      <span className="sr-only"> {reason}</span>
    </span>
  )
}

/**
 * That a FROZEN row's documents have been superseded by a fresher coherent
 * combination.
 *
 * A SECOND badge rather than a fourth lineage state, because the two answer
 * different questions and a frozen row can be both: "these documents belong
 * together" is about the combination, "the project has moved past them" is about
 * the passage of time. Folding staleness into `LineageState` would have made a
 * coherent-but-superseded row indistinguishable from an incoherent one, which is
 * the conflation the whole signal exists to end.
 *
 * WHAT IT DOES NOT DO: it does not touch the row. The frozen row keeps the
 * concrete ids its ballots were cast on and keeps its ballots — that is what
 * freezing is for — so this states a fact and `RowLineageNote` names the action.
 * Silently re-pointing the row at the fresher documents would rewrite what
 * existing ballots described, which is the defect the row model was introduced
 * to prevent.
 */
export function RowStaleBadge({ lineage }: { readonly lineage: RowLineage }): ReactElement | null {
  const { t } = useTranslation('prioritization')
  if (!lineage.stale) return null
  return (
    <span
      data-testid="row-stale"
      title={t('lineage.staleReason')}
      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full whitespace-nowrap bg-orange-100 text-orange-800"
    >
      <History size={12} aria-hidden="true" />
      {t('lineage.stale')}
      <span className="sr-only"> {t('lineage.staleReason')}</span>
    </span>
  )
}

/**
 * The reason in full, inside the expanded row — and, for a stale frozen row, the
 * action that IS available.
 *
 * Beside the composition panel, because both sentences are about which documents
 * this row holds rather than about the numbers on it, and because the control the
 * stale sentence points at — "Add row" — is the next thing on screen. That
 * adjacency is the whole of the advice: a reviewer told to score a fresher
 * combination should not have to go looking for how.
 *
 * ORDINARY TEXT, not a live region: it describes the row it renders in and
 * changes only when the row does, which is the same treatment
 * `composition.locked` gets one panel over.
 *
 * THE BUTTON IS NAMED BY INTERPOLATION, never restated in prose. The sentence's
 * whole value is that it points at a control the reader can see, so the label has
 * to be the one that control renders — `composition.addRow`, the same key
 * `RowCompositionPanel` reads — rather than eight independent copies of it that a
 * relabel or a translation pass silently desynchronises. Not hypothetical: spelled
 * out per locale, zh already said 新增行 while the button said 添加行. Each catalogue
 * keeps its own quotation marks AROUND the placeholder (`„…“`, `« … »`, `「…」`,
 * `“…”`), which is why this interpolates rather than concatenating.
 */
export function RowLineageNote({ lineage }: { readonly lineage: RowLineage }): ReactElement {
  const { t } = useTranslation('prioritization')
  return (
    <div data-testid="row-lineage-note" className="mt-1 space-y-1">
      <p className="flex items-start gap-1.5 text-xs text-gray-600">
        <GitBranch size={14} className="mt-0.5 flex-shrink-0 text-gray-400" aria-hidden="true" />
        {t(LINEAGE_REASON_KEY[lineage.reason].sentenceKey)}
      </p>
      {/* The stale sentence NAMES "Add row" — the button below it — rather than
          leaving a reader to infer that a locked row with superseded documents has
          anything they can do about it. The row itself is untouched, ballots
          included, which is why the advice is to add rather than to edit. */}
      {lineage.stale ? (
        <p className="flex items-start gap-1.5 text-xs text-orange-800">
          <History size={14} className="mt-0.5 flex-shrink-0 text-orange-600" aria-hidden="true" />
          {t('lineage.staleAction', { action: t('composition.addRow') })}
        </p>
      ) : null}
    </div>
  )
}
