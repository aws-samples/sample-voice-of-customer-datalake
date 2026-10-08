/**
 * @fileoverview What a Prioritization row says about the team: the summary numbers, the disagreement badge and the expanded team panel.
 * @module pages/Prioritization/RowTeamScore
 */

import { Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { reviewersDisagreed, teamScoreOf } from './teamScore'
import type { TeamView } from './teamScore'
import type { TFunction } from 'i18next'
import type { ReactElement } from 'react'

/**
 * Which words go under the dash, for each reason there is no number.
 *
 * Every key is spelled as a LITERAL here rather than assembled at the call site,
 * because `scripts/i18n-check.mjs` cannot see a key it did not read verbatim: one
 * built in a ternary — or held in a lookup without a namespace — is reported unused
 * and becomes a deletion candidate in a cleanup pass, leaving the row rendering a raw
 * key path. Same trap documented on `SCORABLE_TYPE_META`, and it fired here once
 * already on a `t(kind === 'unavailable' ? … : …)`.
 *
 * `'scored'` is unreachable — the caller has a number in that case and renders it —
 * but it is in the switch rather than a `default`, so adding a fifth state to
 * `TeamView` fails to compile here instead of silently reading as "not scored yet".
 */
function unscoredLabel(kind: TeamView['kind'], t: TFunction): string {
  switch (kind) {
    case 'unavailable': return t('team.unavailable')
    case 'loading': return t('team.loading')
    case 'unscored': return t('team.noScores')
    case 'scored': return t('team.score')
  }
}

/**
 * One team number as the row prints it: the value to one decimal, or the dash
 * for an axis nobody scored (`null`). One renderer, because the three chips
 * printing independently is how a dash and a `0.0` could otherwise coexist for
 * the same absence. The dash itself is decorative (the treatment every dash on
 * this page gets); the state is carried by visually-hidden text using the same
 * catalogue key the slider's `aria-valuetext` uses, so a screen reader hears
 * "not scored" where a sighted reader sees the dash — not silence.
 */
function TeamNumber({ value, notScoredLabel }: {
  readonly value: number | null
  readonly notScoredLabel: string
}): ReactElement {
  if (value === null) {
    return (
      <>
        <span aria-hidden="true" className="text-muted-strong">—</span>
        <span className="sr-only">{notScoredLabel}</span>
      </>
    )
  }
  return <>{value.toFixed(1)}</>
}

/**
 * The resting row's numbers: what the TEAM said about this document.
 *
 * Not the caller's own ballot, which used to be here and now lives behind the
 * expansion. A reader ranking a backlog is asking what the group thinks, and the
 * list sorts by exactly these numbers (`sortPRFAQs`), so the headline and the
 * order agree by construction.
 *
 * `'unscored'` means NOBODY HAS SCORED THIS — the aggregate omits a document
 * with no votes — which is a different statement from "the team scored it low". It
 * renders as an em dash under the words "Not scored yet": a placeholder where the
 * number would be, never a number. The old summary substituted 3 for an unset axis,
 * so an untouched proposal presented as mid-table; a dash cannot be misread as a
 * score, and the label beneath it says WHICH of the non-scored states this is —
 * `unscoredLabel` names each one, so the dash is never the only thing distinguishing
 * them.
 *
 * `'unavailable'` and `'loading'` are the other two and get their OWN words: the read
 * that carries the team view failed, or has not finished, so this row knows nothing
 * about how anyone scored the document. Rendering either as "Not scored yet" claimed
 * nobody had voted on data that exists on the server — the very ambiguity the error
 * panel above the list exists to close, restated by the row in stronger terms than
 * the panel can retract, and in the loading case with no panel on screen at all
 * because nothing has gone wrong.
 *
 * The reviewer count sits beside the mean, never behind a hover, because one
 * ballot produces a mean equal to that ballot and a spread of zero: without the
 * count, "one person looked" is indistinguishable from "we agree".
 */
export function TeamScoreSummary({ team }: { readonly team: TeamView }): ReactElement {
  const { t } = useTranslation('prioritization')
  if (team.kind !== 'scored') {
    return (
      <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4">
        <div className="text-center px-2 sm:px-3 py-1 bg-bg-accent rounded-lg">
          {/* Decorative, and hidden as such: announced alone an em dash reads like a
              value, and the label below is what carries the state. Same treatment as the
              stats cards' dash. */}
          <div aria-hidden="true" className="text-lg sm:text-xl font-bold text-muted-strong">—</div>
          {/* `text-text`, not `text-muted`: the faint grey measured 2.49:1 on this
              tint, well under the 4.5:1 WCAG AA wants at `text-xs`, and this is the one
              string that tells "nobody voted" from "we could not find out" from "still
              reading" — the distinction the row exists to make. Matches the band label
              beside the title, raised to `text-text` for the same reason. */}
          <div className="text-xs text-text">{unscoredLabel(team.kind, t)}</div>
        </div>
      </div>
    )
  }
  const scored = team.team
  return (
    <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4">
      {/* The axis values the SORT reads, not the raw means: the backend rounds to two
          decimals and this prints one, so printing the raw value here would let the list
          order two rows that show the same number. One rounding, shared — the rule
          `displayComposite` already follows. Captions are `text-muted` rather than the
          fainter `text-muted-strong`, which is under AA at this size. */}
      {/* An axis nobody scored is `null` and prints as the same decorative dash
          the non-scored branch above uses — never a number. The backend reports
          0.0 for it, and printing that ranked "nobody mentioned time to market"
          as "the team rated it worst" (#343). */}
      <div className="text-center">
        <div className="text-base sm:text-lg font-bold font-mono text-info"><TeamNumber value={scored.displayImpact} notScoredLabel={t('scores.notScored')} /></div>
        <div className="text-xs text-muted">{t('scores.impact')}</div>
      </div>
      <div className="text-center">
        <div className="text-base sm:text-lg font-bold font-mono text-aim"><TeamNumber value={scored.displayTimeToMarket} notScoredLabel={t('scores.notScored')} /></div>
        <div className="text-xs text-muted">{t('sort.ttm')}</div>
      </div>
      <div className="text-center px-2 sm:px-3 py-1 bg-bg-accent rounded-lg">
        {/* The same rounded value the priority band beside the title classifies, so
            the printed number and the label describing it are one value rather than
            two roundings of it. Null — a ballot that expressed no axis at all,
            only a note — prints the dash, and the band beside the title reads
            "Not Scored" off the same null. */}
        <div className="text-lg sm:text-xl font-bold font-mono text-ok"><TeamNumber value={scored.displayComposite} notScoredLabel={t('scores.notScored')} /></div>
        {/* Labelled as the TEAM's score, not "Score": this number changed meaning
            from "my composite" to "the team's mean composite", and a row a reader
            cannot attribute is worse than either alone. */}
        <div className="text-xs text-muted">{t('team.score')}</div>
      </div>
      <div className="text-center">
        <div className="flex items-center justify-center gap-1 text-sm sm:text-base font-bold font-mono text-text">
          <Users size={14} className="text-muted" />
          {scored.reviewerCount}
        </div>
        <div className="text-xs text-muted">{t('team.reviewers')}</div>
      </div>
    </div>
  )
}

/**
 * The badge that tells a reader the reviewers did not agree.
 *
 * On the resting row, because the spread is what makes a reader open the row: the
 * notes behind a disagreement are the content worth reading, and nothing else on
 * the collapsed row says they exist. Rendered only for a genuine disagreement —
 * `spread` is null below two comparable ballots and 0 when they agreed, and a
 * badge reading "spread 0.0" would say "look here" about a row with nothing to
 * look at.
 */
export function DisagreementBadge({ team }: { readonly team: TeamView }): ReactElement | null {
  const { t } = useTranslation('prioritization')
  // One shared predicate with `TeamScorePanel`'s pointer to the notes, rather than
  // each re-deriving "is there a disagreement" from `spread`: two spellings of one
  // rule is where the badge and the text it points at start disagreeing. No `?? 0`
  // fallback either — a change to what `spread: null` means then fails to compile
  // here instead of silently keeping the old behaviour. Both non-scored states
  // resolve to `null` through `teamScoreOf` and so show no badge: neither a document
  // nobody voted on nor one whose votes could not be read has a disagreement to
  // point at.
  const score = teamScoreOf(team)
  if (!reviewersDisagreed(score)) return null
  // Interpolated as a plain number rather than through a `count` plural: plural
  // forms differ per locale and a missing form renders the raw key path to users.
  return (
    <span className="text-xs px-2 py-0.5 rounded-full whitespace-nowrap font-mono bg-warn-subtle text-warn">
      {t('team.disagreement', { spread: score.spread.toFixed(1) })}
    </span>
  )
}

/**
 * What the team said, one level in — the composite the resting row leads with, the
 * count of ballots behind it and the spread across them, in words.
 *
 * The per-axis means stay on the collapsed row's summary rather than being repeated
 * here; this panel's job is to say whose numbers those are and whether the
 * reviewers agreed.
 *
 * Above the caller's own sliders, and in its own tinted panel, because these two
 * blocks are the pair a reader must never confuse: the mean the list sorts by, and
 * the ballot this reader can change. Visually distinct from `LinkedFormEvidence`
 * further down, which carries customer star ratings that deliberately do not feed
 * any score.
 *
 * Four states, not two. A read that failed says so ("could not be read"), and one
 * still running says that, rather than either inviting the reader to cast the first
 * ballot on a document the team may already have scored — the sliders are the one
 * thing on this panel that can act, and `team.noScoresDescription` points them at
 * exactly that.
 */
export function TeamScorePanel({ team }: { readonly team: TeamView }): ReactElement {
  const { t } = useTranslation('prioritization')
  const score = teamScoreOf(team)
  return (
    <div className="rounded-lg border border-aim/30 bg-aim-subtle p-3">
      <h4 className="font-medium text-text-strong flex items-center gap-1.5">
        <Users size={14} className="text-aim" />
        {t('team.title')}
      </h4>
      {team.kind === 'unavailable' ? (
        <p className="text-sm text-text mt-1">{t('team.unavailableDescription')}</p>
      ) : null}
      {/* Reads the team view, not a spinner: this panel's job is to say what is known
          about the group's opinion, and "we are still asking" is the honest answer
          while the read runs. Anything else here invites a ballot the reader may be
          about to see already cast. */}
      {team.kind === 'loading' ? (
        <p className="text-sm text-text mt-1">{t('team.loadingDescription')}</p>
      ) : null}
      {team.kind === 'unscored' ? (
        <p className="text-sm text-text mt-1">{t('team.noScoresDescription')}</p>
      ) : null}
      {score ? (
        <>
          <p className="text-sm text-text-strong mt-1">
            {/* A null composite — a ballot that expressed no axis, only a note —
                interpolates the same dash the chips print, keeping one key in
                eight catalogues rather than a second sentence for a state the
                reviewer count beside it already explains. */}
            {t('team.summary', {
              score: score.displayComposite === null ? '—' : score.displayComposite.toFixed(1),
              reviewers: score.reviewerCount,
            })}
          </p>
          {/* Some of those ballots may be ANONYMOUS — cast from a phone in a room
              through a voting session — and the aggregate cannot tell them apart
              from a signed-in reviewer's, by design: each counts as one reviewer.
              So the count above is a count of ballots and not of identifiable
              people, and this line says so rather than leaving a reader to assume
              the stronger claim. Unconditional, because nothing in the aggregate
              distinguishes the kinds: a sentence shown only when anonymous ballots
              exist would be a claim this page cannot make. */}
          <p className="text-xs text-text mt-1">{t('team.unattributedNote')}</p>
          {reviewersDisagreed(score) ? (
            /* The spread is what sends a reader to the notes, so the pointer to
               them sits with it. The same predicate the badge on the collapsed row
               uses, so the badge and the text it points at cannot answer
               differently. Only the CALLER'S OWN note is on this page: the
               prioritization read returns each reviewer's ballot only to its own
               author, so other reviewers' note text is not available without a new
               route — deliberately out of scope here (see the PR description). */
            <p className="text-sm text-text mt-1">
              {t('team.disagreementDescription', { spread: score.spread.toFixed(1) })}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
