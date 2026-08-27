/**
 * @fileoverview The row LIFECYCLE of the prioritization page: composing another
 * row, changing an un-balloted row's documents, and deleting a row with its
 * ballots.
 *
 * Its own module rather than more surface on `client.ts`, following the
 * `projectsApi` and `votingSessionsApi` precedent — `client.ts` is at its
 * `max-lines` budget, and these three calls are one feature that one page owns.
 * The READ (`getPrioritizationScores`) and the idempotent default-row ensure
 * (`createPrioritizationRow`) stay there: they are what every mount performs, while
 * these three are what a reviewer asks for.
 *
 * WHAT THE PAGE DOES WITH AN ANSWER, and why only one of the three is parsed here.
 * Compose and recompose are followed by an invalidation of the prioritization read,
 * which is the authority on what exists — so their `row` is a courtesy the page does
 * not render, and normalizing it here would duplicate `normalizeRow` (the schema the
 * read half is held to) for a value nothing reads. `ballots_deleted` is different:
 * the row is gone, so nothing can be re-read to check, and that number is the only
 * evidence the deletion took the ballots with it. It is therefore parsed, leniently,
 * at this boundary per project convention.
 *
 * Every `row_id` reaches the URL through `encodeURIComponent`. The ids the product
 * mints are hex (`_minted_row_id`) or derived from a project id, so today none of
 * them needs escaping — but this is a path segment built from a value the page read
 * off a response, and one carrying a '/' or a '?' would address a different resource
 * entirely. Same rule `votingSessionsApi.sessionPath` records for a server-minted
 * session id.
 *
 * @module api/prioritizationRowsApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import type { PrioritizationRow } from './types'

/**
 * What a row HOLDS, as a request states it: one project, and the concrete document
 * ids inside it.
 *
 * Both routes take exactly this body, because both mean "this row is these
 * documents of this project" — the compose for a row that does not exist yet and the
 * recompose for one that does. `project_id` is not redundant on the recompose: the
 * API validates the ids against THAT project's own documents and asserts it in the
 * write's condition, so a body without it could install one project's documents on
 * another project's row.
 *
 * Snake case, matching the wire rather than the frontend's own camel case, so a
 * reader comparing this with `projects_handler.py` is comparing identical names.
 * `document_ids` is `readonly` because nothing here mutates it and a caller's array
 * (a selection held in component state) must not be captured as writable.
 */
export interface RowComposition {
  readonly project_id: string
  readonly document_ids: readonly string[]
}

/**
 * What both writing routes answer. `row` is optional in the TYPE for the reason
 * `getPrioritizationScores`' own optional fields are: a field declared required
 * here would make a response from a deployment that omits it fail to type-check,
 * and the page renders the refetched read rather than this row.
 */
interface RowWriteResponse {
  success?: boolean
  created?: boolean
  row?: PrioritizationRow
}

/**
 * The evidence a delete completed, and the one field of it the page can act on.
 *
 * `.catch(0)` rather than a refusal: the deletion has already happened by the time
 * this parses, so a response whose count cannot be read is not a failure to report —
 * it is a successful delete whose receipt is unreadable, and answering 0 says "no
 * ballots are known to have gone with it" instead of throwing away the success.
 */
const rowDeletionSchema = z.object({
  ballots_deleted: z.number().int().min(0).catch(0),
})

export type RowDeletion = z.infer<typeof rowDeletionSchema>

/** What an unreadable receipt reports — see `deletePrioritizationRow`. */
const NO_BALLOTS_REPORTED: RowDeletion = { ballots_deleted: 0 }

export const prioritizationRowsApi = {
  /**
   * Create a row for another combination of one project's documents.
   *
   * Open to any signed-in reviewer, and NEVER idempotent: two calls deliberately
   * produce two rows, because "score another combination" is a request to add one.
   * The bound (`MAX_ROWS_PER_PROJECT`) and every rule about which ids are legal are
   * the server's — a 400 for an empty set, a 404 for an id the project does not
   * hold or that is not scorable, a 409 for a project already at the bound.
   */
  composePrioritizationRow: (input: RowComposition) =>
    fetchApi<RowWriteResponse>('/projects/prioritization/rows/compose', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * Change which documents an UN-BALLOTED row holds.
   *
   * Refused with 409 once a ballot has landed, by a condition on the write itself
   * rather than by anything a client can check first — so a caller that hid its
   * editor on `is_frozen` still has to be able to state this refusal. The same 409
   * covers a row that does not exist and one belonging to another project: the API
   * answers one status for all three, because the caller's remedy (reload, look at
   * the current rows) is identical.
   */
  recomposePrioritizationRow: (rowId: string, input: RowComposition) =>
    fetchApi<RowWriteResponse>(rowPath(rowId), {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  /**
   * Delete one row TOGETHER WITH ITS BALLOTS. Admin only, server-enforced.
   *
   * One atomic write on the server, so no ballot outlives the row it describes, and
   * `ballots_deleted` is how many went with it. A non-admin caller is refused 403
   * before anything is read: the page withholds the control, and this is what makes
   * that a courtesy rather than the protection.
   */
  deletePrioritizationRow: async (rowId: string): Promise<RowDeletion> => {
    const raw = await fetchApi<unknown>(rowPath(rowId), { method: 'DELETE' })
    // `safeParse`, so a body that is not an object at all — a `null`, an API Gateway
    // page — cannot turn a delete the server COMPLETED into a rejected mutation the
    // page reports as a failure. The row is already gone; the only thing lost is the
    // receipt. Same direction as the field's own `.catch(0)`.
    const parsed = rowDeletionSchema.safeParse(raw)
    return parsed.success ? parsed.data : NO_BALLOTS_REPORTED
  },
}

/** The row's own address, with the id escaped — see the module docstring. */
function rowPath(rowId: string): string {
  return `/projects/prioritization/rows/${encodeURIComponent(rowId)}`
}
