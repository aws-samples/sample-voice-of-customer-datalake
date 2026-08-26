/**
 * @fileoverview What one batch of default-row asks HANDED BACK, read off the settled
 * results: the rows the server holds, and the refusals a reader has to be told about.
 *
 * Pure mappings over `Promise.allSettled` results, in their own module rather than
 * inside the effect that fires the batch — a closure four levels deep inside a
 * `useEffect` inside a component is what this page's lint budget refuses, and
 * `Prioritization.tsx` is at its `max-lines` cap besides. Nothing here reads or
 * writes React state: the effect decides what to do with these answers.
 *
 * @module pages/Prioritization/rowEnsureResults
 */

import { apiErrorStatus } from '../../api/apiErrorStatus'
import { normalizeRow } from './prioritizationUtils'
import type { PrioritizationRow } from '../../api/types'

/**
 * The rows a batch of row-ensure asks actually handed back, keyed by row id.
 *
 * The create route is idempotent and answers the STORED row whether it just wrote it
 * or found it, so every fulfilled ask carries a row the server holds — the same record
 * the prioritization read reports, one round trip earlier. Keeping them is what lets
 * the list survive a read that fails or has not landed.
 *
 * Each answer goes through `normalizeRow` — the SAME schema the read half is validated
 * by — rather than being trusted because its declared type says `PrioritizationRow`. A
 * fulfilled ask answering `{success: true, row: {}}` type-checks and satisfies the
 * compiler, and reading `row.row_id.length` off it threw inside the caller's `.then`,
 * which lost every row in the batch and left the rejection unhandled. Validating instead
 * keeps the two halves of the same record held to one contract, including the
 * document-count bound `RowSchema` states.
 *
 * A fulfilled ask with no `row`, an unreadable one, or one whose id is empty contributes
 * nothing: the field is optional on the wire, and a row the page cannot address is a row
 * no ballot, aggregate or expansion could ever be looked up against.
 */
export function rowsAnswered(
  results: readonly PromiseSettledResult<{ readonly row?: PrioritizationRow }>[],
): Record<string, PrioritizationRow> {
  const answered = results.flatMap((result) => {
    if (result.status !== 'fulfilled') return []
    const row = normalizeRow(result.value.row)
    return row ? [row] : []
  })
  return Object.fromEntries(answered.map((row) => [row.row_id, row]))
}

/**
 * The default-row asks that were REFUSED in a way the page has to state, by project.
 *
 * ONE STATUS IS REPORTED AND THE OTHERS ARE NOT, and each side of that is a decision:
 *
 *  * **409** — the project holds more documents than a row can be composed from in one
 *    read. Permanent by construction (the same answer until documents are removed) and
 *    covered by NOTHING on screen: the project just does not appear in the backlog. This
 *    is the state `createPrioritizationRow`'s docstring tracked to #339 phase 2.
 *  * **400** — the project has no PRD and no PR/FAQ. Also permanent, and already
 *    covered: the list's own empty state invites exactly that document, which is more
 *    actionable than an error panel. Kept silent, as it was.
 *  * Anything ELSE — a 500, a throttle, a network fault — is transient, released for
 *    retry by the effect and not worth a panel a reader cannot act on. A pass that
 *    keeps failing leaves the list's own states to speak.
 */
const REPORTED_ENSURE_STATUSES = new Set([409])

export function refusalsByProject(
  projectIds: readonly string[],
  results: readonly PromiseSettledResult<unknown>[],
): Record<string, number> {
  const refused = results.flatMap((result, index): [string, number][] => {
    if (result.status !== 'rejected') return []
    const status = apiErrorStatus(result.reason)
    if (status === null || !REPORTED_ENSURE_STATUSES.has(status)) return []
    return [[projectIds[index], status]]
  })
  return Object.fromEntries(refused)
}

/** The same map with these projects dropped — see the `setEnsureRefusals` call. */
export function withoutProjects(
  known: Record<string, number>,
  projectIds: readonly string[],
): Record<string, number> {
  const dropped = new Set(projectIds)
  return Object.fromEntries(
    Object.entries(known).filter(([projectId]) => !dropped.has(projectId)),
  )
}
