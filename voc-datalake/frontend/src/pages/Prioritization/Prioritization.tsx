/**
 * @fileoverview Feature prioritization page for PR/FAQ documents.
 * @module pages/Prioritization
 */

import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import clsx from 'clsx'
import {
  AlertTriangle, ArrowUpDown, FileText, Sparkles, Save, RotateCcw,
} from 'lucide-react'
import {
  useState, useMemo, useId,
} from 'react'
import type { ReactElement } from 'react'
import {
  useTranslation, Trans,
} from 'react-i18next'
import { useBlocker } from 'react-router-dom'
import { api } from '../../api/client'
import { feedbackFormsKey } from '../../api/feedbackFormQueryKeys'
import { projectsKey } from '../../api/projectQueryKeys'
import { projectsApi } from '../../api/projectsApi'
import ConfirmModal from '../../components/ConfirmModal'
import { usePrototypeLinkRefresh } from '../../components/usePrototypeLinkRefresh'
import { useConfigStore } from '../../store/configStore'
import {
  buildLinkedFormsByDocument, collectProjectDocumentIds, normalizeLinkedForms,
} from './formLinkUtils'
import PRFAQRow from './PRFAQRow'
import {
  applyBallotEdits, getScore, getTeamView, collectPRFAQs, isScorable,
  MAX_NOTE_LENGTH, normalizeAggregates, normalizeScores, ownBallotRead,
  overLongNoteDocuments, priorityBand, READ_STATE_I18N_KEY, sortPRFAQs, teamAggregatesOf,
  teamOrderingAvailable, uncountableTeamRead, withEditedField,
} from './prioritizationUtils'
import type {
  PRFAQWithProject, SortField, SortDirection, TeamAggregates,
} from './prioritizationUtils'
import type { LinkedForm } from './formLinkUtils'
import type {
  Project, PrioritizationScore, PrioritizationBallotEdit,
} from '../../api/types'

/**
 * The prioritization read, validated at the query boundary — BOTH halves of it.
 *
 * Per project convention, the same place `normalizeLinkedForms` validates the form list.
 * `aggregates` is optional on the wire (a deployment predating it sends none at all) and
 * a partial or unreadable row must read as "nobody has scored this" rather than break a
 * row. `scores` goes through a normalizer too: a declared type is a promise about the
 * response and not a proof of it, and passing this half through untouched let a `null` or
 * non-object one leave every slider on `DEFAULT_SCORE` while the save guard read the
 * field as present.
 *
 * The parameter type is DERIVED from the client rather than restated, so `data.scores`
 * and `data.aggregates` are proof that `getPrioritizationScores` declares those fields:
 * remove one there and this fails to compile, where a hand-written shape would keep
 * agreeing with itself while the wire moved.
 *
 * At MODULE level, not inline in the `useQuery` call. TanStack Query memoises a `select`
 * result only while the function's identity is stable, so an inline arrow — a fresh
 * closure on every render — re-parsed the whole map on each render. That was waste rather
 * than a bug (structural sharing kept the result referentially stable downstream), but
 * this page re-renders on every slider drag, so the waste scaled with both the backlog
 * and the interaction.
 */
type PrioritizationRead = Awaited<ReturnType<typeof api.getPrioritizationScores>>

const selectPrioritization = (data: PrioritizationRead) => ({
  scores: normalizeScores(data.scores),
  aggregates: normalizeAggregates(data.aggregates),
})

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
 * a false one; no such read said anything about any of them. Only "Total Documents"
 * survives, because that is counted off the project read, which is a different query
 * and may well have succeeded already.
 */
