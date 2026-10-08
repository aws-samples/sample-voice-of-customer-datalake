/**
 * @fileoverview The stats cards above the Prioritization list, counted off the team aggregate.
 * @module pages/Prioritization/StatsCards
 */

import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { PrioritizationRowView } from './prioritizationUtils'
import { READ_STATE_I18N_KEY, uncountableTeamRead } from './teamRead'
import type { TeamAggregates } from './teamRead'
import { getTeamView, priorityBand } from './teamScore'

/**
 * The backlog at a glance, counted the same way the rows below are labelled.
 *
 * Reads the TEAM aggregate, not the caller's own map, because these cards sit
 * directly above rows that now lead with the team's composite: counting the
 * reader's own opinion under the heading the rows use for the group's would make
 * the totals disagree with the list they summarise. "Not Scored" is likewise
 * absence from the aggregate — nobody voted — rather than the caller's own
 * `impact === 0`, which counted a document the team had scored as unscored merely
 * because this reader had not.
 *
 * Counted through `priorityBand`, the same function that names the band on each
 * row, rather than by re-testing the composite against 4 and 3 here. Two copies of
 * one rule is how a card can say Medium about a row labelled High: the raw
 * composite of four 4s is 3.9999999999999996, so an unrounded `>= 4` counted a row
 * printing `4.0` as Medium. One function, one rounding, so a card and the row it
 * summarises cannot classify the same document differently.
 *
 * When the team read is UNCOUNTABLE (`uncountableTeamRead`: it failed, is still
 * running, or arrived naming documents with not one readable row among them) the
 * three team-derived cards show a dash rather than a count. A zero is a claim ("none
 * of these is high priority") and "1 Not Scored" for every document in the backlog is
 * a false one; no such read said anything about any of them. Only "Total Proposals"
 * survives, because that is counted off the project read, which is a different query
 * and may well have succeeded already.
 */
export function StatsCards({
  rows, aggregates,
}: {
  readonly rows: PrioritizationRowView[];
  readonly aggregates: TeamAggregates
}) {
  const { t } = useTranslation('prioritization')
  const bands = rows.map((row) => priorityBand(getTeamView(aggregates, row.row_id)))
  /**
   * Not `teamReadDelivered`: a response whose EVERY named row is unreadable parses to
   * a map, so "delivered" is true while the read says exactly as little as a failed
   * one — and counting it printed `0 / 0 / 0`, three confident claims about documents
   * no read has described, where the same fault one encoding over (an unreadable
   * container) already dashed. Same fault, same dashes, same sr-only sentence.
   */
  const uncountable = uncountableTeamRead(aggregates)
  /**
   * Rows the response named but could not be read — the gap the line under the grid
   * explains. When the cards are counting, a marked row is in "Total Proposals" and in
   * no other card: it is not high, medium or low (no number), and calling it "Not
   * Scored" is the conflation the row label refuses. Leaving that silent made the
   * cards stop adding up with nothing on the page saying why. Zero when the read is
   * uncountable, because then every team-derived card is already a dash with the same
   * reason in its sr-only text — there are no numbers on screen to explain a gap in.
   */
  const unreadableCount = uncountable === null
    ? bands.filter((band) => band === 'unavailable').length
    : 0
  /**
   * How many rows fall in one band, or an EXPLAINED dash when the read is uncountable.
   *
   * The dash is decorative and hidden from assistive technology, with the reason
   * beside it in text only a screen reader reads. A bare `—` is the one card state a
   * reader cannot interpret: sighted readers have the panel above the list to explain
   * it, while a screen reader announces the card as its label and either nothing or
   * "em dash" — indistinguishable from a zero count, which is the exact confusion the
   * dash exists to avoid. `aria-label` on a `<span>` would not reliably be announced
   * (no role to carry it), hence visually-hidden text, as `AiModelSection` does.
   *
   * The sentence is the one the rows are already showing for the same state, so this
   * adds no key to eight catalogues and cannot drift from what the page says.
   */
  const countOf = (band: 'high' | 'medium' | 'none'): ReactElement => {
    // Both arms return an element, not "a number or an element": `sonarjs`
    // (`function-return-type`) refuses a union return here, and a fragment adds no DOM
    // node, so the card still renders the bare count.
    if (uncountable === null) return <>{bands.filter((b) => b === band).length}</>
    return (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t(READ_STATE_I18N_KEY[uncountable])}</span>
      </>
    )
  }

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        {/* Counts ROWS, and says so: one row is one proposal scored once, which is
            the number a reader ranking a backlog is actually after. The old count was
            documents, so a project whose PRD and PR/FAQ describe one idea inflated
            every card by one. */}
        <div className="card p-4"><div className="text-2xl font-bold font-mono text-text-strong">{rows.length}</div><div className="text-sm text-muted">{t('stats.totalRows')}</div></div>
        <div className="card p-4"><div className="text-2xl font-bold font-mono text-ok">{countOf('high')}</div><div className="text-sm text-muted">{t('stats.highPriority')}</div></div>
        <div className="card p-4"><div className="text-2xl font-bold font-mono text-info">{countOf('medium')}</div><div className="text-sm text-muted">{t('stats.mediumPriority')}</div></div>
        {/* `text-muted`, not the fainter `text-muted-strong`: the faintest grey failed AA
            even at the 3:1 allowance `text-2xl font-bold` would qualify for, so it was
            missed by the contrast sweep rather than judged. `muted` still reads as the
            quiet card of the four. */}
        <div className="card p-4"><div className="text-2xl font-bold font-mono text-muted">{countOf('none')}</div><div className="text-sm text-muted">{t('stats.notScored')}</div></div>
      </div>
      {/* Why the counts above may not add up: a row the response named but could not be
          read is in the total and in no other card — see `unreadableCount`. Ordinary
          visible text rather than a live region, like the row labels that state the same
          thing per document: it renders with the numbers it explains. Body `text-text`
          per the note on `BAND_STYLE` (the muted tone is not body text; this line is
          text-sm on the page background). */}
      {unreadableCount === 0 ? null : (
        <p className="text-sm text-text mt-2">
          {t('stats.unreadable', { count: unreadableCount })}
        </p>
      )}
    </div>
  )
}
