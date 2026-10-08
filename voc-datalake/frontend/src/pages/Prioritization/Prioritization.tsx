/**
 * @fileoverview Feature prioritization page for PR/FAQ documents.
 * @module pages/Prioritization
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Sparkles } from 'lucide-react'
import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { isPermanentRefusal } from '../../api/apiErrorStatus'
import { api } from '../../api/client'
import { feedbackFormsKey } from '../../api/feedbackFormQueryKeys'
import { ALL_PROJECT_DETAILS_ROOT, projectDetailsBatchKey, projectsKey } from '../../api/projectQueryKeys'
import { projectsApi } from '../../api/projectsApi'
import { useUnsavedChangesGuard } from '../../components/UnsavedChangesGuard/useUnsavedChangesGuard'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { failedReads } from '../../utils/failedReads'
import { usePrototypeLinkRefresh } from '../../components/usePrototypeLinkRefresh'
import { useIsAdmin } from '../../store/authStore'
import { useConfigStore } from '../../store/configStore'
import { buildLinkedFormsByDocument, collectProjectDocumentIds, normalizeLinkedForms } from './formLinkUtils'
import { EnsureRefusalPanel, RowActionFailurePanel, RowDeletedPanel } from './RowStatePanels'
import { useRowLifecycle } from './useRowLifecycle'
import { refusalsByProject, rowsAnswered, withoutProjects } from './rowEnsureResults'
import { ownBallotRead } from './ownRead'
import { applyBallotEdits, isScorable, MAX_NOTE_LENGTH, overLongNoteRows, withEditedField } from './prioritizationUtils'
import type { SortField, SortDirection } from './prioritizationUtils'
import {
  alignDetails, collectRows, projectsNeedingARow, retainedEnsuredRows, rowsPerProject, scorableDocumentsByProject, withoutRow,
} from './rowCollection'
import { sortRows } from './rowSort'
import { teamAggregatesOf, teamOrderingAvailable } from './teamRead'
import type { TeamAggregates } from './teamRead'
import type { PrioritizationScore, PrioritizationBallotEdit } from '../../api/types'
import type { Project, PrioritizationRow } from '../../api/projectTypes'
import { selectPrioritization, rowCountSettled } from './prioritizationRead'
import { StatsCards } from './StatsCards'
import { SortControls } from './SortControls'
import { PRFAQList } from './PRFAQList'
import { PrioritizationHeader } from './PrioritizationHeader'

/**
 * Query key root for the fan-out project read — `ALL_PROJECT_DETAILS_ROOT` from
 * api/projectQueryKeys, shared because the assistant's approval executors
 * invalidate it too.
 *
 * A constant rather than two literals because it is both fetched and
 * invalidated (see the prototype re-sign below) — spelled twice, a rename would
 * leave the invalidation matching nothing, and nothing would fail: the page keeps
 * working and the prototype links quietly stop being refreshed.
 */
const ALL_PROJECT_DETAILS_KEY = ALL_PROJECT_DETAILS_ROOT

/**
 * Query key for the prioritization read: rows, the caller's ballots, the team aggregates.
 *
 * A constant for the same reason as `ALL_PROJECT_DETAILS_KEY`, and more urgently: it is
 * fetched once and invalidated from THREE places (after a save, after the prototype
 * re-sign, and after the row-ensure effect below). Spelled four times, a rename would
 * leave the invalidations matching nothing and the page would show stale rows after a
 * save with nothing failing. Stays private to this page per the rule in
 * api/projectQueryKeys.
 */
const PRIORITIZATION_SCORES_KEY = ['prioritization-scores'] as const