function StatsCards({
  allPRFAQs, aggregates,
}: {
  readonly allPRFAQs: PRFAQWithProject[];
  readonly aggregates: TeamAggregates
}) {
  const { t } = useTranslation('prioritization')
  const bands = allPRFAQs.map((p) => priorityBand(getTeamView(aggregates, p.document_id)))
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
   * explains. When the cards are counting, a marked row is in "Total Documents" and in
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
        <div className="bg-white rounded-lg border p-4"><div className="text-2xl font-bold text-gray-900">{allPRFAQs.length}</div><div className="text-sm text-gray-500">{t('stats.totalDocuments')}</div></div>
        <div className="bg-white rounded-lg border p-4"><div className="text-2xl font-bold text-green-600">{countOf('high')}</div><div className="text-sm text-gray-500">{t('stats.highPriority')}</div></div>
        <div className="bg-white rounded-lg border p-4"><div className="text-2xl font-bold text-blue-600">{countOf('medium')}</div><div className="text-sm text-gray-500">{t('stats.mediumPriority')}</div></div>
        {/* `text-gray-500`, not the inherited `text-gray-400`: on this white card gray-400
            measures 2.60:1, which fails AA even at the 3:1 allowance `text-2xl font-bold`
            would qualify for — so it was missed by the contrast sweep rather than judged.
            gray-500 is 4.84:1 and still reads as the quiet card of the four. */}
        <div className="bg-white rounded-lg border p-4"><div className="text-2xl font-bold text-gray-500">{countOf('none')}</div><div className="text-sm text-gray-500">{t('stats.notScored')}</div></div>
      </div>
      {/* Why the counts above may not add up: a row the response named but could not be
          read is in the total and in no other card — see `unreadableCount`. Ordinary
          visible text rather than a live region, like the row labels that state the same
          thing per document: it renders with the numbers it explains. `text-gray-600` per
          the measured table in `BAND_STYLE` (gray-500 fails AA below 18.5px on gray
          backgrounds; this line is text-sm on the page's gray-50). */}
      {unreadableCount === 0 ? null : (
        <p className="text-sm text-gray-600 mt-2">
          {t('stats.unreadable', { count: unreadableCount })}
        </p>
      )}
    </div>
  )
}

function SortControls({
  sortField, sortDirection, onToggleSort, ordersByTeam,
}: {
  readonly sortField: SortField;
  readonly sortDirection: SortDirection;
  readonly onToggleSort: (f: SortField) => void;
  /**
   * Can the three score buttons actually order the list by the team's numbers?
   *
   * `teamOrderingAvailable(aggregates)` — see there for which states answer false. When
   * they do, `sortPRFAQs` leaves the order as it arrived for those three fields, and the
   * hint below the buttons is permanently visible — so leaving it up left the page
   * asserting the list is ordered by the team's numbers while nothing was ordering it.
   */
  readonly ordersByTeam: boolean
}) {
  const { t } = useTranslation('prioritization')
  // Also announced, not only hovered. A `title` tooltip never appears on a touch
  // device and screen-reader support for it is inconsistent, so the readers who most
  // need "whose numbers are these" were the ones who could not reach the answer. The
  // three team-ordered buttons point at one visible line below the row; `title` stays
  // as the pointer affordance.
  const hintId = useId()
  const teamOrderedFields = [t('sort.priorityFull'), t('sort.impact'), t('sort.ttmFull')]
  // Describes the BUTTONS, not the current sort. It is permanently visible — that is
  // the point of moving it out of a `title` — so a sentence about "the list" was false
  // for as long as the reader had Date Created active: an ascending date order sat
  // directly beneath the words "orders the list by the team's numbers". Naming the
  // three options instead is true in every state, including before the reader has
  // clicked anything, which is when the hint is most use.
  //
  // The names are INTERPOLATED from the same keys the buttons render, rather than
  // restated inside the sentence in eight catalogues, so a relabelled button cannot
  // leave the hint naming an option that is no longer on screen.
  //
  // And withdrawn entirely when nothing gives the buttons a number to order by — the
  // read failed, or arrived with no readable row (`teamOrderingAvailable`): the sentence
  // would be describing an effect the reader can click for and not get. The rows and the
  // stats cards already say why the team's numbers are missing; this line's only job is
  // to attribute an ordering that is not happening.
  const teamOrdered = ordersByTeam
    ? t('sort.teamOrdered', { fields: teamOrderedFields.join(', ') })
    : undefined
  const options = [
    {
      field: 'priority_score' as const,
      label: t('sort.priority'),
      fullLabel: t('sort.priorityFull'),
      hint: teamOrdered,
    },
    {
      field: 'impact' as const,
      label: t('sort.impact'),
      fullLabel: t('sort.impact'),
      hint: teamOrdered,
    },
    {
      field: 'time_to_market' as const,
      label: t('sort.ttm'),
      fullLabel: t('sort.ttmFull'),
      hint: teamOrdered,
    },
    {
      field: 'created_at' as const,
      label: t('sort.date'),
      fullLabel: t('sort.dateFull'),
      hint: undefined,
    },
  ]
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-gray-500 w-full sm:w-auto">{t('sort.label')}</span>
        {options.map(({
          field, label, fullLabel, hint,
        }) => (
          <button key={field} title={hint} aria-describedby={hint === undefined ? undefined : hintId} onClick={() => onToggleSort(field)} className={clsx('px-2 sm:px-3 py-1.5 rounded-lg flex items-center gap-1 text-xs sm:text-sm', sortField === field ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}>
            <span className="sm:hidden">{label}</span>
            <span className="hidden sm:inline">{fullLabel}</span>
            {sortField === field && <ArrowUpDown size={14} className={sortDirection === 'desc' ? 'rotate-180' : ''} />}
          </button>
        ))}
      </div>
      {teamOrdered === undefined ? null : (
        <p id={hintId} className="text-xs text-gray-500 mt-1.5">{teamOrdered}</p>
      )}
    </div>
  )
}

