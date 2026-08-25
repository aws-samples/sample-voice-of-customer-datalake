/**
 * @fileoverview PR/FAQ row component for the prioritization table.
 * @module pages/Prioritization/PRFAQRow
 */

import clsx from 'clsx'
import { format } from 'date-fns'
import {
  ChevronDown, ChevronUp, ExternalLink, Users, Wand2,
} from 'lucide-react'
import { useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import PrototypeLinkActions, { PrototypeLinkLifetimeNote } from '../../components/PrototypeLinkActions'
import PrototypeRenderer, { HtmlPrototypeFrame } from '../../components/PrototypeRenderer'
import { parsePrototypeSpec, looksLikeHtmlDocument } from '../../components/prototypeSpec'
import LinkedFormEvidence from './LinkedFormEvidence'
import PrototypeEnlargeButton from './PrototypeEnlargeButton'
import RoomVotePanel from './RoomVotePanel'
import {
  getPriorityLabel, MAX_NOTE_LENGTH, reviewersDisagreed, SCORABLE_TYPE_META, teamScoreOf,
} from './prioritizationUtils'
import ScoreSlider from './ScoreSlider'
import type {
  PrioritizationRowView, TeamView,
} from './prioritizationUtils'
import type { LinkedForm } from './formLinkUtils'
import type {
  PrioritizationScore, ProjectDocument,
} from '../../api/types'
import type { PrototypeSpec } from '../../components/prototypeSpec'
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
        <span aria-hidden="true" className="text-gray-300">—</span>
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
function TeamScoreSummary({ team }: { readonly team: TeamView }): ReactElement {
  const { t } = useTranslation('prioritization')
  if (team.kind !== 'scored') {
    return (
      <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4">
        <div className="text-center px-2 sm:px-3 py-1 bg-gray-50 rounded-lg">
          {/* Decorative, and hidden as such: announced alone an em dash reads like a
              value, and the label below is what carries the state. Same treatment as the
              stats cards' dash. */}
          <div aria-hidden="true" className="text-lg sm:text-xl font-bold text-gray-300">—</div>
          {/* `text-gray-600`, not `text-gray-400`: #99a1af on this `bg-gray-50` is 2.49:1,
              well under the 4.5:1 WCAG AA wants at `text-xs`, and this is the one string
              that tells "nobody voted" from "we could not find out" from "still reading" —
              the distinction the row exists to make. Matches the band label beside the
              title, raised to `text-gray-600` for the same reason. */}
          <div className="text-xs text-gray-600">{unscoredLabel(team.kind, t)}</div>
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
          `displayComposite` already follows. Captions are `text-gray-500` (4.63:1 on this
          white row) rather than `text-gray-400` (2.49:1), which is under AA at this size. */}
      {/* An axis nobody scored is `null` and prints as the same decorative dash
          the non-scored branch above uses — never a number. The backend reports
          0.0 for it, and printing that ranked "nobody mentioned time to market"
          as "the team rated it worst" (#343). */}
      <div className="text-center">
        <div className="text-base sm:text-lg font-bold text-blue-600"><TeamNumber value={scored.displayImpact} notScoredLabel={t('scores.notScored')} /></div>
        <div className="text-xs text-gray-500">{t('scores.impact')}</div>
      </div>
      <div className="text-center">
        <div className="text-base sm:text-lg font-bold text-purple-600"><TeamNumber value={scored.displayTimeToMarket} notScoredLabel={t('scores.notScored')} /></div>
        <div className="text-xs text-gray-500">{t('sort.ttm')}</div>
      </div>
      <div className="text-center px-2 sm:px-3 py-1 bg-gray-50 rounded-lg">
        {/* The same rounded value the priority band beside the title classifies, so
            the printed number and the label describing it are one value rather than
            two roundings of it. Null — a ballot that expressed no axis at all,
            only a note — prints the dash, and the band beside the title reads
            "Not Scored" off the same null. */}
        <div className="text-lg sm:text-xl font-bold text-green-600"><TeamNumber value={scored.displayComposite} notScoredLabel={t('scores.notScored')} /></div>
        {/* Labelled as the TEAM's score, not "Score": this number changed meaning
            from "my composite" to "the team's mean composite", and a row a reader
            cannot attribute is worse than either alone. */}
        <div className="text-xs text-gray-500">{t('team.score')}</div>
      </div>
      <div className="text-center">
        <div className="flex items-center justify-center gap-1 text-sm sm:text-base font-bold text-gray-700">
          <Users size={14} className="text-gray-400" />
          {scored.reviewerCount}
        </div>
        <div className="text-xs text-gray-500">{t('team.reviewers')}</div>
      </div>
    </div>
  )
}

/**
 * Resolved-value badge — receives a pre-computed label and colour from the
 * parent (which already has `t` in scope) instead of calling `useTranslation`
 * itself. Consistent with `PrototypePanel`, which accepts `t` as a prop for
 * the same reason.
 */
function DocumentTypeBadge({
  label, color,
}: {
  readonly label: string
  readonly color: string
}): ReactElement {
  return (
    <span className={clsx('text-xs px-2 py-0.5 rounded-full whitespace-nowrap', color)}>{label}</span>
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
function DisagreementBadge({ team }: { readonly team: TeamView }): ReactElement | null {
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
    <span className="text-xs px-2 py-0.5 rounded-full whitespace-nowrap bg-amber-100 text-amber-800">
      {t('team.disagreement', { spread: score.spread.toFixed(1) })}
    </span>
  )
}

/**
 * One badge per document the row is scored on.
 *
 * A row holds a SET of documents, so the collapsed row says which — a reviewer
 * scoring "Instant refunds" needs to know their one ballot covers its PR/FAQ and its
 * PRD, which is precisely what having two rows for one idea used to hide.
 */
function RowDocumentBadges({
  documents, t,
}: {
  readonly documents: readonly ProjectDocument[]
  readonly t: TFunction
}): ReactElement {
  return (
    <>
      {documents.map((doc) => {
        // Resolved here so DocumentTypeBadge is a pure presentational component
        // (consistent with PrototypePanel's t-as-prop pattern).
        const typeMeta = SCORABLE_TYPE_META[doc.document_type]
        return (
          <DocumentTypeBadge
            key={doc.document_id}
            label={typeMeta ? t(typeMeta.i18nKey) : doc.document_type}
            color={typeMeta?.badgeColor ?? 'bg-gray-100 text-gray-600'}
          />
        )
      })}
    </>
  )
}

function PRFAQRowHeader({
  row,
  index,
  priority,
  team,
  isExpanded,
  onToggle,
}: {
  readonly row: PrioritizationRowView
  readonly index: number
  readonly priority: {
    label: string;
    color: string
  }
  readonly team: TeamView
  readonly isExpanded: boolean
  readonly onToggle: () => void
}) {
  const { t } = useTranslation('prioritization')
  return (
    <button type="button" className="w-full p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 cursor-pointer hover:bg-gray-50 text-left" onClick={onToggle}>
      <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0">
        <div className="text-gray-400 font-mono text-sm w-6 hidden sm:block">#{index + 1}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-gray-900 truncate text-sm sm:text-base">{row.title}</h3>
            {/* One badge per document, because ONE ballot covers all of them. */}
            <RowDocumentBadges documents={row.documents} t={t} />
            <span className={clsx('text-xs px-2 py-0.5 rounded-full whitespace-nowrap', priority.color)}>{priority.label}</span>
            <DisagreementBadge team={team} />
          </div>
          <div className="flex items-center gap-2 sm:gap-3 mt-1 text-xs sm:text-sm text-gray-500">
            <span className="truncate">{row.project_name}</span>
            <span>•</span>
            <span className="whitespace-nowrap">{format(new Date(row.created_at), 'MMM d, yyyy')}</span>
            {/* Says plainly what one ballot covers, next to the badges that name
                the documents. Without it, a row showing two badges leaves a reader
                to guess whether they are scoring both or picking one.
                Only for a row that HOLDS more than one: on a single-document row
                there is nothing to clarify, and it lets the sentence be written in
                the plural rather than through a `count` plural — whose forms differ
                per locale, and a missing one renders the raw key path.
                `documents`, not `count`: `count` is i18next's RESERVED option and
                passing it switches the resolver into plural mode, looking for
                `_one`/`_other` first. */}
            {row.documents.length > 1 ? (
              <>
                <span className="hidden sm:inline">•</span>
                <span className="hidden sm:inline whitespace-nowrap">
                  {t('row.multiDocument', { documents: row.documents.length })}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <TeamScoreSummary team={team} />
      <div className="sm:ml-2">{isExpanded ? <ChevronUp size={20} className="text-gray-400" /> : <ChevronDown size={20} className="text-gray-400" />}</div>
    </button>
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
function TeamScorePanel({ team }: { readonly team: TeamView }): ReactElement {
  const { t } = useTranslation('prioritization')
  const score = teamScoreOf(team)
  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-3">
      <h4 className="font-medium text-indigo-900 flex items-center gap-1.5">
        <Users size={14} className="text-indigo-500" />
        {t('team.title')}
      </h4>
      {team.kind === 'unavailable' ? (
        <p className="text-sm text-indigo-800 mt-1">{t('team.unavailableDescription')}</p>
      ) : null}
      {/* Reads the team view, not a spinner: this panel's job is to say what is known
          about the group's opinion, and "we are still asking" is the honest answer
          while the read runs. Anything else here invites a ballot the reader may be
          about to see already cast. */}
      {team.kind === 'loading' ? (
        <p className="text-sm text-indigo-800 mt-1">{t('team.loadingDescription')}</p>
      ) : null}
      {team.kind === 'unscored' ? (
        <p className="text-sm text-indigo-800 mt-1">{t('team.noScoresDescription')}</p>
      ) : null}
      {score ? (
        <>
          <p className="text-sm text-indigo-900 mt-1">
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
          <p className="text-xs text-indigo-800 mt-1">{t('team.unattributedNote')}</p>
          {reviewersDisagreed(score) ? (
            /* The spread is what sends a reader to the notes, so the pointer to
               them sits with it. The same predicate the badge on the collapsed row
               uses, so the badge and the text it points at cannot answer
               differently. Only the CALLER'S OWN note is on this page: the
               prioritization read returns each reviewer's ballot only to its own
               author, so other reviewers' note text is not available without a new
               route — deliberately out of scope here (see the PR description). */
            <p className="text-sm text-indigo-800 mt-1">
              {t('team.disagreementDescription', { spread: score.spread.toFixed(1) })}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

/**
 * One document of the row, inside the expansion: its type, its text, and the
 * customer evidence collected about IT.
 *
 * Per document rather than merged into the row, because the evidence belongs to the
 * document a form validates — a PR/FAQ's ratings shown under its project's PRD is the
 * confusion `formLinkUtils`' matching rules exist to prevent — and because a reviewer
 * casting one ballot on a set is entitled to read each thing in it.
 */
function RowDocument({
  document: doc, projectId, linkedForms, apiEndpoint, t,
}: {
  readonly document: ProjectDocument
  readonly projectId: string
  readonly linkedForms: readonly LinkedForm[]
  readonly apiEndpoint: string
  readonly t: TFunction
}): ReactElement {
  const typeMeta = SCORABLE_TYPE_META[doc.document_type]
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <DocumentTypeBadge
            label={typeMeta ? t(typeMeta.i18nKey) : doc.document_type}
            color={typeMeta?.badgeColor ?? 'bg-gray-100 text-gray-600'}
          />
          <span className="text-sm font-medium text-gray-900 truncate">{doc.title}</span>
        </div>
        {/* The project, not the document: the document route on this app is the
            project page, and that is where the full text lives. */}
        <a href={`/projects/${projectId}`} className="text-sm text-blue-600 hover:underline flex items-center gap-1 flex-shrink-0">
          <span className="hidden sm:inline">{t('preview.viewFull')}</span>
          <span className="sm:hidden">{t('preview.viewMobile')}</span>
          <ExternalLink size={14} />
        </a>
      </div>
      <div className="bg-white rounded-lg border p-3 sm:p-4 max-h-48 sm:max-h-64 overflow-y-auto prose prose-sm">
        <ReactMarkdown>{doc.content.slice(0, 1500) + (doc.content.length > 1500 ? '...' : '')}</ReactMarkdown>
      </div>
      {/* Ratings already collected about THIS document. Mounted expand-only because
          the stats read is expensive per form — see LinkedFormEvidence. */}
      <LinkedFormEvidence forms={linkedForms} apiEndpoint={apiEndpoint} />
    </div>
  )
}

function PRFAQRowExpanded({
  row, score, team, linkedFormsByDocument, apiEndpoint, onUpdateScore,
}: {
  readonly row: PrioritizationRowView
  readonly score: PrioritizationScore
  readonly team: TeamView
  /** Per DOCUMENT, not per row — see `RowDocument`. */
  readonly linkedFormsByDocument: ReadonlyMap<string, readonly LinkedForm[]>
  readonly apiEndpoint: string
  readonly onUpdateScore: (field: keyof PrioritizationScore, value: number | string) => void
}) {
  const { t } = useTranslation('prioritization')
  return (
    <div className="border-t px-3 sm:px-4 py-4 bg-gray-50">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <div className="space-y-4">
          <TeamScorePanel team={team} />
          <div>
            <h4 className="font-medium text-gray-900">{t('scores.title')}</h4>
            {/* Says whose numbers these are. The row's headline is the team's mean
                now, so the sliders need to name themselves as the reader's own
                ballot — and to say that saving writes only that. */}
            <p className="text-xs text-gray-500 mt-1">{t('scores.yoursOnly')}</p>
            {/* And WHAT they score: one ballot on this row's whole set of documents.
                A reviewer who thought a slider scored only the document they were
                reading is exactly who was scoring half an idea before rows. Shown
                only for a row holding more than one, for the reason the header's
                own count is. */}
            {row.documents.length > 1 ? (
              <p className="text-xs text-gray-500 mt-1">
                {t('scores.wholeRow', { documents: row.documents.length })}
              </p>
            ) : null}
          </div>
          {/* The stored value goes in RAW: 0 means unscored (the API's own
              contract) and `ScoreSlider` renders it as such. The old
              `=== 0 ? 3` coercion here painted a mid-range number the record
              did not hold, indistinguishable from a stored 3 — so a reviewer
              whose partial save recorded three axes as nothing could never
              discover it on screen (#343). */}
          <ScoreSlider label={t('scores.impact')} value={score.impact} onChange={(v) => onUpdateScore('impact', v)} description={t('scores.impactDescription')} lowLabel={t('scores.low')} highLabel={t('scores.high')} />
          <ScoreSlider label={t('scores.timeToMarket')} value={score.time_to_market} onChange={(v) => onUpdateScore('time_to_market', v)} description={t('scores.timeToMarketDescription')} lowLabel={t('scores.slow')} highLabel={t('scores.fast')} />
          <ScoreSlider label={t('scores.strategicFit')} value={score.strategic_fit} onChange={(v) => onUpdateScore('strategic_fit', v)} description={t('scores.strategicFitDescription')} lowLabel={t('scores.low')} highLabel={t('scores.high')} />
          <ScoreSlider label={t('scores.confidence')} value={score.confidence} onChange={(v) => onUpdateScore('confidence', v)} description={t('scores.confidenceDescription')} lowLabel={t('scores.low')} highLabel={t('scores.high')} />
          <div>
            <label className="text-sm font-medium text-gray-700">{t('notes.label')}</label>
            {/* Bounded, because the API REFUSES a longer note rather than
                truncating it — the tail of a justification is content, not a
                number that can be clamped. Without this the page could compose a
                body the save would reject, and `fetchApi` discards the reason. A
                note already over the bound in pre-ballot data is not shortened by
                `maxLength`; `overLongNoteRows` blocks the save for it. */}
            <textarea value={score.notes} onChange={(e) => onUpdateScore('notes', e.target.value)} placeholder={t('notes.placeholder')} rows={2} maxLength={MAX_NOTE_LENGTH} className="mt-1 w-full px-3 py-2 border rounded-lg text-sm" />
          </div>
          {/* Get the ROOM's ballots, not just this reader's: a facilitator opens a
              session for this ROW and the QR goes on the projector, so a room scores
              the whole proposal rather than whichever of its documents the code sat
              on. Under the caller's own sliders because it is the other way to put a
              score in, and above the customer evidence because it is still internal
              scoring. Mounted expand-only, like everything else in this column — it
              opens nothing and reads nothing until a facilitator asks. */}
          <RoomVotePanel rowId={row.row_id} rowTitle={row.title} documentCount={row.documents.length} />
        </div>
        <div className="space-y-4">
          <h4 className="font-medium text-gray-900">{t('preview.title')}</h4>
          {/* Every document the row is scored on, each with its own evidence. Newest
              first, which is the order `collectRows` resolved them in and the order
              the leading title came from. */}
          {row.documents.map((doc) => (
            <RowDocument
              key={doc.document_id}
              document={doc}
              projectId={row.project_id}
              linkedForms={linkedFormsByDocument.get(doc.document_id) ?? NO_LINKED_FORMS}
              apiEndpoint={apiEndpoint}
              t={t}
            />
          ))}
          {/* Prototype preview, under the row's documents. HTML prototypes render in
              a sandboxed iframe; legacy JSON specs render natively. Hidden gracefully
              when the row names no prototype the project still has. */}
          <PrototypePanel prototype={row.prototype} t={t} />
        </div>
      </div>
    </div>
  )
}

/** Decide how to render a prototype document: as HTML, a JSON spec, or not at all. */
function resolvePrototypeMode(
  content: string,
  protoFormat: string | undefined,
): { kind: 'html' } | {
  kind: 'spec';
  spec: PrototypeSpec
} | { kind: 'none' } {
  if (content === '') return { kind: 'none' }
  const isHtml = protoFormat === 'html' || (protoFormat === undefined && looksLikeHtmlDocument(content))
  if (isHtml) return { kind: 'html' }
  const spec = parsePrototypeSpec(content)
  return spec ? {
    kind: 'spec',
    spec,
  } : { kind: 'none' }
}

/**
 * The prototype panel's heading, and the two things a reader can do about a pane
 * this size.
 *
 * Split out of `PrototypePanel` because that function's branch count is capped by
 * eslint's `complexity` rule at 12 and adding the enlarge control put it at 13. A
 * genuine seam rather than an appeasement: everything here is about the AFFORDANCES,
 * and everything left there is about resolving which artifact to render.
 *
 * "Open in new tab" appears only with a `prototype_url` to open — a legacy
 * prototype is inline HTML with no address, and the blob indirection the Documents
 * tab uses for those is not worth carrying onto a page that lists every project.
 * The deadline beneath it is stated rather than implied, because that URL is a
 * signed session credential (see components/PrototypeLinkActions); the page
 * schedules its own re-signing in `Prioritization.tsx`, without which the link
 * would 403 for anyone who parks a pitch on screen for an hour.
 *
 * "Enlarge" appears for EVERY prototype the panel renders, url or not: it
 * re-renders the pane the row is already showing and needs no address of its own,
 * so a legacy inline prototype and a JSON spec enlarge exactly as well as a signed
 * one. It sits beside the anchor because the two answer the same question — "I
 * cannot see this properly" — and a reader comparing them should not have to find
 * them in different places.
 *
 * @param enlarged the prototype as the overlay should render it: the row's own
 *   pane element in a box that fills the dialog.
 */
function PrototypePanelHeader({
  url, noteId, documentTitle, enlarged, t,
}: {
  readonly url?: string
  readonly noteId: string
  readonly documentTitle?: string
  readonly enlarged: ReactElement
  readonly t: TFunction
}): ReactElement {
  return (
    <>
      <div className="flex items-center justify-between mt-2 gap-3">
        <h4 className="font-medium text-gray-900 flex items-center gap-1.5">
          <Wand2 size={14} className="text-orange-500" />
          {t('preview.prototypeTitle', { defaultValue: 'Prototype' })}
        </h4>
        <span className="flex items-center gap-3 text-xs flex-shrink-0">
          {url ? <PrototypeLinkActions url={url} noteId={noteId} /> : null}
          <PrototypeEnlargeButton documentTitle={documentTitle}>{enlarged}</PrototypeEnlargeButton>
        </span>
      </div>
      {/* Under the link, not beside it: this column is half a row wide, and the
          note wraps rather than truncates — the clipped end would be the warning. */}
      {url ? <PrototypeLinkLifetimeNote url={url} noteId={noteId} className="mt-1 text-xs" /> : null}
    </>
  )
}

/**
 * Renders a project's latest prototype under the PR/FAQ preview. Chooses the
 * iframe (HTML format) or the native JSON-spec renderer, or renders nothing
 * when there's no usable prototype.
 *
 * The embedded frame is 384px tall inside half a row — enough to recognise the
 * prototype, not enough to walk a room through it — so the header above it offers
 * the artifact bigger, two ways: out of the app in a new tab, and filling the
 * viewport in place. See `PrototypePanelHeader` for which of those a given
 * prototype gets and why.
 */
function PrototypePanel({
  prototype, t,
}: {
  readonly prototype?: ProjectDocument
  readonly t: TFunction
}): ReactElement | null {
  const content = prototype?.content ?? ''
  const protoFormat = prototype?.prototype_format
  const url = prototype?.prototype_url
  // Minted per panel: a page shows one of these per row, and a module constant
  // would give every row's anchors the same aria-describedby target.
  const lifetimeNoteId = useId()
  // A new (S3-only) prototype has no `content` to run `resolvePrototypeMode`'s
  // heuristics against — treat presence of `prototype_url` as HTML directly.
  const mode = useMemo(
    () => (url ? { kind: 'html' as const } : resolvePrototypeMode(content, protoFormat)),
    [url, content, protoFormat],
  )
  if (mode.kind === 'none') return null
  /**
   * The artifact itself, described once and rendered in two boxes: the row's
   * 384px pane and the enlarge overlay's full-viewport one.
   *
   * One description rather than two, because the sizing lives on the CONTAINER —
   * this frame is `w-full h-full` either way. A second `HtmlPrototypeFrame` call
   * written for the overlay would be free to drift from this one, and the thing it
   * would drift away from is `useLoadedUrl`: the handling that lets a re-signed URL
   * through without reloading the frame under a reviewer, and lets an already-dead
   * one be replaced. A React element is a description and not an instance, so using
   * this in both places mounts a frame per box — and the overlay's box does not
   * exist until somebody opens it, `ModalShell` rendering nothing while closed.
   */
  const pane = mode.kind === 'html' ? (
    <HtmlPrototypeFrame url={url} html={content} title={prototype?.title} className="w-full h-full border-0" />
  ) : (
    <PrototypeRenderer spec={mode.spec} />
  )
  return (
    <div>
      <PrototypePanelHeader
        url={url}
        noteId={lifetimeNoteId}
        documentTitle={prototype?.title}
        enlarged={(
          /* Full height inside the overlay's panel, and scrollable for the JSON
             spec, which is a document rather than a frame and can be taller than
             the screen. */
          <div className={clsx('h-full', mode.kind === 'html' ? 'overflow-hidden' : 'overflow-y-auto p-4')}>
            {pane}
          </div>
        )}
        t={t}
      />
      {mode.kind === 'html' ? (
        <div className="bg-white rounded-lg border overflow-hidden mt-2 h-96">
          {pane}
        </div>
      ) : (
        <div className="bg-white rounded-lg border p-3 sm:p-4 max-h-96 overflow-y-auto mt-2">
          {pane}
        </div>
      )}
    </div>
  )
}

/** Shared empty list, so a row with no linked forms allocates nothing per render. */
const NO_LINKED_FORMS: readonly LinkedForm[] = []

export default function PRFAQRow({
  row, index, score, team, linkedFormsByDocument, apiEndpoint, isExpanded, onToggle, onUpdateScore,
}: {
  readonly row: PrioritizationRowView
  readonly index: number
  /**
   * The CALLER'S OWN ballot, behind the caller's own sliders in the expansion.
   * Not what the resting row shows — see `team`.
   */
  readonly score: PrioritizationScore
  /**
   * What every reviewer together said — the row's resting state, and the same numbers
   * the list is ordered by.
   *
   * See `TeamView` for the states and what each one licenses the row to say, rather than
   * a count restated here: the count was wrong for four commits after `'loading'` joined
   * the union, and a pointer cannot drift from the type the way a number can.
   */
  readonly team: TeamView
  /**
   * Forms that validate each of the row's documents, keyed by document id — see
   * `formLinkUtils.buildLinkedFormsByDocument`.
   *
   * Per document rather than per row, because a form validates a document and the
   * ratings it collected are about that document. The row is how a reader reaches
   * them.
   */
  readonly linkedFormsByDocument: ReadonlyMap<string, readonly LinkedForm[]>
  /**
   * The configured API base, needed only to address a linked form's public page
   * in `LinkedFormEvidence`. Threaded rather than read from the store there, so
   * that panel and its QR stay renderable without one.
   */
  readonly apiEndpoint: string
  readonly isExpanded: boolean
  readonly onToggle: () => void
  readonly onUpdateScore: (field: keyof PrioritizationScore, value: number | string) => void
}) {
  const { t } = useTranslation('prioritization')
  // The priority band describes the TEAM's composite, matching the number beside
  // it and the sort order. The team VIEW is passed whole rather than as
  // `composite ?? 0`, so neither non-scored state reaches the band as a low number:
  // a proposal the team unanimously rated 1 bands "Low Priority", only an unvoted
  // one bands "Not Scored", and a failed read bands as neither. The band also reads
  // the same rounded value the row prints, so label and number cannot disagree.
  const priority = getPriorityLabel(team, t)

  return (
    <div className="bg-white rounded-lg border shadow-sm">
      <PRFAQRowHeader row={row} index={index} priority={priority} team={team} isExpanded={isExpanded} onToggle={onToggle} />
      {isExpanded ? <PRFAQRowExpanded row={row} score={score} team={team} linkedFormsByDocument={linkedFormsByDocument} apiEndpoint={apiEndpoint} onUpdateScore={onUpdateScore} /> : null}
    </div>
  )
}
