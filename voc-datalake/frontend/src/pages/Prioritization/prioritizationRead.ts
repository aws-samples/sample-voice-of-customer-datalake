/**
 * @fileoverview The prioritization scores read as the page selects it, and when its row count is settled.
 * @module pages/Prioritization/prioritizationRead
 */

import { api } from '../../api/client'
import { normalizeRows, normalizeScores } from './ownRead'
import { normalizeAggregates } from './teamRead'

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

export const selectPrioritization = (data: PrioritizationRead) => {
  const rawRows: unknown = data.rows
  const rows = normalizeRows(rawRows)
  const rowsPublished = rawRows !== undefined
    && rawRows !== null
    && typeof rawRows === 'object'
    && !Array.isArray(rawRows)
    && rows !== undefined
    && Object.keys(rows).length === Object.keys(rawRows).length
  return {
    rows,
    /**
     * Did this response actually PUBLISH a completely readable rows map?
     *
     * `normalizeRows` returns `{}` for an omitted field so the page can keep merging
     * ensure-confirmed fallback rows, returns `undefined` for an unreadable container,
     * and drops unreadable entries from an otherwise readable map. None is fully
     * authoritative: only a PRESENT map whose every raw key survived normalization can
     * say an ensured row or sibling is gone. A present readable empty map remains
     * authoritative because both key counts are zero.
     *
     * Asked here, where the raw field and normalized result are both in hand, so
     * malformed containers and partially readable maps cannot settle the count, while
     * an omitted field cannot impersonate a published empty map.
     */
    rowsPublished,
    scores: normalizeScores(data.scores),
    aggregates: normalizeAggregates(data.aggregates),
  }
}

/**
 * Is the per-project row count settled enough to EXPLAIN a withheld delete, as opposed
 * to merely to withhold one?
 *
 * The count (`rowsPerProject` over `knownRows`) is only as complete as the reads behind
 * it, and the two answers cost differently. Withholding the control through an unsettled
 * window is recoverable — the reader waits, or reloads, and it appears — while the
 * sentence explaining the absence asserts a fact about stored state ("this is the
 * project's only default row"), and a reviewer who believes a false one acts on it by
 * adding a row they did not want. So the gate runs on the count regardless and the
 * explanation runs on this.
 *
 * THE SCORES READ MUST HAVE DELIVERED A ROWS MAP, not merely stopped being pending, and
 * that is the condition an earlier version of this missed. Rows reach `ensuredRows` only
 * through `rowsAnswered`, and `api_create_prioritization_row` answers a project's DEFAULT
 * row and nothing else — a row somebody COMPOSED has no path into it at all, existing
 * only in the scores read. So on the path this page deliberately supports (a failed
 * scores read still listing the rows the ensure confirmed, because rows are the page's
 * whole content) `knownRows` holds exactly one default row per project, and every one of
 * them would be classified as its project's only row however many the partition holds.
 *
 * `rowsPublished` rather than `!scoresFailed`, for the same reason `retainedEnsuredRows`
 * is handed that signal: a read that SUCCEEDED on a deployment sending no `rows` field
 * publishes no rows either, so it is the identical blind spot with a 200 on it.
 *
 * The two project reads stay in it because `collectRows` and the count alike are empty
 * until the project list lands, so a row can already be on screen from the ensure while
 * the fan-out is still resolving its siblings.
 *
 * At MODULE level rather than inline: it is a rule about three reads with no dependency
 * on anything else the component holds, and the page is at its `complexity` budget.
 */
export function rowCountSettled({
  loadingProjects, loadingDetails, rowsPublished,
}: {
  readonly loadingProjects: boolean
  readonly loadingDetails: boolean
  /** `undefined` while no read has delivered at all — see `selectPrioritization`. */
  readonly rowsPublished: boolean | undefined
}): boolean {
  return !loadingProjects && !loadingDetails && rowsPublished === true
}