const NO_LINKED_FORMS: readonly LinkedForm[] = []

/**
 * Query key root for the fan-out project read.
 *
 * A constant rather than two literals because it is now both fetched and
 * invalidated (see the prototype re-sign below) — spelled twice, a rename would
 * leave the invalidation matching nothing, and nothing would fail: the page keeps
 * working and the prototype links quietly stop being refreshed. Stays private to
 * this page per the rule in api/projectQueryKeys.
 */
const ALL_PROJECT_DETAILS_KEY = 'all-project-details'

function PRFAQList({
  isLoading, prfaqs, scores, aggregates, linkedFormsByDocument, apiEndpoint, expandedId, onToggleExpand, onUpdateScore, hasNonScorableOnly,
}: {
  readonly isLoading: boolean
  readonly prfaqs: PRFAQWithProject[]
  /** The caller's own ballots, which stay behind each row's own sliders. */
  readonly scores: Record<string, PrioritizationScore>
  /**
   * What every reviewer together said — the resting row, and the sort order.
   *
   * A map, or a read state saying why there is none; see `TeamAggregates` for what the
   * three absences mean, rather than a restatement here that can go stale (this one did,
   * naming a `null` that left the union). Each row states the read state as such rather
   * than as an absence of votes.
   */
  readonly aggregates: TeamAggregates
  readonly linkedFormsByDocument: ReadonlyMap<string, readonly LinkedForm[]>
  /** Passed through to each row's linked-form panel — see PRFAQRow. */
  readonly apiEndpoint: string
  readonly expandedId: string | null
  readonly onToggleExpand: (id: string) => void
  readonly onUpdateScore: (docId: string, field: keyof PrioritizationScore, value: number | string) => void
  readonly hasNonScorableOnly: boolean
}) {
  const { t } = useTranslation('prioritization')

  if (isLoading) {
    return <div className="text-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" /><p className="text-gray-500 mt-4">{t('loading')}</p></div>
  }
  if (prfaqs.length === 0) {
    if (hasNonScorableOnly) {
      return <div className="text-center py-12 bg-white rounded-lg border"><FileText size={48} className="mx-auto text-gray-300 mb-4" /><h3 className="text-lg font-medium text-gray-900">{t('empty.wrongTypeTitle')}</h3><p className="text-gray-500 mt-1">{t('empty.wrongTypeDescription')}</p></div>
    }
    return <div className="text-center py-12 bg-white rounded-lg border"><FileText size={48} className="mx-auto text-gray-300 mb-4" /><h3 className="text-lg font-medium text-gray-900">{t('empty.title')}</h3><p className="text-gray-500 mt-1">{t('empty.description')}</p></div>
  }
  return (
    <div className="space-y-3">
      {prfaqs.map((prfaq, index) => (
        <PRFAQRow
          key={prfaq.document_id}
          prfaq={prfaq}
          index={index}
          score={getScore(scores, prfaq.document_id)}
          team={getTeamView(aggregates, prfaq.document_id)}
          linkedForms={linkedFormsByDocument.get(prfaq.document_id) ?? NO_LINKED_FORMS}
          apiEndpoint={apiEndpoint}
          isExpanded={expandedId === prfaq.document_id}
          onToggle={() => onToggleExpand(prfaq.document_id)}
          onUpdateScore={(field, value) => onUpdateScore(prfaq.document_id, field, value)}
        />
      ))}
    </div>
  )
}