export default function Prioritization() {
  const { t } = useTranslation('prioritization')
  const { config } = useConfigStore()
  const queryClient = useQueryClient()
  // Whether the DELETE control is offered. The refusal itself is the server's
  // (`require_admin` answers 403 before anything is read), so this is the courtesy
  // half — a reviewer who may not delete is not invited to press a button that
  // cannot work.
  const isAdmin = useIsAdmin()
  /**
   * The page heading, as somewhere a dismissed panel can put focus when the control it
   * came from no longer exists. See `PrioritizationHeader.headingRef`.
   */
  const pageHeading = useRef<HTMLHeadingElement>(null)
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

  const projectsQuery = useQuery({
    queryKey: projectsKey(),
    queryFn: () => projectsApi.getProjects(),
    enabled: config.apiEndpoint.length > 0,
  })
  const { data: projectsData, isLoading: loadingProjects } = projectsQuery

  const projects = projectsData?.projects
  const projectIds = Array.isArray(projects) ? projects.map((p: Project) => p.project_id) : []

  // ONE request for every project's documents (`GET /projects?ids=…`), not one per
  // project. Aligned back to `projects` by id: every reader below indexes the two
  // arrays together, and a project the caller cannot view (or that was deleted
  // since the list) is `undefined` there rather than shifting every later row.
  const detailsQuery = useQuery({
    queryKey: projectDetailsBatchKey(projectIds),
    queryFn: async () => alignDetails(projectIds, await projectsApi.getProjectDetails(projectIds)),
    enabled: projectIds.length > 0,
  })
  const { data: allProjectDetails, isLoading: loadingDetails } = detailsQuery

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
    (allProjectDetails ?? []).flatMap((detail) => detail?.documents ?? []),
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
    queryKey: PRIORITIZATION_SCORES_KEY,
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
    select: (data) => normalizeLinkedForms(data.forms),
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

  /**
   * Which projects have something to score, and so should have a row.
   *
   * A JSON key rather than the array itself, because the array is a fresh object on
   * every render of a page that re-renders on every slider drag — and this value is a
   * mutation dependency. The key is the identity that matters: the same projects, in
   * the same order, mean the same ask.
   */
  const rowProjectIds = useMemo(
    () => projectsNeedingARow(allProjectDetails, projects),
    [allProjectDetails, projects],
  )
  const rowProjectKey = rowProjectIds.join(',')

  /**
   * Ask the API to ensure a default row for every project that has something to score.
   *
   * NOBODY PERFORMS A SETUP STEP: a project with a PRD or a PR/FAQ has a row the first
   * time somebody opens this page. The create is idempotent server-side — the row id is
   * derived from the project id and the write is conditional — so this can run on
   * every mount, from two tabs at once, without giving a project a second row.
   *
   * Fired from an effect rather than lazily per row because the rows ARE the list: a
   * project whose row does not exist yet has nothing to render, so there is no row to
   * hang a lazy create off. Failures are silent ON SCREEN — the page's own empty state
   * covers a backlog with no rows, and a red panel per project would report an error a
   * reader cannot act on — but they are NOT forgotten: a rejected ask is un-marked
   * below so the next pass retries it. Marked-and-never-cleared meant one transient 500
   * or one throttle hid that project for the whole mount, on a page whose entire
   * content is rows, with nothing on screen saying so and no way for the reader to get
   * it back short of a reload.
   *
   * `void`, and no `await` of the settled results in the effect body: what the page
   * reads is the prioritization query, which is invalidated once when the asks finish.
   * Refetching per project would fan out N reads of a whole partition.
   */
  const rowsEnsured = useRef(new Set<string>())
  const [ensuredRows, setEnsuredRows] = useState<Record<string, PrioritizationRow>>({})
  /**
   * Which projects the ensure route REFUSED, and with which status.
   *
   * The 409 this makes visible was the one refusal nothing on screen covered: a
   * project holding more documents than one read can compose a row from simply did not
   * appear in the backlog, with nothing saying why (`createPrioritizationRow` records
   * it, and #339 phase 2 is where it was tracked to). It is permanent by construction
   * — the same answer on every attempt until documents are removed — so a reader who
   * cannot see it has no way to learn the project is missing.
   *
   * The 400 stays SILENT, deliberately, and that is not the same decision twice: it
   * means "this project has no PRD or PR/FAQ to score", which is exactly what the
   * list's own empty invitation already says, in words a reader can act on. Reporting
   * it would put a red panel over the ordinary state of a project nobody has written a
   * document for yet.
   *
   * Keyed by project rather than counted, so the panel can NAME the projects — an
   * unnamed "some projects could not be prioritised" is not actionable.
   *
   * A REPORTED ENTRY PERSISTS FOR THE MOUNT, and that is the effect of one decision
   * rather than an oversight: the 409 that reaches this panel is a permanent refusal by
   * `isPermanentRefusal`'s reckoning, so the effect above deliberately does NOT release
   * that project from `rowsEnsured.current` — it therefore never joins a later `pending`
   * batch and is never re-decided. Honest, because the refusal is settled until the
   * project's documents change, and changing them changes `projectsNeedingARow`'s output
   * and so the whole ask. The `withoutProjects` re-decide below is NOT dead: it is live
   * for a project refused with a status this panel does not report, which is released and
   * asked again. Widening `REPORTED_ENSURE_STATUSES` to a TRANSIENT status would need the
   * release changed too, or the panel would name a project the next pass has since
   * succeeded for.
   */
  const [ensureRefusals, setEnsureRefusals] = useState<Record<string, number>>({})
  useEffect(() => {
    // Read back from the KEY, not the array, so the key is the effect's whole input:
    // project ids are `proj_<timestamp>`, so a comma never occurs inside one.
    const ids = rowProjectKey.split(',').filter((id) => id.length > 0)
    if (config.apiEndpoint.length === 0 || ids.length === 0) return
    // Asked ONCE per project per mount, while the ask keeps succeeding. Without this
    // the effect re-runs whenever the project read is refetched — which the prototype
    // re-signing does hourly — and each pass would spend one refused conditional write
    // per project.
    const pending = ids.filter((id) => !rowsEnsured.current.has(id))
    if (pending.length === 0) return
    // Marked BEFORE the request, not after: two renders in the same tick would
    // otherwise both see an unmarked id and both write.
    for (const id of pending) rowsEnsured.current.add(id)
    void Promise.allSettled(
      pending.map((id) => api.createPrioritizationRow(id)),
    ).then((results) => {
      // A TRANSIENT failure is released, so a later render of this same mount — an
      // hourly prototype re-sign, any project refetch — asks again. Idempotent
      // server-side, so a retry costs one refused conditional write and never a
      // duplicate row.
      //
      // A REFUSAL is not released. A 4xx is the server's settled answer about this
      // project — no permission, or no scorable document by the route's reading of it,
      // which is a disagreement with `projectsNeedingARow` that asking again cannot
      // resolve — so releasing it re-asks on every project refetch for the whole mount
      // and never gets a different reply.
      pending.forEach((id, index) => {
        const result = results.at(index)
        if (result?.status !== 'rejected') return
        if (!isPermanentRefusal(result.reason)) rowsEnsured.current.delete(id)
      })
      // WHICH refusals a reader has to be told about, and which the page already
      // covers in words: `refusalsByProject` owns that judgement. Every project in
      // THIS pass is re-decided rather than merged over — an ask that has since
      // succeeded, or failed transiently, must stop being named — while projects the
      // pass did not ask about keep whatever was recorded for them.
      setEnsureRefusals((known) => ({
        ...withoutProjects(known, pending),
        ...refusalsByProject(pending, results),
      }))
      // The rows the asks HANDED BACK, kept rather than discarded. Each is the row the
      // server holds for that project — created just now or already there, since the
      // route is idempotent and answers the stored row either way — so it is the same
      // record the read below reports, arriving one round trip earlier. Keeping it is
      // what makes the list survive a prioritization read that fails or is still in
      // flight: rows ARE the page's content now, and read from that one query alone a
      // 500 on the scores emptied the whole page rather than only the numbers on it.
      const answered = rowsAnswered(results)
      setEnsuredRows((known) => ({
        ...known,
        ...answered,
      }))
      // Refetched only when an ask actually CREATED something, which is what makes the
      // read out of date. `created: false` — the common case, since the route is
      // idempotent and every mount after the first only confirms rows that exist —
      // leaves the read alone: it either already reports those rows or is about to, and
      // invalidating unconditionally spent one whole-partition read per mount and
      // discarded a response the reader was already looking at.
      const created = results.some(
        (result) => result.status === 'fulfilled' && result.value.created === true,
      )
      if (created) void queryClient.invalidateQueries({ queryKey: PRIORITIZATION_SCORES_KEY })
    })
    // `rowProjectKey` rather than the array: see its own comment.
  }, [rowProjectKey, config.apiEndpoint, queryClient])

  /**
   * The rows the page renders: the server's rows, resolved against the documents on
   * screen.
   *
   * `collectRows` decides what each row holds from the server's own `document_ids`,
   * not by recomputing "every scorable document of this project" — a row stores
   * concrete ids, so generating a new PRD leaves existing rows alone.
   *
   * TWO sources for one map, and the READ WINS where both name a row. The read is
   * authoritative — it reports every row in the partition, including ones this page
   * never asked for — while `ensuredRows` covers the window the read cannot: the
   * prioritization query failing, or not having landed, on a page whose entire content
   * is rows. Without it a 500 on the scores read left the reader an empty backlog with
   * "no documents found" over data that exists, rather than the rows they can see with
   * the numbers marked unavailable, which is the distinction the rest of this page is
   * built to keep.
   *
   * The three absences `normalizeRows` distinguishes all land here as "the read adds
   * nothing to what the asks confirmed", which is why the `?? {}` is honest rather than
   * a collapse of that distinction: an absent field (a deployment predating rows), an
   * unreadable one, and a read that has not delivered are all states in which the only
   * rows anybody has vouched for are the ones the create route handed back — and it
   * vouches for each by returning it. An EMPTY map is different only in that it adds
   * nothing to merge, and with no asks answered yet it leaves the page's own empty
   * state, which is the honest reading of a deployment that holds no rows.
   *
   * `ensuredRows` WAS STICKY for the mount, and so the merge could only ever ADD a row.
   * Deletion makes that wrong — a row this page vouched for on mount would survive its
   * own removal until a remount, so a delete that reported success and took its ballots
   * with it would change nothing on screen. `retainedEnsuredRows` is the reconciliation:
   * a read that PUBLISHED a rows map is the authority on what exists, so an ensured row
   * absent from it is dropped; every state where nothing has said that — pending, failed,
   * unreadable, or a deployment sending no `rows` field at all — keeps the fallback
   * exactly as it was. Hence `rowsPublished`, which is what tells an omitted field from
   * an empty published map.
   */
  const knownRows = useMemo(
    () => ({
      ...retainedEnsuredRows(
        ensuredRows,
        savedScores?.rowsPublished === true ? savedScores.rows : undefined,
      ),
      ...savedScores?.rows,
    }),
    [savedScores, ensuredRows],
  )
  const allRows = useMemo(
    () => collectRows(knownRows, allProjectDetails, projects),
    [knownRows, allProjectDetails, projects],
  )

  // True when data is loaded, nothing is scorable, but non-scorable documents exist.
  // Used to show a more helpful empty-state message pointing the user toward
  // creating a PRD or PR/FAQ rather than the generic "no documents" message.
  const hasNonScorableOnly = useMemo(() => {
    if (!allProjectDetails) return false
    const hasNonScorableDoc = allProjectDetails.some(
      (detail) => detail?.documents.some((doc) => !isScorable(doc)) ?? false,
    )
    return allRows.length === 0 && hasNonScorableDoc
  }, [allProjectDetails, allRows])

  // Ordered by the team's numbers — the same ones each row displays. Sorting by
  // the caller's own composite while showing the team's would leave the list
  // ranked by one number and labelled with another. Direction and the unscored
  // block are `sortRows`' business: it negates the comparator rather than
  // reversing the array, so flipping the direction does not also flip rows the
  // sort considers equal, and it keeps unvoted rows at the bottom either way.
  const sortedRows = useMemo(
    () => sortRows(allRows, aggregates, sortField, sortDirection),
    [allRows, aggregates, sortField, sortDirection],
  )

  // Which forms validate which DOCUMENT of which row. Pure bookkeeping over data
  // already fetched; no per-row request happens here. Keyed by document because a
  // form validates a document and its evidence stays attached to it — the row is how
  // a reader reaches it.
  const linkedFormsByDocument = useMemo(
    () => buildLinkedFormsByDocument(
      formsData ?? [],
      allRows,
      collectProjectDocumentIds(allProjectDetails, projects),
    ),
    [formsData, allRows, allProjectDetails, projects],
  )

  // Which pending edits carry a note the API will refuse. The API refuses rather
  // than truncating — the tail of a justification is content — and `fetchApi`
  // discards the response body, so an unanticipated 400 would reach the user as a
  // Save button that does nothing. The textarea's `maxLength` covers what a reviewer
  // TYPES; this covers a note that was already over the bound in the pre-ballot
  // data, which is sent along the moment they touch a slider on that row.
  const overLongNotes = useMemo(() => overLongNoteRows(localEdits), [localEdits])

  // ROW titles, so the panel above can name the rows a reviewer has to fix rather
  // than the ids, which mean nothing to them. Derived from the list already on
  // screen, so a row that has since disappeared falls back to its id instead of
  // rendering blank.
  const titlesByRow = useMemo(
    () => Object.fromEntries(allRows.map((row) => [row.row_id, row.title])),
    [allRows],
  )

  const saveMutation = useMutation({
    mutationFn: () => api.patchPrioritizationScores(localEdits),
    onSuccess: () => {
      setLocalEdits({})
      void queryClient.invalidateQueries({ queryKey: PRIORITIZATION_SCORES_KEY })
    },
  })

  /**
   * Which documents a reviewer may compose a row from, per project.
   *
   * The SAME project read the list is built from — no request per row — filtered to
   * the scorable types, which is the candidate set the compose and recompose routes
   * validate against. See `scorableDocumentsByProject`.
   */
  const candidatesByProject = useMemo(
    () => scorableDocumentsByProject(allProjectDetails, projects),
    [allProjectDetails, projects],
  )

  /**
   * How many rows each project has, so a project's ONLY default row does not offer a
   * delete the API always refuses. No request — these are the rows already in hand.
   *
   * Counted over `knownRows`, the record BEFORE `collectRows` narrows it, deliberately:
   * a sibling row dropped for having no resolvable document (or for a project detail
   * still in flight) would otherwise make a project holding two rows count as one.
   * `rowsPerProject` takes the record itself, so passing the narrowed list is a compile
   * error rather than a silent miscount — see there.
   */
  const rowsByProject = useMemo(() => rowsPerProject(knownRows), [knownRows])

  // Whether the count may be STATED as a reason, not merely acted on. See
  // `rowCountSettled`, at module level, which is where the reasoning lives.
  const countSettled = rowCountSettled({
    loadingProjects, loadingDetails, rowsPublished: savedScores?.rowsPublished,
  })

  // Project names, so the refusal panel can NAME the projects that have no row rather
  // than printing ids nobody recognises. Off the project list read, which is a
  // different query from the one that may have refused, so the names are available in
  // exactly the state the panel renders in.
  const projectNamesById = useMemo(
    () => Object.fromEntries((projects ?? []).map((p: Project) => [p.project_id, p.name])),
    [projects],
  )

  /**
   * Adding a row, changing an un-frozen row's documents, and deleting a row with its
   * ballots — plus what a reader has to be told afterwards. See `useRowLifecycle`.
   *
   * `canDelete` is the caller's admin group, and it decides only whether the control is
   * OFFERED: the refusal is `require_admin`'s, server-side, before anything is read.
   *
   * `onRowDeleted` DROPS THE PENDING EDIT on the row that is gone, and that is not
   * housekeeping. `api_patch_prioritization_scores` checks every named row exists before
   * its first write and raises on any miss, deliberately, so a body naming one vanished
   * row persists NOTHING — a stale key here would take every other row's unsaved edit
   * down with it on the next Save. It also drops the row from `ensuredRows`, so the
   * removal survives a later read that publishes nothing to reconcile against (a cache
   * eviction, a failed refetch) rather than only holding while `retainedEnsuredRows`
   * has an authoritative map to filter by.
   */
  const rowLifecycle = useRowLifecycle({
    candidatesByProject,
    rowsByProject,
    rowCountSettled: countSettled,
    canDelete: isAdmin,
    // Where a dismissal lands when its own control is gone — which is EVERY dismissal of
    // the delete receipt, since a landed delete takes the button that issued it. See
    // `useRowLifecycle.restoreFocus`.
    fallbackFocus: pageHeading,
    onRowsChanged: () => {
      void queryClient.invalidateQueries({ queryKey: PRIORITIZATION_SCORES_KEY })
    },
    onRowDeleted: (rowId) => {
      setLocalEdits((edits) => withoutRow(edits, rowId))
      setEnsuredRows((known) => withoutRow(known, rowId))
    },
  })

  // Records only the field that moved. The edit accumulates across interactions on
  // the same row — a reviewer who sets impact and then confidence sends both — but it
  // never gains a field they did not touch, so an untouched axis stays absent from the
  // body and the route leaves the stored value (or the absence of one) alone.
  const updateScore = (rowId: string, field: keyof PrioritizationScore, value: number | string) => {
    setLocalEdits((prev) => ({
      ...prev,
      [rowId]: withEditedField(prev[rowId] ?? { row_id: rowId }, field, value),
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

  // The shared unsaved-changes guard (E2E F6): Save is the header's own save,
  // and is offered only when the header would allow it.
  const saveBlocked = !ownBallots.inHand || overLongNotes.length > 0
  const guard = useUnsavedChangesGuard({
    dirty: hasChanges,
    canSave: !saveBlocked,
    onSave: async () => {
      await saveMutation.mutateAsync()
      return true
    },
    onDiscard: handleReset,
  })

  if (config.apiEndpoint === '') {
    return <div className="text-center py-12"><p className="text-muted">{t('configureApiEndpoint')}</p></div>
  }

  // Whether the list is still a spinner. The heading's count relies on this being a
  // SUBSET of "no rows yet": `collectRows` returns nothing until both these reads land,
  // and neither query carries `placeholderData`, so a page that is loading always has
  // zero rows and the header's own zero-gate covers the loading pass for free. Widening
  // this to `isFetching` — the obvious way to spin on refetch — breaks that, because
  // cached rows survive a refetch and the count would then sit over a spinner. Gate the
  // badge explicitly if that happens.
  const isLoading = loadingProjects || loadingDetails
  // The projects or their documents could not be read: no rows is then NOT
  // "no PR/FAQs yet" (the empty state used to say exactly that, offline).
  const backlogFailure = failedReads([projectsQuery, detailsQuery])
  return (
    <div className="space-y-4 sm:space-y-6">
      <PrioritizationHeader
        hasChanges={hasChanges}
        isPending={saveMutation.isPending}
        saveBlocked={saveBlocked}
        // The list's OWN length, so the badge and the rows below it are one number.
        // Nothing is gated here — the header withholds a zero, which covers the loading
        // pass as well, since `collectRows` has no documents to compose rows from until
        // the reads `isLoading` tracks have landed. See `rowCount` there.
        rowCount={sortedRows.length}
        headingRef={pageHeading}
        onReset={handleReset}
        onSave={() => saveMutation.mutate()}
      />

      {/* Both panels can be on screen at once — a failed read does not stop a
          pending edit from carrying a long note — so each carries its own
          `aria-labelledby`. Two same-role regions with no accessible name are
          indistinguishable to a screen reader AND to a test: `getByRole('alert')`
          throws on the second one rather than reporting which state was missing. */}
      {overLongNotes.length > 0 ? (
        <div role="alert" aria-labelledby="note-too-long-title" className="bg-warn-subtle border border-warn/30 rounded-lg p-3 sm:p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-warn mt-0.5 flex-shrink-0" size={20} />
            <div>
              <h2 id="note-too-long-title" className="font-medium text-text-strong text-sm sm:text-base">{t('noteTooLong.title')}</h2>
              <p className="text-xs sm:text-sm text-text mt-1">
                {/* No `count` interpolation on purpose: a plural key needs
                    `_one`/`_many`/`_other` forms that differ per locale, and a
                    missing form renders the raw path. */}
                {t('noteTooLong.description', { max: MAX_NOTE_LENGTH })}
              </p>
              {/* WHICH rows, by title. The ids the check returns are meaningless to
                  a reviewer, and rows are collapsed by default, so without this the
                  actionable half of the message is "expand every pending row and
                  look". Titles are data, not UI copy, so this needs no new key. */}
              <ul className="text-xs sm:text-sm text-text mt-2 list-disc list-inside">
                {overLongNotes.map((rowId) => (
                  <li key={rowId}>{titlesByRow[rowId] ?? rowId}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      {/* What did not happen when a reviewer added, edited or deleted a row — including
          the 409 a ballot landing first produces, which is the refusal a hidden control
          cannot prevent. Its own region beside the others, dismissable, because it
          describes an action the reader just took rather than the state of a read. Both
          it and the receipt below move the reader to themselves: the control that
          produced either lives inside an expanded row that may be well below this. */}
      <RowActionFailurePanel
        failure={rowLifecycle.failure}
        onDismiss={rowLifecycle.clearFailure}
      />

      {/* That a delete LANDED, and how many ballots went with it — the one write whose
          success is otherwise indistinguishable from a filter or a failed read, and the
          only place `ballots_deleted` can be read at all. */}
      <RowDeletedPanel
        deleted={rowLifecycle.deleted}
        onDismiss={rowLifecycle.clearDeleted}
      />

      {/* The default-row refusals that leave a project out of the backlog with nothing
          else saying so — see `ensureRefusals`. */}
      <EnsureRefusalPanel refusals={ensureRefusals} namesByProject={projectNamesById} />

      {/* Both ways a reader can be left without their own numbers — the read failed, or it
          succeeded carrying ballots that could not be read. The second used to say nothing
          at all. `ownBallotRead` owns which is which. */}
      {ownBallots.needsPanel ? (
        <div role="alert" aria-labelledby="scores-unavailable-title" className="bg-danger-subtle border border-danger/30 rounded-lg p-3 sm:p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-danger mt-0.5 flex-shrink-0" size={20} />
            <div>
              <h2 id="scores-unavailable-title" className="font-medium text-text-strong text-sm sm:text-base">{t('scoresUnavailable.title')}</h2>
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
              <p className="text-xs sm:text-sm text-text mt-1">
                {ownBallots.inHand ? t('scoresUnavailable.staleDescription') : t('scoresUnavailable.description')}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="bg-accent-subtle rounded-lg p-3 sm:p-4 border border-accent/30">
        <div className="flex items-start gap-3">
          <Sparkles className="text-accent-text mt-0.5 flex-shrink-0" size={20} aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-accent-text">{t('framework.title')}</h2>
            <p className="text-xs sm:text-sm text-text mt-1">
              <Trans i18nKey="framework.description" ns="prioritization">
                Score each PR/FAQ on: <strong>Impact</strong>, <strong>Time to Market</strong>, <strong>Strategic Fit</strong>, and <strong>Confidence</strong>.
              </Trans>
            </p>
          </div>
        </div>
      </div>

      <StatsCards rows={allRows} aggregates={aggregates} />
      <SortControls
        sortField={sortField}
        sortDirection={sortDirection}
        onToggleSort={toggleSort}
        ordersByTeam={teamOrderingAvailable(aggregates)}
      />

      {backlogFailure.loadFailed ? (
        <LoadFailed onRetry={backlogFailure.retry} retrying={backlogFailure.retrying} />
      ) : (
        <PRFAQList
          isLoading={isLoading}
          rows={sortedRows}
          scores={scores}
          aggregates={aggregates}
          linkedFormsByDocument={linkedFormsByDocument}
          apiEndpoint={config.apiEndpoint}
          composition={rowLifecycle.actions}
          expandedId={expandedId}
          onToggleExpand={(id) => setExpandedId(expandedId === id ? null : id)}
          onUpdateScore={updateScore}
          hasNonScorableOnly={hasNonScorableOnly}
        />
      )}

      {guard.dialog}
    </div>
  )
}