function PrioritizationHeader({
  hasChanges, isPending, saveBlocked, onReset, onSave,
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
  readonly onReset: () => void
  readonly onSave: () => void
}) {
  const { t } = useTranslation('prioritization')
  const canSave = hasChanges && !saveBlocked && !isPending
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('title')}</h1>
        <p className="text-sm sm:text-base text-gray-500 mt-1">{t('subtitle')}</p>
      </div>
      <div className="flex items-center gap-2 sm:gap-3">
        {hasChanges ? <button onClick={onReset} className="flex items-center gap-2 px-3 sm:px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm">
          <RotateCcw size={16} /><span className="hidden sm:inline">{t('actions.reset')}</span>
        </button> : null}
        <button onClick={onSave} disabled={!canSave} className={clsx('flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg font-medium text-sm', canSave ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed')}>
          <Save size={16} />
          <span className="hidden sm:inline">{isPending ? t('actions.saving') : t('actions.save')}</span>
          <span className="sm:hidden">{isPending ? t('actions.savingMobile') : t('actions.saveMobile')}</span>
        </button>
      </div>
    </div>
  )
}

export default function Prioritization() {
  const { t } = useTranslation('prioritization')
  const { config } = useConfigStore()
  const queryClient = useQueryClient()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sortField, setSortField] = useState<SortField>('priority_score')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  // Only unsaved edits live in local state; saved scores stay in the query
  // cache. Displayed scores are derived (saved ⊕ edits), so a refetch after
  // saving — or landing here with a stale cache — always shows the server's
  // latest values instead of a one-time snapshot (issue #95).
  //
  // A `PrioritizationBallotEdit`, not a whole score: an edit holds ONLY the fields
  // this reviewer actually set. Seeding it from `getScore` — and so from
  // `DEFAULT_SCORE` for a row with no stored ballot — meant moving one slider saved
  // all four axes, two of them as a `0` the slider cannot express and none of the
  // other three chosen by the reviewer. The backend counts those as votes and
  // averages each axis over the reviewers who cast one, so a reviewer who cared only
  // about impact dragged the TEAM's confidence and strategic-fit means toward zero
  // for everybody — into the number this page now displays, bands, counts and sorts
  // by. The verb is PATCH, so an omitted axis means "leave it alone".
  const [localEdits, setLocalEdits] = useState<Record<string, PrioritizationBallotEdit>>({})

  const hasChanges = Object.keys(localEdits).length > 0

  const {
    data: projectsData, isLoading: loadingProjects,
  } = useQuery({
    queryKey: projectsKey(),
    queryFn: () => projectsApi.getProjects(),
    enabled: config.apiEndpoint.length > 0,
  })

  const projects = projectsData?.projects
  const projectIds = Array.isArray(projects) ? projects.map((p: Project) => p.project_id) : []

  const {
    data: allProjectDetails, isLoading: loadingDetails,
  } = useQuery({
    queryKey: [ALL_PROJECT_DETAILS_KEY, projectIds],
    queryFn: () => Promise.all(projectIds.map((id) => projectsApi.getProject(id))),
    enabled: projectIds.length > 0,
  })

  /**
   * Re-sign the prototype links before they lapse.
   *
   * This read is where every prototype URL on the page comes from, and the API
   * mints a fresh signature on every project read — so refetching it IS the
   * re-sign. Without this the row's "Open in new tab" would 403 for anyone who
   * parks a pitch on screen past the signature's ~1h life: it is a plain anchor by
   * necessity, so nothing can fetch a replacement at click time.
   *
   * Invalidated by prefix, not with the full `[key, projectIds]`, so it still
   * matches when the project list has changed underneath.
   *
   * That prefix invalidation re-reads EVERY project off whichever single deadline
   * falls soonest, so one prototype nearing expiry costs N project reads. Correct
   * and cheap at this page's scale — the same fan-out it already performs on mount,
   * once an hour, for a list of projects one team can prioritise in a sitting — and
   * it is what keeps every row's link live off one timer. It is the wrong shape if
   * the fan-out is ever paginated or the project count grows by an order of
   * magnitude: at that point the refresh belongs per row, next to the row that owns
   * the link, rather than here.
   *
   * Not memoised: the flattened array is consumed inside the hook by
   * `earliestPrototypeExpiry`, which reduces it to a number before anything can
   * depend on its identity. A `useMemo` would stabilise a reference nothing holds.
   */
  usePrototypeLinkRefresh(
    (allProjectDetails ?? []).flatMap((detail) => detail.documents ?? []),
    () => {
      void queryClient.invalidateQueries({ queryKey: [ALL_PROJECT_DETAILS_KEY] })
    },
    // A constant, because this page has exactly one scope: it always reads all
    // projects, and the invalidation above is by prefix and so does not vary. The
    // parameter exists for the detail page, which navigates between scopes.
    ALL_PROJECT_DETAILS_KEY,
  )

  // `isError` is read, not just `data`. The endpoint now RAISES on a failed read
  // instead of answering an empty map, precisely so that "the read failed" and
  // "nobody has scored anything" stop looking identical — but consuming only
  // `data` would undo that on screen: `savedScores` stays undefined, every row
  // falls back to DEFAULT_SCORE, and the user sees an unscored backlog with no
  // error. The server half of that invariant is worth nothing without this half.
  //
  // `isPending` is read for the SAME reason, one state along. It is undefined while
  // the read is in flight too, and `?? {}` there made every row say "Not scored yet"
  // and the panel invite a first ballot the moment the project fan-out settled first —
  // a race, not an ordering, since this read scans a whole partition over up to
  // MAX_PRIORITIZATION_PAGES round trips. No error panel retracts that, because
  // nothing has failed.
  const {
    data: savedScores, isError: scoresFailed, isPending: scoresPending,
  } = useQuery({
    queryKey: ['prioritization-scores'],
    queryFn: () => api.getPrioritizationScores(),
    select: selectPrioritization,
    enabled: config.apiEndpoint.length > 0,
  })

  // One list read to learn WHICH forms validate which document. The expensive
  // part — each form's collected ratings — is fetched per form when a row is
  // expanded (see LinkedFormEvidence), not here.
  const { data: formsData } = useQuery({
    queryKey: feedbackFormsKey(),
    queryFn: () => api.getFeedbackForms(),
    // Validate at the query boundary, per project convention: stored forms
    // predate the link fields, so the record on the wire can omit them
    // entirely — an unlinked form must read as "not linked", not crash the page.
    select: (data) => normalizeLinkedForms(data.forms ?? []),
    enabled: config.apiEndpoint.length > 0,
  })

  // The caller's own half, resolved ONCE for its three consumers: the sliders, the save
  // guard, and the panel's wording. Asking separately is how the guard came to read the
  // reader's ballots while the panel read the team's — see `ownBallotRead`.
  const ownBallots = useMemo(
    () => ownBallotRead({
      failed: scoresFailed,
      arrived: savedScores !== undefined,
      ballots: savedScores?.scores,
    }),
    [scoresFailed, savedScores],
  )

  // Merged per FIELD, not by spreading one object over the other: a pending edit
  // carries only what the reader set, so an object spread would let an axis it says
  // nothing about overwrite a saved one with `undefined` and blank a slider showing a
  // score the reviewer had stored.
  const scores = useMemo(
    () => applyBallotEdits(ownBallots.ballots, localEdits),
    [ownBallots, localEdits],
  )

  /**
   * The team view, as the rows show it and the list is ordered by.
   *
   * A READ STATE — not `{}` — whenever there is no map. An empty map means "the read
   * arrived and nobody has scored anything", and absence from it is how this page says
   * "nobody voted on this document"; falling back to one made every row assert that
   * about data that exists on the server, and the stats cards count the whole backlog
   * as unscored. The row copy is the strongest statement on the page — it invites the
   * reader to "cast the first ballot" — so it is exactly where an invented emptiness
   * does the most damage.
   *
   * `savedScores` alone cannot tell the states apart: it is undefined while a read is
   * in flight, when it has failed, and before it is enabled. Hence the query's own
   * `isError` and `isPending` are passed alongside it — the first is what the error
   * panel below is keyed on, and the second closes the same hole for the window before
   * either outcome exists. Which of the two wins — and that a map already in the cache
   * outranks both, so the refetch this page fires after every save cannot blank the
   * team column on one failure — is `teamAggregatesOf`'s business.
   *
   * Deliberately NOT merged with `localEdits` the way `scores` is. A pending edit
   * is one reviewer's unsaved ballot; folding it into the team's mean would make
   * the headline number move as this reader drags a slider, which is precisely the
   * "my score presented as the group's" confusion this page is being changed to
   * remove. The mean updates when the save is refetched, from the arithmetic the
   * backend owns.
   */
  const aggregates: TeamAggregates = useMemo(
    () => teamAggregatesOf({
      failed: scoresFailed,
      pending: scoresPending,
      aggregates: savedScores?.aggregates,
    }),
    [savedScores, scoresFailed, scoresPending],
  )

  const allPRFAQs = useMemo(() => collectPRFAQs(allProjectDetails, projects), [allProjectDetails, projects])

  // True when data is loaded, nothing is scorable, but non-scorable documents exist.
  // Used to show a more helpful empty-state message pointing the user toward
  // creating a PRD or PR/FAQ rather than the generic "no documents" message.
  const hasNonScorableOnly = useMemo(() => {
    if (!allProjectDetails) return false
    const hasNonScorableDoc = allProjectDetails.some(
      (detail) => detail.documents && detail.documents.some((doc) => !isScorable(doc)),
    )
    return allPRFAQs.length === 0 && hasNonScorableDoc
  }, [allProjectDetails, allPRFAQs])

  // Ordered by the team's numbers — the same ones each row displays. Sorting by
  // the caller's own composite while showing the team's would leave the list
  // ranked by one number and labelled with another. Direction and the unscored
  // block are `sortPRFAQs`' business: it negates the comparator rather than
  // reversing the array, so flipping the direction does not also flip rows the
  // sort considers equal, and it keeps unvoted rows at the bottom either way.
  const sortedPRFAQs = useMemo(
    () => sortPRFAQs(allPRFAQs, aggregates, sortField, sortDirection),
    [allPRFAQs, aggregates, sortField, sortDirection],
  )

  // Which forms validate which row. Pure bookkeeping over data already fetched;
  // no per-row request happens here.
  const linkedFormsByDocument = useMemo(
    () => buildLinkedFormsByDocument(
      formsData ?? [],
      allPRFAQs,
      collectProjectDocumentIds(allProjectDetails, projects),
    ),
    [formsData, allPRFAQs, allProjectDetails, projects],
  )

  // Which pending edits carry a note the API will refuse. The API refuses rather
  // than truncating — the tail of a justification is content — and `fetchApi`
  // discards the response body, so an unanticipated 400 would reach the user as a
  // Save button that does nothing. The textarea's `maxLength` covers what a reviewer
  // TYPES; this covers a note that was already over the bound in the pre-ballot
  // data, which is sent along the moment they touch a slider on that row.
  const overLongNotes = useMemo(() => overLongNoteDocuments(localEdits), [localEdits])

  // Document titles, so the panel above can name the rows a reviewer has to fix
  // rather than the ids, which mean nothing to them. Derived from the list already
  // on screen, so a row that has since disappeared falls back to its id instead of
  // rendering blank.
  const titlesByDocument = useMemo(
    () => Object.fromEntries(allPRFAQs.map((doc) => [doc.document_id, doc.title])),
    [allPRFAQs],
  )

  const saveMutation = useMutation({
    mutationFn: () => api.patchPrioritizationScores(localEdits),
    onSuccess: () => {
      setLocalEdits({})
      void queryClient.invalidateQueries({ queryKey: ['prioritization-scores'] })
    },
  })

  const blocker = useBlocker(hasChanges)

  // Records only the field that moved. The edit accumulates across interactions on
  // the same row — a reviewer who sets impact and then confidence sends both — but it
  // never gains a field they did not touch, so an untouched axis stays absent from the
  // body and the route leaves the stored value (or the absence of one) alone.
  const updateScore = (docId: string, field: keyof PrioritizationScore, value: number | string) => {
    setLocalEdits((prev) => ({
      ...prev,
      [docId]: withEditedField(prev[docId] ?? { document_id: docId }, field, value),
    }))
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((d) => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('desc')
    }
  }

  const handleReset = () => {
    setLocalEdits({})
  }

  if (config.apiEndpoint === '') {
    return <div className="text-center py-12"><p className="text-gray-500">{t('configureApiEndpoint')}</p></div>
  }

  const isLoading = loadingProjects || loadingDetails

  return (
    <div className="space-y-4 sm:space-y-6">
      <PrioritizationHeader
        hasChanges={hasChanges}
        isPending={saveMutation.isPending}
        saveBlocked={!ownBallots.inHand || overLongNotes.length > 0}
        onReset={handleReset}
        onSave={() => saveMutation.mutate()}
      />

      {/* Both panels can be on screen at once — a failed read does not stop a
          pending edit from carrying a long note — so each carries its own
          `aria-labelledby`. Two same-role regions with no accessible name are
          indistinguishable to a screen reader AND to a test: `getByRole('alert')`
          throws on the second one rather than reporting which state was missing. */}
      {overLongNotes.length > 0 ? (
        <div role="alert" aria-labelledby="note-too-long-title" className="bg-amber-50 border border-amber-200 rounded-lg p-3 sm:p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-amber-600 mt-0.5 flex-shrink-0" size={20} />
            <div>
              <h3 id="note-too-long-title" className="font-medium text-amber-900 text-sm sm:text-base">{t('noteTooLong.title')}</h3>
              <p className="text-xs sm:text-sm text-amber-700 mt-1">
                {/* No `count` interpolation on purpose: a plural key needs
                    `_one`/`_many`/`_other` forms that differ per locale, and a
                    missing form renders the raw path. */}
                {t('noteTooLong.description', { max: MAX_NOTE_LENGTH })}
              </p>
              {/* WHICH rows, by title. The ids the check returns are meaningless to
                  a reviewer, and rows are collapsed by default, so without this the
                  actionable half of the message is "expand every pending row and
                  look". Titles are data, not UI copy, so this needs no new key. */}
              <ul className="text-xs sm:text-sm text-amber-800 mt-2 list-disc list-inside">
                {overLongNotes.map((documentId) => (
                  <li key={documentId}>{titlesByDocument[documentId] ?? documentId}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      {/* Both ways a reader can be left without their own numbers — the read failed, or it
          succeeded carrying ballots that could not be read. The second used to say nothing
          at all. `ownBallotRead` owns which is which. */}
      {ownBallots.needsPanel ? (
        <div role="alert" aria-labelledby="scores-unavailable-title" className="bg-red-50 border border-red-200 rounded-lg p-3 sm:p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-red-600 mt-0.5 flex-shrink-0" size={20} />
            <div>
              <h3 id="scores-unavailable-title" className="font-medium text-red-900 text-sm sm:text-base">{t('scoresUnavailable.title')}</h3>
              {/* Chosen by THE SAME question the save guard asks — the caller's own
                  ballots — because these two sentences differ precisely on whether a save
                  is possible, and the button next to them is controlled by that. Keyed on
                  the team map instead, the page could say "no need to reload before
                  saving" beside a DISABLED Save whenever `aggregates` was readable and
                  `scores` was not: two predicates about two halves of one response, with
                  the copy from one contradicting the button from the other.
                  `staleDescription` is honest only while the reviewer's ballot is actually
                  in hand; otherwise the original wording is true — the sliders below ARE
                  defaults and reloading IS the right move before saving. Both keys are
                  literals with the condition OUTSIDE `t(...)`: `i18n-check` only sees a
                  key it reads verbatim, so a ternary inside the call reports both unused. */}
              <p className="text-xs sm:text-sm text-red-700 mt-1">
                {ownBallots.inHand ? t('scoresUnavailable.staleDescription') : t('scoresUnavailable.description')}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-3 sm:p-4 border border-blue-100">
        <div className="flex items-start gap-3">
          <Sparkles className="text-blue-600 mt-0.5 flex-shrink-0" size={20} />
          <div>
            <h3 className="font-medium text-blue-900 text-sm sm:text-base">{t('framework.title')}</h3>
            <p className="text-xs sm:text-sm text-blue-700 mt-1">
              <Trans i18nKey="framework.description" ns="prioritization">
                Score each PR/FAQ on: <strong>Impact</strong>, <strong>Time to Market</strong>, <strong>Strategic Fit</strong>, and <strong>Confidence</strong>.
              </Trans>
            </p>
          </div>
        </div>
      </div>

      <StatsCards allPRFAQs={allPRFAQs} aggregates={aggregates} />
      <SortControls
        sortField={sortField}
        sortDirection={sortDirection}
        onToggleSort={toggleSort}
        ordersByTeam={teamOrderingAvailable(aggregates)}
      />

      <PRFAQList
        isLoading={isLoading}
        prfaqs={sortedPRFAQs}
        scores={scores}
        aggregates={aggregates}
        linkedFormsByDocument={linkedFormsByDocument}
        apiEndpoint={config.apiEndpoint}
        expandedId={expandedId}
        onToggleExpand={(id) => setExpandedId(expandedId === id ? null : id)}
        onUpdateScore={updateScore}
        hasNonScorableOnly={hasNonScorableOnly}
      />

      <ConfirmModal
        isOpen={blocker.state === 'blocked'}
        title={t('unsavedChanges.title')}
        message={t('unsavedChanges.message')}
        confirmLabel={t('unsavedChanges.confirm')}
        cancelLabel={t('unsavedChanges.cancel')}
        variant="warning"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </div>
  )
}
